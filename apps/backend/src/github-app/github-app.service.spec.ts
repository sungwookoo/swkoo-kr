jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() } }));
import axios from 'axios';
import { GithubAppService } from './github-app.service';

describe('installation token least privilege', () => {
  let service: GithubAppService;
  beforeEach(() => {
    jest.resetAllMocks();
    service = new GithubAppService({ deployOwner: 'platform-deploy' } as any);
    jest.spyOn(service as any, 'generateAppJwt').mockReturnValue('app-jwt');
    (axios.get as jest.Mock).mockResolvedValue({ data: { id: 7 } });
    (axios.post as jest.Mock).mockResolvedValue({ data: { token: 'scoped-token' } });
  });
  it.each([{ contents: 'read' }, { contents: 'write' }, { metadata: 'read' }, { administration: 'write' }])(
    'always binds repository permissions %j to exactly one repository', async permissions => {
      expect(await service.getInstallationTokenForRepo('alice', 'app', permissions as any)).toBe('scoped-token');
      expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/7/access_tokens'),
        { repositories: ['app'], permissions }, expect.anything());
    });
  it.each([undefined, null, {}, [], { contents: 'admin' }])('rejects missing or invalid scope %j before requesting a token', async permissions => {
    await expect(service.getInstallationTokenForRepo('alice', 'app', permissions as any)).rejects.toThrow('Explicit');
    expect(axios.get).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled();
  });
  it.each([
    ['create-repository', { administration: 'write' }], ['list-repositories', { metadata: 'read' }],
  ] as const)('narrows the platform organization exception for %s', async (purpose, permissions) => {
    await service.getInstallationTokenForOrg('platform-deploy', purpose);
    expect(axios.post).toHaveBeenCalledWith(expect.anything(), { permissions }, expect.anything());
  });
  it('rejects another organization and implicit organization scope', async () => {
    await expect(service.getInstallationTokenForOrg('other', 'create-repository')).rejects.toThrow('restricted');
    await expect(service.getInstallationTokenForOrg('platform-deploy', undefined as any)).rejects.toThrow('purpose');
    expect(axios.get).not.toHaveBeenCalled();
  });
});

describe('atomic commit ref update failures', () => {
  const service = new GithubAppService({} as any);
  const args = { owner: 'operator', repo: 'control', branch: 'deployment-data', files: { 'deploy/users/alice.yaml': 'login: alice' }, message: 'register', token: 'installation-secret' };
  beforeEach(() => {
    jest.resetAllMocks();
    (axios.get as jest.Mock).mockResolvedValueOnce({ data: { object: { sha: 'head' } } })
      .mockResolvedValueOnce({ data: { tree: { sha: 'old-tree' } } });
    (axios.post as jest.Mock).mockResolvedValueOnce({ data: { sha: 'blob' } })
      .mockResolvedValueOnce({ data: { sha: 'new-tree' } })
      .mockResolvedValueOnce({ data: { sha: 'new-commit' } });
  });
  it.each([
    [403, 'Repository rule violations found', 503, 'REGISTRATION_BRANCH_PROTECTED'],
    [409, 'Conflict', 409, undefined],
    [422, 'Update is not a fast forward', 409, undefined],
    [502, 'Bad gateway', 503, undefined],
  ])('returns a safe HTTP error for GitHub %s', async (status, message, expected, reason) => {
    (axios.patch as jest.Mock).mockRejectedValue({ response: { status, data: { message } }, config: { headers: { Authorization: args.token } } });
    const error = await service.commitFilesAtomic(args).catch(err => err);
    expect(error.getStatus()).toBe(expected);
    if (reason) expect(error.getResponse().reason).toBe(reason);
    expect(JSON.stringify(error)).not.toContain(args.token);
    expect(error.cause).toBeUndefined();
  });
  it('updates the configured data branch without a force push', async () => {
    (axios.patch as jest.Mock).mockResolvedValue({});
    expect(await service.commitFilesAtomic(args)).toBe('new-commit');
    expect(axios.patch).toHaveBeenCalledWith(expect.stringContaining('/heads/deployment-data'),
      { sha: 'new-commit', force: false }, expect.anything());
  });
});
