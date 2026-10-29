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
