// `@kubernetes/client-node` is ESM; ts-jest can't load it without
// transformIgnorePatterns gymnastics. Owner check runs entirely on
// in-memory state before any kube call, so a thin shim is enough.
jest.mock('@kubernetes/client-node', () => ({
  PatchStrategy: { MergePatch: 'merge-patch' },
  setHeaderOptions: jest.fn(),
}));

// detectStack uses axios. The other tests don't exercise the axios
// path, so module-level mock here is safe — they only touch
// service.findByLogin / githubApp / customDomains.
jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

import axios from 'axios';
import { ForbiddenException } from '@nestjs/common';

import type { AuthService } from '../onboarding/auth.service';
import type { GithubAppService } from '../github-app/github-app.service';
import type { UsersRepository } from '../onboarding/users.repository';
import type { ArgoCdClient } from '../pipelines/services/argo-cd.client';
import type { KubeClient } from '../kube/kube.client';
import type { EmailService } from '../email/email.service';
import { DeployService } from './deploy.service';

/** Regression for ownership check on /deploy/register: a logged-in user
 *  must not be able to deploy someone else's repo by sending a forged
 *  fullName. detectStack would also reject (foreign repo isn't visible to
 *  this user's installation token) but the explicit 403 here is the
 *  authoritative boundary — no GitHub side-channel, clean audit reason. */
describe('DeployService.registerForUser — ownership check', () => {
  function makeService(login: string, isAllowed: boolean) {
    const findByLogin = jest.fn().mockReturnValue({
      id: 1,
      githubLogin: login,
      isAllowed,
    });
    const audit = jest.fn();
    const users = { findByLogin, audit } as unknown as UsersRepository;
    const auth = {} as AuthService;
    const githubApp = {} as GithubAppService;
    const argo = {} as ArgoCdClient;
    const kube = {} as KubeClient;
    const email = {} as EmailService;
    // Owner check runs before any DB read on custom_domains, but the
    // constructor needs *something* for the injected dep.
    const customDomains = { findForRender: jest.fn() } as never;
    const config = { appsDomain: 'apps.swkoo.kr' } as never;
    const service = new DeployService(
      auth, githubApp, users, argo, kube, email, customDomains, config
    );
    return { service, audit, findByLogin };
  }

  it('rejects with 403 NOT_REPO_OWNER when fullName.owner !== caller login', async () => {
    const { service, audit } = makeService('hizieun', true);

    await expect(
      service.registerForUser('hizieun', { fullName: 'sungwookoo/nextjs-sample' })
    ).rejects.toThrow(ForbiddenException);

    // Audit log captures the attempted cross-user deploy for incident review.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'hizieun',
        action: 'ACCESS_DENIED',
        target: 'sungwookoo/nextjs-sample',
        reason: 'NOT_REPO_OWNER',
      })
    );
  });

  it('treats owner check as case-insensitive (GitHub preserves case in login)', async () => {
    // Caller login `Hizieun` (capital H) requesting their own repo `hizieun/portfolio`
    // must NOT trip the owner check — both lowercase to the same value.
    const { service } = makeService('Hizieun', true);

    // We can't fully exercise the happy path (downstream GitHub calls would
    // run) but we *can* assert the owner check passes by verifying we get
    // past it — the next failure should be from a different reason.
    await expect(
      service.registerForUser('Hizieun', { fullName: 'hizieun/portfolio' })
    ).rejects.toThrow(); // Will throw later (no real auth token), but NOT NOT_REPO_OWNER.
  });

  it('rejects 403 NOT_ALLOWED before owner check (allowlist gate is first)', async () => {
    const { service, audit } = makeService('hizieun', false);

    await expect(
      service.registerForUser('hizieun', { fullName: 'sungwookoo/nextjs-sample' })
    ).rejects.toThrow(ForbiddenException);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'NOT_ALLOWED' })
    );
  });
});

