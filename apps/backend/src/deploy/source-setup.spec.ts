jest.mock('axios');
import axios from 'axios';
import { SourceSetup, SOURCE_SETUP_CONSENT } from './source-setup';
import { GithubAppService } from '../github-app/github-app.service';

const desired = { Dockerfile: 'FROM node\n', '.github/workflows/build.yml': 'name: build\n' };
function setup(existing: Record<string, string> = {}) {
  const gh = { get: jest.fn(async (url: string) => {
    if (url === '') return { data: { default_branch: 'main' } };
    if (url.startsWith('/git/ref/')) return { data: { object: { sha: 'base-sha' } } };
    if (url.startsWith('/git/commits/')) return { data: { tree: { sha: 'base-tree' }, parents: [{ sha: 'base-sha' }] } };
    if (url.startsWith('/git/trees/')) return { data: { tree: Object.keys(existing).map(path => ({ path, type: 'blob', mode: '100644', sha: path, size: 20 })) } };
    if (url.startsWith('/git/blobs/')) return { data: { content: Buffer.from(existing[url.slice('/git/blobs/'.length)]).toString('base64'), encoding: 'base64', size: 20 } };
    if (url === '/pulls') return { data: [] };
    throw new Error(`unexpected ${url}`);
  }), post: jest.fn(async (url: string) => ({ data: url === '/pulls' ? { html_url: 'https://github.com/alice/app/pull/1' } : { sha: 'new-sha' } })) };
  (axios.create as jest.Mock).mockReturnValue(gh);
  const github = { getInstallationTokenForRepo: jest.fn(async () => 'test-token'), commitFilesAtomic: jest.fn(async () => 'created-sha') };
  return { service: new SourceSetup(github as any), github, gh };
}

