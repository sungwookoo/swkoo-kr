import axios from 'axios';

export const GHCR_SECRET = 'swkoo-private-package';
const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
const requestOptions = { timeout: 5000, maxRedirects: 0 };

export async function privateImageDigest(imageRepo: string, tag: string, auth: string, organization: boolean): Promise<string> {
  const [, owner, image] = imageRepo.split('/');
  const token = Buffer.from(auth, 'base64').toString('utf8').split(':')[1];
  const pkg = await axios.get<{ visibility: string }>(
    `https://api.github.com/${organization ? 'orgs' : 'users'}/${owner}/packages/container/${image}`, {
      ...requestOptions, headers: { Authorization: `Bearer ${token}` },
    });
  if (pkg.data.visibility !== 'private') throw new Error('Package must be private');
  const registry = await axios.get<{ token: string }>('https://ghcr.io/token', {
    ...requestOptions, headers: { Authorization: `Basic ${auth}` },
    params: { service: 'ghcr.io', scope: `repository:${owner}/${image}:pull` },
  });
  const result = await axios.head(`https://ghcr.io/v2/${owner}/${image}/manifests/${encodeURIComponent(tag)}`, {
    ...requestOptions, headers: { Authorization: `Bearer ${registry.data.token}`, Accept: ACCEPT },
  });
  const digest = result.headers['docker-content-digest'];
  if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Could not verify image digest');
  return digest;
}
