jest.mock('@kubernetes/client-node', () => ({}));
import { DeployService } from './deploy.service';
import { SourceSetup, SourceSetupPlan, SOURCE_SETUP_CONSENT } from './source-setup';

describe('source review before deployment side effects', () => {
  const plan: SourceSetupPlan = { repo: 'alice/app', branch: 'main', sha: 'source-sha', digest: 'digest',
    files: [{ path: 'Dockerfile', action: 'keep', before: 'same', after: 'same' }] };
  const req = { fullName: 'alice/app', setupDigest: 'digest', setupConsent: SOURCE_SETUP_CONSENT };
  function setup() {
    const github = { getInstallationTokenForOrg: jest.fn(async () => 'token'), getInstallationTokenForRepo: jest.fn(async () => 'token'),
      ensureRepoInOrg: jest.fn(async () => undefined), commitFilesAtomic: jest.fn(async () => 'manifest-sha') };
    const users = { findByLogin: jest.fn(() => ({ id: 1, githubLogin: 'alice', isAllowed: true })), audit: jest.fn() };
    const service = new DeployService({} as any, github as any, users as any, {} as any, {} as any,
      { findForRender: () => null } as any, { appsDomain: 'apps.swkoo.kr', deployOwner: 'swkoo-deploy', manifestRepo: 'operator/control', manifestBranch: 'main' } as any, {} as any);
    jest.spyOn(service, 'detectStack').mockResolvedValue({ stack: 'nextjs', packageName: 'app', port: 3000, nodeEngine: null, checks: [] });
    const claim = jest.spyOn(service as any, 'claimSubdomainOrDefault').mockReturnValue('alice-app');
    jest.spyOn(service as any, 'readExistingStorageProfile').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'refreshUsersApplicationSet').mockResolvedValue(undefined);
    const inspect = jest.spyOn(SourceSetup.prototype, 'inspect').mockResolvedValue(plan);
    const create = jest.spyOn(SourceSetup.prototype, 'createMissing').mockResolvedValue('source-sha');
    const pr = jest.spyOn(SourceSetup.prototype, 'createPr').mockResolvedValue({ prUrl: 'https://github.com/alice/app/pull/1' });
    return { service, github, users, claim, inspect, create, pr };
  }
  afterEach(() => jest.restoreAllMocks());
  it('rejects missing consent before claiming a URL, committing files or registering manifests', async () => {
    const s = setup();
    await expect(s.service.registerForUser('alice', { fullName: 'alice/app' })).rejects.toThrow('동의');
    expect(s.claim).not.toHaveBeenCalled(); expect(s.create).not.toHaveBeenCalled(); expect(s.github.commitFilesAtomic).not.toHaveBeenCalled();
  });
  it('rejects differing existing files even with valid consent', async () => {
    const s = setup(); s.inspect.mockResolvedValue({ ...plan, files: [{ ...plan.files[0], action: 'review' }] });
    await expect(s.service.registerForUser('alice', req)).rejects.toThrow('PR 검토');
    expect(s.claim).not.toHaveBeenCalled(); expect(s.create).not.toHaveBeenCalled();
  });
  it('PR request performs no URL claim, manifest registration or deployment', async () => {
    const s = setup();
    expect(await s.service.requestSourceSetupPr('alice', req)).toHaveProperty('prUrl');
    expect(s.pr).toHaveBeenCalled(); expect(s.claim).not.toHaveBeenCalled(); expect(s.create).not.toHaveBeenCalled();
    expect(s.github.getInstallationTokenForOrg).not.toHaveBeenCalled(); expect(s.github.commitFilesAtomic).not.toHaveBeenCalled();
  });
  it('rejects other owners and disallowed users before source reads', async () => {
    const s = setup();
    await expect(s.service.previewSourceSetup('alice', 'bob/app')).rejects.toThrow('본인');
    s.users.findByLogin.mockReturnValue({ id: 1, githubLogin: 'alice', isAllowed: false });
    await expect(s.service.requestSourceSetupPr('alice', req)).rejects.toThrow('본인');
    expect(s.inspect).not.toHaveBeenCalled(); expect(s.pr).not.toHaveBeenCalled();
  });
  it('reports the source commit after downstream registration failure and does not roll it back', async () => {
    const s = setup(); s.github.getInstallationTokenForOrg.mockRejectedValue(new Error('unavailable'));
    const err = await s.service.registerForUser('alice', req).catch(error => error);
    expect(err.getResponse()).toMatchObject({ reason: 'DEPLOY_PARTIAL', completed: ['소스 파일 생성 또는 기존 파일 유지 확인'], sourceUrl: 'https://github.com/alice/app/commit/source-sha' });
    expect(s.create).toHaveBeenCalledTimes(1); expect(s.github.commitFilesAtomic).not.toHaveBeenCalled();
  });
  it('registers after reviewed matching files and returns the source revision', async () => {
    const s = setup();
    expect(await s.service.registerForUser('alice', req)).toMatchObject({ ok: true, userRepoCommit: 'source-sha' });
    expect(s.github.commitFilesAtomic).toHaveBeenCalledTimes(2);
    expect(s.github.commitFilesAtomic.mock.calls.every(([args]: any[]) => args.owner !== 'alice')).toBe(true);
  });
});
