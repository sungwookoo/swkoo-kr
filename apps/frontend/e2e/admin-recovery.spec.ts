import { expect, test } from '@playwright/test';
import { ALICE, installCatchAll, json, mockAuthenticatedAs } from './fixtures';

test('administrator reviews resource absence before releasing a reservation, and a changed state requires a fresh review', async ({ page }) => {
  await installCatchAll(page); await mockAuthenticatedAs(page, { ...ALICE, isAdmin: true });
  await page.route('**/api/admin/users', route => json(route, 200, { users: [] }));
  await page.route('**/api/admin/deployment-capacity', route => json(route, 503, {}));
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
  await expect(page.getByRole('region', { name: '배포 예약 복구' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '배포 앱 관리' })).toHaveCount(0);
  expect(adminRequests).toBe(0);
});

test('administrator pauses and resumes one app and types its full name before deletion', async ({ page }) => {
  await installCatchAll(page);
  await mockAuthenticatedAs(page, { ...ALICE, isAdmin: true });
  await page.route('**/api/admin/users', route => json(route, 200, { users: [{
    ...ALICE, githubLogin: 'test-user', createdAt: '2026-11-01', lastLoginAt: '2026-11-02',
  }] }));
  await page.route('**/api/admin/deployment-capacity', route => json(route, 503, {}));
  await page.route('**/api/admin/deployment-recovery', route => json(route, 200, { reservations: [] }));
  let state = 'active';
  const writes: unknown[] = [];
  await page.route('**/api/admin/users/test-user/deployments', route => json(route, 200, state === 'deleted' ? [] : [{
    key: 'test-user', fullName: 'test-user/sample', liveUrl: 'https://sample.apps.swkoo.kr',
    state, stopped: state === 'paused', ready: state === 'active',
  }]));
  await page.route('**/api/admin/users/test-user/deployments/test-user/lifecycle', route => {
    const payload = route.request().postDataJSON();
    writes.push(payload);
    state = { pause: 'paused', resume: 'active', delete: 'deleted' }[payload.action as 'pause' | 'resume' | 'delete'];
    return json(route, 201, { commit: 'commit-id' });
  });
  await page.goto('/admin');
  const panel = page.getByRole('region', { name: '배포 앱 관리' });
  await panel.getByLabel('사용자 선택').selectOption('test-user');
  await expect(panel.getByText('실행 중', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '일시 중지', exact: true }).click();
  expect(writes).toEqual([]);
  await panel.getByRole('button', { name: '중지 확인' }).click();
  await expect(panel.getByText('일시 중지됨')).toBeVisible();
  await expect(panel.getByText('https://sample.apps.swkoo.kr')).toBeVisible();
  await panel.getByRole('button', { name: '다시 시작' }).click();
  await expect(panel.getByText('실행 중', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '영구 삭제', exact: true }).click();
  await panel.getByRole('textbox').fill('test-user/another');
  await expect(panel.getByRole('button', { name: '삭제 확인' })).toBeDisabled();
  await panel.getByRole('textbox').fill('test-user/sample');
  await panel.getByRole('button', { name: '삭제 확인' }).click();
  await expect(panel.getByText('이 사용자의 배포 앱이 없습니다.')).toBeVisible();
  expect(writes).toEqual([{ action: 'pause' }, { action: 'resume' }, { action: 'delete', confirmation: 'test-user/sample' }]);
});

test('an administrator edits and saves a single account’s deployment policy', async ({ page }) => {
  await installCatchAll(page);
  await mockAuthenticatedAs(page, { ...ALICE, isAdmin: true });
  const target = { ...ALICE, githubLogin: 'test-user', createdAt: '2026-11-01', lastLoginAt: '2026-11-02',
    deployPolicy: { maxApps: 1, cpuMillicores: 500, memoryMiB: 512 } };
  await page.route('**/api/admin/users', route => json(route, 200, { users: [target] }));
  await page.route('**/api/admin/deployment-capacity', route => json(route, 503, {}));
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

test('administrator sees actual capacity and refreshes the deployment estimate', async ({ page }) => {
  await installCatchAll(page);
  await mockAuthenticatedAs(page, { ...ALICE, isAdmin: true });
  await page.route('**/api/admin/users', route => json(route, 200, { users: [] }));
  await page.route('**/api/admin/deployment-recovery', route => json(route, 200, { reservations: [] }));
  let blocked = false;
  await page.route('**/api/admin/deployment-capacity', route => json(route, 200, {
    checkedAt: '2026-11-19T05:00:00Z',
    cpu: { totalMillicores: 4000, idleMillicores: 3500 },
    memory: { totalMiB: 24576, availableMiB: 16384 },
    deployment: {
      pending: 1, reason: blocked ? 'storage' : null,
      availableMillicores: 1600, availableMemoryMiB: 12288,
      requiredMillicores: 200, requiredMemoryMiB: 512,
      safetyMillicores: 1000, safetyMemoryMiB: 4096, usageCeilingPercent: 70,
      suggestedLimits: blocked ? null : { cpuMillicores: 1200, memoryMiB: 6144 },
    },
  }));
  await page.goto('/admin');
  const region = page.getByRole('region', { name: '서버 가용 자원' });
  await expect(region.getByText('3.5코어 / 4코어')).toBeVisible();
  await expect(region.getByText(/새 앱 1개의 상한 설정 참고/)).toContainText('CPU 1.2코어');
  blocked = true;
  await region.getByRole('button', { name: '새로 확인' }).click();
  await expect(region.getByText(/신규 배포 보류/)).toContainText('저장공간');
  await expect(region.getByText(/새 앱 1개의 상한 설정 참고/)).toHaveCount(0);
});
