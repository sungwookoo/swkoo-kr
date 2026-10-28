import { expect, test } from '@playwright/test';
import { installCatchAll, json, mockAuthenticatedAs } from './fixtures';

test('reviewed deployment → progress → environment save → reload → removal', async ({ page }) => {
  await installCatchAll(page);
  await mockAuthenticatedAs(page);
  let active = false;
  let vars: Record<string, string> = {};
  let saves = 0;
  const current = { login: 'alice', repo: 'sample', fullName: 'alice/sample', appName: 'sample',
    liveUrl: 'https://alice-sample.apps.swkoo.kr', state: 'active', syncStatus: 'Synced', healthStatus: 'Healthy' };
  await page.route('**/api/deploy/current', route => json(route, 200, active ? current : null));
  await page.route('**/api/deploy/repos', route => json(route, 200, [{ name: 'sample', fullName: 'alice/sample', defaultBranch: 'main', htmlUrl: 'https://github.com/alice/sample', isPrivate: false }]));
  await page.route('**/api/deploy/preview**', route => json(route, 200, { stack: 'nextjs', port: 3000, checks: [] }));
  await page.route('**/api/deploy/register', async route => {
    expect(route.request().postDataJSON()).toMatchObject({ fullName: 'alice/sample', setupDigest: 'reviewed-digest' });
    active = true;
    await json(route, 200, { ok: true, userRepoCommit: 'source-sha', manifestRepoCommit: 'manifest-sha', ...current });
  });
  await page.route('**/api/deploy/status/alice/sample', route => json(route, 200, { ...current,
    stages: Object.fromEntries(['manifests', 'build', 'imageDetected', 'deploy', 'live'].map(stage => [stage, { status: 'success', message: `${stage} verified` }])) }));
  await page.route('**/api/deploy/domain/**', route => json(route, 200, { domain: null }));
  await page.route('**/api/deploy/env/alice/sample', async route => {
    if (route.request().method() === 'PUT') {
      vars = route.request().postDataJSON().vars; saves++;
      await json(route, 200, { ok: true, count: Object.keys(vars).length });
    } else await json(route, 200, { vars });
  });
  await page.route('**/api/deploy', async route => {
    expect(route.request().method()).toBe('DELETE'); active = false;
    await json(route, 200, { commit: 'removed-sha' });
  });
  await page.goto('/deploy');
  await page.getByRole('button', { name: /sample/ }).first().click();
  await expect(page.getByRole('button', { name: /^Deploy/ })).toBeDisabled();
  await page.getByRole('checkbox', { name: /파일 생성·유지/ }).check();
  await page.getByRole('button', { name: /^Deploy/ }).click();
  await page.getByRole('button', { name: '배포 진행상황 보기' }).click();
  await expect(page.getByText('live verified', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '+ Add variable' }).click();
  await page.getByPlaceholder('APP_BASE_URL').fill('TEST_MARKER');
  await page.getByPlaceholder('APP_BASE_URL').locator('..').locator('input').nth(1).fill('fixture-value');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/✓ 적용됨/)).toBeVisible();
  expect(saves).toBe(1);
  await page.reload();
  await expect(page.getByPlaceholder('APP_BASE_URL')).toHaveValue('TEST_MARKER');
  await expect(page.getByRole('button', { name: 'Show value' })).toBeVisible();
  await page.getByRole('button', { name: '이 앱 제거하기' }).click();
  await page.getByRole('button', { name: '취소', exact: true }).click();
  expect(active).toBe(true);
  await page.getByRole('button', { name: '이 앱 제거하기' }).click();
  await page.getByRole('button', { name: '제거 확정' }).click();
  await expect(page).toHaveURL(/\/deploy\?removed=1$/);
  expect(active).toBe(false);
});
