import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { onboardingConfig } from '../config/onboarding.config';
import { GithubAppService } from './github-app.service';

@Module({
  imports: [ConfigModule.forFeature(onboardingConfig)],
  providers: [GithubAppService],
  exports: [GithubAppService],
})
export class GithubAppModule {}
