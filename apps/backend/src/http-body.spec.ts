import express from 'express';
import request from 'supertest';
import { gzipSync } from 'node:zlib';
import { bodyParsers } from './http-body';

describe('HTTP body boundary', () => {
  const app = express();
  app.use(...bodyParsers());
  app.post('/', (req, res) => res.json({ body: req.body, raw: (req as any).rawBody?.toString() }));
  it('preserves exact webhook bytes', async () => {
    const raw = '{ "event": "ping" }';
    const result = await request(app).post('/').set('Content-Type', 'application/json').send(raw).expect(200);
    expect(result.body).toEqual({ body: { event: 'ping' }, raw });
  });
  it('rejects compressed bodies before decoding and remains available', async () => {
    await request(app).post('/').set('Content-Type', 'application/json').set('Content-Encoding', 'gzip')
      .send(gzipSync('{}')).expect(415);
    await request(app).post('/').send({ ok: true }).expect(200);
  });
});
