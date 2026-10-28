jest.mock('@kubernetes/client-node', () => ({}));
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { DeployController } from './deploy.controller';
import { DeployService } from './deploy.service';
import { EnvService } from './env.service';
import { AuthService, SESSION_COOKIE } from '../onboarding/auth.service';
import { UsersRepository } from '../onboarding/users.repository';

describe('Deployment HTTP authorization boundary', () => {
  let app: any;
  const service = { getDeploymentStatus: jest.fn() };
  const env = { getEnv: jest.fn(), setEnv: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [DeployController],
      providers: [
        { provide: DeployService, useValue: service },
        { provide: EnvService, useValue: env },
        { provide: AuthService, useValue: { verifySessionToken: (token: string) => ({ 'alice-session': { uid: 1 }, 'bob-session': { uid: 2 }, 'revoked-session': { uid: 3 } }[token] ?? null) } },
        { provide: UsersRepository, useValue: { findById: (id: number) => ({ id, githubLogin: id === 2 ? 'bob' : 'alice', isAllowed: id !== 3 }), audit: jest.fn() } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());
  it('rejects missing and invalid sessions', async () => {
    await request(app.getHttpServer()).get('/deploy/status/alice/app').expect(401);
    await request(app.getHttpServer()).get('/deploy/status/alice/app').set('Cookie', `${SESSION_COOKIE}=invalid`).expect(401);
    expect(service.getDeploymentStatus).not.toHaveBeenCalled();
    await request(app.getHttpServer()).get('/deploy/setup?repo=alice/app').expect(401);
    await request(app.getHttpServer()).post('/deploy/setup/pr').send({ fullName: 'alice/app' }).expect(401);
  });
  it.each(['/deploy/status/bob/app', '/deploy/env/bob/app'])('denies cross-user read: %s', async (path) => {
    await request(app.getHttpServer()).get(path).set('Cookie', `${SESSION_COOKIE}=alice-session`).expect(403);
    expect(service.getDeploymentStatus).not.toHaveBeenCalled();
    expect(env.getEnv).not.toHaveBeenCalled();
  });
  it('denies cross-user environment writes before Kubernetes access', async () => {
    await request(app.getHttpServer()).put('/deploy/env/bob/app').set('Cookie', `${SESSION_COOKIE}=alice-session`)
      .send({ vars: { TOKEN: 'test-value' } }).expect(403);
    expect(env.setEnv).not.toHaveBeenCalled();
  });
  it('passes the authenticated identity and structured status through HTTP', async () => {
    service.getDeploymentStatus.mockResolvedValue({ stages: { deploy: { status: 'failed', reason: 'POD_NOT_READY' } } });
    const result = await request(app.getHttpServer()).get('/deploy/status/alice/app')
      .set('Cookie', `${SESSION_COOKIE}=alice-session`).expect(200);
    expect(service.getDeploymentStatus).toHaveBeenCalledWith(1, 'alice', 'app');
    expect(result.body.stages.deploy.reason).toBe('POD_NOT_READY');
  });
  it.each([[], ['value'], null, 'value', 42])('rejects malformed vars without replacing existing secrets: %j', async (vars) => {
    await request(app.getHttpServer()).put('/deploy/env/alice/app').set('Cookie', `${SESSION_COOKIE}=alice-session`)
      .send({ vars }).expect(400);
    expect(env.setEnv).not.toHaveBeenCalled();
  });
  it('rejects an environment write after deployment permission is revoked', async () => {
    await request(app.getHttpServer()).put('/deploy/env/alice/app').set('Cookie', `${SESSION_COOKIE}=revoked-session`)
      .send({ vars: { TOKEN: 'test-value' } }).expect(403);
    expect(env.setEnv).not.toHaveBeenCalled();
  });
  it('keeps both users isolated while allowing each to read, replace and clear their own environment', async () => {
    const state = new Map<string, Record<string, string>>();
    env.setEnv.mockImplementation(async (login, app, vars) => { state.set(`${login}/${app}`, vars); });
    env.getEnv.mockImplementation(async (login, app) => state.get(`${login}/${app}`) ?? {});
    for (const login of ['alice', 'bob']) {
      const cookie = `${SESSION_COOKIE}=${login}-session`;
      await request(app.getHttpServer()).put(`/deploy/env/${login}/app`).set('Cookie', cookie)
        .send({ vars: { MARKER: login } }).expect(200);
      for (const other of ['alice', 'bob'].filter(value => value !== login)) {
        await request(app.getHttpServer()).get(`/deploy/env/${other}/app`).set('Cookie', cookie).expect(403);
        await request(app.getHttpServer()).put(`/deploy/env/${other}/app`).set('Cookie', cookie)
          .send({ vars: {} }).expect(403);
        await request(app.getHttpServer()).get(`/deploy/status/${other}/app`).set('Cookie', cookie).expect(403);
      }
    }
    for (const login of ['alice', 'bob']) {
      const cookie = `${SESSION_COOKIE}=${login}-session`;
      const response = await request(app.getHttpServer()).get(`/deploy/env/${login}/app`).set('Cookie', cookie).expect(200);
      expect(response.body).toEqual({ vars: { MARKER: login } });
      await request(app.getHttpServer()).put(`/deploy/env/${login}/app`).set('Cookie', cookie).send({ vars: {} }).expect(200);
    }
  });
});
