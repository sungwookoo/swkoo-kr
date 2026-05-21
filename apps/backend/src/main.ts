import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import type { Request, Response, NextFunction } from 'express';

import { AppModule } from './app.module';

// Single source of truth for both CORS allowlist and the CSRF Origin
// check below. If CORS_ORIGINS env is unset we fall back to a hard
// allowlist — never to `true`/`*` — because cookies are credentialed.
function resolveAllowedOrigins(): string[] {
  if (process.env.CORS_ORIGINS) {
    return process.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  }
  return process.env.NODE_ENV === 'production'
    ? ['https://swkoo.kr']
    : ['http://localhost:3000', 'http://localhost:3001'];
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = new Logger('Bootstrap');

  app.use(cookieParser());

  // Preserve raw body buffer for HMAC signature verification on webhook routes.
  const captureRaw = (req: Request & { rawBody?: Buffer }, _res: unknown, buf: Buffer) => {
    req.rawBody = Buffer.from(buf);
  };
  app.use(json({ limit: '1mb', verify: captureRaw }));
  app.use(urlencoded({ extended: true, verify: captureRaw }));

  const allowedOrigins = resolveAllowedOrigins();

  // CSRF defense for credentialed mutating requests. The threat model:
  // `*.apps.swkoo.kr` (friend apps) share registrable domain `swkoo.kr`
  // with our API, so SameSite=Lax cookies travel on cross-subdomain
  // fetches. We mitigate by rejecting mutating requests whose Origin
  // header isn't in the allowlist. Modern browsers also send
  // Sec-Fetch-Site, which we trust as the primary signal — Origin is
  // the fallback for older clients.
  //
  // Webhook routes opt out: they use HMAC signing, not session cookies,
  // and external senders (GitHub, ArgoCD) don't send Sec-Fetch-Site
  // or a swkoo.kr Origin.
  const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (req.path.startsWith('/api/webhooks/')) return next();

    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite === 'same-origin' || fetchSite === 'none') return next();
    if (fetchSite === 'same-site' || fetchSite === 'cross-site') {
      res.status(403).json({
        statusCode: 403,
        message: { reason: 'CSRF_BLOCKED', message: 'cross-origin mutating request blocked' },
      });
      return;
    }

    const origin = req.headers.origin;
    if (!origin) return next(); // server-to-server / curl, no session cookie attaches anyway
    if (!allowedOrigins.includes(origin as string)) {
      res.status(403).json({
        statusCode: 403,
        message: { reason: 'CSRF_BLOCKED', message: 'origin not allowed' },
      });
      return;
    }
    next();
  });

  app.setGlobalPrefix('api', { exclude: ['metrics'] });
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true
    })
  );

  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);
  logger.log(`API ready on port ${port}`);
}

void bootstrap();