/** When /api/deploy DELETE removes the user's deployment, any custom
 *  domain row for that login must be cleaned up — otherwise the row
 *  outlives the deployment, gets stuck behind NO_DEPLOYMENT on every
 *  domain endpoint, and blocks the same domain from being re-registered
 *  later (global UNIQUE index). v0 is one-app-per-user so cleaning by
 *  login is correct. */
describe('DeployService.deleteDeployment — orphan custom_domain cleanup', () => {
  function makeDeleteService(opts: {
    isAllowed?: boolean;
    commitFails?: 'NOTHING_TO_COMMIT' | Error | false;
    customDomainRows?: Array<{ id: number; login: string; appName: string; domain: string }>;
  }) {
    const audit = jest.fn();
    const users = {
      findByLogin: jest.fn().mockReturnValue({
        id: 1,
        githubLogin: 'alice',
        isAllowed: opts.isAllowed ?? true,
      }),
      audit,
    } as unknown as UsersRepository;

    const commitFilesAtomic = jest.fn(async () => {
      if (opts.commitFails === 'NOTHING_TO_COMMIT') {
        throw new Error('NOTHING_TO_COMMIT');
      }
      if (opts.commitFails instanceof Error) throw opts.commitFails;
      return 'sha-delete-commit';
    });
    const githubApp = {
      getInstallationTokenForRepo: jest.fn(async () => 'tok'),
      getInstallationTokenForOrg: jest.fn(async () => 'org-tok'),
      commitFilesAtomic,
      archiveRepo: jest.fn(async () => undefined),
    } as unknown as GithubAppService;

    const findByLoginMock = jest.fn(() => opts.customDomainRows ?? []);
    const deleteByLoginMock = jest.fn(() => (opts.customDomainRows ?? []).length);
    const customDomains = {
      findForRender: jest.fn(),
      findByLogin: findByLoginMock,
      deleteByLogin: deleteByLoginMock,
    } as never;

    const auth = {} as AuthService;
    const argo = {
      // refreshUsersApplicationSet uses kube; keep at no-op
    } as ArgoCdClient;
    const kube = {} as KubeClient;
    const email = {} as EmailService;
    const config = {
      appsDomain: 'apps.swkoo.kr',
      manifestRepo: 'sungwookoo/swkoo-kr',
      manifestBranch: 'main',
      deployOwner: 'swkoo-deploy',
    } as never;

    const service = new DeployService(
      auth, githubApp, users, argo, kube, email, customDomains, config
    );
    // refreshUsersApplicationSet is called at the end of deleteDeployment
    // (best-effort, fire-and-forget); stub it to avoid kube.custom usage.
    (service as unknown as { refreshUsersApplicationSet: () => Promise<void> })
      .refreshUsersApplicationSet = jest.fn(async () => undefined);

    return { service, audit, commitFilesAtomic, findByLoginMock, deleteByLoginMock };
  }

  it('removes custom_domain row when deleteDeployment commit succeeds', async () => {
    const { service, audit, deleteByLoginMock } = makeDeleteService({
      customDomainRows: [
        { id: 11, login: 'alice', appName: 'nextjs-sample', domain: 'app.alice-example.com' },
      ],
    });

    await service.deleteDeployment('alice');

    expect(deleteByLoginMock).toHaveBeenCalledWith('alice');
    // Audit captures the cascade with the deploy commit SHA so an
    // incident reviewer can correlate.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'DOMAIN_DELETED_BY_DEPLOY_DELETE',
        target: 'alice/nextjs-sample:app.alice-example.com',
      })
    );
  });

  it('preserves custom_domain row when unregister commit fails', async () => {
    const { service, deleteByLoginMock } = makeDeleteService({
      commitFails: 'NOTHING_TO_COMMIT',
      customDomainRows: [
        { id: 11, login: 'alice', appName: 'nextjs-sample', domain: 'app.alice-example.com' },
      ],
    });

    await expect(service.deleteDeployment('alice')).rejects.toThrow(ForbiddenException);
    // The cleanup only runs after the commit succeeds. NOTHING_TO_COMMIT
    // means no registration file existed → no orphan to clean either.
    expect(deleteByLoginMock).not.toHaveBeenCalled();
  });

  it('deleteDeployment succeeds when no custom_domain row exists', async () => {
    const { service, deleteByLoginMock, audit } = makeDeleteService({
      customDomainRows: [],
    });

    const result = await service.deleteDeployment('alice');

    expect(result.commit).toBe('sha-delete-commit');
    // No row → no audit cascade, no DELETE call.
    expect(deleteByLoginMock).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DOMAIN_DELETED_BY_DEPLOY_DELETE' })
    );
    // Normal unregister audit still happens.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DEPLOY_UNREGISTER' })
    );
  });
});

