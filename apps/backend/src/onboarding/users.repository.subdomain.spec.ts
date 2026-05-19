import { ConfigType } from '@nestjs/config';

import { webhooksConfig } from '../config/webhooks.config';
import { UsersRepository } from './users.repository';

// Direct-instantiation helper. The @Inject decorator only kicks in under
// NestJS DI; passing the config object directly is enough for tests.
function makeRepo(): UsersRepository {
  const config = { dbPath: ':memory:' } as ConfigType<typeof webhooksConfig>;
  const repo = new UsersRepository(config);
  repo.onModuleInit();
  return repo;
}

function seedTwoUsers(repo: UsersRepository): { aliceId: number; bobId: number } {
  const alice = repo.upsertUser({
    githubId: 1,
    githubLogin: 'alice',
    name: null,
    email: null,
    avatarUrl: null,
  });
  const bob = repo.upsertUser({
    githubId: 2,
    githubLogin: 'bob',
    name: null,
    email: null,
    avatarUrl: null,
  });
  return { aliceId: alice.id, bobId: bob.id };
}

describe('UsersRepository.setSubdomain', () => {
  let repo: UsersRepository;

  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    repo.onModuleDestroy();
  });

  it('claims an available slug', () => {
    seedTwoUsers(repo);
    expect(repo.setSubdomain('alice', 'myapp')).toBe('ok');
    expect(repo.findByLogin('alice')?.subdomain).toBe('myapp');
  });

  it('rejects with taken when another user already owns it', () => {
    seedTwoUsers(repo);
    repo.setSubdomain('alice', 'myapp');
    expect(repo.setSubdomain('bob', 'myapp')).toBe('taken');
    // Alice's claim must be intact.
    expect(repo.findByLogin('alice')?.subdomain).toBe('myapp');
    expect(repo.findByLogin('bob')?.subdomain).toBeNull();
  });

  it('allows the same user to reclaim their own slug (no-op UPDATE)', () => {
    seedTwoUsers(repo);
    repo.setSubdomain('alice', 'myapp');
    expect(repo.setSubdomain('alice', 'myapp')).toBe('ok');
    expect(repo.findByLogin('alice')?.subdomain).toBe('myapp');
  });

  it('allows multiple users with NULL subdomain (partial UNIQUE index)', () => {
    seedTwoUsers(repo);
    expect(repo.setSubdomain('alice', null)).toBe('ok');
    expect(repo.setSubdomain('bob', null)).toBe('ok');
  });

  it('returns no_user when the login does not exist', () => {
    expect(repo.setSubdomain('ghost', 'myapp')).toBe('no_user');
  });

  it('is case-insensitive on the login lookup', () => {
    seedTwoUsers(repo);
    // Login stored as 'alice'; updater accepts any casing.
    expect(repo.setSubdomain('ALICE', 'myapp')).toBe('ok');
    expect(repo.findByLogin('alice')?.subdomain).toBe('myapp');
  });
});

describe('UsersRepository soft-delete + subdomain', () => {
  let repo: UsersRepository;

  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    repo.onModuleDestroy();
  });

  it('soft-deleting a user releases their slug for another user to claim', () => {
    const { aliceId } = seedTwoUsers(repo);
    repo.setSubdomain('alice', 'myapp');
    repo.softDeleteUser(aliceId);
    // Bob can now claim the freed slug.
    expect(repo.setSubdomain('bob', 'myapp')).toBe('ok');
    expect(repo.findByLogin('bob')?.subdomain).toBe('myapp');
  });
});

describe('UsersRepository.findBySubdomain', () => {
  let repo: UsersRepository;

  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    repo.onModuleDestroy();
  });

  it('returns the owner when the slug is claimed', () => {
    seedTwoUsers(repo);
    repo.setSubdomain('alice', 'myapp');
    expect(repo.findBySubdomain('myapp')?.githubLogin).toBe('alice');
  });

  it('returns undefined when nobody owns the slug', () => {
    seedTwoUsers(repo);
    expect(repo.findBySubdomain('myapp')).toBeUndefined();
  });

  it('does not return soft-deleted users', () => {
    const { aliceId } = seedTwoUsers(repo);
    repo.setSubdomain('alice', 'myapp');
    repo.softDeleteUser(aliceId);
    expect(repo.findBySubdomain('myapp')).toBeUndefined();
  });
});
