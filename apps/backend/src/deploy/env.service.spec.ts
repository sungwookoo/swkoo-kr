jest.mock('@kubernetes/client-node', () => ({
  PatchStrategy: { StrategicMergePatch: 'strategic-merge-patch' }, setHeaderOptions: jest.fn(),
}));
import { EnvService } from './env.service';

describe('environment replacement and rollout', () => {
  function setup() {
    const secrets = new Map<string, any>();
    const key = ({ namespace, name }: any) => `${namespace}/${name}`;
    const core = {
      readNamespacedSecret: jest.fn(async (args) => {
        if (!secrets.has(key(args))) throw { code: 404 };
        return secrets.get(key(args));
      }),
      replaceNamespacedSecret: jest.fn(async (args) => {
        if (!secrets.has(key(args))) throw { code: 404 };
        secrets.set(key(args), args.body);
      }),
      createNamespacedSecret: jest.fn(async (args) => { secrets.set(key({ ...args, name: args.body.metadata.name }), args.body); }),
    };
    const patch = jest.fn(async (_args: any, _options?: any) => undefined);
    const audit = jest.fn();
    const service = new EnvService({ available: () => true, core, apps: { patchNamespacedDeployment: patch } } as any, { audit } as any);
    return { service, core, patch, audit };
  }
  it('creates, replaces and clears only the selected user secret, restarting on each save', async () => {
    const { service, patch, audit } = setup();
    await service.setEnv('alice', 'app', { TOKEN: 'alice-secret', REMOVE: 'old' });
    await service.setEnv('bob', 'app', { TOKEN: 'bob-secret' });
    await service.setEnv('alice', 'app', { TOKEN: 'new-secret' });
    expect(await service.getEnv('alice', 'app')).toEqual({ TOKEN: 'new-secret' });
    expect(await service.getEnv('bob', 'app')).toEqual({ TOKEN: 'bob-secret' });
    await service.setEnv('alice', 'app', {});
    expect(await service.getEnv('alice', 'app')).toEqual({});
    expect(await service.getEnv('bob', 'app')).toEqual({ TOKEN: 'bob-secret' });
    expect(patch).toHaveBeenCalledTimes(4);
    expect(patch.mock.calls[0][0]).toMatchObject({ namespace: 'user-alice', name: 'app' });
    expect(JSON.stringify(audit.mock.calls)).not.toContain('secret');
  });
  it('does not save or restart when a key is invalid', async () => {
    const { service, core, patch, audit } = setup();
    await expect(service.setEnv('alice', 'app', { 'bad-key': 'value' })).rejects.toThrow('INVALID_KEY');
    expect(core.replaceNamespacedSecret).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled();
  });
});
