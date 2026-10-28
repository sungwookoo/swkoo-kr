jest.mock('@kubernetes/client-node', () => ({}));
import { DeploymentDiagnosticsService, redactAppLogs } from './deployment-diagnostics.service';

describe('app diagnostics isolation and bounded logs', () => {
  function setup() {
    const user = { id: 1, githubLogin: 'alice', isAllowed: true } as any;
    const deploy = { getCurrentDeployment: jest.fn(async () => ({ repo:'app',appName:'app',fullName:'alice/app',state:'active' })) };
    const pod = { metadata:{name:'app-new',namespace:'user-alice',labels:{app:'app'},creationTimestamp:new Date()},
      spec:{containers:[{name:'app',resources:{limits:{cpu:'500m',memory:'512Mi'}},env:[]}]},
      status:{phase:'Running',containerStatuses:[{name:'app',restartCount:0,ready:true,state:{running:{}}}],initContainerStatuses:[] as any[]} };
    const kube = { available:()=>true,core:{listNamespacedPod:jest.fn(async()=>({items:[pod]})),readNamespacedPodLog:jest.fn(async()=> 'TOKEN=private-value\nhello <script>alert(1)</script>')} };
    const env = { getEnv:jest.fn(async()=>({TOKEN:'private-value'})) };
    const metrics = { query:jest.fn(async()=>[]) }, users = { audit:jest.fn() };
    return {service:new DeploymentDiagnosticsService(deploy as any,kube as any,metrics as any,env as any,users as any),user,deploy,pod,kube,env,metrics,users};
  }
  it('rejects other users and revoked access before any cluster read', async () => {
    const s=setup();
    await expect(s.service.get(s.user,'bob','app',true)).rejects.toThrow('본인');
    await expect(s.service.get({...s.user,isAllowed:false},'alice','app',true)).rejects.toThrow('본인');
    expect(s.deploy.getCurrentDeployment).not.toHaveBeenCalled(); expect(s.kube.core.listNamespacedPod).not.toHaveBeenCalled();
  });
  it('binds the requested repository to the current active registration', async () => {
    const s=setup();
    await expect(s.service.get(s.user,'alice','old',true)).rejects.toThrow('현재');
    s.deploy.getCurrentDeployment.mockResolvedValue({...await s.deploy.getCurrentDeployment(),state:'deleting'});
    await expect(s.service.get(s.user,'alice','app',true)).rejects.toThrow('현재');
    expect(s.kube.core.listNamespacedPod).not.toHaveBeenCalled();
  });
  it('does not read logs or secrets by default and never turns unknown usage into zero', async () => {
    const s=setup(), result=await s.service.get(s.user,'alice','app',false);
    expect(result.usage).toMatchObject({cpuMillicores:null,memoryMiB:null}); expect(result.logs).toBeNull();
    expect(s.env.getEnv).not.toHaveBeenCalled(); expect(s.kube.core.readNamespacedPodLog).not.toHaveBeenCalled();
    expect(s.kube.core.listNamespacedPod).toHaveBeenCalledWith({namespace:'user-alice',labelSelector:'app=app'});
  });
  it('masks logs, bounds the Kubernetes request and audits only metadata', async () => {
    const s=setup(), result=await s.service.get(s.user,'alice','app',true);
    expect(result.logs).toContain('[숨김]'); expect(result.logs).not.toContain('private-value');
    expect(s.kube.core.readNamespacedPodLog).toHaveBeenCalledWith({namespace:'user-alice',name:'app-new',container:'app',tailLines:100,limitBytes:16384,sinceSeconds:3600,timestamps:true,follow:false});
    expect(JSON.stringify(s.users.audit.mock.calls)).not.toContain('private-value');
  });
  it('refuses to read logs when the secret mask cannot be prepared', async () => {
    const s=setup(); s.env.getEnv.mockRejectedValue(Error('forbidden'));
    const result=await s.service.get(s.user,'alice','app',true);
    expect(result.logs).toBeNull(); expect(result.logError).toBeTruthy(); expect(s.kube.core.readNamespacedPodLog).not.toHaveBeenCalled();
  });
  it('selects failing initialization logs and never reports a crash as running', async () => {
    const s=setup(); s.pod.status.initContainerStatuses=[{name:'prisma-db-init',restartCount:1,state:{terminated:{exitCode:1}}}];
    const result=await s.service.get(s.user,'alice','app',true);
    expect(result.state).toBe('Failed'); expect(result.logSource).toBe('initialization');
    expect(s.kube.core.readNamespacedPodLog).toHaveBeenCalledWith(expect.objectContaining({container:'prisma-db-init'}));
  });
  it('does not use pods outside the resolved namespace or app', async () => {
    const s=setup(); s.pod.metadata.namespace='user-bob';
    const result=await s.service.get(s.user,'alice','app',true);
    expect(result.logs).toBeNull(); expect(s.kube.core.readNamespacedPodLog).not.toHaveBeenCalled();
  });
});

it('masks known values, structured credentials, cookies, private keys and JWTs', () => {
  const raw='known-super-secret\n{"password":"hidden-pass"}\nAuthorization: Bearer abc\nCookie: session=abc\npostgres://user:pass@host/db\neyJhbGc.abcdef.signature\n-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----\n\x1b[31mhello';
  const redacted=redactAppLogs(raw,['known-super-secret']);
  for(const value of ['known-super-secret','hidden-pass','Bearer abc','session=abc','user:pass','eyJhbGc','private-material','\x1b']) expect(redacted).not.toContain(value);
  expect(redacted).toContain('hello');
});
