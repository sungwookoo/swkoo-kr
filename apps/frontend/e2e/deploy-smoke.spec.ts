// Mock-only browser smoke for the swkoo.kr /deploy flow. Every /api/*
// call is intercepted via `page.route()` — we never hit a real backend,
// GitHub, K8s, or ArgoCD. The harness is to validate UI wiring (copy
// is present, CTAs route to the right URL, gated buttons stay
// disabled), not to validate backend behavior — that's covered by
// Vitest/Jest specs.
//
// Scenarios mapped to the Phase 3 spec list:
//   1) Pre-login /deploy copy + CTAs
//   2) Authenticated but no repos returned
//   3) Selected repo → preview unsupported
//   4) Selected repo → preview checks with fail
//   5) Deploy error with installUrl shape
//   6) Status page: failed build stage with structured userAction
//   7) Custom domain apex (APEX_NOT_SUPPORTED) → www CTA
//   8) Custom domain CNAME conflict (DNS_CNAME_CONFLICTS_WITH_A)
import { expect, test } from '@playwright/test';

import { ALICE, installCatchAll, json, mockAuthenticatedAs } from './fixtures';

test.beforeEach(async ({ page }) => {
  // Always wire the catch-all FIRST so per-test handlers (registered
  // later) take precedence — Playwright walks handlers in reverse.
  await installCatchAll(page);
});

// ─────────────────────────────────────────────────────────────────────
// 1) Pre-login /deploy
// ─────────────────────────────────────────────────────────────────────
test('scenario 1: pre-login /deploy shows Install + Login CTAs and Authorized/Installed explanation', async ({ page }) => {
  await page.route('**/api/auth/me', async (route) => {
    // No session — backend returns 401, the SWR fetcher coerces that
    // to null, and the page renders the unauth view.
    await route.fulfill({ status: 401, body: '' });
  });

  await page.goto('/deploy');

  await expect(page.getByRole('heading', { name: 'Deploy your app' })).toBeVisible();
  // Role-scoped: the install + login links must both be anchors. We
  // hit visibility on each link rather than on the inner text node so
  // a rewrap (e.g. label inside a <span>) doesn't break the assertion.
  await expect(page.getByRole('link', { name: /GitHub App 설치하고 시작/ })).toBeVisible();
  await expect(page.getByRole('link', { name: '이미 설치했다면 로그인' })).toBeVisible();
  // Authorized / Installed explanation — checks two distinct anchor
  // words from the copy block so we catch silent rewordings.
  await expect(page.getByText(/Authorized/)).toBeVisible();
  await expect(page.getByText(/Installed/)).toBeVisible();
  // "Next.js 앱을 지원합니다" — Phase 2 copy fix regression guard.
  await expect(page.getByText(/Next\.js 앱을 지원합니다/)).toBeVisible();
});

// ─────────────────────────────────────────────────────────────────────
// 2) repo 없음
// ─────────────────────────────────────────────────────────────────────
test('scenario 2: empty repo list shows template CTA and GitHub App access link', async ({ page }) => {
  await mockAuthenticatedAs(page);
  await page.route('**/api/deploy/repos', async (route) => {
    await json(route, 200, []);
  });

  await page.goto('/deploy');

  // Authenticated header rendered.
  await expect(page.getByText(`@${ALICE.githubLogin}`)).toBeVisible();
  // Empty state copy.
  await expect(page.getByText(/본인이 owner인 GitHub repo가 아직 없네요/)).toBeVisible();
  // Template CTA links out to GitHub /generate.
  const tpl = page.getByRole('link', { name: /템플릿으로 새 repo 만들기/ });
  await expect(tpl).toBeVisible();
  await expect(tpl).toHaveAttribute(
    'href',
    'https://github.com/sungwookoo/nextjs-sample/generate'
  );
  // GitHub App access change link — for users on "Only select repositories".
  const accessLink = page.getByRole('link', { name: /여기서/ });
  await expect(accessLink).toHaveAttribute(
    'href',
    'https://github.com/apps/swkoo-deploy/installations/select_target'
  );
});

