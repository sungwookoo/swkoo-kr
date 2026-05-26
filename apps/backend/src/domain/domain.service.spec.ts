jest.mock('@kubernetes/client-node', () => ({
  PatchStrategy: { MergePatch: 'merge-patch' },
  setHeaderOptions: jest.fn(),
}));

// axios mock — `get` for kustomization fetch, `post` for the operator
// failure webhook. Tests reassign behaviour per case.
const axiosMock = {
  get: jest.fn(async () => ({
    data: {
      content: Buffer.from(
        'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - namespace.yaml\n'
      ).toString('base64'),
    },
  })),
  post: jest.fn(async () => ({ data: {} })),
};
jest.mock('axios', () => ({ default: axiosMock, __esModule: true }));

import { BadRequestException, ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import { onboardingConfig } from '../config/onboarding.config';
import { webhooksConfig } from '../config/webhooks.config';
import type { CurrentDeployment } from '../deploy/deploy.service';
import { CertStatusCache } from './cert-status-cache';
import { DnsResolver } from './dns-resolver';
import { CustomDomainsRepository } from './domain.repository';
import { DomainService } from './domain.service';
import type { GithubAppService } from '../github-app/github-app.service';
import type { UsersRepository } from '../onboarding/users.repository';

function makeCurrent(overrides: Partial<CurrentDeployment> = {}): CurrentDeployment {
  return {
    login: 'alice',
    repo: 'nextjs-sample',
    fullName: 'alice/nextjs-sample',
    appName: 'nextjs-sample',
    liveUrl: 'https://alice-nextjs-sample.apps.swkoo.kr',
    syncStatus: 'Synced',
    healthStatus: 'Healthy',
    state: 'active',
    ...overrides,
  };
}

function makeService(opts: {
  dnsTxt?: string[] | Error;
  dnsCname?: string[] | Error;
  commitSha?: string;
  token?: string;
  kustomizationContent?: string;
  certReady?: boolean;
  discordBuildFailureWebhookUrl?: string;
}) {
  // Each makeService() resets the post mock so notification-call
  // assertions don't bleed across tests.
  axiosMock.post.mockReset();
  axiosMock.post.mockResolvedValue({ data: {} });
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
    audit: jest.fn(),
  } as unknown as UsersRepository;

  const config = {
    deployOwner: 'swkoo-deploy',
    appsDomain: 'apps.swkoo.kr',
    discordBuildFailureWebhookUrl: opts.discordBuildFailureWebhookUrl,
  } as ConfigType<typeof onboardingConfig>;

  const service = new DomainService(repo, dns, githubApp, certCache, users, config);
  return { service, repo, dns, githubApp, certCache, users };
}

describe('DomainService.register', () => {
  it('rejects invalid input with 400', async () => {
    const { service } = makeService({});
    await expect(
      service.register({ userId: 1, current: makeCurrent(), domain: 'swkoo.kr' })
    ).rejects.toThrow(BadRequestException);
  });

  it('creates pending row with expectedCname from current.liveUrl', async () => {
    const { service } = makeService({});
    const info = await service.register({
      userId: 1,
      current: makeCurrent({ liveUrl: 'https://hello.apps.swkoo.kr' }),
      domain: 'app.alice-example.com',
    });
    expect(info.status).toBe('pending');
    expect(info.dnsRecords?.cname.target).toBe('hello.apps.swkoo.kr');
    expect(info.verificationToken).toMatch(/^sk-[0-9a-f]{32}$/);
  });

  it('rejects duplicate domain across users with 409', async () => {
    const { service, repo } = makeService({});
    repo.create({
      userId: 999,
      login: 'bob',
      appName: 'bob-app',
      domain: 'app.shared-example.com',
      verificationToken: 'tok',
      expectedCname: 'bob-bob-app.apps.swkoo.kr',
    });
    await expect(
      service.register({
        userId: 1,
        current: makeCurrent(),
        domain: 'app.shared-example.com',
      })
    ).rejects.toThrow(ConflictException);
  });

  it('rejects second domain on same app with 409', async () => {
    const { service } = makeService({});
    const current = makeCurrent();
    await service.register({ userId: 1, current, domain: 'first.alice-example.com' });
    await expect(
      service.register({ userId: 1, current, domain: 'second.alice-example.com' })
    ).rejects.toThrow(ConflictException);
  });
});

