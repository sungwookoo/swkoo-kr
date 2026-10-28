jest.mock('@kubernetes/client-node', () => ({ PatchStrategy: { MergePatch: 'merge-patch' }, setHeaderOptions: jest.fn() }));
import { DeployService } from './deploy.service';

it('requests reconciliation with the ApplicationSet-specific refresh annotation', async () => {
  const patch = jest.fn(async () => undefined);
  const service = new DeployService({} as any, {} as any, {} as any, {} as any,
    { available: () => true, custom: { patchNamespacedCustomObject: patch } } as any,
    {} as any, {} as any, {} as any, {} as any);
  await (service as any).refreshUsersApplicationSet();
  expect(patch).toHaveBeenCalledWith({ group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd',
    plural: 'applicationsets', name: 'swkoo-users', body: { metadata: {
      annotations: { 'argocd.argoproj.io/application-set-refresh': 'true' },
    } } }, undefined);
});
