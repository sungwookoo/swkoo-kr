jest.mock('@kubernetes/client-node', () => ({}));
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { DeploymentRecoveryController } from './deployment-recovery.controller';
import { DeploymentRecoveryService } from './deployment-recovery.service';
import { AuthService, SESSION_COOKIE } from '../onboarding/auth.service';
import { UsersRepository } from '../onboarding/users.repository';
import { onboardingConfig } from '../config/onboarding.config';

describe('administrator-only recovery HTTP boundary', () => {
  let app: any;
  const service = { inspect: jest.fn(async () => ({ canRelease: false })), release: jest.fn(async () => ({ ok: true })) };
  const users = { listAdmissionReservations: jest.fn(() => []), audit: jest.fn(), findById: (id: number) => ({ id, githubLogin: id === 2 ? 'admin' : 'alice' }) };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [DeploymentRecoveryController], providers: [
      { provide: DeploymentRecoveryService, useValue: service }, { provide: UsersRepository, useValue: users },
      { provide: onboardingConfig.KEY, useValue: { adminLogins: ['admin'] } },
      { provide: AuthService, useValue: { verifySessionToken: (token: string) => token === 'admin' ? { uid: 2 } : token === 'normal' ? { uid: 1 } : null } },
    ] }).compile();
    app = module.createNestApplication(); app.use(cookieParser()); await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());
  it('refuses unauthenticated and normal users before reading or changing recovery data', async () => {
    for (const path of ['/admin/deployment-recovery', '/admin/deployment-recovery/alice']) {
      await request(app.getHttpServer()).get(path).expect(401);
      await request(app.getHttpServer()).get(path).set('Cookie', `${SESSION_COOKIE}=normal`).expect(403);
    }
    await request(app.getHttpServer()).post('/admin/deployment-recovery/alice/release').set('Cookie', `${SESSION_COOKIE}=normal`).send({ digest: 'x' }).expect(403);
    expect(service.inspect).not.toHaveBeenCalled(); expect(service.release).not.toHaveBeenCalled(); expect(users.listAdmissionReservations).not.toHaveBeenCalled();
  });
  it('uses the authenticated administrator as audit actor and prevents caching', async () => {
    const response = await request(app.getHttpServer()).get('/admin/deployment-recovery/alice').set('Cookie', `${SESSION_COOKIE}=admin`).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    await request(app.getHttpServer()).post('/admin/deployment-recovery/alice/release').set('Cookie', `${SESSION_COOKIE}=admin`).send({ digest: 'reviewed', actor: 'forged' }).expect(201);
    expect(service.release).toHaveBeenCalledWith('alice', 'reviewed', 'admin');
  });
});
