import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { webhooksConfig } from '../config/webhooks.config';
import { CustomDomainsRepository } from './domain.repository';
import { DnsResolver } from './dns-resolver';

/** v0 — only foundation pieces wired here (repository + DNS resolver).
 * Service + controller land in commit 3 once templates/RBAC are in. */
@Module({
  imports: [ConfigModule.forFeature(webhooksConfig)],
  providers: [CustomDomainsRepository, DnsResolver],
  exports: [CustomDomainsRepository, DnsResolver],
})
export class DomainModule {}