// ─────────────────────────────────────────────────────────────────────
// 3) preview unsupported
// ─────────────────────────────────────────────────────────────────────
test('scenario 3: unsupported preview shows reason + checks list, no Deploy button', async ({ page }) => {
  await mockAuthenticatedAs(page);
  await page.route('**/api/deploy/repos', async (route) => {
    await json(route, 200, [
      {
        name: 'random-script',
        fullName: 'alice/random-script',
        description: 'just a bash thing',
        language: 'Shell',
        defaultBranch: 'main',
        htmlUrl: 'https://github.com/alice/random-script',
        updatedAt: new Date().toISOString(),
        isFork: false,
        isPrivate: false,
      },
    ]);
  });
  await page.route('**/api/deploy/preview**', async (route) => {
    await json(route, 200, {
      stack: 'unsupported',
      reason: 'repo 루트에 package.json이 없어요.',
      checks: [
        { key: 'repo_access', status: 'pass', label: 'GitHub repo 접근', message: '읽기 권한이 확인됐어요.' },
        {
          key: 'package_json',
          status: 'fail',
          label: 'package.json',
          message: 'repo 루트에 package.json이 없어요.',
        },
      ],
    });
  });

  await page.goto('/deploy');
  // Select the repo (clicks the RepoCard button).
  await page.getByRole('button', { name: /random-script/ }).click();

  await expect(page.getByText('⚠️ 지원하지 않는 스택')).toBeVisible();
  // The reason text appears twice (reason paragraph + the fail row in
  // the checks list) — that's intentional. Assert ≥1 visible match.
  await expect(page.getByText(/package\.json이 없어요/).first()).toBeVisible();
  await expect(page.getByText('배포 전 점검')).toBeVisible();
  // Per gating policy: no Deploy button on unsupported preview.
  await expect(page.getByRole('button', { name: /Deploy/ })).toHaveCount(0);
});

// ─────────────────────────────────────────────────────────────────────
// 4) preview checks with fail → Deploy disabled
// ─────────────────────────────────────────────────────────────────────
test('scenario 4: preview checks render and fail row disables Deploy button', async ({ page }) => {
  await mockAuthenticatedAs(page);
  await page.route('**/api/deploy/repos', async (route) => {
    await json(route, 200, [
      {
        name: 'sample',
        fullName: 'alice/sample',
        description: 'a Next.js app',
        language: 'TypeScript',
        defaultBranch: 'develop',
        htmlUrl: 'https://github.com/alice/sample',
        updatedAt: new Date().toISOString(),
        isFork: false,
        isPrivate: false,
      },
    ]);
  });
  // Synthetic: stack=nextjs but default_branch fails. Tests defense in
  // depth — the button reads check status, not just preview.stack.
  await page.route('**/api/deploy/preview**', async (route) => {
    await json(route, 200, {
      stack: 'nextjs',
      packageName: 'sample',
      port: 3000,
      nodeEngine: null,
      checks: [
        { key: 'repo_access', status: 'pass', label: 'GitHub repo 접근', message: '읽기 권한이 확인됐어요.' },
        {
          key: 'default_branch',
          status: 'fail',
          label: '기본 브랜치',
          message: "기본 브랜치가 'main'이 아닙니다 (현재: 'develop').",
          userAction: "GitHub repo Settings → Branches → Default branch에서 'main'으로 변경 후 다시 시도해 주세요.",
        },
        { key: 'package_json', status: 'pass', label: 'package.json', message: 'repo 루트에 package.json이 있어요.' },
        { key: 'next_dep', status: 'pass', label: 'Next.js 의존성', message: 'package.json에 next가 포함돼 있어요.' },
        { key: 'build_script', status: 'pass', label: 'scripts.build', message: 'package.json에 build 스크립트가 있어요.' },
        {
          key: 'package_lockfile',
          status: 'warn',
          label: 'package-lock.json',
          message: 'package-lock.json이 없어요. swkoo.kr의 자동 빌드는 npm ci를 사용하기 때문에 lockfile이 없으면 빌드가 실패합니다.',
          userAction: '로컬에서 npm install 후 생성된 package-lock.json을 커밋해 주세요.',
        },
        { key: 'repo_casing', status: 'pass', label: 'Repo 이름 casing', message: 'lowercase repo 이름이에요. 별도 처리 필요 없어요.' },
      ],
    });
  });

  await page.goto('/deploy');
  await page.getByRole('button', { name: /sample/ }).first().click();

  await expect(page.getByText('배포 전 점검')).toBeVisible();
  // fail + warn rows render their userAction hint as "→ ...".
  await expect(page.getByText(/Settings → Branches/)).toBeVisible();
  await expect(page.getByText(/lockfile을.+커밋|package-lock.json을 커밋/)).toBeVisible();

  // Deploy button: present + disabled + gate copy.
  const deploy = page.getByRole('button', { name: /Deploy/ });
  await expect(deploy).toBeVisible();
  await expect(deploy).toBeDisabled();
  await expect(
    page.getByText(/위 점검에서 ✕ 항목이 있어 배포를 시작할 수 없습니다/)
  ).toBeVisible();
});

