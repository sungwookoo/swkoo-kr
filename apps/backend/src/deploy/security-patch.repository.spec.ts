import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecurityPatchRepository, PatchPlan } from './security-patch.repository';
import { UsersRepository } from '../onboarding/users.repository';

describe('security proposal retention', () => {
  it('survives restart, exports to its owner, and is deleted with the account', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swkoo-patch-'));
    const config = { dbPath: join(dir, 'test.sqlite') };
    const users = new UsersRepository(config); users.onModuleInit();
    const user = users.upsertUser({ githubId: 99, githubLogin: 'alice', name: null, email: null, avatarUrl: null });
    let repo = new SecurityPatchRepository(config); repo.onModuleInit();
    try {
      const plan: PatchPlan = { id: 'id', userId: user.id, repo: 'alice/app', base: 'main', sha: 'sha', state: 'preparing',
        createdAt: Date.now(), updatedAt: Date.now(), manifest: '{}', original: '{}' };
      repo.save(plan); repo.onModuleDestroy(); repo = new SecurityPatchRepository(config); repo.onModuleInit();
      expect(repo.get(user.id)?.id).toBe('id');
      expect(repo.get(user.id + 1)).toBeNull();
      expect(repo.countPreparing()).toBe(1);
      expect(users.exportSecurityPatch(user.id)).toMatchObject({ id: 'id' });
      users.softDeleteUser(user.id); expect(repo.get(user.id)).toBeNull();
    } finally { repo.onModuleDestroy(); users.onModuleDestroy(); rmSync(dir, { recursive: true, force: true }); }
  });
});
