import { ConfigType } from '@nestjs/config';

import { webhooksConfig } from '../config/webhooks.config';
import {
  GhcrPackageVersion,
  GithubAppService,
} from '../github-app/github-app.service';
import { ProvenanceRepository } from './provenance.repository';
import { ProvenanceService } from './provenance.service';
import { GitHubClient } from './services/github.client';
import type { WorkflowRun } from './types/github.types';

const DIGEST_A = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DIGEST_B = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const DIGEST_C = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const SHA_HEAD_NEWER = '1111111111111111111111111111111111111111';
const SHA_HEAD_OLDER = '2222222222222222222222222222222222222222';

function makeRepo(): ProvenanceRepository {
  const config = { dbPath: ':memory:' } as ConfigType<typeof webhooksConfig>;
  const repo = new ProvenanceRepository(config);
  repo.onModuleInit();
  return repo;
}

interface StubState {
  versions: GhcrPackageVersion[] | null;
  versionsErr?: Error;
  tokenErr?: Error;
  runForSha: Record<string, WorkflowRun | null>;
  successfulRuns: WorkflowRun[] | null;
  githubConfigured: boolean;
}

function makeStubs(state: StubState) {
  const githubApp = {
    getInstallationTokenForRepo: jest.fn(async () => {
      if (state.tokenErr) throw state.tokenErr;
      return 'token-x';
    }),
    listUserPackageVersions: jest.fn(async () => {
      if (state.versionsErr) throw state.versionsErr;
      return state.versions;
    }),
  } as unknown as GithubAppService;

  const githubClient = {
    isConfigured: () => state.githubConfigured,
    fetchWorkflowRunForSha: jest.fn(async ({ sha }: { sha: string }) =>
      state.runForSha[sha] ?? null
    ),
    fetchSuccessfulRunsWithin: jest.fn(async () => state.successfulRuns),
  } as unknown as GitHubClient;

  return { githubApp, githubClient };
}

function makeRun(overrides: Partial<WorkflowRun>): WorkflowRun {
  return {
    id: 1,
    name: 'build',
    status: 'completed',
    conclusion: 'success',
    headSha: overrides.headSha ?? SHA_HEAD_NEWER,
    headBranch: 'main',
    event: 'push',
    createdAt: '2026-05-21T00:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-05-21T00:00:00Z',
    runDurationSeconds: 30,
    htmlUrl: overrides.htmlUrl ?? `https://github.com/x/y/actions/runs/${overrides.headSha ?? 'x'}`,
  };
}

