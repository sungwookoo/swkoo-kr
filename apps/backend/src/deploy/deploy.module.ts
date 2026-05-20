import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { emailConfig } from '../config/email.config';
import { onboardingConfig } from '../config/onboarding.config';
import { EmailModule } from '../email/email.module';
import { KubeModule } from '../kube/kube.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { PipelinesModule } from '../pipelines/pipelines.module';
import { AccountController } from './account.controller';
import { CleanupService } from './cleanup.service';
import { DeployController } from './deploy.controller';
import { DeployService } from './deploy.service';
import { EnvService } from './env.service';
import { GithubAppService } from './github-app.service';
import { ScanService } from './scan.service';

@Module({
  imports: [
    OnboardingModule,
    PipelinesModule,
    KubeModule,
    EmailModule,
    ConfigModule.forFeature(onboardingConfig),
    ConfigModule.forFeature(emailConfig),
  ],
  controllers: [DeployController, AccountController],
  providers: [DeployService, GithubAppService, EnvService, CleanupService, ScanService],
  exports: [DeployService, GithubAppService, EnvService],
})
export class DeployModule {}
