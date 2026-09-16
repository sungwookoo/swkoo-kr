import { expect, test } from '@playwright/test';
import { installCatchAll, json, mockAuthenticatedAs } from './fixtures';

for (const failure of [false, true]) {
  test(`old live response does not mark a new ${failure ? 'failed' : 'pending'} deployment complete`, async ({ page }) => {
    await installCatchAll(page);
    await mockAuthenticatedAs(page);
    await page.route('**/api/deploy/env/**', (route) => json(route, 200, { vars: {} }));
    await page.route('**/api/deploy/domain/**', (route) => json(route, 200, { domain: null }));
    await page.route('**/api/account/scan', (route) => json(route, 200, { scan: null }));
    await page.route('**/api/deploy/status/**', (route) => json(route, 200, {
      login: 'alice', repo: 'app', appName: 'app', liveUrl: 'https://alice-app.apps.swkoo.kr',
      stages: {
        manifests: { status: 'success', message: '등록 완료' },
        build: { status: 'success', message: '빌드 완료' },
        imageDetected: { status: 'success', message: '이미지 확인' },
        deploy: { status: failure ? 'failed' : 'running', message: failure ? '컨테이너 시작 실패 (CrashLoopBackOff)' : '최신 이미지 준비 중' },
        // Defensive UI check against an older API/cache reporting a healthy URL.
        live: { status: 'success', message: '이전 앱 응답 정상' },
      },
    }));
    await page.goto('/deploy/alice/app');
    await expect(page.getByText('✓ 라이브 —', { exact: false })).toHaveCount(0);
    await expect(page.getByText(failure ? '⚠ 배포 확인 필요 —' : '⏳ 배포 진행 중 —', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: '이 앱 제거하기' }).click();
    await expect(page.getByText(/연결된 영구 저장공간과 DB 데이터도 삭제/)).toBeVisible();
  });
}

for (const code of [401, 403]) {
  test(`deployment management explains ${code} without exposing panels`, async ({ page }) => {
    await installCatchAll(page);
    await page.route('**/api/auth/me', route => json(route, 401, {}));
    await page.route('**/api/deploy/status/**', route => json(route, code, {}));
    await page.goto('/deploy/hizieun/portfolio');
    if (code === 401) {
      const link = page.getByRole('link', { name: 'GitHub로 로그인하고 돌아오기' });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', /returnTo=%2Fdeploy%2Fhizieun%2Fportfolio$/);
    } else {
      await expect(page.getByText('이 앱의 관리 권한이 없습니다.', { exact: false })).toBeVisible();
    }
    await expect(page.getByText('상태 조회 실패:', { exact: false })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '+ Add variable' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '이 앱 제거하기' })).toHaveCount(0);
  });
}
