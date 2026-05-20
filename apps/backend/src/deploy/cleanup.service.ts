import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import { onboardingConfig } from '../config/onboarding.config';
import { UsersRepository } from '../onboarding/users.repository';
import { GithubAppService } from './github-app.service';
import { ScanService } from './scan.service';

const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Daily housekeeping cron — enforces the 30-day retention window promised
 * in the privacy policy. Two jobs:
 *
 *   1. users: hard-delete rows where deleted_at < now - 30d, along with the
 *      anonymized audit_log entries pointed at them.
 *   2. swkoo-deploy org: hard-delete repos archived for > 30d (operator
 *      retains the option to manually unarchive within the window).
 *
 * Single backend replica → no leader election; @nestjs/schedule fires once
 * per scheduled tick in this process. Each tick is logged + audited so the
 * operator can spot anomalies (e.g. a run that tries to delete thousands).
 */
@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);

  constructor(
    private readonly users: UsersRepository,
    private readonly githubApp: GithubAppService,
    private readonly scan: ScanService,
    @Inject(onboardingConfig.KEY)
    private readonly config: ConfigType<typeof onboardingConfig>
  ) {}

  // Daily at 03:00 KST (UTC offset varies; just pick a low-traffic hour).
  // Production schedule would pull this from config; for now a constant is
  // fine — one replica and a short user list.
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async runDailyCleanup(): Promise<void> {
    this.logger.log('daily housekeeping cron tick');
    await this.cleanupSoftDeletedUsers();
    await this.cleanupArchivedDeployRepos();
    await this.scan.scanAllActiveUsers();
    await this.scan.scanOperatorImages();
  }

  /** Public for tests / manual triggering. */
  cleanupSoftDeletedUsers(): void {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * DAY_MS).toISOString();
    const deleted = this.users.hardDeleteOldUsers(cutoff);
    if (deleted > 0) {
      this.users.audit({
        actor: 'system',
        action: 'CLEANUP_HARD_DELETE_USERS',
        target: null,
        reason: null,
        metaJson: JSON.stringify({ count: deleted, cutoff }),
      });
      this.logger.log(`hard-deleted ${deleted} soft-deleted user row(s) older than ${cutoff}`);
    }
  }

  /** Public for tests / manual triggering. */
  async cleanupArchivedDeployRepos(): Promise<void> {
    const cutoffMs = Date.now() - RETENTION_DAYS * DAY_MS;
    let token: string;
    try {
      token = await this.githubApp.getInstallationTokenForOrg(this.config.deployOwner);
    } catch (err) {
      this.logger.warn(
        `cleanup: could not mint org token for ${this.config.deployOwner}: ${(err as Error).message}`
      );
      return;
    }
    let archived: Awaited<ReturnType<GithubAppService['listArchivedRepos']>>;
    try {
      archived = await this.githubApp.listArchivedRepos(this.config.deployOwner, token);
    } catch (err) {
      this.logger.warn(`cleanup: listArchivedRepos failed: ${(err as Error).message}`);
      return;
    }
    const expired = archived.filter(
      (r) => Date.parse(r.archivedSinceIso) < cutoffMs
    );
    if (expired.length === 0) {
      this.logger.log(`cleanup: ${archived.length} archived repo(s) found, none past retention`);
      return;
    }
    for (const r of expired) {
      try {
        await this.githubApp.deleteRepo({
          owner: this.config.deployOwner,
          repo: r.name,
          token,
        });
      } catch (err) {
        this.logger.error(`cleanup: deleteRepo ${r.name} failed: ${(err as Error).message}`);
      }
    }
    this.users.audit({
      actor: 'system',
      action: 'CLEANUP_HARD_DELETE_REPOS',
      target: null,
      reason: null,
      metaJson: JSON.stringify({
        count: expired.length,
        names: expired.map((r) => r.name),
      }),
    });
    this.logger.log(`cleanup: hard-deleted ${expired.length} archived repo(s)`);
  }
}
