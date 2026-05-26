jest.mock('@kubernetes/client-node', () => ({
  PatchStrategy: { MergePatch: 'merge-patch' },
  setHeaderOptions: jest.fn(),
}));

// kustomization.yaml fetch stub. Tests can override behavior by
// reassigning `axiosMock.get` per-case if they need to.
const axiosMock = {
  get: jest.fn(async () => ({
    data: {
      content: Buffer.from(
        'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - namespace.yaml\n'
      ).toString('base64'),
    },
  })),
};
jest.mock('axios', () => ({ default: axiosMock, __esModule: true }));

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import { onboardingConfig } from '../config/onboarding.config';
import { webhooksConfig } from '../config/webhooks.config';
import { CertStatusCache } from './cert-status-cache';
import { DnsResolver } from './dns-resolver';
import { CustomDomainsRepository } from './domain.repository';
import { DomainService } from './domain.service';
import type { GithubAppService } from '../github-app/github-app.service';
import type { UsersRepository, UserRow } from '../onboarding/users.repository';

function makeService(opts: {
  dnsTxt?: string[] | Error;
  dnsCname?: string[] | Error;
  /** Returned by commitFilesAtomic mock. */
  commitSha?: string;
  /** Returned by GithubAppService.getInstallationTokenForRepo. */
  token?: string;
  /** Returned by fetched kustomization.yaml contents. */
  kustomizationContent?: string;
  /** UsersRepository.findById return value. */
  userRow?: Partial<UserRow>;
  /** CertStatusCache.get return. */
  certReady?: boolean;
}) {
  const repo = new CustomDomainsRepository({ dbPath: ':memory:' } as ConfigType<typeof webhooksConfig>);
  repo.onModuleInit();

  const dns = {
    resolveTxt: jest.fn(async () => {
      if (opts.dnsTxt instanceof Error) throw opts.dnsTxt;
      return opts.dnsTxt ?? [];
    }),
    resolveCname: jest.fn(async () => {
      if (opts.dnsCname instanceof Error) throw opts.dnsCname;
      return opts.dnsCname ?? [];
    }),
  } as unknown as DnsResolver;

  // kustomization.yaml content for the fetch inside commit flow.
  axiosMock.get.mockResolvedValue({
    data: {
      content: Buffer.from(
        opts.kustomizationContent ??
          'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - namespace.yaml\n'
      ).toString('base64'),
    },
  });

  const githubApp = {
    getInstallationTokenForRepo: jest.fn(async () => opts.token ?? 'tok'),
    commitFilesAtomic: jest.fn(async () => opts.commitSha ?? 'sha-abc'),
  } as unknown as GithubAppService;

  const certCache = {
    get: jest.fn(async () => ({
      ready: opts.certReady ?? false,
      observedAt: Date.now(),
    })),
    invalidate: jest.fn(),
  } as unknown as CertStatusCache;

  const users = {
    findById: jest.fn(() => opts.userRow ?? { id: 1, githubLogin: 'alice', subdomain: null }),
    audit: jest.fn(),
  } as unknown as UsersRepository;

  const config = {
    deployOwner: 'swkoo-deploy',
    appsDomain: 'apps.swkoo.kr',
  } as ConfigType<typeof onboardingConfig>;

  const service = new DomainService(repo, dns, githubApp, certCache, users, config);
  return { service, repo, dns, githubApp, certCache, users };
}

describe('DomainService.register', () => {
  it('rejects invalid input with 400', async () => {
    const { service } = makeService({});
    await expect(
      service.register({ userId: 1, login: 'alice', repo: 'app', domain: 'swkoo.kr' })
    ).rejects.toThrow(BadRequestException);
  });

  it('creates pending row with TXT+CNAME guidance', async () => {
    const { service } = makeService({});
    const info = await service.register({
      userId: 1,
      login: 'alice',
      repo: 'nextjs-sample',
      domain: 'app.alice-example.com',
    });
    expect(info.status).toBe('pending');
    expect(info.domain).toBe('app.alice-example.com');
    expect(info.verificationToken).toMatch(/^sk-[0-9a-f]{32}$/);
    expect(info.dnsRecords?.txt.host).toBe('_swkoo-challenge.app.alice-example.com');
    expect(info.dnsRecords?.txt.value).toBe(
      `swkoo-domain-verification=${info.verificationToken}`
    );
    // No custom subdomain set on UserRow → fallback to <login>-<appName>.
    expect(info.dnsRecords?.cname.target).toBe('alice-nextjs-sample.apps.swkoo.kr');
  });

  it('uses user.subdomain when set, not the fallback', async () => {
    const { service } = makeService({
      userRow: { id: 1, githubLogin: 'alice', subdomain: 'hello' } as UserRow,
    });
    const info = await service.register({
      userId: 1, login: 'alice', repo: 'app', domain: 'app.alice-example.com',
    });
    expect(info.dnsRecords?.cname.target).toBe('hello.apps.swkoo.kr');
  });

  it('rejects duplicate domain across users with 409', async () => {
    const { service, repo } = makeService({});
    // Plant a row from a different user.
    repo.create({
      userId: 999,
      login: 'bob',
      appName: 'bob-app',
      domain: 'app.shared-example.com',
      verificationToken: 'tok',
      expectedCname: 'bob-bob-app.apps.swkoo.kr',
    });
    await expect(
      service.register({ userId: 1, login: 'alice', repo: 'app', domain: 'app.shared-example.com' })
    ).rejects.toThrow(ConflictException);
  });

  it('rejects second domain on same app with 409', async () => {
    const { service } = makeService({});
    await service.register({ userId: 1, login: 'alice', repo: 'app', domain: 'first.alice-example.com' });
    await expect(
      service.register({ userId: 1, login: 'alice', repo: 'app', domain: 'second.alice-example.com' })
    ).rejects.toThrow(ConflictException);
  });
});

