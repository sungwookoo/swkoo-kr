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
        { provide: AuthService, useValue: { verifySessionToken: (token: string) => token === 'alice-session' ? { uid: 1 } : null } },
        { provide: UsersRepository, useValue: { findById: () => ({ id: 1, githubLogin: 'alice' }), audit: jest.fn() } },
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
});
