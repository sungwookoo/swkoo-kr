import { expect, test } from '@playwright/test';
import { installCatchAll, json, mockAuthenticatedAs } from './fixtures';

test('security patch uses two explicit actions and a draft PR', async ({ page }) => {
  await installCatchAll(page); await mockAuthenticatedAs(page);
  await page.route('**/api/deploy/env/**', r => json(r, 200, { vars: {} }));
  await page.route('**/api/deploy/domain/**', r => json(r, 200, { domain: null }));
  await page.route('**/api/deploy/status/**', r => json(r, 200, {
    login: 'alice', repo: 'app', appName: 'app', liveUrl: 'https://alice-app.apps.swkoo.kr',
    stages: Object.fromEntries(['manifests', 'build', 'imageDetected', 'deploy', 'live'].map(k => [k, { status: 'success', message: '완료' }])),
  }));
  let prepares = 0, publications = 0;
  const plan = { id: 'id', repo: 'alice/app', base: 'main', sha: '0123456789', state: 'ready', before: 2, after: 1,
    changes: [{ path: 'node_modules/example', from: '1.0.0', to: '1.0.1' }],
    evidence: { checkedAt: 1790208000000, before: { total: 2, findings: [
      { id: '123', package: 'example', title: 'Example vulnerability', severity: 'high', range: '<1.0.1', versions: ['1.0.0'], url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' },
      { id: '456', package: 'remaining', title: 'Unresolved vulnerability', severity: 'moderate', range: '<2.0.0', versions: ['1.0.0'], url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff' },
    ] }, after: { total: 1, findings: [
      { id: '456', package: 'remaining', title: 'Unresolved vulnerability', severity: 'moderate', range: '<2.0.0', versions: ['1.0.0'], url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff' },
    ] } } };
  await page.route('**/api/deploy/security-patch**', async r => {
    if (r.request().method() === 'GET') return json(r, 200, null);
    expect(r.request().postDataJSON().consent).toBe('npm-lockfile-v1');
    if (r.request().url().endsWith('/prepare')) { prepares++; return json(r, 200, plan); }
    publications++; return json(r, 200, { ...plan, state: 'pr', prUrl: 'https://github.com/alice/app/pull/1' });
  });
  await page.goto('/deploy/alice/app');
  const panel = page.getByRole('region', { name: 'npm 의존성 취약점 수정 PR' });
  const prepare = panel.getByRole('button', { name: 'npm 수정안 준비' });
  await expect(prepare).toBeDisabled(); expect(prepares).toBe(0); expect(publications).toBe(0);
  await panel.getByRole('checkbox').check(); await prepare.click();
  const publish = panel.getByRole('button', { name: '검토용 초안 PR 만들기' });
  await expect(publish).toBeDisabled(); expect(publications).toBe(0);
  await expect(panel.getByText(/병합하면 기존 자동 배포/)).toBeVisible();
  await expect(panel.getByRole('heading', { name: '제안에서 해결된 취약점 (1)' })).toBeVisible();
  await expect(panel.getByRole('heading', { name: '제안에 남은 취약점 (1)' })).toBeVisible();
  await expect(panel.getByRole('link', { name: '취약점 근거 보기' }).first()).toHaveAttribute('href', 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc');
  await panel.screenshot({ path: 'test-results/security-patch-ready.png' });
  await panel.getByRole('checkbox').check(); await publish.click();
  await expect(panel.getByRole('link', { name: 'GitHub에서 생성된 PR 확인' })).toHaveAttribute('href', 'https://github.com/alice/app/pull/1');
  expect(prepares).toBe(1); expect(publications).toBe(1);
});
