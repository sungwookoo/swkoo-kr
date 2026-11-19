import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { AdminController } from './admin.controller';
import { UsersRepository } from './users.repository';

it('persists and audits a targeted admin policy while retaining other accounts’ defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swkoo-test-deploy-policy-'));
  const dbPath = join(dir, 'test.sqlite');
  const open = () => {
    const repo = new UsersRepository({ dbPath } as any);
    repo.onModuleInit();
    return repo;
  };
  let users = open();
  const req = { user: { githubLogin: 'operator' } } as any;
  const config = { adminLogins: ['operator'] } as any;
  try {
    for (const [githubId, githubLogin] of [[1, 'alice'], [2, 'bob'], [3, 'operator']] as const) {
      users.upsertUser({ githubId, githubLogin, name: null, email: null, avatarUrl: null });
    }
    const admin = new AdminController(users, config);
    const policy = { maxApps: 2, cpuMillicores: 750, memoryMiB: 768 };
    expect(() => admin.patchDeployPolicy('alice', { ...policy, memoryMiB: 128 }, req)).toThrow();
    expect(() => admin.patchDeployPolicy('alice', { ...policy, maxApps: 1.5 }, req)).toThrow();
    expect(admin.patchDeployPolicy('ALICE', policy, req).deployPolicy).toEqual(policy);
    users.onModuleDestroy();
    users = open();
    const persisted = new AdminController(users, config).listUsers().users;
    expect(persisted.find(u => u.githubLogin === 'alice')?.deployPolicy).toEqual(policy);
    expect(persisted.find(u => u.githubLogin === 'bob')?.deployPolicy).toEqual({ maxApps: 1, cpuMillicores: 500, memoryMiB: 512 });
    expect(persisted.find(u => u.githubLogin === 'operator')?.deployPolicy.maxApps).toBeNull();
    expect(users.listAuditByActor('operator')).toEqual([
      expect.objectContaining({ action: 'DEPLOY_POLICY_UPDATED', target: 'ALICE', metaJson: JSON.stringify(policy) }),
    ]);
  } finally {
    users.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
  }
});
