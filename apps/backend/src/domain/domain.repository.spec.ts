import { ConfigType } from '@nestjs/config';

import { webhooksConfig } from '../config/webhooks.config';
import { CustomDomainsRepository } from './domain.repository';

function makeRepo(): CustomDomainsRepository {
  const repo = new CustomDomainsRepository({
    dbPath: ':memory:',
  } as ConfigType<typeof webhooksConfig>);
  repo.onModuleInit();
  return repo;
}

function seed(repo: CustomDomainsRepository, overrides: Partial<{
  userId: number;
  login: string;
  appName: string;
  domain: string;
}> = {}) {
  return repo.create({
    userId: overrides.userId ?? 1,
    login: overrides.login ?? 'alice',
    appName: overrides.appName ?? 'nextjs-sample',
    domain: overrides.domain ?? 'app.alice-example.com',
    verificationToken: 'tok-123',
    expectedCname: 'alice-nextjs-sample.apps.swkoo.kr',
  });
}

describe('CustomDomainsRepository', () => {
  let repo: CustomDomainsRepository;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { repo.onModuleDestroy(); });

  it('creates with status=pending and no applied_commit', () => {
    const r = seed(repo);
    expect(r.status).toBe('pending');
    expect(r.appliedCommit).toBeNull();
    expect(r.domain).toBe('app.alice-example.com');
  });

  it('findByLoginApp returns the seeded row', () => {
    seed(repo);
    expect(repo.findByLoginApp('alice', 'nextjs-sample')?.domain).toBe('app.alice-example.com');
    expect(repo.findByLoginApp('alice', 'unknown')).toBeUndefined();
  });

  it('findByDomain enforces global uniqueness (UNIQUE constraint)', () => {
    seed(repo, { domain: 'shared.example-host.com' });
    expect(repo.findByDomain('shared.example-host.com')).toBeDefined();
    expect(() =>
      seed(repo, { userId: 2, login: 'bob', appName: 'app2', domain: 'shared.example-host.com' })
    ).toThrow(/UNIQUE constraint failed.*domain/);
  });

  it('UNIQUE (user_id, app_name) prevents two domains on one app', () => {
    seed(repo);
    expect(() =>
      seed(repo, { domain: 'second.alice-example.com' })
    ).toThrow(/UNIQUE constraint failed.*user_id.*app_name/);
  });

  describe('findForRender preservation guard', () => {
    it('returns nothing for pending (manifest never landed)', () => {
      seed(repo);
      expect(repo.findForRender('alice', 'nextjs-sample')).toBeUndefined();
    });

    it('returns row when status=applying', () => {
      const r = seed(repo);
      repo.updateStatus(r.id, 'applying');
      expect(repo.findForRender('alice', 'nextjs-sample')?.status).toBe('applying');
    });

    it('returns row when status=active', () => {
      const r = seed(repo);
      repo.updateStatus(r.id, 'active');
      expect(repo.findForRender('alice', 'nextjs-sample')?.status).toBe('active');
    });

    it('returns row when status=error but appliedCommit set (manifest already in repo)', () => {
      // Real scenario: verify succeeded → commit landed → status=applying →
      // cert-manager couldn't issue → status=error. Manifest is still in
      // the deploy repo, so re-render must preserve it (else next user
      // redeploy wipes the custom ingress that cert-manager is still
      // trying to satisfy).
      const r = seed(repo);
      repo.markApplied(r.id, 'abc1234');
      repo.updateStatus(r.id, 'error', { lastError: 'cert challenge failed' });
      const row = repo.findForRender('alice', 'nextjs-sample');
      expect(row?.status).toBe('error');
      expect(row?.appliedCommit).toBe('abc1234');
    });

    it('does NOT return when status=verified and appliedCommit null', () => {
      // Edge: verified is the transient between "DNS OK" and "manifest
      // committed". If we crash between those two, status=verified but
      // appliedCommit=null. Don't emit the ingress on re-render — there's
      // no actual cert/secret in the cluster yet.
      const r = seed(repo);
      repo.updateStatus(r.id, 'verified');
      expect(repo.findForRender('alice', 'nextjs-sample')).toBeUndefined();
    });
  });

  it('markApplied + updateStatus + clearError flow', () => {
    const r = seed(repo);
    repo.updateStatus(r.id, 'verified');
    const applied = repo.markApplied(r.id, 'sha-abcdef');
    expect(applied?.appliedCommit).toBe('sha-abcdef');
    const errored = repo.updateStatus(r.id, 'error', { lastError: 'cert timed out' });
    expect(errored?.lastError).toBe('cert timed out');
    repo.clearError(r.id);
    expect(repo.findByLoginApp('alice', 'nextjs-sample')?.lastError).toBeNull();
  });

  it('delete removes the row', () => {
    const r = seed(repo);
    repo.delete(r.id);
    expect(repo.findByLoginApp('alice', 'nextjs-sample')).toBeUndefined();
    expect(repo.findByDomain('app.alice-example.com')).toBeUndefined();
  });
});