describe('DomainService.verify', () => {
  it('NotFound when no row registered', async () => {
    const { service } = makeService({});
    await expect(service.verify(makeCurrent())).rejects.toThrow(NotFoundException);
  });

  it('transitions to error when TXT not found', async () => {
    const enotfound = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    const { service } = makeService({ dnsTxt: enotfound });
    const current = makeCurrent();
    await service.register({ userId: 1, current, domain: 'app.alice-example.com' });
    const info = await service.verify(current);
    expect(info.status).toBe('error');
    expect(info.lastError).toContain('TXT 레코드를 찾을 수 없습니다');
  });

  it('transitions to applying after DNS OK + manifest commit', async () => {
    const { service, githubApp, repo } = makeService({ commitSha: 'sha-abc1234' });
    const current = makeCurrent({ liveUrl: 'https://alice-nextjs-sample.apps.swkoo.kr' });
    const reg = await service.register({
      userId: 1,
      current,
      domain: 'app.alice-example.com',
    });
    const dns = (service as unknown as { dns: { resolveTxt: jest.Mock; resolveCname: jest.Mock } }).dns;
    dns.resolveTxt.mockResolvedValue([`swkoo-domain-verification=${reg.verificationToken}`]);
    dns.resolveCname.mockResolvedValue(['alice-nextjs-sample.apps.swkoo.kr']);

    const info = await service.verify(current);
    expect(info.status).toBe('applying');
    expect(githubApp.commitFilesAtomic).toHaveBeenCalledTimes(1);
    expect(repo.findForRender('alice', 'nextjs-sample')).toBeDefined();
  });

  it('opportunistically promotes applying → active when cert is ready on GET', async () => {
    const { service, repo } = makeService({ certReady: true, commitSha: 'sha-abc1234' });
    const current = makeCurrent({ liveUrl: 'https://alice-nextjs-sample.apps.swkoo.kr' });
    const reg = await service.register({
      userId: 1,
      current,
      domain: 'app.alice-example.com',
    });
    const dns = (service as unknown as { dns: { resolveTxt: jest.Mock; resolveCname: jest.Mock } }).dns;
    dns.resolveTxt.mockResolvedValue([`swkoo-domain-verification=${reg.verificationToken}`]);
    dns.resolveCname.mockResolvedValue(['alice-nextjs-sample.apps.swkoo.kr']);
    await service.verify(current);

    const info = await service.get('alice', current);
    expect(info.status).toBe('active');
    expect(info.url).toBe('https://app.alice-example.com');
    const stored = repo.findByLoginApp('alice', 'nextjs-sample');
    expect(stored?.status).toBe('active');
  });

  it('idempotent on already-applying row (no extra commit)', async () => {
    const { service, githubApp } = makeService({ commitSha: 'sha-abc1234' });
    const current = makeCurrent();
    const reg = await service.register({
      userId: 1,
      current,
      domain: 'app.alice-example.com',
    });
    const dns = (service as unknown as { dns: { resolveTxt: jest.Mock; resolveCname: jest.Mock } }).dns;
    dns.resolveTxt.mockResolvedValue([`swkoo-domain-verification=${reg.verificationToken}`]);
    dns.resolveCname.mockResolvedValue(['alice-nextjs-sample.apps.swkoo.kr']);
    await service.verify(current);
    await service.verify(current);
    expect(githubApp.commitFilesAtomic).toHaveBeenCalledTimes(1);
  });
});

