import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import axios from 'axios';

import { emailConfig } from '../config/email.config';

export interface DeploySuccessEmail {
  to: string;          // recipient email (from users.email)
  login: string;       // GitHub login — for personalization
  repo: string;        // repo name
  liveUrl: string;     // https://<slug>.apps.swkoo.kr
  imageDigest: string; // short sha256 prefix for traceability
}

/**
 * Thin Resend wrapper. We only need POST /emails; not worth pulling in
 * the resend SDK. Failures are logged but never thrown — email is a
 * notification side-effect, never the user's deploy path.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @Inject(emailConfig.KEY)
    private readonly config: ConfigType<typeof emailConfig>
  ) {}

  enabled(): boolean {
    return this.config.enabled;
  }

  async sendDeploySuccess(payload: DeploySuccessEmail): Promise<boolean> {
    if (!this.config.enabled) return false;
    if (!payload.to) {
      this.logger.warn(`deploy-success email skipped: no recipient for ${payload.login}`);
      return false;
    }

    const subject = `swkoo.kr 배포 완료 — ${payload.repo}`;
    const text = this.renderText(payload);
    const html = this.renderHtml(payload);

    try {
      await axios.post(
        'https://api.resend.com/emails',
        {
          from: this.config.from,
          to: [payload.to],
          subject,
          text,
          html,
        },
        {
          headers: {
            Authorization: `Bearer ${this.config.resendApiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 10_000,
        }
      );
      this.logger.log(`deploy-success email sent to ${payload.to} for ${payload.login}/${payload.repo}`);
      return true;
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      this.logger.error(
        `deploy-success email failed (${status ?? 'no-status'}) to ${payload.to}: ${(err as Error).message}`
      );
      return false;
    }
  }

  private renderText(p: DeploySuccessEmail): string {
    return [
      `안녕하세요, @${p.login}.`,
      '',
      `${p.repo} 가 swkoo.kr 클러스터에 배포 완료됐습니다.`,
      '',
      `라이브 URL: ${p.liveUrl}`,
      `이미지: ${p.imageDigest}`,
      '',
      '진행도 / 환경변수 / 스캔 결과:',
      `${this.config.appBaseUrl}/deploy/${p.login.toLowerCase()}/${p.repo}`,
      '',
      '— swkoo.kr',
      '이 메시지는 swkoo.kr/deploy 등록자에게 자동 발송됩니다. 알림 해제는 계정 삭제로 가능합니다.',
    ].join('\n');
  }

  private renderHtml(p: DeploySuccessEmail): string {
    const dashboardUrl = `${this.config.appBaseUrl}/deploy/${p.login.toLowerCase()}/${p.repo}`;
    return `<!doctype html>
<html lang="ko">
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #1f2937; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="margin: 0 0 16px; font-size: 18px;">✅ swkoo.kr 배포 완료</h2>
  <p style="margin: 0 0 12px;">@${escapeHtml(p.login)} — <code style="background:#f3f4f6; padding:2px 6px; border-radius:4px; font-size:13px;">${escapeHtml(p.repo)}</code> 가 라이브 상태입니다.</p>
  <p style="margin: 16px 0;"><a href="${escapeAttr(p.liveUrl)}" style="display:inline-block; background:#10b981; color:#fff; padding:10px 18px; border-radius:6px; text-decoration:none; font-weight:500;">${escapeHtml(p.liveUrl)} 열기 →</a></p>
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
  <p style="margin: 0 0 8px; font-size: 13px; color: #6b7280;">이미지 digest</p>
  <code style="display:block; background:#f9fafb; padding:8px 12px; border-radius:4px; font-size:12px; color:#374151;">${escapeHtml(p.imageDigest)}</code>
  <p style="margin: 16px 0 0; font-size: 13px;"><a href="${escapeAttr(dashboardUrl)}" style="color:#3b82f6; text-decoration:none;">진행도·환경변수·스캔 결과 보기 →</a></p>
  <p style="margin: 32px 0 0; font-size: 11px; color: #9ca3af;">이 메시지는 swkoo.kr/deploy 등록자에게 자동 발송됩니다. 알림 해제는 swkoo.kr/deploy 에서 계정 삭제로 가능합니다.</p>
</body>
</html>`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
