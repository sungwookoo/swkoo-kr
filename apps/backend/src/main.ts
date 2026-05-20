// build sanity 2026-05-20 — triggers backend job to verify OCIR docker
// login under the rotated OCI_AUTH_TOKEN. Comment-only change; remove
// on the next functional commit.
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import type { Request } from 'express';

import { AppModule } from './app.module';

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

  app.setGlobalPrefix('api', { exclude: ['metrics'] });
  app.enableCors({
    origin: process.env.CORS_ORIGINS?.split(',').map((origin) => origin.trim()) ?? true,
    credentials: true
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