describe('DomainService.delete', () => {
  it('skips manifest commit when row was pending', async () => {
    const { service, githubApp } = makeService({});
    const current = makeCurrent();
    await service.register({ userId: 1, current, domain: 'app.alice-example.com' });
    await service.delete(current);
    expect(githubApp.commitFilesAtomic).not.toHaveBeenCalled();
    const after = await service.get('alice', current);
    expect(after.status).toBeNull();
  });

  it('commits removal when row had been applied', async () => {
    const { service, githubApp, certCache } = makeService({ commitSha: 'sha-abc' });
    const current = makeCurrent();
    const reg = await service.register({
      userId: 1,
      current,
      domain: 'app.alice-example.com',
    });
    const dns = (service as unknown as { dns: { resolveTxt: jest.Mock; resolveCname: jest.Mock } }).dns;
    dns.resolveTxt.mockResolvedValue([`swkoo-domain-verification=${reg.verificationToken}`]);
    dns.resolveCname.mockResolvedValue(['alice-nextjs-sample.apps.swkoo.kr']);
    await service.verify(current);

    await service.delete(current);
    expect(githubApp.commitFilesAtomic).toHaveBeenCalledTimes(2);
    expect(certCache.invalidate).toHaveBeenCalledWith('user-alice', 'nextjs-sample-custom-domain-tls');
  });
});

/** /verify cooldown — protects 1.1.1.1 from spam and GitHub from
 *  thrashing when a confused user repeatedly clicks [확인]. Applies to
 *  the work-doing branches (pending|verified|error); applying/active
 *  return early without consuming the cooldown budget. */
