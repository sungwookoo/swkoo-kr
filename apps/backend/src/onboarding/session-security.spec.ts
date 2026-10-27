import { AuthService } from './auth.service';
import { UsersRepository } from './users.repository';
import { TokenCipher } from './token-cipher';
import { sign } from 'jsonwebtoken';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('session revocation and token protection', () => {
  let users: UsersRepository;
  beforeEach(() => { users = new UsersRepository({ dbPath: ':memory:' } as any); users.onModuleInit(); });
  afterEach(() => users.onModuleDestroy());
  it('revokes only the logged-out session and rejects legacy signed tokens', () => {
    const user = users.upsertUser({ githubId: 1, githubLogin: 'alice', name: null, email: null, avatarUrl: null });
    const auth = new AuthService({ jwtSecret: 'test-secret' } as any, users);
    const first = auth.signSessionToken(user), second = auth.signSessionToken(user);
    expect(auth.verifySessionToken(first)?.uid).toBe(user.id);
    auth.revokeSession(first);
    expect(auth.verifySessionToken(first)).toBeNull();
    expect(auth.verifySessionToken(second)?.uid).toBe(user.id);
    expect(auth.verifySessionToken(sign({ uid: user.id }, 'test-secret'))).toBeNull();
  });
  it('stores authenticated ciphertext bound to a user and token kind', () => {
    const user = users.upsertUser({ githubId: 1, githubLogin: 'alice', name: null, email: null, avatarUrl: null });
    const tokens = { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: '2099-01-01' };
    users.saveTokens(user.id, tokens);
    const row = (users as any).db.prepare('SELECT access_token, refresh_token FROM users').get();
    expect(row.access_token).toMatch(/^enc1:/);
    expect(JSON.stringify(row)).not.toContain('secret');
    expect(users.getTokens(user.id)).toEqual(tokens);
    (users as any).db.prepare('UPDATE users SET access_token = refresh_token').run();
    expect(() => users.getTokens(user.id)).toThrow();
  });
  it('rejects wrong keys and modified ciphertext', () => {
    const a = new TokenCipher(Buffer.alloc(32, 1).toString('base64'));
    const b = new TokenCipher(Buffer.alloc(32, 2).toString('base64'));
    const value = a.encrypt('token', '1:access_token');
    expect(() => b.decrypt(value, '1:access_token')).toThrow();
    expect(() => a.decrypt(value, '2:access_token')).toThrow();
  });
  it('migrates persisted plaintext once and reads ciphertext after restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'swkoo-token-test-'));
    const previous = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
    let repository = new UsersRepository({ dbPath: join(directory, 'users.db') } as any);
    try {
      repository.onModuleInit();
      const user = repository.upsertUser({ githubId: 2, githubLogin: 'legacy', name: null, email: null, avatarUrl: null });
      (repository as any).db.prepare('UPDATE users SET access_token=?, refresh_token=?, token_expires_at=? WHERE id=?')
        .run('legacy-access', 'legacy-refresh', '2099-01-01', user.id);
      repository.onModuleDestroy();
      for (let restart = 0; restart < 2; restart++) {
        repository = new UsersRepository({ dbPath: join(directory, 'users.db') } as any);
        repository.onModuleInit();
        expect(repository.getTokens(user.id)?.accessToken).toBe('legacy-access');
        expect((repository as any).db.prepare('SELECT access_token FROM users').get().access_token).toMatch(/^enc1:/);
        repository.onModuleDestroy();
      }
    } finally {
      if (previous === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('revokes every session when the account is deleted', () => {
    const user = users.upsertUser({ githubId: 3, githubLogin: 'deleted', name: null, email: null, avatarUrl: null });
    users.createSession('session', user.id, Math.floor(Date.now() / 1000) + 3600);
    users.softDeleteUser(user.id);
    expect(users.hasSession('session', user.id)).toBe(false);
  });
});
