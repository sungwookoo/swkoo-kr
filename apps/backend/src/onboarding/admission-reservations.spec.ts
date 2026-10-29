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
    expect(repo.recoverAdmissionReservation(`deleted_${user.id}`, 456, 'admin')).toBe(false);
    expect(repo.listAdmissionReservations()).toHaveLength(1);
    expect(repo.recoverAdmissionReservation(`deleted_${user.id}`, 123, 'admin')).toBe(true);
    expect(repo.listAdmissionReservations()).toEqual([]);
    repo.reserveAdmission('audit-rollback', 789);
    const audit = jest.spyOn(repo, 'audit').mockImplementationOnce(() => { throw Error('audit failed'); });
    expect(() => repo.recoverAdmissionReservation('audit-rollback', 789, 'admin')).toThrow('audit failed');
    expect(repo.listAdmissionReservations()).toEqual([{ login: 'audit-rollback', createdAt: 789 }]);
    audit.mockRestore(); repo.releaseAdmissionReservation('audit-rollback');
  } finally { repo.onModuleDestroy(); rmSync(directory, { recursive: true, force: true }); }
});
