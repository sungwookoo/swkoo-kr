jest.mock('@kubernetes/client-node', () => ({}));
import axios from 'axios';
import { DeployService } from './deploy.service';
import { SourceSetup, SourceSetupPlan, SOURCE_SETUP_CONSENT } from './source-setup';

describe('source review before deployment side effects', () => {
  const plan: SourceSetupPlan = { repo: 'alice/app', branch: 'main', sha: 'source-sha', digest: 'digest',
    files: [{ path: 'Dockerfile', action: 'keep', before: 'same', after: 'same' }] };
  const req = { fullName: 'alice/app', setupDigest: 'digest', setupConsent: SOURCE_SETUP_CONSENT };
  function setup() {
    const github = { getInstallationTokenForOrg: jest.fn(async () => 'org-admin-token'), getInstallationTokenForRepo: jest.fn(async () => 'repo-contents-token'),
      ensureRepoInOrg: jest.fn(async () => undefined), commitFilesAtomic: jest.fn(async (_args: unknown) => 'manifest-sha'), archiveRepo: jest.fn() };
    const users = { findByLogin: jest.fn(() => ({ id: 1, githubLogin: 'alice', isAllowed: true })), audit: jest.fn(),
      findBySubdomain: jest.fn(), listAdditionalDeployments: jest.fn(() => [] as Array<{ key: string; sourceRepo: string }>),
      addAdditionalDeployment: jest.fn(), releaseAdmissionReservation: jest.fn() };
    const sourceMetadata = jest.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      const full_name = url.replace('https://api.github.com/repos/', '');
      const [login, name] = full_name.split('/');
      return { status: 200, data: { full_name, name, owner: { login, type: 'User' }, visibility: 'public', private: false } };
    });
    const service = new DeployService({ getValidAccessToken: async () => 'user-token' } as any, github as any, users as any, {} as any, {} as any,
      { findForRender: () => null, findByLogin: () => [] } as any, { appsDomain: 'apps.swkoo.kr', deployOwner: 'swkoo-deploy', manifestRepo: 'operator/control', manifestBranch: 'deployment-data', adminLogins: [] } as any, {} as any, { reserve: jest.fn(async () => undefined) } as any);
    jest.spyOn(service, 'detectStack').mockResolvedValue({ stack: 'nextjs', packageName: 'app', port: 3000, nodeEngine: null, checks: [] });
    jest.spyOn(service, 'getCurrentDeployment').mockResolvedValue(null);
    const claim = jest.spyOn(service as any, 'claimSubdomainOrDefault').mockReturnValue('alice-app');
    jest.spyOn(service as any, 'readExistingStorageProfile').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'refreshUsersApplicationSet').mockResolvedValue(undefined);
    const inspect = jest.spyOn(SourceSetup.prototype, 'inspect').mockResolvedValue(plan);
    const create = jest.spyOn(SourceSetup.prototype, 'createMissing').mockResolvedValue('source-sha');
    const pr = jest.spyOn(SourceSetup.prototype, 'createPr').mockResolvedValue({ prUrl: 'https://github.com/alice/app/pull/1' });
    return { service, github, users, claim, inspect, create, pr, sourceMetadata };
  }
  afterEach(() => jest.restoreAllMocks());
  it('filters the repository list on the server and requests public results by default', async () => {
    const s = setup();
    (s.service as any).config.privateManifestRepo = 'operator/private-control';
    const repos = [
      { name: 'public', full_name: 'alice/public', visibility: 'public', owner: { login: 'alice', type: 'User' } },
      { name: 'private', full_name: 'alice/private', private: true, visibility: 'private', owner: { login: 'alice', type: 'User' } },
      { name: 'peer', full_name: 'bob/peer', visibility: 'public', owner: { login: 'bob', type: 'User' } },
      { name: 'org', full_name: 'org/org', visibility: 'public', owner: { login: 'org', type: 'Organization' }, permissions: { admin: true } },
      { name: 'managed', full_name: 'SwKoo-Deploy/managed', visibility: 'private', private: true, owner: { login: 'SwKoo-Deploy', type: 'Organization' }, permissions: { admin: true } },
    ];
    s.sourceMetadata.mockResolvedValue({ data: repos });
    expect((await s.service.listRepos(1, 'alice')).map(repo => repo.name)).toEqual(['public', 'org']);
    expect(s.sourceMetadata).toHaveBeenLastCalledWith(expect.stringContaining('/user/repos'),
      expect.objectContaining({ params: expect.objectContaining({ visibility: 'public' }) }));
    expect((await s.service.listRepos(1, 'alice', true)).map(repo => repo.name)).toEqual(['public', 'private', 'org']);
    expect((await s.service.listRepos(1, 'alice', true, 'personal')).map(repo => repo.name)).toEqual(['public', 'private']);
    expect((await s.service.listRepos(1, 'alice', true, 'organization', 'ORG/ORG')).map(repo => repo.name)).toEqual(['org']);
    expect(await s.service.listRepos(1, 'alice', true, 'organization', 'managed')).toEqual([]);
  });
  it('denies the internal organization before reading or writing source repository data', async () => {
    const s = setup();
    (s.service as any).config.privateManifestRepo = 'operator/private-control';
    const fullName = 'SWKOO-deploy/managed';
    await expect(s.service.previewRepository(1, 'alice', fullName, true)).rejects.toThrow('플랫폼 내부');
    await expect(s.service.previewSourceSetup('alice', fullName, true)).rejects.toThrow('플랫폼 내부');
    await expect(s.service.registerForUser('alice', { ...req, fullName, includePrivate: true })).rejects.toThrow('플랫폼 내부');
    expect(s.sourceMetadata).not.toHaveBeenCalled();
    expect(s.inspect).not.toHaveBeenCalled();
    expect(s.create).not.toHaveBeenCalled();
  });
  it('recovery treats an empty or malformed registration as present and propagates Argo lookup failures', async () => {
    const s = setup(), argo = (s.service as any).argo;
    argo.isConfigured = () => true; argo.getApplication = jest.fn(async () => null);
    jest.spyOn(s.service as any, 'readManifestFile').mockResolvedValue('');
    await expect(s.service.getRecoveryRegistrationState('alice')).resolves.toEqual({ registration: true, application: false });
    expect(argo.getApplication).toHaveBeenCalledWith('swkoo-user-alice', 'default');
    argo.getApplication.mockRejectedValue(Error('access denied'));
    await expect(s.service.getRecoveryRegistrationState('alice')).rejects.toThrow('access denied');
    expect(s.github.commitFilesAtomic).not.toHaveBeenCalled();
  });
  it('checks capacity before changing source or claiming a URL', async () => {
    const s = setup(); (s.service as any).admission.reserve.mockRejectedValue(Error('capacity blocked'));
    await expect(s.service.registerForUser('alice', req)).rejects.toThrow('capacity blocked');
    expect(s.create).not.toHaveBeenCalled(); expect(s.claim).not.toHaveBeenCalled(); expect(s.github.commitFilesAtomic).not.toHaveBeenCalled();
  });
  it('allows existing app recovery without a new admission reservation', async () => {
    const s = setup(); jest.spyOn(s.service, 'getCurrentDeployment').mockResolvedValue({ state: 'active', repo: 'app', fullName: 'alice/app' } as any);
    expect(await s.service.registerForUser('alice', req)).toMatchObject({ ok: true });
    expect((s.service as any).admission.reserve).not.toHaveBeenCalled();
  });
  it('keeps a paused app in the account slot and prevents registering over its pause', async () => {
    const s = setup();
    jest.spyOn(s.service, 'getCurrentDeployment').mockResolvedValue({ state: 'paused', repo: 'app', fullName: 'alice/app' } as any);
    await expect(s.service.registerForUser('alice', req)).rejects.toThrow('일시 중지');
    await expect(s.service.registerForUser('alice', { ...req, fullName: 'alice/another-app' })).rejects.toThrow('계정당 앱은 최대');
    expect(s.create).not.toHaveBeenCalled();
    expect(s.github.commitFilesAtomic).not.toHaveBeenCalled();
  });
  it('registers independent stateful apps from one administrator and preserves the original registration', async () => {
    const s = setup();
    (s.service as any).config.adminLogins = ['ALICE'];
    const primary = { login: 'alice', repo: 'sprintflow', fullName: 'alice/sprintflow', state: 'active' } as any;
    jest.spyOn(s.service, 'getCurrentDeployment').mockResolvedValue(primary);
    const read = jest.spyOn(s.service as any, 'readDeployment').mockResolvedValue(null);
    jest.spyOn(s.service, 'detectStack').mockResolvedValue({
      stack: 'nextjs', packageName: 'app', port: 3000, nodeEngine: null, checks: [],
      storageProfile: { type: 'prisma-sqlite', size: '1Gi', mountPath: '/data', databaseUrl: 'file:/data/app.db', initMode: 'db-push' },
    });
    const first = await s.service.registerForUser('alice', req);
    const second = await s.service.registerForUser('alice', { ...req, fullName: 'alice/second' });
    expect(first.subdomain).not.toBe(second.subdomain);
    expect(first.liveUrl).toBe(`https://${first.subdomain}.apps.swkoo.kr`);
    for (const result of [first, second]) {
      const key = result.subdomain;
      expect((s.service as any).admission.reserve).toHaveBeenCalledWith(key);
      expect(s.github.commitFilesAtomic).toHaveBeenCalledWith(expect.objectContaining({
        repo: key, files: expect.objectContaining({ [`${key}/pvc.yaml`]: expect.stringContaining(`namespace: user-${key}`) }),
      }));
      expect(s.github.commitFilesAtomic).toHaveBeenCalledWith(expect.objectContaining({
        repo: 'control', files: { [`deploy/users/${key}.yaml`]: expect.stringContaining(`login: ${key}`) },
      }));
    }
    expect(read).toHaveBeenCalledTimes(2);
    expect(s.claim).not.toHaveBeenCalled();
  });
  it('removes only the selected app registration and deploy repository', async () => {
    const s = setup();
    const key = 'app--second-01234567890123456789';
    jest.spyOn(s.service, 'getCurrentDeployment').mockResolvedValue({ state: 'active', repo: 'second', deploymentKey: key } as any);
    await expect(s.service.deleteDeployment('alice', 'sprintflow')).rejects.toThrow('삭제할 앱');
    expect(s.github.commitFilesAtomic).not.toHaveBeenCalled();
    await s.service.deleteDeployment('alice', 'second');
    expect(s.github.commitFilesAtomic).toHaveBeenCalledWith(expect.objectContaining({
      repo: 'control', deletePaths: [`deploy/users/${key}.yaml`],
    }));
    expect(s.github.archiveRepo).toHaveBeenCalledWith(expect.objectContaining({ repo: key }));
    expect(s.users.releaseAdmissionReservation).toHaveBeenCalledWith(key);
  });
  it('preserves the immutable storage class of an existing legacy PVC', async () => {
    const s = setup();
    const legacy = { type:'prisma-sqlite',size:'1Gi',mountPath:'/data',databaseUrl:'file:/data/app.db',initMode:'db-push' };
    jest.spyOn(s.service as any,'readExistingStorageProfile').mockResolvedValue(legacy);
    jest.spyOn(s.service,'detectStack').mockResolvedValue({ stack:'nextjs',packageName:'app',port:3000,nodeEngine:null,checks:[],storageProfile:{...legacy,storageClassName:'swkoo-user-quota'} } as any);
    await s.service.registerForUser('alice',req);
    const commit = (s.github.commitFilesAtomic.mock.calls as any)[0][0];
    expect(commit.files['app/pvc.yaml']).toMatch(/storageClassName: local-path/);
    expect(commit.files['app/deployment.yaml']).toMatch(/localhostProfile: swkoo-user-storage-v1.json/);
  });
  it('allows a second app for a normal account, then blocks the next app before writes', async () => {
    const s = setup();
    s.users.findByLogin.mockReturnValue({ id: 1, githubLogin: 'alice', isAllowed: true,
      deployPolicy: { maxApps: 2, cpuMillicores: 750, memoryMiB: 768 },
    } as any);
    await s.service.registerForUser('alice', req);
    expect(s.github.commitFilesAtomic).toHaveBeenCalledWith(expect.objectContaining({
      repo: 'control', files: { 'deploy/users/alice.yaml': expect.stringContaining('sourceRepo: alice/app') },
    }));
    s.github.commitFilesAtomic.mockClear();
    const first = { login: 'alice', repo: 'app', fullName: 'alice/app', state: 'active' } as const;
    jest.spyOn(s.service, 'getCurrentDeployment').mockResolvedValue(first as any);
    jest.spyOn(s.service as any, 'readDeployment').mockResolvedValue(null);
    const second = await s.service.registerForUser('alice', { ...req, fullName: 'alice/second' });
    expect(second.subdomain).toMatch(/^app--second-/);
    const key = second.subdomain;
    const config = (s.github.commitFilesAtomic.mock.calls as any)[0][0].files;
    expect(config[`${key}/deployment.yaml`]).toMatch(/limits:\s+cpu: 750m\s+memory: 768Mi/);
    expect(config['limit-range.yaml']).toMatch(/max:\s+cpu: 750m\s+memory: 768Mi/);
    expect(config['resource-quota.yaml']).toMatch(/limits.cpu: "1500m"\s+limits.memory: "1536Mi"/);
    s.users.listAdditionalDeployments.mockReturnValue([{ key, sourceRepo: 'alice/second' }]);
    jest.spyOn(s.service, 'listDeployments').mockResolvedValue([first, { deploymentKey: key, fullName: 'alice/second' }] as any);
    s.github.commitFilesAtomic.mockClear();
    s.create.mockClear();
    await expect(s.service.registerForUser('alice', { ...req, fullName: 'alice/third' })).rejects.toThrow('최대 2개');
    expect(s.github.commitFilesAtomic).not.toHaveBeenCalled();
    expect(s.create).not.toHaveBeenCalled();
  });

  it('allows an existing app to redeploy over the new count limit and applies lower container caps', async () => {
    const s = setup();
    s.users.findByLogin.mockReturnValue({ id: 1, githubLogin: 'alice', isAllowed: true,
      deployPolicy: { maxApps: 0, cpuMillicores: 100, memoryMiB: 256 },
    } as any);
    jest.spyOn(s.service, 'getCurrentDeployment').mockResolvedValue({ state: 'active', repo: 'app',
      fullName: 'alice/app', resourceLimits: { cpuMillicores: 750, memoryMiB: 768 } } as any);
    await s.service.registerForUser('alice', req);
    const config = (s.github.commitFilesAtomic.mock.calls as any)[0][0].files;
    expect(config['app/deployment.yaml']).toMatch(/strategy:\s+type: Recreate/);
    expect(config['app/deployment.yaml']).toMatch(/limits:\s+cpu: 100m\s+memory: 256Mi/);
    expect((s.service as any).admission.reserve).not.toHaveBeenCalled();
  });
  it.each(['deleting', 'other-app'])('blocks %s before any source or manifest writes', async state => {
    const s = setup();
    jest.spyOn(s.service, 'getCurrentDeployment').mockResolvedValue({ repo: state === 'deleting' ? 'app' : 'other', fullName: state === 'deleting' ? 'alice/app' : 'alice/other', state: state === 'deleting' ? 'deleting' : 'active' } as any);
    await expect(s.service.registerForUser('alice', req)).rejects.toThrow(state === 'deleting' ? '삭제 중' : '1개');
    expect(s.claim).not.toHaveBeenCalled(); expect(s.create).not.toHaveBeenCalled(); expect(s.github.commitFilesAtomic).not.toHaveBeenCalled();
  });
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
  it('writes a private organization app only to private repositories after consent', async () => {
    const s = setup();
    const { config } = s.service as any;
    config.privateManifestRepo = 'operator/private-control';
    const repo = { full_name: 'team/app', name: 'app', id: 123, owner: { login: 'team', type: 'Organization' },
      permissions: { admin: true }, visibility: 'private', private: true };
    s.sourceMetadata.mockResolvedValueOnce({ status: 200, data: repo });
    await expect(s.service.registerForUser('alice', { ...req, fullName: repo.full_name })).rejects.toThrow('조직');
    expect(s.create).not.toHaveBeenCalled();
    s.sourceMetadata.mockResolvedValueOnce({ status: 200, data: repo })
      .mockResolvedValueOnce({ status: 200, data: { ...repo, full_name: 'operator/private-control' } });
    await s.service.registerForUser('alice', { ...req, fullName: repo.full_name, includePrivate: true });
    expect(s.github.commitFilesAtomic).toHaveBeenCalledWith(expect.objectContaining({
      repo: 'private-control', branch: 'main',
      files: { 'deploy/users/alice.yaml': expect.stringContaining('sourceRepo: team/app') },
    }));
    expect(s.github.commitFilesAtomic).not.toHaveBeenCalledWith(expect.objectContaining({ repo: 'control' }));
  });
  it('rejects a public repository configured as the private registration store', async () => {
    const s = setup();
    (s.service as any).config.privateManifestRepo = 'operator/control';
    s.sourceMetadata.mockResolvedValueOnce({ status: 200, data: {
      id: 55, full_name: 'alice/app', name: 'app', owner: { type: 'User', login: 'alice' },
      private: true, visibility: 'private',
    }});
    await expect(s.service.registerForUser('alice', { ...req, includePrivate: true })).rejects.toThrow('비공개 배포 설정');
    expect(s.create).not.toHaveBeenCalled();
    expect(s.github.commitFilesAtomic).not.toHaveBeenCalled();
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
    await expect(s.service.requestSourceSetupPr('alice', req)).rejects.toThrow('배포 권한');
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
    expect(s.github.commitFilesAtomic).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'operator', repo: 'control', branch: 'deployment-data', token: 'repo-contents-token',
    }));
    expect(s.github.getInstallationTokenForOrg).toHaveBeenCalledWith('swkoo-deploy', 'create-repository');
    expect(s.github.ensureRepoInOrg).toHaveBeenCalledWith(expect.objectContaining({ token: 'org-admin-token' }));
    expect(s.github.getInstallationTokenForRepo).toHaveBeenCalledWith('swkoo-deploy', 'alice', { contents: 'write' });
    expect(s.github.getInstallationTokenForRepo).toHaveBeenCalledWith('operator', 'control', { contents: 'write' });
    expect(s.github.commitFilesAtomic.mock.calls.every(([args]: any[]) => args.token !== 'org-admin-token')).toBe(true);
    expect(s.github.commitFilesAtomic.mock.calls.every(([args]: any[]) => args.owner !== 'alice')).toBe(true);
  });
});
