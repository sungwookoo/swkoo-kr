jest.mock('@kubernetes/client-node', () => ({}));
import { INestApplication, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { onboardingConfig } from '../config/onboarding.config';
import { AuthService, SESSION_COOKIE } from '../onboarding/auth.service';
import { UsersRepository } from '../onboarding/users.repository';
import { DeployService } from './deploy.service';
import { DeploymentLifecycleController } from './deployment-lifecycle.controller';

describe('admin application lifecycle', () => {
  const key = 'app--test';
  const path = `deploy/users/${key}.yaml`;
  const endpoint = `/admin/users/alice/deployments/${key}/lifecycle`;
  const cookie = `${SESSION_COOKIE}=admin`;
  const registration = `login: ${key}\nappName: ${key}\nsourceRepo: alice/app\nimage:\n  repo: ghcr.io/alice/app\nstorage:\n  size: 1Gi\n`;
  let app: INestApplication;
  let content: string | null;
  let replicas: number;
  let podCount: number;
  const github = {
    getInstallationTokenForRepo: jest.fn(async () => 'installation-token'),
    commitFilesAtomic: jest.fn(async (args: { files: Record<string, string>; deletePaths?: string[] }) => {
      content = args.deletePaths?.includes(path) ? null : args.files[path];
      return 'commit-id';
    }),
    archiveRepo: jest.fn(),
  };
  const users = {
    findById: (id: number) => ({ id, githubLogin: id === 1 ? 'admin' : 'alice' }),
    findByLogin: (login: string) => login === 'alice' ? { id: 2, githubLogin: 'alice', isAllowed: false } : undefined,
    listAdditionalDeployments: () => [{ key, sourceRepo: 'alice/app' }],
    audit: jest.fn(),
    releaseAdmissionReservation: jest.fn(),
  };
  const argo = { isConfigured: () => true, getApplication: async () => null };
  const kube = {
    available: () => false,
    apps: { readNamespacedDeployment: jest.fn(async () => ({ spec: { replicas } })) },
    core: { listNamespacedPod: jest.fn(async () => ({ items: Array(podCount).fill({}) })) },
  };
  const domains = { findByLogin: () => [] };
  const config = { manifestRepo: 'platform/control', manifestBranch: 'deployment-data', privateManifestRepo: 'platform/private-control',
    adminLogins: ['admin'], deployOwner: 'platform-deploy', appsDomain: 'apps.swkoo.kr' };
  const admission = { reserve: jest.fn(async () => undefined) };

  beforeAll(async () => {
    const auth = { verifySessionToken: (token: string) => token === 'admin' ? { uid: 1 } : token === 'alice' ? { uid: 2 } : null };
    const service = new DeployService(auth as any, github as any, users as any, argo as any,
      kube as any, domains as any, config as any, {} as any, admission as any);
    jest.spyOn(service as any, 'readManifestFile').mockImplementation((_owner, repo, file) =>
      Promise.resolve(repo === 'private-control' && file === path ? content : null));
    const module = await Test.createTestingModule({ controllers: [DeploymentLifecycleController], providers: [
      { provide: DeployService, useValue: service }, { provide: UsersRepository, useValue: users },
      { provide: onboardingConfig.KEY, useValue: config }, { provide: AuthService, useValue: auth },
    ] }).compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    await app.init();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    content = registration;
    replicas = 1;
    podCount = 1;
  });
  afterAll(async () => app.close());

  it('requires the administrator for reads and mutations', async () => {
    const list = '/admin/users/alice/deployments';
    await request(app.getHttpServer()).get(list).expect(401);
    await request(app.getHttpServer()).get(list).set('Cookie', `${SESSION_COOKIE}=alice`).expect(403);
    await request(app.getHttpServer()).post(endpoint).set('Cookie', `${SESSION_COOKIE}=alice`).send({ action: 'pause' }).expect(403);
    expect(github.commitFilesAtomic).not.toHaveBeenCalled();
  });

  it('pauses the selected app without changing its address or storage and waits for pod termination before resume', async () => {
    await request(app.getHttpServer()).post(endpoint).set('Cookie', cookie).send({ action: 'pause', actor: 'forged' }).expect(201);
    expect(github.commitFilesAtomic).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'platform', repo: 'private-control', branch: 'main', files: { [path]: registration + 'suspended: true\n' },
    }));
    expect(users.audit).toHaveBeenCalledWith(expect.objectContaining({ actor: 'admin', action: 'ADMIN_DEPLOY_PAUSE' }));
    expect(users.releaseAdmissionReservation).toHaveBeenCalledWith(key);
    expect(github.archiveRepo).not.toHaveBeenCalled();

    const paused = await request(app.getHttpServer()).get('/admin/users/alice/deployments').set('Cookie', cookie).expect(200);
    expect(paused.headers['cache-control']).toBe('private, no-store');
    expect(paused.body).toEqual([expect.objectContaining({ key, state: 'paused', stopped: false,
      liveUrl: 'https://app--test.apps.swkoo.kr' })]);
    replicas = 0;
    await request(app.getHttpServer()).post(endpoint).set('Cookie', cookie).send({ action: 'resume' }).expect(409);
    expect(admission.reserve).not.toHaveBeenCalled();

    podCount = 0;
    admission.reserve.mockRejectedValueOnce(new ServiceUnavailableException('capacity'));
    await request(app.getHttpServer()).post(endpoint).set('Cookie', cookie).send({ action: 'resume' }).expect(503);
    expect(github.commitFilesAtomic).toHaveBeenCalledTimes(1);
    await request(app.getHttpServer()).post(endpoint).set('Cookie', cookie).send({ action: 'resume' }).expect(201);
    expect(admission.reserve).toHaveBeenCalledWith(key, 'resume');
    expect(github.commitFilesAtomic).toHaveBeenLastCalledWith(expect.objectContaining({ files: { [path]: registration } }));
  });

  it('scopes deletion to the target account and requires an exact confirmation', async () => {
    content += 'suspended: true\n';
    await request(app.getHttpServer()).post(endpoint.replace('/alice/', '/other/')).set('Cookie', cookie)
      .send({ action: 'delete', confirmation: 'alice/app' }).expect(404);
    await request(app.getHttpServer()).post(endpoint).set('Cookie', cookie).send({ action: 'delete', confirmation: 'alice/other' }).expect(400);
    expect(github.commitFilesAtomic).not.toHaveBeenCalled();
    await request(app.getHttpServer()).post(endpoint).set('Cookie', cookie).send({ action: 'delete', confirmation: 'alice/app' }).expect(201);
    expect(github.commitFilesAtomic).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'platform', repo: 'private-control', branch: 'main', files: {}, deletePaths: [path],
    }));
    expect(github.archiveRepo).toHaveBeenCalledWith(expect.objectContaining({ owner: 'platform-deploy', repo: key }));
    expect(github.getInstallationTokenForRepo.mock.calls).toEqual([
      ['platform', 'private-control', { contents: 'write' }],
      ['platform-deploy', key, { administration: 'write' }],
    ]);
  });
});
