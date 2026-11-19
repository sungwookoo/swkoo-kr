import { expect, test } from '@playwright/test';
import { ALICE, installCatchAll, json, mockAuthenticatedAs } from './fixtures';

test('administrator reviews resource absence before releasing a reservation, and a changed state requires a fresh review', async ({ page }) => {
  await installCatchAll(page); await mockAuthenticatedAs(page, { ...ALICE, isAdmin: true });
  await page.route('**/api/admin/users', route => json(route, 200, { users: [] }));
  await page.route('**/api/admin/deployment-recovery', route => json(route, 200, { reservations: [{ login: 'alice', createdAt: 123 }] }));
  await page.route('**/api/admin/deployment-recovery/alice', route => json(route, 200, {
    login: 'alice', registration: false, application: false, namespace: false, persistentVolumes: 0, canRelease: true, digest: 'reviewed',
  }));
  let writes = 0;
  await page.route('**/api/admin/deployment-recovery/alice/release', route => {
    writes++; expect(route.request().postDataJSON()).toEqual({ digest: 'reviewed' });
    return json(route, 409, { message: '조회 이후 상태가 바뀌었습니다. 다시 조회해 주세요.' });
  });
  await page.goto('/admin');
  const panel = page.getByRole('region', { name: '배포 예약 복구' });
  await expect(panel.getByRole('button', { name: '상태 확인' })).toBeVisible();
  await expect(panel.getByRole('button', { name: '미사용 예약 해제' })).toHaveCount(0); expect(writes).toBe(0);
  await panel.getByRole('button', { name: '상태 확인' }).click();
  await expect(panel.getByText(/저장 볼륨 0개/)).toBeVisible();
  await panel.getByRole('button', { name: '미사용 예약 해제' }).click();
  await expect(panel.getByRole('status')).toContainText('상태가 바뀌었습니다');
  await expect(panel.getByRole('button', { name: '미사용 예약 해제' })).toHaveCount(0); expect(writes).toBe(1);
});

test('ordinary users never render the recovery controls or request administrator data', async ({ page }) => {
  await installCatchAll(page); await mockAuthenticatedAs(page);
  let adminRequests = 0;
  await page.route('**/api/admin/**', route => { adminRequests++; return json(route, 403, {}); });
  await page.goto('/admin'); await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('region', { name: '배포 예약 복구' })).toHaveCount(0); expect(adminRequests).toBe(0);
});

test('an administrator edits and saves a single account’s deployment policy', async ({ page }) => {
  await installCatchAll(page);
  await mockAuthenticatedAs(page, { ...ALICE, isAdmin: true });
  const target = { ...ALICE, githubLogin: 'test-user', createdAt: '2026-11-01', lastLoginAt: '2026-11-02',
    deployPolicy: { maxApps: 1, cpuMillicores: 500, memoryMiB: 512 } };
  await page.route('**/api/admin/users', route => json(route, 200, { users: [target] }));
  await page.route('**/api/admin/deployment-recovery', route => json(route, 200, { reservations: [] }));
  await page.route('**/api/admin/users/test-user/deploy-policy', route => {
    expect(route.request().method()).toBe('PATCH');
    const payload = route.request().postDataJSON();
    expect(payload).toEqual({ maxApps: 2, cpuMillicores: 750, memoryMiB: 768 });
    return json(route, 200, { ok: true, deployPolicy: payload });
  });
  await page.goto('/admin');
  await page.getByText('앱 최대 1개 · 0.5코어 · 512MiB').click();
  await page.getByLabel('최대 앱 수').fill('2');
  await page.getByLabel('앱당 CPU (m)').fill('750');
  await page.getByLabel('앱당 메모리 (MiB)').fill('768');
  await page.getByRole('button', { name: '한도 저장' }).click();
  await expect(page.getByText('앱 최대 2개 · 0.75코어 · 768MiB')).toBeVisible();
});