describe('reviewed source setup', () => {
  it('shows create, keep and review without writing on inspection', async () => {
    const s = setup({ Dockerfile: 'custom file' });
    const plan = await s.service.inspect('alice/app', desired);
    expect(plan.files.map(f => f.action)).toEqual(['review', 'create']);
    expect(plan.files[0].before).toBe('custom file');
    expect(plan.files[0].after).toBe(desired.Dockerfile);
    expect(s.gh.post).not.toHaveBeenCalled(); expect(s.github.commitFilesAtomic).not.toHaveBeenCalled();
  });
  it('keeps matching files including CRLF and creates only absent files', async () => {
    const s = setup({ Dockerfile: 'FROM node\r\n' }); const plan = await s.service.inspect('alice/app', desired);
    s.service.assertReviewed(plan, plan.digest, SOURCE_SETUP_CONSENT);
    await s.service.createMissing(plan);
    expect(s.github.commitFilesAtomic).toHaveBeenCalledWith(expect.objectContaining({ expectedHeadSha: 'base-sha', files: { '.github/workflows/build.yml': desired['.github/workflows/build.yml'] } }));
  });
  it('does not commit if both files already match', async () => {
    const s = setup(desired); const plan = await s.service.inspect('alice/app', desired);
    expect(await s.service.createMissing(plan)).toBe('base-sha');
    expect(s.github.commitFilesAtomic).not.toHaveBeenCalled();
  });
  it('rejects missing consent and stale reviewed content', async () => {
    const s = setup(); const plan = await s.service.inspect('alice/app', desired);
    expect(() => s.service.assertReviewed(plan, plan.digest, '')).toThrow('동의');
    expect(() => s.service.assertReviewed(plan, 'old-digest', SOURCE_SETUP_CONSENT)).toThrow('다시 확인');
    const changed = await s.service.inspect('alice/app', { ...desired, Dockerfile: 'updated template' });
    expect(changed.digest).not.toBe(plan.digest);
  });
  it('never directly overwrites existing files', async () => {
    const s = setup({ Dockerfile: 'custom' }); const plan = await s.service.inspect('alice/app', desired);
    await expect(s.service.createMissing(plan)).rejects.toThrow('PR 검토');
    expect(s.github.commitFilesAtomic).not.toHaveBeenCalled();
  });
  it('creates a draft on a separate branch, never updates a ref or merges', async () => {
    const s = setup({ Dockerfile: 'custom' }); const plan = await s.service.inspect('alice/app', desired);
    expect(await s.service.createPr(plan)).toEqual({ prUrl: 'https://github.com/alice/app/pull/1' });
    expect(s.gh.post.mock.calls.map(c => c[0])).toEqual(['/git/blobs', '/git/blobs', '/git/trees', '/git/commits', '/git/refs', '/pulls']);
    expect(s.gh.post).toHaveBeenCalledWith('/git/refs', expect.objectContaining({ ref: `refs/heads/swkoo/setup-${plan.digest.slice(0, 24)}` }));
    expect(s.gh.post).toHaveBeenCalledWith('/pulls', expect.objectContaining({ draft: true, base: 'main' }));
    expect(s.github.commitFilesAtomic).not.toHaveBeenCalled();
  });
  it('reuses an existing open PR on retry without writing', async () => {
    const s = setup({ Dockerfile: 'custom' }); const plan = await s.service.inspect('alice/app', desired);
    s.gh.get.mockResolvedValue({ data: [{ state: 'open', html_url: 'https://github.com/alice/app/pull/2' }] } as any);
    expect(await s.service.createPr(plan)).toEqual({ prUrl: 'https://github.com/alice/app/pull/2' });
    expect(s.gh.post).not.toHaveBeenCalled();
  });
  it('blocks a changed base before creating proposal objects', async () => {
    const s = setup({ Dockerfile: 'custom' }); const plan = await s.service.inspect('alice/app', desired);
    s.gh.get.mockImplementation(async url => ({ data: url === '/pulls' ? [] : { object: { sha: 'changed' } } } as any));
    await expect(s.service.createPr(plan)).rejects.toThrow('기준 브랜치'); expect(s.gh.post).not.toHaveBeenCalled();
  });
  it('does not overwrite a proposal branch edited after an interrupted attempt', async () => {
    const s = setup({ Dockerfile: 'custom' }); const plan = await s.service.inspect('alice/app', desired);
    (axios.isAxiosError as unknown as jest.Mock).mockReturnValue(true);
    s.gh.post.mockImplementation(async url => {
      if (url === '/git/refs') throw { response: { status: 422 } };
      return { data: { sha: 'new-sha' } } as any;
    });
    await expect(s.service.createPr(plan)).rejects.toThrow('제안 브랜치가 수정');
    expect(s.gh.post.mock.calls.some(([url]) => url === '/pulls')).toBe(false);
    (axios.isAxiosError as unknown as jest.Mock).mockReset();
  });
  it('does not treat unreadable files or a truncated tree as absent', async () => {
    const s = setup(); s.gh.get.mockImplementation(async url => ({ data: url === '' ? { default_branch: 'main' } :
      url.includes('/ref/') ? { object: { sha: 'base' } } : url.includes('/commits/') ? { tree: { sha: 'tree' } } : { tree: [], truncated: true } } as any));
    await expect(s.service.inspect('alice/app', desired)).rejects.toThrow('완전히 확인'); expect(s.gh.post).not.toHaveBeenCalled();
  });
});

describe('atomic source commit head guard', () => {
  it('stops before creating Git objects when the reviewed head changed', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { object: { sha: 'new-head' } } });
    (axios.post as jest.Mock).mockClear();
    const github = new GithubAppService({} as any);
    await expect(github.commitFilesAtomic({ owner: 'alice', repo: 'app', branch: 'main', expectedHeadSha: 'reviewed-head', files: desired, message: 'setup', token: 'test' })).rejects.toThrow('SOURCE_CHANGED');
    expect(axios.post).not.toHaveBeenCalled();
  });
});
