import { expect, test, type Page } from '@playwright/test';
import { installCatchAll, json, mockAuthenticatedAs } from './fixtures';

const current = { login: 'alice', repo: 'sample', fullName: 'alice/sample', appName: 'sample',
  liveUrl: 'https://alice-sample.apps.swkoo.kr', state: 'active', syncStatus: 'Synced', healthStatus: 'Healthy' };

async function activeApp(page: Page, deploy: Record<string, unknown> = { status: 'success', message: '컨테이너 준비 완료' }) {
  await installCatchAll(page);
  await mockAuthenticatedAs(page);
  await page.route('**/api/deploy/current', route => json(route, 200, current));
  await page.route('**/api/deploy/domain/**', route => json(route, 200, { domain: null }));
  await page.route('**/api/deploy/status/alice/sample', route => json(route, 200, { ...current,
    stages: { manifests: { status: 'success' }, build: { status: 'success' }, imageDetected: { status: 'success' },
      deploy, live: { status: deploy.status === 'success' ? 'success' : 'pending' } } }));
}

for (const failure of [
  { status: 'failed', reason: 'MEMORY_LIMIT_EXCEEDED', message: '컨테이너가 메모리 한도를 초과해 종료됐습니다.',
    action: '동시 처리량·캐시를 줄여주세요. 메모리 한도는 자동으로 늘어나지 않습니다.' },
  { status: 'running', reason: 'CLUSTER_CAPACITY_PENDING', message: '서버의 CPU 또는 메모리 여유를 기다리고 있습니다.',
    action: '잠시 기다려주세요. 대기가 계속되면 운영자에게 문의해주세요.' },
  { status: 'failed', reason: 'POD_NOT_READY', message: '컨테이너 시작 실패 (CrashLoopBackOff)',
    action: '필수 환경변수와 DB 연결 설정을 점검해주세요.' },
]) {
  test(`shows recovery guidance for ${failure.reason}`, async ({ page }) => {
    await activeApp(page, { ...failure, userAction: { kind: 'docs', label: failure.action } });
    await page.route('**/api/deploy/env/alice/sample', route => json(route, 200, { vars: {} }));
    await page.goto('/deploy/alice/sample');
    await expect(page.getByText(failure.message, { exact: true })).toBeVisible();
    await expect(page.getByText(failure.action, { exact: true })).toBeVisible();
  });
}

test('failed save retains input; failed removal stays on the app; both can retry', async ({ page }) => {
  await activeApp(page);
  let vars = {}, saves = 0, removals = 0;
  await page.route('**/api/deploy/env/alice/sample', async route => {
    if (route.request().method() === 'PUT') {
      if (++saves === 1) return json(route, 503, { message: '환경변수 저장 일시 실패' });
      vars = route.request().postDataJSON().vars;
      return json(route, 200, { ok: true, count: 1 });
    }
    return json(route, 200, { vars });
  });
  await page.route('**/api/deploy', route => ++removals === 1
    ? json(route, 503, { message: 'GitHub 연결 일시 실패' })
    : json(route, 200, { commit: 'removed-sha' }));
  await page.goto('/deploy/alice/sample');
  await page.getByRole('button', { name: '+ Add variable' }).click();
  const key = page.getByPlaceholder('APP_BASE_URL');
  const value = key.locator('..').locator('input').nth(1);
  await key.fill('TEST_MARKER'); await value.fill('fixture-value');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('환경변수 저장 일시 실패', { exact: true })).toBeVisible();
  await expect(key).toHaveValue('TEST_MARKER'); await expect(value).toHaveValue('fixture-value');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/✓ 적용됨/)).toBeVisible();
  expect(vars).toEqual({ TEST_MARKER: 'fixture-value' });
  await page.getByRole('button', { name: '이 앱 제거하기' }).click();
  await page.getByRole('button', { name: '제거 확정' }).click();
  await expect(page.getByText(/제거 실패:.*GitHub 연결 일시 실패/)).toBeVisible();
  await expect(page).toHaveURL(/\/deploy\/alice\/sample$/);
  await page.getByRole('button', { name: '돌아가기', exact: true }).click();
  await page.getByRole('button', { name: '이 앱 제거하기' }).click();
  await page.getByRole('button', { name: '제거 확정' }).click();
  await expect(page).toHaveURL(/\/deploy\?removed=1$/);
  expect(removals).toBe(2);
});
