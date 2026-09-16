jest.mock('../kube/kube.client', () => ({ KubeClient: class {} }));
jest.mock('./deploy.service', () => ({ DeployService: class {} }));
import { ScanService } from './scan.service';

describe('scan result lifecycle', () => {
  function setup() {
    const kube = { batch: { createNamespacedJob: jest.fn(async () => ({})) } };
    const service = new ScanService(kube as any, {} as any, {} as any, {} as any);
    const internal = service as any;
    internal.waitForJob = jest.fn(async () => ({ status: { succeeded: 1 } }));
    internal.readJobLogs = jest.fn(async () => '{"Results":[]}');
    internal.deleteJob = jest.fn(async () => undefined);
    return { service, internal, kube };
  }
  it('reads the scan before deleting its job', async () => {
    const { service, internal } = setup();
    expect(await service.runScan('alice', 'ghcr.io/alice/app:latest')).not.toBeNull();
    expect(internal.readJobLogs.mock.invocationCallOrder[0]).toBeLessThan(internal.deleteJob.mock.invocationCallOrder[0]);
  });
  it('cleans up failed jobs without reading missing results', async () => {
    const { service, internal } = setup();
    internal.waitForJob.mockResolvedValue({ status: { failed: 1 } });
    expect(await service.runScan('alice', 'ghcr.io/alice/app:latest')).toBeNull();
    expect(internal.readJobLogs).not.toHaveBeenCalled();
    expect(internal.deleteJob).toHaveBeenCalledTimes(1);
  });
  it.each([['ghcr.io/alice/app:latest', false], ['nrt.ocir.io/tenant/backend:sha', true]])('limits registry credentials for %s', async (image, privateRegistry) => {
    const { service, kube } = setup();
    await service.runScan('alice', image as string);
    const pod = (kube.batch.createNamespacedJob.mock.calls as any)[0][0].body.spec.template.spec;
    expect(pod.volumes.some((v: any) => v.name === 'registry')).toBe(privateRegistry);
    expect(pod.automountServiceAccountToken).toBe(false);
  });
});
