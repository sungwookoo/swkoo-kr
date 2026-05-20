import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Post,
  Req,
  UnauthorizedException
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { webhooksConfig } from '../config/webhooks.config';
import { WebhooksService } from './webhooks.service';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

// HMAC-protected webhook endpoints (ArgoCD, GitHub) already authenticate
// the sender. Rate-limiting them risks dropping events from bursts of
// legitimate activity (e.g., a GHA workflow that emits many run events
// in quick succession).
@SkipThrottle()
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly service: WebhooksService,
    @Inject(webhooksConfig.KEY)
    private readonly config: ConfigType<typeof webhooksConfig>
  ) {}

  @Post('argocd')
  @HttpCode(204)
  receiveArgocd(
    @Req() req: RawBodyRequest,
    @Headers('x-webhook-secret') token: string | undefined
  ): void {
    if (!this.config.argocdSecret) {
      throw new UnauthorizedException('argocd webhook secret not configured');
    }
    if (!token || !this.constantTimeEqual(token, this.config.argocdSecret)) {
      throw new UnauthorizedException('invalid argocd webhook secret');
    }
    const raw = this.requireRaw(req);
    const parsed = this.parseJson(raw);
    this.service.receive('argocd', raw.toString('utf8'), parsed);
  }

  @Post('github')
  @HttpCode(204)
  receiveGithub(
    @Req() req: RawBodyRequest,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Headers('x-github-event') event: string | undefined
  ): void {
    if (!this.config.githubSecret) {
      throw new UnauthorizedException('github webhook secret not configured');
    }
    if (!signature) {
      throw new UnauthorizedException('missing X-Hub-Signature-256');
    }
    const raw = this.requireRaw(req);
    if (!this.verifyGithubSignature(raw, signature)) {
      throw new UnauthorizedException('invalid github signature');
    }
    if (event && event !== 'workflow_run' && event !== 'ping') {
      this.logger.debug(`github event '${event}' ignored`);
      return;
    }
    if (event === 'ping') {
      return;
    }
    const parsed = this.parseJson(raw);
    this.service.receive('github', raw.toString('utf8'), parsed);
  }

  private requireRaw(req: RawBodyRequest): Buffer {
    if (!req.rawBody) {
      throw new BadRequestException('raw body unavailable');
    }
    return req.rawBody;
  }

  private parseJson(raw: Buffer): unknown {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      throw new BadRequestException('invalid JSON body');
    }
  }

  private constantTimeEqual(a: string, b: string): boolean {
    const aBuf = Buffer.from(a, 'utf8');
    const bBuf = Buffer.from(b, 'utf8');
    if (aBuf.length !== bBuf.length) return false;
    return timingSafeEqual(aBuf, bBuf);
  }

  private verifyGithubSignature(raw: Buffer, signature: string): boolean {
    if (!this.config.githubSecret) return false;
    const hmac = createHmac('sha256', this.config.githubSecret);
    hmac.update(raw);
    const expected = `sha256=${hmac.digest('hex')}`;
    const sigBuf = Buffer.from(signature, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expBuf.length) return false;
    return timingSafeEqual(sigBuf, expBuf);
  }
}
