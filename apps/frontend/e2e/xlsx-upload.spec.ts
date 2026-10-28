import { expect, test } from '@playwright/test';
import { deflateRawSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';

function oversizedArchive() {
  const payload = Buffer.alloc(20 * 1024 * 1024, 32), compressed = deflateRawSync(payload);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const name = Buffer.from('large.xml'), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(payload.length, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(payload.length, 24); central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + compressed.length, 16);
  return Buffer.concat([local, name, compressed, central, name, end]);
}

test('downloaded sample uploads and parses in a worker under the enforcing CSP', async ({ page }) => {
  await page.goto('/excel-service/demo');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '샘플 엑셀 받기', exact: true }).click();
  const download = await pending;
  const file = await download.path();
  await page.locator('#files').setInputFiles({ name: download.suggestedFilename(), mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await readFile(file!) });
  await page.getByRole('button', { name: '선택 파일 취합·검증', exact: true }).click();
  await expect(page.locator('#countRows')).toHaveText('12');
  await expect(page.locator('#countBad')).toHaveText('6');
});

test('small compressed file with excessive expanded size is rejected without freezing the UI', async ({ page }) => {
  await page.goto('/excel-service/demo');
  await page.locator('#files').setInputFiles({ name: 'oversized.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: oversizedArchive() });
  await page.getByRole('button', { name: '선택 파일 취합·검증', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('압축 해제 크기');
  await page.getByRole('button', { name: '샘플 3개로 체험하기', exact: true }).click();
  await expect(page.locator('#countRows')).toHaveText('12');
});

test('an unresponsive parser is terminated and controls recover', async ({ page }) => {
  await page.goto('/excel-service/demo');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '샘플 엑셀 받기', exact: true }).click();
  const download = await pending;
  const file = await download.path();
  await page.route('**/excel-service/parse-worker.js', route => route.fulfill({ contentType: 'application/javascript', body: 'self.onmessage=()=>{while(true){}};' }));
  await page.locator('#files').setInputFiles({ name: download.suggestedFilename(), mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await readFile(file!) });
  await page.getByRole('button', { name: '선택 파일 취합·검증', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('시간이 초과', { timeout: 12000 });
  await expect(page.getByRole('button', { name: '샘플 3개로 체험하기', exact: true })).toBeEnabled();
});
