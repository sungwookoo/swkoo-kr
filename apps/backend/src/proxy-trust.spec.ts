import express from 'express';
import request from 'supertest';

describe('trusted ingress client address', () => {
  it('separates clients and ignores a prepended spoofed address', async () => {
    const app = express(); app.set('trust proxy', ['loopback']);
    app.get('/', (req, res) => res.json({ ip: req.ip }));
    const first = await request(app).get('/').set('X-Forwarded-For', '198.51.100.1');
    const second = await request(app).get('/').set('X-Forwarded-For', '203.0.113.99, 198.51.100.2');
    expect(first.body.ip).toBe('198.51.100.1');
    expect(second.body.ip).toBe('198.51.100.2');
  });
});
