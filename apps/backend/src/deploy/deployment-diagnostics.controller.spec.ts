jest.mock('@kubernetes/client-node', () => ({}));
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { DeploymentDiagnosticsController } from './deployment-diagnostics.controller';
import { DeploymentDiagnosticsService } from './deployment-diagnostics.service';
import { AuthService, SESSION_COOKIE } from '../onboarding/auth.service';
import { UsersRepository } from '../onboarding/users.repository';

describe('diagnostics HTTP boundary', () => {
  let app: any;
  const service = { get: jest.fn().mockResolvedValue({ state:'Running',usage:null,logs:null }) };
  beforeAll(async () => {
    const module = await Test.createTestingModule({controllers:[DeploymentDiagnosticsController],providers:[
      {provide:DeploymentDiagnosticsService,useValue:service},
      {provide:AuthService,useValue:{verifySessionToken:(token:string)=>token==='valid'?{uid:1}:null}},
      {provide:UsersRepository,useValue:{findById:()=>({id:1,githubLogin:'alice',isAllowed:true})}},
    ]}).compile();
    app=module.createNestApplication(); app.use(cookieParser()); await app.init();
  });
  afterAll(async()=>app.close()); beforeEach(()=>{ jest.clearAllMocks(); service.get.mockResolvedValue({state:'Running',usage:null,logs:null}); });
  it('runs the real ownership check after authentication and before log/metric access', async()=>{
    const kube={available:jest.fn(),core:{listNamespacedPod:jest.fn()}};
    const real=new DeploymentDiagnosticsService({getCurrentDeployment:async()=>({repo:'app',appName:'app',state:'active'})} as any,kube as any,{} as any,{} as any,{} as any);
    service.get.mockImplementation(real.get.bind(real));
    await request(app.getHttpServer()).get('/deploy/diagnostics/bob/app?logs=1').set('Cookie',`${SESSION_COOKIE}=valid`).expect(403);
    await request(app.getHttpServer()).get('/deploy/diagnostics/alice/old?logs=1').set('Cookie',`${SESSION_COOKIE}=valid`).expect(409);
    expect(kube.available).not.toHaveBeenCalled(); expect(kube.core.listNamespacedPod).not.toHaveBeenCalled();
  });
  it('rejects missing authentication before diagnostics or logs are read', async()=>{
    await request(app.getHttpServer()).get('/deploy/diagnostics/alice/app?logs=1').expect(401);
    expect(service.get).not.toHaveBeenCalled();
  });
  it('disables caching and defaults to metrics only', async()=>{
    const response=await request(app.getHttpServer()).get('/deploy/diagnostics/alice/app').set('Cookie',`${SESSION_COOKIE}=valid`).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(service.get).toHaveBeenCalledWith(expect.objectContaining({githubLogin:'alice'}),'alice','app',false);
  });
  it('only enables logs for the explicit flag', async()=>{
    await request(app.getHttpServer()).get('/deploy/diagnostics/alice/app?logs=1').set('Cookie',`${SESSION_COOKIE}=valid`).expect(200);
    expect(service.get).toHaveBeenCalledWith(expect.anything(),'alice','app',true);
    await request(app.getHttpServer()).get('/deploy/diagnostics/alice/app?logs=all').set('Cookie',`${SESSION_COOKIE}=valid`).expect(400);
    expect(service.get).toHaveBeenCalledTimes(1);
  });
});