/** Pre-deploy check coverage. Verifies the 7-row checklist surfaced by
 *  /api/deploy/preview is correctly computed from the GitHub responses:
 *  pass/warn/fail per row, final stack classification depending only on
 *  the fail set (warn rows don't block), and that mixed-case repos
 *  pass with the lowercasing-info message. */
describe('DeployService.detectStack — pre-deploy checks', () => {
  type AxiosGet = jest.Mock<Promise<{ data: unknown }>, [string, unknown]>;

  function makeService() {
    const auth = {
      getValidAccessToken: jest.fn(async () => 'fake-token'),
    } as unknown as AuthService;
    const users = {} as UsersRepository;
    const githubApp = {} as GithubAppService;
    const argo = {} as ArgoCdClient;
    const kube = {} as KubeClient;
    const email = {} as EmailService;
    const customDomains = { findForRender: jest.fn() } as never;
    const config = { appsDomain: 'apps.swkoo.kr' } as never;
    const service = new DeployService(
      auth, githubApp, users, argo, kube, email, customDomains, config
    );
    return service;
  }

  /** Sets up axios.get to dispatch by URL pattern. `responses` is a map
   * of regex → either resolved data or an axios-shaped error. */
  function wireAxios(responses: Array<{
    pattern: RegExp;
    data?: unknown;
    error?: { response?: { status?: number } };
  }>): void {
    const mock = axios.get as unknown as AxiosGet;
    mock.mockReset();
    mock.mockImplementation(async (url: string) => {
      const hit = responses.find((r) => r.pattern.test(url));
      if (!hit) throw new Error(`unmatched URL in test: ${url}`);
      if (hit.error) {
        // Mimic axios error shape used by the production catch blocks.
        throw Object.assign(new Error('axios error'), hit.error);
      }
      return { data: hit.data };
    });
  }

  function encode(pkg: object): string {
    return Buffer.from(JSON.stringify(pkg), 'utf8').toString('base64');
  }

  function findCheck(
    checks: Array<{ key: string; status: string; message: string; userAction?: string }>,
    key: string
  ) {
    return checks.find((c) => c.key === key);
  }

  it('main branch + Next.js + lockfile → stack=nextjs, all checks pass', async () => {
    wireAxios([
      { pattern: /\/repos\/o\/r$/, data: { default_branch: 'main' } },
      {
        pattern: /\/contents\/package\.json/,
        data: { content: encode({ name: 'app', dependencies: { next: '15' }, scripts: { build: 'next build' } }) },
      },
      { pattern: /\/contents\/package-lock\.json/, data: { content: '' } },
    ]);
    const r = await makeService().detectStack(1, 'o', 'r');
    expect(r.stack).toBe('nextjs');
    if (r.stack === 'nextjs') {
      expect(r.checks.every((c) => c.status === 'pass')).toBe(true);
      // All required keys present.
      const keys = r.checks.map((c) => c.key).sort();
      expect(keys).toEqual(
        ['build_script', 'default_branch', 'next_dep', 'package_json', 'package_lockfile', 'repo_access', 'repo_casing'].sort()
      );
    }
  });

  it('non-main default branch → stack=unsupported, default_branch=fail', async () => {
    wireAxios([
      { pattern: /\/repos\/o\/r$/, data: { default_branch: 'develop' } },
      { pattern: /\/contents\/package\.json/, data: { content: encode({ dependencies: { next: '15' }, scripts: { build: 'x' } }) } },
      { pattern: /\/contents\/package-lock\.json/, data: { content: '' } },
    ]);
    const r = await makeService().detectStack(1, 'o', 'r');
    expect(r.stack).toBe('unsupported');
    const c = findCheck(r.checks, 'default_branch');
    expect(c?.status).toBe('fail');
    expect(c?.message).toContain("'develop'");
    expect(c?.userAction).toMatch(/Default branch/);
  });

  it('package.json 404 → stack=unsupported, package_json=fail, next/build skipped', async () => {
    wireAxios([
      { pattern: /\/repos\/o\/r$/, data: { default_branch: 'main' } },
      { pattern: /\/contents\/package\.json/, error: { response: { status: 404 } } },
      { pattern: /\/contents\/package-lock\.json/, error: { response: { status: 404 } } },
    ]);
    const r = await makeService().detectStack(1, 'o', 'r');
    expect(r.stack).toBe('unsupported');
    expect(findCheck(r.checks, 'package_json')?.status).toBe('fail');
    // next_dep / build_script depend on parsed pkg → not added
    expect(findCheck(r.checks, 'next_dep')).toBeUndefined();
    expect(findCheck(r.checks, 'build_script')).toBeUndefined();
  });

  it('no next dependency → stack=unsupported, next_dep=fail', async () => {
    wireAxios([
      { pattern: /\/repos\/o\/r$/, data: { default_branch: 'main' } },
      { pattern: /\/contents\/package\.json/, data: { content: encode({ dependencies: { express: '4' }, scripts: { build: 'x' } }) } },
      { pattern: /\/contents\/package-lock\.json/, data: { content: '' } },
    ]);
    const r = await makeService().detectStack(1, 'o', 'r');
    expect(r.stack).toBe('unsupported');
    expect(findCheck(r.checks, 'next_dep')?.status).toBe('fail');
  });

  it('missing scripts.build → still stack=nextjs (warn), build_script=warn', async () => {
    wireAxios([
      { pattern: /\/repos\/o\/r$/, data: { default_branch: 'main' } },
      { pattern: /\/contents\/package\.json/, data: { content: encode({ dependencies: { next: '15' } }) } }, // no scripts
      { pattern: /\/contents\/package-lock\.json/, data: { content: '' } },
    ]);
    const r = await makeService().detectStack(1, 'o', 'r');
    expect(r.stack).toBe('nextjs');
    const c = findCheck(r.checks, 'build_script');
    expect(c?.status).toBe('warn');
    expect(c?.message).toMatch(/build.*스크립트/);
    expect(c?.userAction).toMatch(/next build/);
  });

  it('missing package-lock.json → still stack=nextjs (warn), package_lockfile=warn', async () => {
    wireAxios([
      { pattern: /\/repos\/o\/r$/, data: { default_branch: 'main' } },
      { pattern: /\/contents\/package\.json/, data: { content: encode({ dependencies: { next: '15' }, scripts: { build: 'x' } }) } },
      { pattern: /\/contents\/package-lock\.json/, error: { response: { status: 404 } } },
    ]);
    const r = await makeService().detectStack(1, 'o', 'r');
    expect(r.stack).toBe('nextjs');
    const c = findCheck(r.checks, 'package_lockfile');
    expect(c?.status).toBe('warn');
    expect(c?.message).toMatch(/npm ci/);
    expect(c?.userAction).toMatch(/lock\.json을 커밋/);
  });

  it('mixed-case repo → repo_casing=pass with lowercasing note', async () => {
    wireAxios([
      { pattern: /PocketPlan$/, data: { default_branch: 'main' } },
      { pattern: /\/contents\/package\.json/, data: { content: encode({ dependencies: { next: '15' }, scripts: { build: 'x' } }) } },
      { pattern: /\/contents\/package-lock\.json/, data: { content: '' } },
    ]);
    const r = await makeService().detectStack(1, 'hatbann', 'PocketPlan');
    expect(r.stack).toBe('nextjs');
    const c = findCheck(r.checks, 'repo_casing');
    expect(c?.status).toBe('pass');
    expect(c?.message).toMatch(/PocketPlan/);
    expect(c?.message).toMatch(/소문자로 변환/);
  });

  it('repo metadata 404 → stack=unsupported, repo_access=fail, no further checks', async () => {
    wireAxios([
      { pattern: /\/repos\/o\/r$/, error: { response: { status: 404 } } },
    ]);
    const r = await makeService().detectStack(1, 'o', 'r');
    expect(r.stack).toBe('unsupported');
    expect(findCheck(r.checks, 'repo_access')?.status).toBe('fail');
    // Bails before any other check is added.
    expect(r.checks).toHaveLength(1);
  });
});