// ─────────────────────────────────────────────────────────────────────
// 5) Deploy error with installUrl
// ─────────────────────────────────────────────────────────────────────
test('scenario 5: deploy register error with installUrl shows both recovery links', async ({ page }) => {
  await mockAuthenticatedAs(page);
  await page.route('**/api/deploy/repos', async (route) => {
    await json(route, 200, [
      {
        name: 'sample',
        fullName: 'alice/sample',
        description: 'a Next.js app',
        language: 'TypeScript',
        defaultBranch: 'main',
        htmlUrl: 'https://github.com/alice/sample',
        updatedAt: new Date().toISOString(),
        isFork: false,
        isPrivate: false,
      },
    ]);
  });
  await page.route('**/api/deploy/preview**', async (route) => {
    await json(route, 200, {
      stack: 'nextjs',
      packageName: 'sample',
      port: 3000,
      nodeEngine: null,
      checks: [
        { key: 'repo_access', status: 'pass', label: 'GitHub repo 접근', message: '읽기 권한이 확인됐어요.' },
        { key: 'default_branch', status: 'pass', label: '기본 브랜치', message: "기본 브랜치가 'main'이에요." },
        { key: 'package_json', status: 'pass', label: 'package.json', message: 'repo 루트에 package.json이 있어요.' },
        { key: 'next_dep', status: 'pass', label: 'Next.js 의존성', message: 'package.json에 next가 포함돼 있어요.' },
        { key: 'build_script', status: 'pass', label: 'scripts.build', message: 'package.json에 build 스크립트가 있어요.' },
        { key: 'package_lockfile', status: 'pass', label: 'package-lock.json', message: 'lockfile이 커밋돼 있어요.' },
        { key: 'repo_casing', status: 'pass', label: 'Repo 이름 casing', message: 'lowercase repo 이름이에요. 별도 처리 필요 없어요.' },
      ],
    });
  });
  // /register fails with the structured 403 shape from registerForUser.
  await page.route('**/api/deploy/register', async (route) => {
    await json(route, 403, {
      statusCode: 403,
      message: {
        reason: 'APP_NOT_INSTALLED_ON_USER_REPO',
        message: 'alice/sample 에 swkoo.kr GitHub App이 설치되어 있지 않습니다. 해당 repo에 App을 추가하고 다시 시도해주세요.',
        installUrl: 'https://github.com/apps/swkoo-deploy/installations/new',
      },
    });
  });

  await page.goto('/deploy');
  await page.getByRole('button', { name: /sample/ }).first().click();
  // Click Deploy to trigger the failed /register.
  await page.getByRole('button', { name: /Deploy/ }).click();

  // Both recovery anchors visible after the error.
  const installLink = page.getByRole('link', { name: /이 repo에 App 설치하기/ });
  await expect(installLink).toHaveAttribute(
    'href',
    'https://github.com/apps/swkoo-deploy/installations/new'
  );
  const accessLink = page.getByRole('link', { name: /GitHub에서 repo access 변경/ });
  await expect(accessLink).toHaveAttribute(
    'href',
    'https://github.com/apps/swkoo-deploy/installations/select_target'
  );
  // Explanation prose.
  await expect(page.getByText(/All repositories/)).toBeVisible();
});