describe('ProvenanceService', () => {
  let repo: ProvenanceRepository;

  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    repo.onModuleDestroy();
  });

  it('verified — deployed digest matches a package version with a SHA tag', async () => {
    const stubs = makeStubs({
      versions: [
        {
          name: DIGEST_A,
          metadata: { container: { tags: [SHA_HEAD_NEWER, 'latest'] } },
        },
      ],
      runForSha: {
        [SHA_HEAD_NEWER]: makeRun({
          headSha: SHA_HEAD_NEWER,
          htmlUrl: 'https://github.com/o/r/actions/runs/9',
        }),
      },
      successfulRuns: null,
      githubConfigured: true,
    });
    const svc = new ProvenanceService(repo, stubs.githubApp, stubs.githubClient);

    const result = await svc.resolve({
      imageOwner: 'o',
      imageName: 'r',
      digest: DIGEST_A,
    });

    expect(result.confidence).toBe('verified');
    expect(result.sourceSha).toBe(SHA_HEAD_NEWER);
    expect(result.sourceRunUrl).toBe('https://github.com/o/r/actions/runs/9');
    expect(result.method).toBe('gh_package_tag_digest');
    expect(result.evidence).toBe('gh_package_tag_digest');
  });

  it('verified — picks the correct version when multiple exist and ignores the latest-only one', async () => {
    const stubs = makeStubs({
      versions: [
        // Newer version, only :latest — would be wrong if we matched on
        // position. Must be skipped because digest != deployedDigest.
        {
          name: DIGEST_C,
          metadata: { container: { tags: ['latest'] } },
        },
        // Older version, has the actual SHA tag.
        {
          name: DIGEST_B,
          metadata: { container: { tags: [SHA_HEAD_OLDER] } },
        },
      ],
      runForSha: {
        [SHA_HEAD_OLDER]: makeRun({
          headSha: SHA_HEAD_OLDER,
          htmlUrl: 'https://github.com/o/r/actions/runs/older',
        }),
      },
      successfulRuns: null,
      githubConfigured: true,
    });
    const svc = new ProvenanceService(repo, stubs.githubApp, stubs.githubClient);

    const result = await svc.resolve({
      imageOwner: 'o',
      imageName: 'r',
      digest: DIGEST_B,
    });

    expect(result.confidence).toBe('verified');
    expect(result.sourceSha).toBe(SHA_HEAD_OLDER);
  });

  it('estimated — GHCR lookup returns null, falls back to time-window heuristic', async () => {
    const stubs = makeStubs({
      versions: null, // 404 / 403 from GHCR
      runForSha: {},
      successfulRuns: [
        makeRun({
          headSha: SHA_HEAD_OLDER,
          updatedAt: '2026-05-21T00:09:00Z',
          htmlUrl: 'https://github.com/o/r/actions/runs/older',
        }),
        makeRun({
          headSha: SHA_HEAD_NEWER,
          // Closest before deployedAt — should be picked.
          updatedAt: '2026-05-21T00:09:55Z',
          htmlUrl: 'https://github.com/o/r/actions/runs/newer',
        }),
      ],
      githubConfigured: true,
    });
    const svc = new ProvenanceService(repo, stubs.githubApp, stubs.githubClient);

    const result = await svc.resolve({
      imageOwner: 'o',
      imageName: 'r',
      digest: DIGEST_A,
      timeContext: { deployedAt: '2026-05-21T00:10:00Z' },
    });

    expect(result.confidence).toBe('estimated');
    expect(result.method).toBe('time_window');
    expect(result.evidence).toBe('time_window_estimate');
    expect(result.sourceSha).toBe(SHA_HEAD_NEWER);
  });

  it('unknown — no workflow runs available, no GHCR match', async () => {
    const stubs = makeStubs({
      versions: [],
      runForSha: {},
      successfulRuns: [],
      githubConfigured: true,
    });
    const svc = new ProvenanceService(repo, stubs.githubApp, stubs.githubClient);

    const result = await svc.resolve({
      imageOwner: 'o',
      imageName: 'r',
      digest: DIGEST_A,
      timeContext: { deployedAt: '2026-05-21T00:00:00Z' },
    });

    expect(result.confidence).toBe('unknown');
    expect(result.sourceSha).toBeNull();
    expect(result.sourceRunUrl).toBeNull();
    expect(result.method).toBe('none');
  });

  it('caches verified result; second resolve does not call GitHub again', async () => {
    const stubs = makeStubs({
      versions: [
        {
          name: DIGEST_A,
          metadata: { container: { tags: [SHA_HEAD_NEWER] } },
        },
      ],
      runForSha: { [SHA_HEAD_NEWER]: makeRun({ headSha: SHA_HEAD_NEWER }) },
      successfulRuns: null,
      githubConfigured: true,
    });
    const svc = new ProvenanceService(repo, stubs.githubApp, stubs.githubClient);

    await svc.resolve({ imageOwner: 'o', imageName: 'r', digest: DIGEST_A });
    await svc.resolve({ imageOwner: 'o', imageName: 'r', digest: DIGEST_A });

    // Verified rows are permanent — second call must hit cache, not GitHub.
    expect(stubs.githubApp.listUserPackageVersions).toHaveBeenCalledTimes(1);
    expect(stubs.githubApp.getInstallationTokenForRepo).toHaveBeenCalledTimes(1);
  });

  it('persists unknown row on transient GitHub error so the next request short-circuits', async () => {
    const stubs = makeStubs({
      versions: null,
      versionsErr: new Error('ENOTFOUND api.github.com'),
      runForSha: {},
      successfulRuns: null,
      githubConfigured: true,
    });
    const svc = new ProvenanceService(repo, stubs.githubApp, stubs.githubClient);

    const result = await svc.resolve({
      imageOwner: 'o',
      imageName: 'r',
      digest: DIGEST_A,
    });
    expect(result.confidence).toBe('unknown');
    expect(result.evidence).toMatch(/^error:/);
    // Row is persisted; isStale for unknown is 1h, so within the test the
    // record exists.
    const cached = repo.find('o', 'r', DIGEST_A);
    expect(cached?.confidence).toBe('unknown');
  });
});
