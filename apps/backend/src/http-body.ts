import { json, urlencoded } from 'express';
import type { Request } from 'express';

export function bodyParsers() {
  const verify = (req: Request & { rawBody?: Buffer }, _res: unknown, buf: Buffer) => {
    req.rawBody = Buffer.from(buf);
  };
  return [json({ limit: '1mb', inflate: false, verify }),
    urlencoded({ extended: true, limit: '1mb', inflate: false, verify })];
}
