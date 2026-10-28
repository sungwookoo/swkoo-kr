import { expect, test } from '@playwright/test';
import { installCatchAll, json, mockAuthenticatedAs } from './fixtures';

test('diagnostics fetches logs only on request, renders text safely and hides stale logs on authorization failure', async ({page}) => {
  await page.clock.install(); await installCatchAll(page); await mockAuthenticatedAs(page);
  await page.route('**/api/deploy/status/**', route=>json(route,200,{login:'alice',repo:'app',appName:'app',liveUrl:'https://alice-app.apps.swkoo.kr',
    stages:Object.fromEntries(['manifests','build','imageDetected','deploy','live'].map(name=>[name,{status:'success'}]))}));
  await page.route('**/api/deploy/env/**',route=>json(route,200,{vars:{}}));
  await page.route('**/api/deploy/domain/**',route=>json(route,200,{domain:null}));
  await page.route('**/api/account/scan',route=>json(route,200,null));
  let logRequests=0, expired=false;
  await page.route('**/api/deploy/diagnostics/**',route=>{
    const logs=new URL(route.request().url()).searchParams.get('logs')==='1';
    if(logs)logRequests++;
    return json(route,expired?401:200,{checkedAt:new Date().toISOString(),state:'Running',restarts:0,
      usage:{cpuMillicores:20,memoryMiB:null,cpuLimit:'500m',memoryLimit:'512Mi'},
      logs:logs?'TOKEN=[숨김]\n<script>window.logExecuted=true</script>':null,logSource:logs?'app':null,logError:null});
  });
  await page.goto('/deploy/alice/app');
  const panel=page.getByRole('region',{name:'앱 실행 정보'});
  await expect(panel.getByText('0.02코어 / 최대 0.5코어')).toBeVisible();
  await expect(panel.getByText('측정 대기 / 최대 512MiB')).toBeVisible(); expect(logRequests).toBe(0);
  await panel.getByRole('button',{name:'최근 실행 로그 보기'}).click();
  await expect(panel.locator('pre')).toContainText('<script>window.logExecuted=true</script>');
  expect(await page.evaluate(()=> (window as any).logExecuted)).toBeUndefined(); expect(logRequests).toBe(1);
  expired=true; await page.clock.runFor(31_000);
  await expect(panel.getByText(/현재 로그인과 배포 상태/)).toBeVisible(); await expect(panel.locator('pre')).toHaveCount(0);
});
