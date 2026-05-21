import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';

import { EventsModule } from '../events/events.module';
import { GithubAppModule } from '../github-app/github-app.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { PipelinesController } from './pipelines.controller';
import { PipelinesService } from './pipelines.service';
import { ProvenanceRepository } from './provenance.repository';
import { ProvenanceService } from './provenance.service';
import { ArgoCdClient } from './services/argo-cd.client';
import { GitHubClient } from './services/github.client';

@Module({
  imports: [HttpModule, EventsModule, OnboardingModule, GithubAppModule],
  controllers: [PipelinesController],
  providers: [
    ArgoCdClient,
    GitHubClient,
    ProvenanceRepository,
    ProvenanceService,
    PipelinesService,
  ],
  exports: [PipelinesService, ArgoCdClient]
})
export class PipelinesModule {}
