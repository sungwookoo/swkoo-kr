import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { onboardingConfig } from '../config/onboarding.config';
import { webhooksConfig } from '../config/webhooks.config';
import { GithubAppModule } from '../github-app/github-app.module';
import { KubeModule } from '../kube/kube.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { CertStatusCache } from './cert-status-cache';
import { DnsResolver } from './dns-resolver';
import { DomainController } from './domain.controller';
import { CustomDomainsRepository } from './domain.repository';
import { DomainService } from './domain.service';

@Module({
  imports: [
    ConfigModule.forFeature(webhooksConfig),
    ConfigModule.forFeature(onboardingConfig),
    GithubAppModule,
    KubeModule,
    OnboardingModule,
  ],
  controllers: [DomainController],
  providers: [
    CustomDomainsRepository,
    DnsResolver,
    CertStatusCache,
    DomainService,
  ],
  exports: [CustomDomainsRepository, DnsResolver],
})
export class DomainModule {}