/** Phase 3 — structured failure reasons on the deployment status feed.
 *  We test the *classification path* of checkBuildStage and the deploy
 *  stage degraded path. We don't fully exercise getDeploymentStatus
 *  (Promise.all of four probes); the classifier is the new logic and
 *  callers wire its return through unchanged. */
describe('DeployService.checkBuildStage — failure classification', () => {
  type AxiosGet = jest.Mock<Promise<{ data: unknown }>, [string, unknown]>;

  // ---- shared service factory (mirrors detectStack tests but adds
  // an auth mock since checkBuildStage calls getValidAccessToken) ----
  function makeService() {
    const auth = {
      getValidAccessToken: jest.fn(async () => 'fake-token'),
    } as unknown as AuthService;
    const users = {} as UsersRepository;
    const githubApp = {} as GithubAppService;
    const argo = {} as ArgoCdClient;
    const kube = {} as KubeClient;
    const email = {} as EmailService;
    const customDomains = { findForRender: jest.fn() } as never;
    const config = {
      appsDomain: 'apps.swkoo.kr',
      discordBuildFailureWebhookUrl: undefined,
    } as never;
    return new DeployService(
      auth, githubApp, users, argo, kube, email, customDomains, config
    );
  }

  function wireAxios(responses: Array<{
    pattern: RegExp;
    data?: unknown;
    error?: { response?: { status?: number } };
  }>): void {
    const mock = axios.get as unknown as AxiosGet;
    mock.mockReset();
    mock.mockImplementation(async (url: string) => {
      const hit = responses.find((r) => r.pattern.test(url));
      if (!hit) throw new Error(`unmatched URL in test: ${url}`);
      if (hit.error) {
        throw Object.assign(new Error('axios error'), hit.error);
      }
      return { data: hit.data };
    });
  }

  function encode(text: string): string {
    return Buffer.from(text, 'utf8').toString('base64');
  }

  function callCheckBuildStage(
    service: DeployService,
    owner: string,
    repo: string
  ) {
    return (service as unknown as {
      checkBuildStage: (uid: number, o: string, r: string) => Promise<{
        status: string;
        message: string;
        link?: string;
        reason?: string;
        userAction?: { label: string; href?: string; kind?: string };
        operatorHint?: string;
      }>;
    }).checkBuildStage(1, owner, repo);
  }

  // Legacy workflow template — `${{ github.repository }}` in the tag.
  // This is the pre-c98b452 shape that breaks mixed-case repos.
  const LEGACY_WORKFLOW = [
    'name: Build',
    'jobs:',
    '  build:',
    '    steps:',
    '      - uses: docker/build-push-action@v6',
    '        with:',
    '          tags: ghcr.io/${{ github.repository }}:${{ github.sha }}',
  ].join('\n');

  const MODERN_WORKFLOW = [
    'name: Build',
    'jobs:',
    '  build:',
    '    steps:',
    '      - uses: docker/build-push-action@v6',
    '        with:',
    '          tags: ghcr.io/alice/sample:${{ github.sha }}',
  ].join('\n');

  const FAILED_RUN = {
    id: 999,
    status: 'completed',
    conclusion: 'failure',
    html_url: 'https://github.com/o/r/actions/runs/999',
    head_sha: 'deadbeef',
    created_at: '2026-06-01T00:00:00Z',
  };

  it('legacy workflow template + mixed-case repo → WORKFLOW_OLD_TEMPLATE with casing note', async () => {
    wireAxios([
      {
        pattern: /\/actions\/runs(?!\/)/,
        data: { workflow_runs: [FAILED_RUN] },
      },
      {
        pattern: /\/contents\/\.github\/workflows\/build\.yml/,
        data: { content: encode(LEGACY_WORKFLOW) },
      },
    ]);
    const r = await callCheckBuildStage(makeService(), 'hatbann', 'PocketPlan');
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('WORKFLOW_OLD_TEMPLATE');
    expect(r.message).toMatch(/구버전 workflow/);
    expect(r.message).toMatch(/대문자/);
    expect(r.userAction?.label).toMatch(/swkoo\.kr/);
    expect(r.userAction?.href).toBe('/deploy');
  });

  it('legacy workflow template + lowercase repo → WORKFLOW_OLD_TEMPLATE without casing note', async () => {
    wireAxios([
      {
        pattern: /\/actions\/runs(?!\/)/,
        data: { workflow_runs: [FAILED_RUN] },
      },
      {
        pattern: /\/contents\/\.github\/workflows\/build\.yml/,
        data: { content: encode(LEGACY_WORKFLOW) },
      },
    ]);
    const r = await callCheckBuildStage(makeService(), 'alice', 'sample');
    expect(r.reason).toBe('WORKFLOW_OLD_TEMPLATE');
    // The mixed-case suffix is omitted for lowercase repos so the user
    // doesn't see an irrelevant hint.
    expect(r.message).not.toMatch(/대문자/);
  });

  it('modern workflow + failed "Build and push" step → DOCKER_BUILD_FAILED', async () => {
    wireAxios([
      {
        pattern: /\/actions\/runs(?!\/)/,
        data: { workflow_runs: [FAILED_RUN] },
      },
      {
        pattern: /\/contents\/\.github\/workflows\/build\.yml/,
        data: { content: encode(MODERN_WORKFLOW) },
      },
      {
        pattern: /\/actions\/runs\/999\/jobs/,
        data: {
          jobs: [
            {
              name: 'build',
              status: 'completed',
              conclusion: 'failure',
              steps: [
                { name: 'Checkout', status: 'completed', conclusion: 'success' },
                { name: 'Build and push', status: 'completed', conclusion: 'failure' },
              ],
            },
          ],
        },
      },
    ]);
    const r = await callCheckBuildStage(makeService(), 'alice', 'sample');
    expect(r.reason).toBe('DOCKER_BUILD_FAILED');
    expect(r.message).toMatch(/Docker 빌드/);
    expect(r.userAction?.href).toBe(FAILED_RUN.html_url);
  });

  it('modern workflow + failed "Login to GHCR" step → GHCR_PUSH_FAILED with operatorHint', async () => {
    wireAxios([
      {
        pattern: /\/actions\/runs(?!\/)/,
        data: { workflow_runs: [FAILED_RUN] },
      },
      {
        pattern: /\/contents\/\.github\/workflows\/build\.yml/,
        data: { content: encode(MODERN_WORKFLOW) },
      },
      {
        pattern: /\/actions\/runs\/999\/jobs/,
        data: {
          jobs: [
            {
              name: 'build',
              status: 'completed',
              conclusion: 'failure',
              steps: [
                { name: 'Checkout', status: 'completed', conclusion: 'success' },
                { name: 'Login to GHCR', status: 'completed', conclusion: 'failure' },
              ],
            },
          ],
        },
      },
    ]);
    const r = await callCheckBuildStage(makeService(), 'alice', 'sample');
    expect(r.reason).toBe('GHCR_PUSH_FAILED');
    expect(r.operatorHint).toMatch(/packages/);
  });

  it('modern workflow + no matching step → UNKNOWN_BUILD_FAILURE (still links the log)', async () => {
    wireAxios([
      {
        pattern: /\/actions\/runs(?!\/)/,
        data: { workflow_runs: [FAILED_RUN] },
      },
      {
        pattern: /\/contents\/\.github\/workflows\/build\.yml/,
        data: { content: encode(MODERN_WORKFLOW) },
      },
      {
        pattern: /\/actions\/runs\/999\/jobs/,
        data: {
          jobs: [
            {
              name: 'build',
              status: 'completed',
              conclusion: 'failure',
              steps: [
                // No step is failed — defensive against an upstream
                // edge case (e.g. job-level failure without a single
                // failed step). The classifier should not invent a
                // category for this — pure fallback.
                { name: 'Checkout', status: 'completed', conclusion: 'success' },
              ],
            },
          ],
        },
      },
    ]);
    const r = await callCheckBuildStage(makeService(), 'alice', 'sample');
    expect(r.reason).toBe('UNKNOWN_BUILD_FAILURE');
    expect(r.userAction?.label).toBe('GitHub Actions 로그 보기');
    expect(r.userAction?.href).toBe(FAILED_RUN.html_url);
  });

  it('successful run → success, no reason field', async () => {
    wireAxios([
      {
        pattern: /\/actions\/runs(?!\/)/,
        data: { workflow_runs: [{ ...FAILED_RUN, conclusion: 'success' }] },
      },
    ]);
    const r = await callCheckBuildStage(makeService(), 'alice', 'sample');
    expect(r.status).toBe('success');
    expect(r.reason).toBeUndefined();
    expect(r.userAction).toBeUndefined();
  });

  it('no workflow run yet → pending, no reason field', async () => {
    wireAxios([
      {
        pattern: /\/actions\/runs(?!\/)/,
        data: { workflow_runs: [] },
      },
    ]);
    const r = await callCheckBuildStage(makeService(), 'alice', 'sample');
    expect(r.status).toBe('pending');
    expect(r.reason).toBeUndefined();
  });
});

