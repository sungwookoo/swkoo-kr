import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { onboardingConfig } from '../config/onboarding.config';
import { webhooksConfig } from '../config/webhooks.config';
import { DeployModule } from '../deploy/deploy.module';
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
    // Circular: DeployModule already imports DomainModule for the
    // re-render preservation guard. DomainController needs DeployService
    // for current-deployment binding; forwardRef breaks the cycle.
    forwardRef(() => DeployModule),
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
