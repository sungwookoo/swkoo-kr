import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { alertmanagerConfig } from './config/alertmanager.config';
import { backupConfig } from './config/backup.config';
import { githubConfig } from './config/github.config';
import { onboardingConfig } from './config/onboarding.config';
import { pipelinesConfig } from './config/pipelines.config';
import { webhooksConfig } from './config/webhooks.config';

import { AlertsModule } from './alerts/alerts.module';
import { BackupModule } from './backup/backup.module';
import { DeployModule } from './deploy/deploy.module';
import { HealthController } from './health/health.controller';
import { MetricsModule } from './metrics/metrics.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { OverviewController } from './overview/overview.controller';
import { OverviewService } from './overview/overview.service';
import { PipelinesModule } from './pipelines/pipelines.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [pipelinesConfig, githubConfig, alertmanagerConfig, webhooksConfig, onboardingConfig, backupConfig]
    }),
    ScheduleModule.forRoot(),
    // Global rate limiter — primary purpose is brute-force protection on
    // `/api/auth/*` (OAuth callback, consent, logout) and `/api/admin/*`.
    // 60 req / minute / IP is generous enough that no legitimate user
    // hits it during a normal session.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    PipelinesModule,
    AlertsModule,
    MetricsModule,
    WebhooksModule,
    OnboardingModule,
    DeployModule,
    BackupModule
  ],
  controllers: [HealthController, OverviewController],
  providers: [
    OverviewService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