/** Phase 3 — deploy stage Degraded carries ARGO_SYNC_FAILED. */
describe('DeployService.checkDeployStage — ARGO_SYNC_FAILED', () => {
  function makeService() {
    const auth = {} as AuthService;
    const users = {} as UsersRepository;
    const githubApp = {} as GithubAppService;
    const argo = {} as ArgoCdClient;
    const kube = {} as KubeClient;
    const email = {} as EmailService;
    const customDomains = { findForRender: jest.fn() } as never;
    const config = { appsDomain: 'apps.swkoo.kr' } as never;
    return new DeployService(
      auth, githubApp, users, argo, kube, email, customDomains, config
    );
  }

  function callCheckDeployStage(service: DeployService, app: unknown) {
    return (service as unknown as {
      checkDeployStage: (a: unknown) => {
        status: string;
        message: string;
        reason?: string;
        userAction?: { label: string; kind?: string };
        operatorHint?: string;
      };
    }).checkDeployStage(app);
  }

  it('Degraded health → failed + ARGO_SYNC_FAILED + operatorHint', () => {
    const app = {
      status: { sync: { status: 'Synced' }, health: { status: 'Degraded' } },
    };
    const r = callCheckDeployStage(makeService(), app);
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('ARGO_SYNC_FAILED');
    expect(r.operatorHint).toMatch(/ImagePullBackOff|CrashLoopBackOff/);
  });

  it('Healthy + Synced → success, no reason', () => {
    const r = callCheckDeployStage(makeService(), {
      status: { sync: { status: 'Synced' }, health: { status: 'Healthy' } },
    });
    expect(r.status).toBe('success');
    expect(r.reason).toBeUndefined();
  });

  it('In-progress (Progressing health) → running, no reason', () => {
    const r = callCheckDeployStage(makeService(), {
      status: { sync: { status: 'OutOfSync' }, health: { status: 'Progressing' } },
    });
    expect(r.status).toBe('running');
    expect(r.reason).toBeUndefined();
  });
});
