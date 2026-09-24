import { expect, test, type Page } from '@playwright/test';
import { installCatchAll, json, mockAuthenticatedAs } from './fixtures';

async function openDeploy(page: Page) {
  await installCatchAll(page); await mockAuthenticatedAs(page);
  await page.route('**/api/deploy/repos', r => json(r, 200, [{ name: 'sample', fullName: 'alice/sample', description: 'Next app', language: 'TypeScript', defaultBranch: 'main', htmlUrl: 'https://github.com/alice/sample', updatedAt: new Date().toISOString(), isFork: false, isPrivate: false }]));
  await page.route('**/api/deploy/preview**', r => json(r, 200, { stack: 'nextjs', packageName: 'sample', port: 3000, nodeEngine: null,
    checks: [{ key: 'repo_access', status: 'pass', label: '저장소', message: '확인' }] }));
}

test('existing source changes require a PR and a fresh review after merge before deployment', async ({ page }) => {
  await openDeploy(page);
  let merged = false, prs = 0, registrations = 0;
  await page.route('**/api/deploy/setup?*', r => json(r, 200, { repo: 'alice/sample', branch: 'main', sha: merged ? 'merged-sha' : 'base-sha', digest: merged ? 'merged-digest' : 'reviewed-digest',
    files: [{ path: 'Dockerfile', action: merged ? 'keep' : 'review', before: merged ? 'FROM new' : 'FROM custom', after: 'FROM new' }] }));
  await page.route('**/api/deploy/setup/pr', r => {
    prs++; expect(r.request().postDataJSON()).toMatchObject({ setupConsent: 'source-setup-v1', setupDigest: 'reviewed-digest' });
    return json(r, 201, { prUrl: 'https://github.com/alice/sample/pull/1' });
  });
  await page.route('**/api/deploy/register', r => {
    registrations++; expect(merged).toBe(true); expect(r.request().postDataJSON().setupDigest).toBe('merged-digest');
    return json(r, 201, { ok: true, fullName: 'alice/sample', userRepoCommit: 'merged-sha', manifestRepoCommit: 'manifest-sha' });
  });
  await page.goto('/deploy'); await page.getByRole('button', { name: /sample/ }).first().click();
  const panel = page.getByRole('region', { name: '저장소 변경 확인' });
  const pr = page.getByRole('button', { name: '설정 변경 초안 PR 요청' });
  await expect(pr).toBeDisabled(); expect(prs).toBe(0); expect(registrations).toBe(0);
  await panel.getByText('Dockerfile: 차이 있음 — PR 검토 필요').click();
  await expect(panel.getByText('FROM custom', { exact: true })).toBeVisible();
  await expect(panel.getByText('FROM new', { exact: true })).toBeVisible();
  await panel.getByRole('checkbox').check(); await pr.click();
  await expect(panel.getByRole('link', { name: 'GitHub에서 설정 PR 검토' })).toHaveAttribute('href', 'https://github.com/alice/sample/pull/1');
  expect(prs).toBe(1); expect(registrations).toBe(0);
  merged = true; await panel.getByRole('button', { name: '파일 상태 다시 조회' }).click();
  await expect(panel.getByText(/기준: merged-/)).toBeVisible();
  const deploy = page.getByRole('button', { name: 'Deploy →' });
  await expect(deploy).toBeDisabled(); await panel.getByRole('checkbox').check(); await deploy.click();
  await expect(panel.getByRole('link', { name: '소스 커밋 확인' })).toHaveAttribute('href', 'https://github.com/alice/sample/commit/merged-sha');
  expect(registrations).toBe(1);
});

test('partial registration failure shows completed steps and source link', async ({ page }) => {
  await openDeploy(page);
  await page.route('**/api/deploy/register', r => json(r, 503, { reason: 'DEPLOY_PARTIAL',
    message: '배포 등록을 완료하지 못했습니다. 변경은 자동 취소되지 않았습니다.', completed: ['소스 파일 생성'], sourceUrl: 'https://github.com/alice/sample/commit/created' }));
  await page.goto('/deploy'); await page.getByRole('button', { name: /sample/ }).first().click();
  await expect(page.getByRole('button', { name: 'Deploy →' })).toBeDisabled();
  await page.getByRole('checkbox', { name: /파일 생성·유지/ }).check(); await page.getByRole('button', { name: 'Deploy →' }).click();
  await expect(page.getByText('완료된 단계: 소스 파일 생성')).toBeVisible();
  await expect(page.getByRole('link', { name: '소스 저장소 확인' })).toHaveAttribute('href', 'https://github.com/alice/sample/commit/created');
});
