import { Controller, Get, Header } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

// Skip rate limiting — kubelet liveness/readiness probes hit this on a
// fixed cadence from a single source IP (the node). 6 req/min today,
// but defensive: never want a probe to be 429'd.
@SkipThrottle()
@Controller('health')
export class HealthController {
  @Get()
  @Header('Cache-Control', 'no-store')
  getHealth() {
    return {
      status: 'ok',
      revision: /^[a-f0-9]{40}$/.test(process.env.BUILD_REVISION ?? '') ? process.env.BUILD_REVISION : null,
      timestamp: new Date().toISOString()
    };
  }
}
