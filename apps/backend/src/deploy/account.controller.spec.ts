jest.mock('@kubernetes/client-node', () => ({}));
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AccountController } from './account.controller';
import { DeployService } from './deploy.service';
import { EnvService } from './env.service';
import { KubeClient } from '../kube/kube.client';
import { AuthService, SESSION_COOKIE } from '../onboarding/auth.service';
import { UsersRepository } from '../onboarding/users.repository';

describe('account scan HTTP response', () => {
  let app: any;
  const latest = jest.fn();
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [AccountController], providers: [
      { provide: DeployService, useValue: { getCurrentDeployment: async () => null } },
      { provide: EnvService, useValue: {} },
      { provide: KubeClient, useValue: { available: () => false } },
      { provide: AuthService, useValue: { verifySessionToken: (token: string) => token === 'alice' ? { uid: 1 } : token === 'bob' ? { uid: 2 } : null } },
      { provide: UsersRepository, useValue: { findById: (id: number) => ({ id, githubLogin: id === 1 ? 'alice' : 'bob' }), latestScanResultForUser: latest,
        listAuditByActor:()=>[],listDeployNotifications:()=>[],exportSecurityPatch:()=>[],
        listAdmissionReservations:()=>[{login:'alice',createdAt:123},{login:'bob',createdAt:456}] } },
    ] }).compile();
    app = module.createNestApplication(); app.use(cookieParser()); await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => latest.mockReset());
  it('exports the new reservation metadata only for the authenticated account', async()=>{
    for(const login of ['alice','bob']) {
      const result=await request(app.getHttpServer()).get('/account/export?userId=999').set('Cookie',`${SESSION_COOKIE}=${login}`).expect(200);
      expect(result.body.admissionReservation).toEqual({login,createdAt:login==='alice'?123:456});
      expect(result.body.user.githubLogin).toBe(login);
    }
  });
  it('returns JSON null before the first scan', async () => {
    latest.mockReturnValue(null);
    const response = await request(app.getHttpServer()).get('/account/scan').set('Cookie', `${SESSION_COOKIE}=alice`).expect(200);
    expect(response.text).toBe('null');
    expect(response.headers['content-type']).toMatch(/application\/json/);
  });
  it('uses the authenticated user and marks an unverifiable old scan as stale', async () => {
    latest.mockImplementation((id: number) => ({ userId: id, scannedAt: '2020-01-01', image: `image-${id}`, findingsJson: null }));
    for (const [token, id] of [['alice', 1], ['bob', 2]] as const) {
      const response = await request(app.getHttpServer()).get('/account/scan?userId=999').set('Cookie', `${SESSION_COOKIE}=${token}`).expect(200);
      expect(response.body).toMatchObject({ userId: id, image: `image-${id}`, matchesCurrentImage: null, stale: true });
    }
  });
  it('does not read scan data for anonymous requests', async () => {
    await request(app.getHttpServer()).get('/account/scan').expect(401);
    expect(latest).not.toHaveBeenCalled();
  });
});