describe('DomainService.verify', () => {
  it('NotFound when no row registered', async () => {
    const { service } = makeService({});
    await expect(service.verify('alice', 'app')).rejects.toThrow(NotFoundException);
  });

  it('transitions to error when TXT not found', async () => {
    const enotfound = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    const { service } = makeService({ dnsTxt: enotfound });
    await service.register({ userId: 1, login: 'alice', repo: 'app', domain: 'app.alice-example.com' });
    const info = await service.verify('alice', 'app');
    expect(info.status).toBe('error');
    expect(info.lastError).toContain('TXT 레코드를 찾을 수 없습니다');
  });

  it('transitions to applying after DNS OK + manifest commit', async () => {
    const { service, githubApp, repo } = makeService({
      // Set after register() so TXT contains the matching token.
      commitSha: 'sha-abc1234',
    });
    const reg = await service.register({
      userId: 1, login: 'alice', repo: 'app', domain: 'app.alice-example.com',
    });
    // Wire DNS to return matching records for the just-registered token.
    const dns = (service as unknown as { dns: { resolveTxt: jest.Mock; resolveCname: jest.Mock } }).dns;
    dns.resolveTxt.mockResolvedValue([`swkoo-domain-verification=${reg.verificationToken}`]);
    dns.resolveCname.mockResolvedValue(['alice-app.apps.swkoo.kr']);

    const info = await service.verify('alice', 'app');
    expect(info.status).toBe('applying');
    expect(githubApp.commitFilesAtomic).toHaveBeenCalledTimes(1);
    // applied_commit should be set so re-render preservation guard returns it.
    expect(repo.findForRender('alice', 'app')).toBeDefined();
  });

  it('opportunistically promotes applying → active when cert is ready on GET', async () => {
    const { service, repo } = makeService({
      certReady: true,
      commitSha: 'sha-abc1234',
    });
    const reg = await service.register({
      userId: 1, login: 'alice', repo: 'app', domain: 'app.alice-example.com',
    });
    const dns = (service as unknown as { dns: { resolveTxt: jest.Mock; resolveCname: jest.Mock } }).dns;
    dns.resolveTxt.mockResolvedValue([`swkoo-domain-verification=${reg.verificationToken}`]);
    dns.resolveCname.mockResolvedValue(['alice-app.apps.swkoo.kr']);
    await service.verify('alice', 'app');

    const info = await service.get('alice', 'app');
    expect(info.status).toBe('active');
    expect(info.url).toBe('https://app.alice-example.com');
    const stored = repo.findByLoginApp('alice', 'app');
    expect(stored?.status).toBe('active');
  });

  it('idempotent on already-applying row (no extra commit)', async () => {
    const { service, githubApp } = makeService({ commitSha: 'sha-abc1234' });
    const reg = await service.register({
      userId: 1, login: 'alice', repo: 'app', domain: 'app.alice-example.com',
    });
    const dns = (service as unknown as { dns: { resolveTxt: jest.Mock; resolveCname: jest.Mock } }).dns;
    dns.resolveTxt.mockResolvedValue([`swkoo-domain-verification=${reg.verificationToken}`]);
    dns.resolveCname.mockResolvedValue(['alice-app.apps.swkoo.kr']);
    await service.verify('alice', 'app');
    await service.verify('alice', 'app');
    expect(githubApp.commitFilesAtomic).toHaveBeenCalledTimes(1);
  });
});

describe('DomainService.delete', () => {
  it('skips manifest commit when row was pending (no commit ever landed)', async () => {
    const { service, githubApp } = makeService({});
    await service.register({ userId: 1, login: 'alice', repo: 'app', domain: 'app.alice-example.com' });
    await service.delete('alice', 'app');
    expect(githubApp.commitFilesAtomic).not.toHaveBeenCalled();
    const after = await service.get('alice', 'app');
    expect(after.status).toBeNull();
  });

  it('commits removal when row had been applied', async () => {
    const { service, githubApp, certCache } = makeService({ commitSha: 'sha-abc' });
    const reg = await service.register({
      userId: 1, login: 'alice', repo: 'app', domain: 'app.alice-example.com',
    });
    const dns = (service as unknown as { dns: { resolveTxt: jest.Mock; resolveCname: jest.Mock } }).dns;
    dns.resolveTxt.mockResolvedValue([`swkoo-domain-verification=${reg.verificationToken}`]);
    dns.resolveCname.mockResolvedValue(['alice-app.apps.swkoo.kr']);
    await service.verify('alice', 'app');

    await service.delete('alice', 'app');
    // 2 commits total: add then remove.
    expect(githubApp.commitFilesAtomic).toHaveBeenCalledTimes(2);
    expect(certCache.invalidate).toHaveBeenCalledWith('user-alice', 'app-custom-domain-tls');
  });
});
