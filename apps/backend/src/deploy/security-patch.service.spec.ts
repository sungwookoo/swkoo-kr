jest.mock('../kube/kube.client', () => ({ KubeClient: class {} }));
jest.mock('./deploy.service', () => ({ DeployService: class {} }));
jest.mock('axios');
import axios from 'axios';
import { SecurityPatchService } from './security-patch.service';
import { PATCH_POLICY } from './security-patch.policy';
import type { PatchPlan } from './security-patch.repository';

const manifest = JSON.stringify({ dependencies: { demo: '^1.0.0' } });
const lock = (version: string) => JSON.stringify({ lockfileVersion: 3, packages: {
  '': { dependencies: { demo: '^1.0.0' } },
  'node_modules/demo': { version, resolved: 'https://registry.npmjs.org/demo/-/demo.tgz', integrity: 'sha512-YWJj' },
} });
const user = { id: 1, githubLogin: 'alice', isAllowed: true } as any;
function setup() {
  let plan: PatchPlan | null = { id: 'proposal', userId: 1, repo: 'alice/app', base: 'release', sha: 'base-sha', state: 'ready',
    createdAt: Date.now(), updatedAt: Date.now(), manifest, original: lock('1.0.0'), lockfile: lock('1.0.1'), before: 1, after: 0,
    changes: [{ path: 'node_modules/demo', from: '1.0.0', to: '1.0.1' }] };
  const plans = { get: jest.fn(() => plan), save: jest.fn(p => { plan = p; }), prune: jest.fn(), countPreparing: jest.fn(() => 0) };
  const gh = { get: jest.fn(async (url: string) => {
    if (url === '') return { data: { default_branch: 'release' } };
    if (url === '/pulls') return { data: [] };
    if (url.startsWith('/commits/')) return { data: { sha: 'base-sha' } };
    if (url.startsWith('/git/commits/')) return { data: { tree: { sha: 'base-tree' } } };
    return { data: {} };
  }), post: jest.fn(async (url: string) => ({ data: url === '/pulls' ? { html_url: 'https://github.com/alice/app/pull/1' } : { sha: 'new-sha' } })) };
  (axios.create as jest.Mock).mockReturnValue(gh);
  const github = { getInstallationTokenForRepo: jest.fn(async () => 'scoped-test-token') };
  const users = { audit: jest.fn() };
  const deploy = { getCurrentDeployment: jest.fn(async () => ({ state: 'active', fullName: 'alice/app' })) };
  const kube = { available: () => true, batch: { listNamespacedJob: jest.fn(async () => ({ items: [] })), createNamespacedJob: jest.fn() } };
  const service = new SecurityPatchService(github as any, kube as any, users as any, deploy as any, plans as any);
  return { service, gh, github, plans, kube, deploy, setPlan: (p: PatchPlan | null) => { plan = p; }, getPlan: () => plan! };
}
describe('opt-in security PR boundary', () => {
  it('rejects another owner before reading GitHub or creating a job', async () => {
    const s = setup();
    await expect(s.service.prepare(user, 'bob/app', PATCH_POLICY)).rejects.toThrow();
    expect(s.github.getInstallationTokenForRepo).not.toHaveBeenCalled();
    expect(s.kube.batch.createNamespacedJob).not.toHaveBeenCalled();
  });
  it('requires explicit policy consent for preparation and publication', async () => {
    const s = setup();
    await expect(s.service.prepare(user, 'alice/app', '')).rejects.toThrow();
    await expect(s.service.createPr(user, 'alice/app', 'proposal', '')).rejects.toThrow();
    expect(s.gh.post).not.toHaveBeenCalled();
  });
  it('rejects users removed from the allowlist', async () => {
    const s = setup();
    await expect(s.service.createPr({ ...user, isAllowed: false }, 'alice/app', 'proposal', PATCH_POLICY)).rejects.toThrow();
    expect(s.gh.post).not.toHaveBeenCalled();
  });
  it('does not publish a stale source proposal', async () => {
    const s = setup();
    s.gh.get.mockImplementation(async url => ({ data: url === '/pulls' ? [] : { sha: 'changed' } } as any));
    await expect(s.service.createPr(user, 'alice/app', 'proposal', PATCH_POLICY)).rejects.toThrow('기준 브랜치');
    expect(s.gh.post).not.toHaveBeenCalled();
    expect(s.getPlan().state).toBe('blocked');
  });
  it('creates only a lockfile branch and draft PR, never writes to the base or merges', async () => {
    const s = setup();
    await s.service.createPr(user, 'alice/app', 'proposal', PATCH_POLICY);
    expect(s.github.getInstallationTokenForRepo).toHaveBeenCalledWith('alice', 'app', { contents: 'write', pull_requests: 'write' });
    expect(s.gh.post.mock.calls.map(c => c[0])).toEqual(['/git/blobs', '/git/trees', '/git/commits', '/git/refs', '/pulls']);
    expect(s.gh.post).toHaveBeenCalledWith('/git/trees', { base_tree: 'base-tree', tree: [{ path: 'package-lock.json', mode: '100644', type: 'blob', sha: 'new-sha' }] });
    expect(s.gh.post).toHaveBeenCalledWith('/git/refs', { ref: 'refs/heads/swkoo/security-proposal', sha: 'new-sha' });
    expect(s.gh.post).toHaveBeenCalledWith('/pulls', expect.objectContaining({ base: 'release', draft: true }));
  });
  it('returns the same PR on duplicate submission', async () => {
    const s = setup();
    await s.service.createPr(user, 'alice/app', 'proposal', PATCH_POLICY);
    const count = s.gh.post.mock.calls.length;
    await s.service.createPr(user, 'alice/app', 'proposal', PATCH_POLICY);
    expect(s.gh.post).toHaveBeenCalledTimes(count);
  });
  it('recovers a PR created before the DB write failed', async () => {
    const s = setup(); s.getPlan().state = 'creating';
    s.gh.get.mockResolvedValue({ data: [{ html_url: 'https://github.com/alice/app/pull/9' }] } as any);
    expect(await s.service.createPr(user, 'alice/app', 'proposal', PATCH_POLICY)).toMatchObject({ state: 'pr', prUrl: 'https://github.com/alice/app/pull/9' });
    expect(s.gh.post).not.toHaveBeenCalled();
  });
  it('rejects expired proposals and another proposal id', async () => {
    const s = setup();
    await expect(s.service.createPr(user, 'alice/app', 'other', PATCH_POLICY)).rejects.toThrow();
    s.getPlan().createdAt = 0;
    await expect(s.service.createPr(user, 'alice/app', 'proposal', PATCH_POLICY)).rejects.toThrow();
    expect(s.gh.post).not.toHaveBeenCalled();
  });
  it('a status read never publishes a PR or exposes source files', async () => {
    const s = setup(); const result = await s.service.status(user, 'alice/app');
    expect(result).not.toHaveProperty('manifest'); expect(result).not.toHaveProperty('lockfile');
    expect(s.gh.post).not.toHaveBeenCalled();
  });
});
