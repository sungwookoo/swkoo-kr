jest.mock('@kubernetes/client-node', () => ({
  PatchStrategy: { MergePatch: 'merge-patch' },
  setHeaderOptions: jest.fn(),
}));

// kustomization.yaml fetch stub.
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