describe('DomainService.verify cooldown', () => {
  beforeEach(() => {
    // Use fake timers so we can advance past the 30s cooldown deterministically.
    jest.useFakeTimers({ now: new Date('2026-06-01T00:00:00Z') });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  async function setupVerified(): Promise<{
    service: DomainService;
    current: CurrentDeployment;
  }> {
    const { service } = makeService({
      dnsTxt: [], // intentionally empty so verify fails fast with DNS_TXT_MISMATCH
    });
    const current = makeCurrent();
    await service.register({
      userId: 1,
      current,
      domain: 'app.alice-example.com',
    });
    return { service, current };
  }

  it('first verify runs (no cooldown on fresh row)', async () => {
    const { service, current } = await setupVerified();
    const result = await service.verify(current);
    expect(result.status).toBe('error'); // DNS empty → error, but the call completed
    expect(result.lastError).toBeTruthy();
  });

  it('second verify within 30s is rejected with DOMAIN_VERIFY_COOLDOWN (429)', async () => {
    const { service, current } = await setupVerified();
    await service.verify(current);

    jest.advanceTimersByTime(10_000); // 10s later

    try {
      await service.verify(current);
      throw new Error('expected cooldown to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      const response = (err as HttpException).getResponse() as {
        statusCode: number;
        message: { reason: string; message: string; retryAfterSec: number };
      };
      expect(response.statusCode).toBe(429);
      expect(response.message.reason).toBe('DOMAIN_VERIFY_COOLDOWN');
      expect(response.message.retryAfterSec).toBeGreaterThan(0);
      expect(response.message.retryAfterSec).toBeLessThanOrEqual(20);
    }
  });

  it('verify is re-allowed after the 30s cooldown elapses', async () => {
    const { service, current } = await setupVerified();
    await service.verify(current);

    jest.advanceTimersByTime(31_000); // past 30s

    const result = await service.verify(current);
    // No cooldown throw — second attempt ran (and errored on DNS, expected).
    expect(result.status).toBe('error');
  });

  it('applying/active rows bypass cooldown (idempotent early return)', async () => {
    // Wire DNS pass so first verify reaches `applying`.
    const { service } = makeService({ commitSha: 'sha-abc' });
    const current = makeCurrent();
    const reg = await service.register({
      userId: 1,
      current,
      domain: 'app.alice-example.com',
    });
    const dns = (service as unknown as { dns: { resolveTxt: jest.Mock; resolveCname: jest.Mock } }).dns;
    dns.resolveTxt.mockResolvedValue([`swkoo-domain-verification=${reg.verificationToken}`]);
    dns.resolveCname.mockResolvedValue(['alice-nextjs-sample.apps.swkoo.kr']);

    await service.verify(current); // → applying

    // Immediate retry must NOT hit cooldown — it's an idempotent read.
    const second = await service.verify(current);
    expect(second.status).toBe('applying');
  });
});

/** Operator failure notifications — reuse the deploy-failure Discord
 *  channel. Each failure stage fires a webhook; success paths don't.
 *  Webhook failure must not break the API response. */
describe('DomainService operator failure notifications', () => {
  const WEBHOOK = 'https://discord.example.com/api/webhooks/secret';

  it('fires Discord post on DNS verify failure', async () => {
    const enotfound = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    const { service } = makeService({
      dnsTxt: enotfound,
      discordBuildFailureWebhookUrl: WEBHOOK,
    });
    const current = makeCurrent();
    await service.register({ userId: 1, current, domain: 'app.alice-example.com' });
    await service.verify(current);

    expect(axiosMock.post).toHaveBeenCalledWith(
      WEBHOOK,
      expect.objectContaining({
        content: expect.stringMatching(/custom domain 실패.*alice.*nextjs-sample.*DNS 확인/s),
      }),
      expect.objectContaining({ timeout: 5_000 })
    );
  });

  it('fires Discord post on manifest commit failure', async () => {
    const { service, githubApp } = makeService({
      discordBuildFailureWebhookUrl: WEBHOOK,
    });
    const current = makeCurrent();
    const reg = await service.register({
      userId: 1, current, domain: 'app.alice-example.com',
    });
    // DNS passes, commit throws.
    const dns = (service as unknown as { dns: { resolveTxt: jest.Mock; resolveCname: jest.Mock } }).dns;
    dns.resolveTxt.mockResolvedValue([`swkoo-domain-verification=${reg.verificationToken}`]);
    dns.resolveCname.mockResolvedValue(['alice-nextjs-sample.apps.swkoo.kr']);
    (githubApp.commitFilesAtomic as jest.Mock).mockRejectedValueOnce(new Error('GitHub 502'));

    await service.verify(current);

    expect(axiosMock.post).toHaveBeenCalledWith(
      WEBHOOK,
      expect.objectContaining({
        content: expect.stringMatching(/매니페스트 커밋.*COMMIT_FAILED.*GitHub 502/s),
      }),
      expect.any(Object)
    );
  });

  it('fires Discord post on delete commit failure (and still throws to caller)', async () => {
    const { service, githubApp } = makeService({
      discordBuildFailureWebhookUrl: WEBHOOK,
      commitSha: 'sha-add',
    });
    const current = makeCurrent();
    const reg = await service.register({
      userId: 1, current, domain: 'app.alice-example.com',
    });
    const dns = (service as unknown as { dns: { resolveTxt: jest.Mock; resolveCname: jest.Mock } }).dns;
    dns.resolveTxt.mockResolvedValue([`swkoo-domain-verification=${reg.verificationToken}`]);
    dns.resolveCname.mockResolvedValue(['alice-nextjs-sample.apps.swkoo.kr']);
    await service.verify(current); // → applying with applied_commit set

    // Now make the DELETE commit throw.
    (githubApp.commitFilesAtomic as jest.Mock).mockRejectedValueOnce(new Error('GitHub 503'));

    await expect(service.delete(current)).rejects.toThrow('GitHub 503');

    expect(axiosMock.post).toHaveBeenCalledWith(
      WEBHOOK,
      expect.objectContaining({
        content: expect.stringMatching(/삭제.*COMMIT_FAILED.*GitHub 503/s),
      }),
      expect.any(Object)
    );
  });

  it('skips webhook when DISCORD_BUILD_FAILURE_WEBHOOK_URL is unset', async () => {
    const enotfound = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    const { service } = makeService({
      dnsTxt: enotfound,
      discordBuildFailureWebhookUrl: undefined,
    });
    const current = makeCurrent();
    await service.register({ userId: 1, current, domain: 'app.alice-example.com' });
    await service.verify(current);

    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  it('webhook failure does not break the API response', async () => {
    const enotfound = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    const { service } = makeService({
      dnsTxt: enotfound,
      discordBuildFailureWebhookUrl: WEBHOOK,
    });
    axiosMock.post.mockRejectedValue(new Error('webhook 5xx'));
    const current = makeCurrent();
    await service.register({ userId: 1, current, domain: 'app.alice-example.com' });

    // Must NOT throw — the verify response should still come back to
    // the user with status=error and the lastError populated. The
    // webhook failure is swallowed and logged.
    const result = await service.verify(current);
    expect(result.status).toBe('error');
  });
});
