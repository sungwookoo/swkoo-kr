import axios from 'axios';
import { privateImageDigest } from './private-image';

const authorization = Buffer.from('alice:test-credential').toString('base64');
const digest = 'sha256:' + 'a'.repeat(64);

afterEach(() => jest.restoreAllMocks());

it.each(['public', 'internal'])('does not request a registry token for a %s package', async visibility => {
  const get = jest.spyOn(axios, 'get').mockResolvedValueOnce({ data: { visibility } });
  const head = jest.spyOn(axios, 'head');
  await expect(privateImageDigest('ghcr.io/team/swkoo-123', 'latest', authorization, true))
    .rejects.toThrow('Package must be private');
  expect(get).toHaveBeenCalledTimes(1);
  expect(head).not.toHaveBeenCalled();
});

it('uses organization metadata and the exact registry repository and tag', async () => {
  const get = jest.spyOn(axios, 'get').mockResolvedValueOnce({ data: { visibility: 'private' } })
    .mockResolvedValueOnce({ data: { token: 'registry-token' } });
  const head = jest.spyOn(axios, 'head').mockResolvedValue({ headers: { 'docker-content-digest': digest } });
  await expect(privateImageDigest('ghcr.io/team/swkoo-123', 'source-sha', authorization, true)).resolves.toBe(digest);
  expect(get).toHaveBeenNthCalledWith(1, 'https://api.github.com/orgs/team/packages/container/swkoo-123',
    expect.objectContaining({ maxRedirects: 0 }));
  expect(get).toHaveBeenNthCalledWith(2, 'https://ghcr.io/token',
    expect.objectContaining({ params: { service: 'ghcr.io', scope: 'repository:team/swkoo-123:pull' } }));
  expect(head).toHaveBeenCalledWith('https://ghcr.io/v2/team/swkoo-123/manifests/source-sha',
    expect.objectContaining({ maxRedirects: 0 }));
});