// ─────────────────────────────────────────────────────────────────────
// 6) Status page: failed build with structured userAction
// ─────────────────────────────────────────────────────────────────────
test('scenario 6: failed build stage shows "다음 조치" CTA and GitHub Actions log link', async ({ page }) => {
  await mockAuthenticatedAs(page);
  // The status page also reads env vars + domain; null-out anything
  // it touches to keep the test focused on StageRow rendering.
  await page.route('**/api/deploy/env/**', async (route) => {
    await json(route, 200, { vars: {} });
  });
  await page.route('**/api/deploy/domain/**', async (route) => {
    // 404 NO_DEPLOYMENT hides the DomainPanel entirely — clean
    // isolation for the StageRow assertions.
    await json(route, 404, {
      statusCode: 404,
      message: { reason: 'NO_DEPLOYMENT', message: 'no active deployment' },
    });
  });
  await page.route('**/api/deploy/status/**', async (route) => {
    await json(route, 200, {
      login: 'alice',
      repo: 'sample',
      appName: 'sample',
      liveUrl: 'https://alice-sample.apps.swkoo.kr',
      stages: {
        manifests: { status: 'success', message: '매니페스트 등록 완료' },
        build: {
          status: 'failed',
          message:
            '빌드 실패: failure — 구버전 workflow 템플릿을 사용 중입니다 (repo 이름에 대문자가 포함되어 있어 lowercase GHCR 태그 규칙을 위반합니다).',
          link: 'https://github.com/alice/sample/actions/runs/999',
          reason: 'WORKFLOW_OLD_TEMPLATE',
          userAction: {
            label: 'swkoo.kr에서 다시 배포 시작 (workflow 자동 갱신)',
            href: '/deploy',
            kind: 'link',
          },
        },
        imageDetected: { status: 'pending', message: '새 이미지 감지 대기 중' },
        deploy: { status: 'pending', message: 'ArgoCD Application 감지 대기 중' },
        live: {
          status: 'pending',
          message: '라이브 URL 응답 대기 중',
          link: 'https://alice-sample.apps.swkoo.kr',
        },
      },
    });
  });

  await page.goto('/deploy/alice/sample');

  // Header shows the deployment ident.
  await expect(page.getByRole('heading', { name: 'alice/sample' })).toBeVisible();
  // Failed build row.
  await expect(page.getByText('이미지 빌드')).toBeVisible();
  await expect(page.getByText(/구버전 workflow 템플릿/)).toBeVisible();
  // The structured userAction renders under a "다음 조치" label.
  await expect(page.getByText('다음 조치')).toBeVisible();
  const cta = page.getByRole('link', { name: /swkoo\.kr에서 다시 배포 시작/ });
  await expect(cta).toHaveAttribute('href', '/deploy');
  // GitHub Actions log link kept (rendered via stage.link when not
  // shadowed by a same-href userAction).
  await expect(page.getByRole('link', { name: 'GitHub Actions 로그 보기' })).toBeVisible();
});

// ─────────────────────────────────────────────────────────────────────
// 7) Custom domain apex → APEX_NOT_SUPPORTED → www suggestion
// ─────────────────────────────────────────────────────────────────────
test('scenario 7: apex domain registration shows www.<domain> CTA', async ({ page }) => {
  await mockAuthenticatedAs(page);
  // Status page must render the DomainPanel — return current=alice/sample.
  await page.route('**/api/deploy/current', async (route) => {
    await json(route, 200, {
      login: 'alice',
      repo: 'sample',
      fullName: 'alice/sample',
      appName: 'sample',
      liveUrl: 'https://alice-sample.apps.swkoo.kr',
      syncStatus: 'Synced',
      healthStatus: 'Healthy',
      state: 'active',
    });
  });
  await page.route('**/api/deploy/env/**', async (route) => {
    await json(route, 200, { vars: {} });
  });
  await page.route('**/api/deploy/status/**', async (route) => {
    await json(route, 200, {
      login: 'alice',
      repo: 'sample',
      appName: 'sample',
      liveUrl: 'https://alice-sample.apps.swkoo.kr',
      stages: {
        manifests: { status: 'success', message: '매니페스트 등록 완료' },
        build: { status: 'success', message: '빌드 완료 (abcd123)' },
        imageDetected: { status: 'success', message: '새 이미지 감지' },
        deploy: { status: 'success', message: '배포 완료 (Synced / Healthy)' },
        live: { status: 'success', message: '응답 정상', link: 'https://alice-sample.apps.swkoo.kr' },
      },
    });
  });
  // Initial GET — no domain registered yet.
  await page.route('**/api/deploy/domain/alice/sample', async (route) => {
    if (route.request().method() === 'GET') {
      await json(route, 200, { domain: null });
      return;
    }
    if (route.request().method() === 'POST') {
      // POST registerDomain for the apex → 400 APEX_NOT_SUPPORTED with
      // the suggestion fields the panel branches on.
      await json(route, 400, {
        statusCode: 400,
        message: {
          reason: 'APEX_NOT_SUPPORTED',
          message: 'v0는 서브도메인만 지원합니다 (예: app.example.com).',
          registrableDomain: 'example.com',
          suggestedSubdomain: 'www.example.com',
        },
      });
      return;
    }
    await route.fallback();
  });

  await page.goto('/deploy/alice/sample');
  await expect(page.getByRole('heading', { name: '커스텀 도메인' })).toBeVisible();

  // Enter an apex domain and submit.
  const input = page.getByPlaceholder(/www\.your-domain\.com/);
  await input.fill('example.com');
  await page.getByRole('button', { name: '도메인 추가' }).click();

  // www CTA appears with the suggested domain.
  const wwwCta = page.getByRole('button', { name: /www\.example\.com.+사용하기/ });
  await expect(wwwCta).toBeVisible();
  await expect(page.getByText(/루트 도메인이라 직접 연결할 수 없습니다/)).toBeVisible();
});

