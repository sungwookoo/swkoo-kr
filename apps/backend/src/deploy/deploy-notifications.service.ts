import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';

import { DeploySuccessEmail, EmailService } from '../email/email.service';
import { UsersRepository } from '../onboarding/users.repository';
import { ArgoCdClient } from '../pipelines/services/argo-cd.client';
import type { ArgoCdApplication } from '../pipelines/types/argo-cd.types';
import { DeployService } from './deploy.service';

/** Require the compared source and resource summary to agree with the desired
 * image. An old Healthy status alone does not establish a new deployment. */
export function readyImageDigest(app: ArgoCdApplication | null, login: string, repo: string): string | null {
  const status = app?.status;
  if (status?.sync?.status !== 'Synced' || status.health?.status !== 'Healthy') return null;
  if (status.operationState?.phase !== 'Succeeded') return null;
  const imageRepo = `ghcr.io/${login}/${repo}`.toLowerCase();
  const matches = (image: string) => image.toLowerCase().startsWith(`${imageRepo}:`)
    || image.toLowerCase().startsWith(`${imageRepo}@`);
  const desired = app?.spec.source?.kustomize?.images?.find(matches);
  const digest = desired?.match(/@(sha256:[a-f0-9]{64})$/)?.[1];
  if (!digest || !desired) return null;
  if (!status.sync.comparedTo?.source?.kustomize?.images?.includes(desired)) return null;
  if (!status.summary?.images?.some((image) => matches(image) && image.endsWith(`@${digest}`))) return null;
  return digest;
}

@Injectable()
export class DeployNotificationsService {
  private readonly logger = new Logger(DeployNotificationsService.name);
  // The backend currently has one replica. Prevent overlapping cron ticks.
  private running = false;

  constructor(
    private readonly users: UsersRepository,
    private readonly deploy: DeployService,
    private readonly argo: ArgoCdClient,
    private readonly email: EmailService
  ) {}

  @Cron('*/1 * * * *')
  async notifyReadyDeployments(): Promise<void> {
    if (this.running || !this.email.enabled()) return;
    this.running = true;
    try {
      for (const user of this.users.listAllUsers()) {
        if (!user.email || !user.isAllowed) continue;
        try {
          const current = await this.deploy.getCurrentDeployment(user.githubLogin);
          if (!current || current.state !== 'active') continue;
          const app = await this.argo.getApplication(`swkoo-user-${current.login}`);
          const digest = readyImageDigest(app, current.login, current.repo);
          if (!digest || this.users.getLastNotifiedImageSha(user.id) === digest) continue;
          const live = await axios.get(current.liveUrl, {
            timeout: 3000, maxRedirects: 3, validateStatus: () => true,
          });
          if (live.status < 200 || live.status >= 400) continue;
          // Account deletion may have completed while external requests ran.
          if (!this.users.findById(user.id)?.isAllowed) continue;
          const notification = this.users.queueDeployNotification(user.id, digest, {
            to: user.email, login: current.login, repo: current.repo,
            liveUrl: current.liveUrl, imageDigest: digest,
          });
          if (notification.state !== 'pending') continue;
          const now = Date.now();
          // Resend retains idempotency keys for 24h. Stop before that window
          // expires: an ambiguous earlier response must not cause duplicates.
          if (notification.firstAttemptAt !== null && now - notification.firstAttemptAt >= 23 * 60 * 60_000) {
            this.users.finishDeployNotification(notification.id, user.id, digest, 'expired');
            this.users.audit({ actor: user.githubLogin, action: 'DEPLOY_NOTIFY_EXPIRED',
              target: current.repo, reason: 'RETRY_WINDOW_EXPIRED', metaJson: JSON.stringify({ digest }) });
            this.logger.warn(`Deploy email retry window expired for ${current.login}/${current.repo}`);
            continue;
          }
          if (notification.nextAttemptAt > now) continue;
          this.users.startDeployNotificationAttempt(notification.id, now);
          const sent = await this.email.sendDeploySuccess(
            JSON.parse(notification.payload) as DeploySuccessEmail,
            notification.idempotencyKey
          );
          if (sent && this.users.findById(user.id)) {
            this.users.finishDeployNotification(notification.id, user.id, digest, 'sent');
            this.users.audit({ actor: user.githubLogin, action: 'DEPLOY_NOTIFY',
              target: current.repo, reason: null, metaJson: JSON.stringify({ digest }) });
          }
        } catch (err) {
          this.logger.warn(`Deploy notification check failed for ${user.githubLogin}: ${(err as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
