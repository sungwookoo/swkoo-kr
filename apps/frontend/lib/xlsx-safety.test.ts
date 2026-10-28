import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const { checkZip } = createRequire(import.meta.url)('../public/excel-service/xlsx-safety.js');

function archive(expanded = 1, method = 0) {
  const bytes = new Uint8Array(30 + 1 + 46 + 22), view = new DataView(bytes.buffer), central = 31, end = 77;
  view.setUint32(0, 0x04034b50, true); view.setUint16(8, method, true);
  view.setUint32(central, 0x02014b50, true); view.setUint16(central + 10, method, true);
  view.setUint32(central + 20, 1, true); view.setUint32(central + 24, expanded, true);
  view.setUint32(end, 0x06054b50, true); view.setUint16(end + 8, 1, true); view.setUint16(end + 10, 1, true);
  view.setUint32(end + 12, 46, true); view.setUint32(end + 16, central, true);
  return bytes.buffer;
}

describe('XLSX archive preflight', () => {
  it('accepts a bounded stored ZIP entry', () => expect(() => checkZip(archive())).not.toThrow());
  it('rejects truncated files', () => expect(() => checkZip(new ArrayBuffer(10))).toThrow());
  it('rejects excessive expanded size before decompression', () => expect(() => checkZip(archive(20 * 1024 * 1024, 8))).toThrow(/압축/));
  it('rejects excessive compression ratio', () => expect(() => checkZip(archive(1000, 8))).toThrow(/압축/));
  it('rejects malformed central directory offsets', () => {
    const buffer = archive(); new DataView(buffer).setUint32(77 + 16, 200, true);
    expect(() => checkZip(buffer)).toThrow(/손상/);
  });
});