// ─────────────────────────────────────────────────────────────────────
// 8) Custom domain CNAME conflict (existing A-record)
// ─────────────────────────────────────────────────────────────────────
test('scenario 8: CNAME conflict (DNS_CNAME_CONFLICTS_WITH_A) shows recommended subdomain + prefix input', async ({ page }) => {
  await mockAuthenticatedAs(page);
  await page.route('**/api/deploy/current', async (route) => {
    await json(route, 200, {
      login: 'alice',
      repo: 'sample',
      fullName: 'alice/sample',
      appName: 'sample',
      liveUrl: 'https://alice-sample.apps.swkoo.kr',
      syncStatus: 'Synced',
      healthStatus: 'Healthy',
      state: 'active',
    });
  });
  await page.route('**/api/deploy/env/**', async (route) => {
    await json(route, 200, { vars: {} });
  });
  await page.route('**/api/deploy/status/**', async (route) => {
    await json(route, 200, {
      login: 'alice',
      repo: 'sample',
      appName: 'sample',
      liveUrl: 'https://alice-sample.apps.swkoo.kr',
      stages: {
        manifests: { status: 'success', message: '매니페스트 등록 완료' },
        build: { status: 'success', message: '빌드 완료' },
        imageDetected: { status: 'success', message: '감지' },
        deploy: { status: 'success', message: 'Synced / Healthy' },
        live: { status: 'success', message: '응답 정상' },
      },
    });
  });
  // GET domain: returns an existing row in "error" state with the
  // CNAME-conflict reason so the ConflictRecovery UI renders.
  await page.route('**/api/deploy/domain/alice/sample', async (route) => {
    if (route.request().method() === 'GET') {
      await json(route, 200, {
        domain: 'app.example.com',
        status: 'error',
        lastError:
          'app.example.com 에 이미 A 레코드가 있어 CNAME을 함께 둘 수 없습니다. (1) 새 서브도메인 사용 또는 (2) A 레코드 삭제 후 CNAME 등록을 권장합니다.',
        lastErrorReason: 'DNS_CNAME_CONFLICTS_WITH_A',
        registrableDomain: 'example.com',
        suggestedSubdomain: 'app2.example.com',
        dnsRecords: {
          txt: null,
          cname: {
            host: 'app.example.com',
            target: 'cd-sk-abc123.domains.swkoo.kr',
          },
        },
      });
      return;
    }
    await route.fallback();
  });

  await page.goto('/deploy/alice/sample');
  await expect(page.getByRole('heading', { name: '커스텀 도메인' })).toBeVisible();

  // The error panel renders the conflict-recovery UI.
  await expect(page.getByText(/이미 A 레코드가 있어/)).toBeVisible();
  // Recommended subdomain CTA.
  await expect(page.getByRole('button', { name: /app2\.example\.com.+사용하기/ })).toBeVisible();
  // Free-form prefix input ("또는 원하는 이름:").
  await expect(page.getByText(/또는 원하는 이름/)).toBeVisible();
});
