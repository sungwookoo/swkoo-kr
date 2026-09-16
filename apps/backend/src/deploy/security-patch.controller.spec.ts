jest.mock('@kubernetes/client-node', () => ({}));
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { SecurityPatchController } from './security-patch.controller';
import { SecurityPatchService } from './security-patch.service';
import { AuthService, SESSION_COOKIE } from '../onboarding/auth.service';
import { UsersRepository } from '../onboarding/users.repository';

describe('security patch HTTP consent', () => {
  let app: any;
  const service = { prepare: jest.fn(async () => ({})), createPr: jest.fn(async () => ({})), status: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [SecurityPatchController], providers: [
      { provide: SecurityPatchService, useValue: service },
      { provide: AuthService, useValue: { verifySessionToken: () => ({ uid: 1 }) } },
      { provide: UsersRepository, useValue: { findById: () => ({ id: 1, githubLogin: 'alice' }) } },
    ] }).compile();
    app = module.createNestApplication(); app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());
  it('serializes an absent proposal as JSON null instead of an empty HTTP body', async () => {
    service.status.mockResolvedValue(null);
    const response = await request(app.getHttpServer()).get('/deploy/security-patch?repo=alice/app')
      .set('Cookie', `${SESSION_COOKIE}=session`).expect(200);
    expect(response.text).toBe('null');
    expect(response.headers['content-type']).toMatch(/application\/json/);
  });
  it('rejects anonymous preparation, publication and state access', async () => {
    await request(app.getHttpServer()).post('/deploy/security-patch/prepare').send({}).expect(401);
    await request(app.getHttpServer()).post('/deploy/security-patch/pr').send({}).expect(401);
    await request(app.getHttpServer()).get('/deploy/security-patch?repo=alice/app').expect(401);
    expect(service.prepare).not.toHaveBeenCalled(); expect(service.createPr).not.toHaveBeenCalled();
  });
  it('rejects missing consent and caller-provided patch content', async () => {
    await request(app.getHttpServer()).post('/deploy/security-patch/prepare').set('Cookie', `${SESSION_COOKIE}=session`)
      .send({ repo: 'alice/app' }).expect(400);
    await request(app.getHttpServer()).post('/deploy/security-patch/pr').set('Cookie', `${SESSION_COOKIE}=session`)
      .send({ repo: 'alice/app', consent: 'npm-lockfile-v1', id: '76ec4d36-20ce-4473-bf6a-ec69353f4b6a', lockfile: 'arbitrary' }).expect(400);
    expect(service.prepare).not.toHaveBeenCalled(); expect(service.createPr).not.toHaveBeenCalled();
  });
});
