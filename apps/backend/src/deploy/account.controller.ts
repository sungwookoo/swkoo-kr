import {
  Controller,
  Delete,
  Get,
  Header,
  Logger,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import { JwtAuthGuard, type AuthedRequest } from '../onboarding/jwt-auth.guard';
import { SESSION_COOKIE } from '../onboarding/auth.service';
import { UsersRepository } from '../onboarding/users.repository';
import { DeployService } from './deploy.service';
import { EnvService } from './env.service';
import { Req } from '@nestjs/common';

@Controller('account')
@UseGuards(JwtAuthGuard)
export class AccountController {
  private readonly logger = new Logger(AccountController.name);

  constructor(
    private readonly users: UsersRepository,
    private readonly deploy: DeployService,
    private readonly env: EnvService
  ) {}

  /** Latest Trivy scan for the requesting user, or null if never scanned.
   * Lightweight (single DB row) — safe to call on page load. Decodes the
   * findings JSON for the frontend (it doesn't need to know we stored it
   * as a string). The full record lives in /account/export. */
  @Get('scan')
  getLatestScan(@Req() req: AuthedRequest): unknown {
    const row = this.users.latestScanResultForUser(req.user.id);
    if (!row) return null;
    let findings: unknown[] = [];
    if (row.findingsJson) {
      try {
        const parsed: unknown = JSON.parse(row.findingsJson);
        if (Array.isArray(parsed)) findings = parsed;
      } catch {
        // legacy or corrupted blob — treat as empty
      }
    }
    return {
      id: row.id,
      userId: row.userId,
      image: row.image,
      critical: row.critical,
      high: row.high,
      medium: row.medium,
      scannedAt: row.scannedAt,
      trivyVersion: row.trivyVersion,
      findings,
    };
  }

  /** GDPR Art.20 / K-PIPA right to data portability. Returns everything the
   * service knows about the requesting user as a single JSON document. Env
   * values are included (the user already sees them in the env panel — not
   * including them here would be inconsistent). */
  @Get('export')
  @Header('Content-Type', 'application/json; charset=utf-8')
  async exportData(@Req() req: AuthedRequest): Promise<unknown> {
    const user = req.user;
    const deployment = await this.deploy.getCurrentDeployment(user.githubLogin);
    let envVars: Record<string, string> = {};
    if (deployment) {
      try {
        envVars = await this.env.getEnv(user.githubLogin, deployment.appName);
      } catch (err) {
        this.logger.warn(`env export failed for ${user.githubLogin}: ${(err as Error).message}`);
      }
    }
    const auditLog = this.users.listAuditByActor(user.githubLogin);
    const latestScan = this.users.latestScanResultForUser(user.id);
    return {
      exportedAt: new Date().toISOString(),
      user: {
        githubLogin: user.githubLogin,
        githubId: user.githubId,
        name: user.name,
        email: user.email,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        isAllowed: user.isAllowed,
      },
      deployment,
      envVars,
      latestScan,
      auditLog,
    };
  }

  /** GDPR Art.17 / K-PIPA Art.36 right to erasure. Tears down the active
   * deployment (if any), anonymizes the user row + their audit entries in
   * place (preserving FK shape so retained ops audit stays coherent), then
   * clears the session cookie so the response is the user's logout. */
  @Delete()
  async deleteAccount(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response
  ): Promise<{ ok: true }> {
    const user = req.user;
    const login = user.githubLogin;

    // Tear down deployment if active. NO_EXISTING_DEPLOYMENT is fine — just
    // means there was nothing to delete.
    try {
      await this.deploy.deleteDeployment(login);
    } catch (err) {
      const reason = (err as { response?: { reason?: string } }).response?.reason;
      if (reason !== 'NO_EXISTING_DEPLOYMENT') {
        this.logger.warn(`pre-delete deployment cleanup failed for ${login}: ${(err as Error).message}`);
        // Continue anyway — the user wants their account gone; we don't want
        // a transient infra hiccup to block that. Operator will see archived
        // repo / leftover Application via Observatory.
      }
    }

    this.users.audit({
      actor: login,
      action: 'ACCOUNT_DELETE',
      target: null,
      reason: null,
      metaJson: null,
    });
    this.users.softDeleteUser(user.id);

    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }
}
