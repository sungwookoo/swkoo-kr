import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsersRepository } from './users.repository';

it('preserves admission reservations across reopen and anonymizes them on account deletion', () => {
  const directory = mkdtempSync(join(tmpdir(), 'swkoo-admission-'));
  let repo = new UsersRepository({ dbPath: join(directory, 'test.sqlite') } as any);
  try {
    repo.onModuleInit();
    const user = repo.upsertUser({ githubId: 1, githubLogin: 'alice', name: null, email: null, avatarUrl: null });
    repo.reserveAdmission('alice', 123); repo.reserveAdmission('alice', 456); repo.onModuleDestroy();
    repo = new UsersRepository({ dbPath: join(directory, 'test.sqlite') } as any); repo.onModuleInit();
    expect(repo.listAdmissionReservations()).toEqual([{ login: 'alice', createdAt: 123 }]);
    repo.softDeleteUser(user.id); expect(repo.listAdmissionReservations()).toEqual([{ login: `deleted_${user.id}`, createdAt: 123 }]);
    repo.releaseAdmissionReservation(`deleted_${user.id}`); expect(repo.listAdmissionReservations()).toEqual([]);
  } finally { repo.onModuleDestroy(); rmSync(directory, { recursive: true, force: true }); }
});
