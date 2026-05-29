import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { parse } from 'tldts';

import { onboardingConfig } from '../config/onboarding.config';
import { CurrentDeployment } from '../deploy/deploy.service';
import {
  getCustomDomainIngressPath,
  renderCustomDomainIngress,
} from '../deploy/templates';
import { GithubAppService } from '../github-app/github-app.service';
import { UsersRepository } from '../onboarding/users.repository';
import { CertStatusCache } from './cert-status-cache';
import { DnsResolver } from './dns-resolver';
import {
  CustomDomainRow,
  CustomDomainStatus,
  CustomDomainsRepository,
  VerificationScheme,
} from './domain.repository';
import {
  REJECT_MESSAGES,
  RejectReason,
  validateCustomDomain,
} from './validation';

const TXT_PREFIX = '_swkoo-challenge.';
const TXT_VALUE_PREFIX = 'swkoo-domain-verification=';
const TOKEN_PREFIX = 'sk-';

/** Per (login, appName, domain) cooldown between /verify attempts.
 *  Backs the throttle that prevents DNS-resolution-spam: a confused user
 *  rapidly clicking [확인] would otherwise issue one DNS query per click
 *  to 1.1.1.1, and (worse) repeatedly retry the GitHub commit when DNS
 *  passes. Cooldown applies to all states that *attempt* work — not to
 *  applying/active which are idempotent early-returns. */
const VERIFY_COOLDOWN_MS = 30_000;

export type FailureStage = 'verify' | 'commit' | 'delete';

export interface OperatorFailureNotice {
  stage: FailureStage;
  actor: string;
  appName: string;
  domain: string;
  reason: string;
  lastError: string | null;
}

export interface DomainInfo {
  domain: string | null;
  status: CustomDomainStatus | null;
  /** Which verification flow this row uses. Drives the panel's record
   * count (cname_token = CNAME only; txt_cname = TXT + CNAME). */
  scheme: VerificationScheme | null;
  verificationToken: string | null;
  dnsRecords: {
    // null for cname_token (CNAME alone is the ownership proof).
    txt: { host: string; value: string } | null;
    cname: { host: string; target: string };
  } | null;
  verifiedAt: string | null;
  lastError: string | null;
  /** Machine reason of the last failure — lets the panel render
   * reason-specific recovery UX (e.g. conflict → prefix picker). */
  lastErrorReason: string | null;
  /** Registrable domain of `domain` (e.g. www.zieun.dev → zieun.dev).
   * Provided so the frontend doesn't have to ship a PSL parser for the
   * apex/conflict recovery UX. */
  registrableDomain: string | null;
  /** Context-specific suggestion: conflict → portfolio.<registrable>. */
  suggestedSubdomain: string | null;
  certificateReady: boolean;
  certificateError: string | null;
  /** Resolved external URL when status === 'active' and cert is ready. */
  url: string | null;
}

/** Orchestrates the v0 custom-domain flow. State machine lives in
 *  the repository; this layer enforces ownership, talks DNS, runs the
 *  manifest commit, and surfaces live cert status. Validation is
 *  delegated to `validateCustomDomain` (apex / swkoo / reserved). */
@Injectable()
export class DomainService {
  private readonly logger = new Logger(DomainService.name);
  /** Per-process Map. v0 single replica makes this correct; if we scale
   * out the worst-case is a user's cooldown round-robins across pods,
   * which is fine — the DB serializes the actual state transitions. */
  private readonly lastVerifyAttempt = new Map<string, number>();

  constructor(
    private readonly repo: CustomDomainsRepository,
    private readonly dns: DnsResolver,
    private readonly githubApp: GithubAppService,
    private readonly certCache: CertStatusCache,
    private readonly users: UsersRepository,
    @Inject(onboardingConfig.KEY)
    private readonly config: ConfigType<typeof onboardingConfig>
  ) {}

  private cooldownKey(login: string, appName: string, domain: string): string {
    return `${login}|${appName}|${domain}`;
  }

  /** Fire-and-forget operator notification for custom-domain failures.
   *  Reuses the existing `DISCORD_BUILD_FAILURE_WEBHOOK_URL` channel —
   *  same operator audience as deploy-pipeline failures, so no new env
   *  var. Failures here never throw: the API response must succeed even
   *  if the webhook is down. */
  private notifyOperatorOfFailure(notice: OperatorFailureNotice): void {
    const url = this.config.discordBuildFailureWebhookUrl;
    if (!url) return; // not configured → silently skip
    const stageLabel = notice.stage === 'verify'
      ? 'DNS 확인'
      : notice.stage === 'commit'
      ? '매니페스트 커밋'
      : '삭제';
    const lines = [
      '🟠 custom domain 실패',
      `**${notice.actor}** · ${notice.appName} · ${notice.domain}`,
      `단계: ${stageLabel} · reason: \`${notice.reason}\``,
    ];
    if (notice.lastError) lines.push(`> ${notice.lastError.slice(0, 500)}`);
    void axios
      .post(url, { content: lines.join('\n') }, { timeout: 5_000 })
      .catch((err) => {
        this.logger.error(
          `operator webhook failed for ${notice.stage}: ${(err as Error).message}`
        );
      });
  }

  async get(login: string, current: CurrentDeployment): Promise<DomainInfo> {
    const row = this.repo.findByLoginApp(login, current.appName);
    if (!row) {
      return this.emptyInfo();
    }
    return this.toInfo(row);
  }

  async register(args: {
    userId: number;
    current: CurrentDeployment;
    domain: string;
  }): Promise<DomainInfo> {
    const { userId, current, domain } = args;
    const login = current.login;
    const appName = current.appName;

    const validation = validateCustomDomain(domain);
    if (!validation.ok) {
      // Apex gets enriched payload so the panel can offer "use www.<domain>"
      // without shipping a PSL parser. For apex the input IS the registrable
      // domain (validation rejected it precisely because domain === registrable).
      if (validation.reason === 'APEX_NOT_SUPPORTED') {
        const registrable = (domain ?? '').trim().toLowerCase();
        throw new BadRequestException({
          reason: 'APEX_NOT_SUPPORTED',
          message: REJECT_MESSAGES.APEX_NOT_SUPPORTED,
          registrableDomain: registrable,
          suggestedSubdomain: `www.${registrable}`,
        });
      }
      throw new BadRequestException({
        reason: validation.reason,
        message: REJECT_MESSAGES[validation.reason as RejectReason],
      });
    }
    const normalized = validation.normalized as string;

    // Reject if (a) user already has a domain on this app, or (b) the
    // domain is taken globally. We hit DB twice but both are O(1) indexed
    // reads.
    const existing = this.repo.findByLoginApp(login, appName);
    if (existing) {
      throw new ConflictException({
        reason: 'DOMAIN_ALREADY_REGISTERED',
        message: `이 앱에 이미 도메인이 등록되어 있습니다: ${existing.domain}`,
      });
    }
    const globalConflict = this.repo.findByDomain(normalized);
    if (globalConflict) {
      throw new ConflictException({
        reason: 'DOMAIN_TAKEN',
        message: '이미 다른 사용자가 등록한 도메인입니다.',
      });
    }

    // v0.2: tokenized CNAME-only. The CNAME target embeds a per-
    // registration token (cd-<token>.<domainsBase>); pointing the domain
    // at that exact target is itself the ownership proof, so no TXT
    // record is needed. The target is a DNS landing pad — *.domainsBase
    // resolves to the cluster, Host-header routing does the rest (same
    // as the v0 <app>.apps.swkoo.kr target). New registrations are
    // always cname_token; existing rows stay txt_cname (grandfathered).
    const token = TOKEN_PREFIX + randomUUID().replace(/-/g, '');
    const expectedCname = `cd-${token}.${this.config.domainsBase}`;

    const row = this.repo.create({
      userId,
      login,
      appName,
      domain: normalized,
      scheme: 'cname_token',
      verificationToken: token,
      expectedCname,
    });
    this.users.audit({
      actor: login,
      action: 'DOMAIN_REGISTER',
      target: `${login}/${appName}:${normalized}`,
      reason: null,
      metaJson: null,
    });
    return this.toInfo(row);
  }

  /** Verifies DNS, commits the custom-domain ingress, transitions
   *  pending|error → verified → applying. Idempotent on re-call for the
   *  same row: if already applying|active, no-op. */
  async verify(current: CurrentDeployment): Promise<DomainInfo> {
    const login = current.login;
    const appName = current.appName;
    const row = this.repo.findByLoginApp(login, appName);
    if (!row) {
      throw new NotFoundException({
        reason: 'DOMAIN_NOT_REGISTERED',
        message: '등록된 도메인이 없습니다. 먼저 도메인을 추가하세요.',
      });
    }
    if (row.status === 'applying' || row.status === 'active') {
      // Idempotent early-return — no DNS query, no GitHub call. Don't
      // burn the cooldown budget on a free read.
      return this.toInfo(row);
    }

    // Cooldown — applies to pending|verified|error (states that trigger
    // real work below). Includes DNS-failure paths so a misconfigured
    // CNAME can't be hammered against 1.1.1.1.
    const key = this.cooldownKey(login, appName, row.domain);
    const lastAt = this.lastVerifyAttempt.get(key);
    const now = Date.now();
    if (lastAt && now - lastAt < VERIFY_COOLDOWN_MS) {
      const retryAfterSec = Math.ceil((VERIFY_COOLDOWN_MS - (now - lastAt)) / 1000);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: {
            reason: 'DOMAIN_VERIFY_COOLDOWN',
            message: `재시도까지 ${retryAfterSec}초 남았습니다. 잠시 후 다시 시도해 주세요.`,
            retryAfterSec,
          },
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
    this.lastVerifyAttempt.set(key, now);

    // DNS step. We surface DNS_NOT_FOUND vs DNS_MISMATCH separately so
    // the panel can guide the user (propagation lag vs wrong target).
    const dnsErr = await this.checkDns(row);
    if (dnsErr) {
      const errored = this.repo.updateStatus(row.id, 'error', {
        lastError: dnsErr.message,
        lastErrorReason: dnsErr.reason,
      });
      this.users.audit({
        actor: login,
        action: 'DOMAIN_VERIFY_FAILED',
        target: `${login}/${appName}:${row.domain}`,
        reason: dnsErr.reason,
        metaJson: null,
      });
      this.notifyOperatorOfFailure({
        stage: 'verify',
        actor: login,
        appName,
        domain: row.domain,
        reason: dnsErr.reason,
        lastError: dnsErr.message,
      });
      return this.toInfo(errored ?? row);
    }

    // Promote to verified, then commit. Two-step so an interrupt between
    // them leaves the row in `verified` with no commit — manual retry of
    // /verify resumes the commit. (Pure UX preference; could collapse.)
    this.repo.clearError(row.id);
    this.repo.updateStatus(row.id, 'verified', {
      verifiedAt: new Date().toISOString(),
    });

    try {
      const sha = await this.commitCustomDomainIngress(row);
      this.repo.markApplied(row.id, sha);
      const updated = this.repo.updateStatus(row.id, 'applying');
      this.users.audit({
        actor: login,
        action: 'DOMAIN_VERIFIED',
        target: `${login}/${appName}:${row.domain}`,
        reason: null,
        metaJson: JSON.stringify({ commitSha: sha }),
      });
      return this.toInfo(updated ?? row);
    } catch (err) {
      const msg = (err as Error).message;
      const errored = this.repo.updateStatus(row.id, 'error', {
        lastError: `manifest 커밋 실패: ${msg}`,
      });
      this.users.audit({
        actor: login,
        action: 'DOMAIN_COMMIT_FAILED',
        target: `${login}/${appName}:${row.domain}`,
        reason: 'COMMIT_FAILED',
        metaJson: JSON.stringify({ error: msg }),
      });
      this.notifyOperatorOfFailure({
        stage: 'commit',
        actor: login,
        appName,
        domain: row.domain,
        reason: 'COMMIT_FAILED',
        lastError: msg,
      });
      return this.toInfo(errored ?? row);
    }
  }

  /** Removes the custom-domain ingress from the deploy repo (single
   *  commit), then drops the DB row. If the manifest commit fails the
   *  row stays — better to leak a deploy-repo file than to claim a
   *  domain is gone while it's still routing traffic. */
  async delete(current: CurrentDeployment): Promise<void> {
    const login = current.login;
    const appName = current.appName;
    const row = this.repo.findByLoginApp(login, appName);
    if (!row) {
      // Idempotent — caller sees 204 either way.
      return;
    }
    // Only commit deletion if a manifest actually landed. A pending row
    // never had a commit, so just drop the DB row.
    if (row.appliedCommit) {
      try {
        await this.commitCustomDomainIngressRemove(row);
      } catch (err) {
        const msg = (err as Error).message;
        this.repo.updateStatus(row.id, 'error', {
          lastError: `삭제 커밋 실패: ${msg}`,
        });
        this.users.audit({
          actor: login,
          action: 'DOMAIN_DELETE_FAILED',
          target: `${login}/${appName}:${row.domain}`,
          reason: 'COMMIT_FAILED',
          metaJson: JSON.stringify({ error: msg }),
        });
        this.notifyOperatorOfFailure({
          stage: 'delete',
          actor: login,
          appName,
          domain: row.domain,
          reason: 'COMMIT_FAILED',
          lastError: msg,
        });
        throw err;
      }
    }
    this.repo.delete(row.id);
    this.certCache.invalidate(`user-${login}`, `${appName}-custom-domain-tls`);
    this.users.audit({
      actor: login,
      action: 'DOMAIN_DELETED',
      target: `${login}/${appName}:${row.domain}`,
      reason: null,
      metaJson: null,
    });
  }

  // ----- internal helpers -----

  private async checkDns(
    row: CustomDomainRow
  ): Promise<{ reason: string; message: string } | null> {
    // v0.2 cname_token: the tokenized CNAME target is the whole proof —
    // no TXT step. v0 txt_cname rows (grandfathered) still require the
    // TXT challenge before the CNAME check below.
    if (row.scheme === 'txt_cname') {
      const txtHost = TXT_PREFIX + row.domain;
      const expectedTxt = TXT_VALUE_PREFIX + row.verificationToken;
      let txtRecords: string[] = [];
      try {
        txtRecords = await this.dns.resolveTxt(txtHost);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOTFOUND' || code === 'ENODATA') {
          return {
            reason: 'DNS_TXT_NOT_FOUND',
            message: `TXT 레코드를 찾을 수 없습니다 (${txtHost}). DNS 전파를 기다리거나 레코드를 다시 확인하세요.`,
          };
        }
        return { reason: 'DNS_TXT_ERROR', message: `TXT 조회 실패: ${(err as Error).message}` };
      }
      if (!txtRecords.includes(expectedTxt)) {
        return {
          reason: 'DNS_TXT_MISMATCH',
          message: `TXT 값이 일치하지 않습니다. 기대값: ${expectedTxt}`,
        };
      }
    }

    let cnameRecords: string[] = [];
    try {
      cnameRecords = await this.dns.resolveCname(row.domain);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOTFOUND' || code === 'ENODATA') {
        // No CNAME. Before reporting plain "not found", check whether the
        // host already holds an A record — the usual reason a CNAME can't
        // be added (RFC 1034: a name can't have both). This turns a
        // confusing "CNAME 없음" into an actionable "기존 서비스와 충돌"
        // message. A-lookup failure must NOT break verify — fall back to
        // the plain not-found reason.
        const aConflict = await this.detectAConflict(row.domain);
        if (aConflict) return aConflict;
        return {
          reason: 'DNS_CNAME_NOT_FOUND',
          message: `CNAME 레코드를 찾을 수 없습니다 (${row.domain}).`,
        };
      }
      return { reason: 'DNS_CNAME_ERROR', message: `CNAME 조회 실패: ${(err as Error).message}` };
    }
    // Node returns the target without trailing dot; compare normalized.
    const expected = row.expectedCname.toLowerCase().replace(/\.$/, '');
    const matched = cnameRecords.map((c) => c.toLowerCase().replace(/\.$/, '')).includes(expected);
    if (!matched) {
      return {
        reason: 'DNS_CNAME_MISMATCH',
        message: `CNAME 대상이 일치하지 않습니다. 기대값: ${row.expectedCname}, 실제: ${cnameRecords.join(',') || '(none)'}`,
      };
    }
    return null;
  }

  /** When a CNAME can't be found, an A record on the same host is the
   * usual culprit (the domain already points at Vercel/Netlify/etc., and
   * DNS won't allow a CNAME alongside an A record). Returns the conflict
   * reason when an A record exists, else null. Swallows resolveA failures
   * (timeout/NXDOMAIN/NODATA) — diagnosis is best-effort and must never
   * break the verify flow; the caller falls back to DNS_CNAME_NOT_FOUND. */
  private async detectAConflict(
    domain: string
  ): Promise<{ reason: string; message: string } | null> {
    let aRecords: string[] = [];
    try {
      aRecords = await this.dns.resolveA(domain);
    } catch {
      return null; // no A record / lookup failed → not a conflict we can assert
    }
    if (aRecords.length === 0) return null;
    // Registrable domain via the public-suffix list (tldts) so the
    // "new subdomain" suggestion is correct even for multi-label TLDs
    // (zieun.co.kr) and deeper subdomains (a.b.zieun.dev → zieun.dev).
    // Fall back to strip-first-label if tldts can't resolve it.
    const registrable = parse(domain).domain ?? domain.split('.').slice(1).join('.');
    return {
      reason: 'DNS_CNAME_CONFLICTS_WITH_A',
      message:
        `${domain}은 현재 다른 서비스(Vercel 등)로 연결된 A 레코드가 있습니다. ` +
        `DNS 규칙상 한 host는 A 레코드와 CNAME을 동시에 가질 수 없습니다. ` +
        `기존 서비스를 유지하려면 portfolio.${registrable} 같은 새 subdomain을 사용하세요. ` +
        `${domain}을 swkoo.kr로 옮기려면 기존 A 레코드를 삭제하고 CNAME을 추가하세요.`,
    };
  }

  private async commitCustomDomainIngress(row: CustomDomainRow): Promise<string> {
    const deployOrg = this.config.deployOwner;
    const deployRepo = row.login;
    const token = await this.githubApp.getInstallationTokenForRepo(deployOrg, deployRepo);
    const path = getCustomDomainIngressPath(row.appName);

    // Render the new Ingress (custom-domain only). Build a minimal
    // RenderParams shim — only login/appName are referenced by
    // renderCustomDomainIngress, but the type is broader so we satisfy it
    // with safe defaults that go unread.
    const ingressYaml = renderCustomDomainIngress({
      login: row.login,
      appName: row.appName,
      domain: row.domain,
    });
    const updatedKustomization = await this.updateKustomizationAddEntry(
      deployOrg,
      deployRepo,
      row.appName,
      token
    );

    return await this.githubApp.commitFilesAtomic({
      owner: deployOrg,
      repo: deployRepo,
      branch: 'main',
      files: {
        [path]: ingressYaml,
        'kustomization.yaml': updatedKustomization,
      },
      message: `feat(domain): add custom domain ${row.domain}\n\nManaged by https://swkoo.kr — re-render preserves this Ingress until the user removes the domain.`,
      token,
    });
  }

  private async commitCustomDomainIngressRemove(row: CustomDomainRow): Promise<string> {
    const deployOrg = this.config.deployOwner;
    const deployRepo = row.login;
    const token = await this.githubApp.getInstallationTokenForRepo(deployOrg, deployRepo);
    const path = getCustomDomainIngressPath(row.appName);
    const updatedKustomization = await this.updateKustomizationRemoveEntry(
      deployOrg,
      deployRepo,
      row.appName,
      token
    );
    return await this.githubApp.commitFilesAtomic({
      owner: deployOrg,
      repo: deployRepo,
      branch: 'main',
      files: {
        'kustomization.yaml': updatedKustomization,
      },
      deletePaths: [path],
      message: `chore(domain): remove custom domain ${row.domain}\n\nManaged by https://swkoo.kr — base <slug>.apps.swkoo.kr URL preserved.`,
      token,
    });
  }

  private async updateKustomizationAddEntry(
    owner: string,
    repo: string,
    appName: string,
    token: string
  ): Promise<string> {
    const current = await this.fetchFile(owner, repo, 'kustomization.yaml', token);
    const entry = `  - ${appName}/custom-domain-ingress.yaml`;
    if (current.split('\n').some((l) => l.trim() === entry.trim())) {
      return current;
    }
    // Append at end of `resources:` block. Simplest: ensure file ends
    // with newline, then add the entry. kustomize doesn't care about
    // order within resources.
    const trimmed = current.endsWith('\n') ? current : current + '\n';
    return trimmed + entry + '\n';
  }

  private async updateKustomizationRemoveEntry(
    owner: string,
    repo: string,
    appName: string,
    token: string
  ): Promise<string> {
    const current = await this.fetchFile(owner, repo, 'kustomization.yaml', token);
    const entry = `${appName}/custom-domain-ingress.yaml`;
    return current
      .split('\n')
      .filter((l) => !l.trim().endsWith(entry) || !l.trim().startsWith('-'))
      .join('\n');
  }

  private async fetchFile(
    owner: string,
    repo: string,
    path: string,
    token: string
  ): Promise<string> {
    // Direct authenticated read — avoids adding a public method on
    // GithubAppService just for read-by-path.
    const resp = await axios.get<{ content: string; encoding: string }>(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );
    return Buffer.from(resp.data.content, 'base64').toString('utf8');
  }

  private async toInfo(row: CustomDomainRow): Promise<DomainInfo> {
    const ns = `user-${row.login}`;
    const certName = `${row.appName}-custom-domain-tls`;
    const cert = await this.certCache.get(ns, certName);

    // Opportunistic state transition: when ArgoCD has synced the new
    // Ingress and cert-manager has issued the cert, flip applying →
    // active. Done in toInfo (GET path) so we don't need a cron.
    let row2 = row;
    if (row.status === 'applying' && cert.ready) {
      row2 = this.repo.updateStatus(row.id, 'active') ?? row;
      this.users.audit({
        actor: row.login,
        action: 'DOMAIN_ACTIVE',
        target: `${row.login}/${row.appName}:${row.domain}`,
        reason: null,
        metaJson: null,
      });
    }

    // TXT row only for the grandfathered v0 scheme; cname_token rows
    // surface CNAME alone (the whole point of v0.2).
    const txtRecord =
      row2.scheme === 'txt_cname'
        ? {
            host: `_swkoo-challenge.${row2.domain}`,
            value: `swkoo-domain-verification=${row2.verificationToken}`,
          }
        : null;

    // registrableDomain + suggestedSubdomain power the conflict-recovery
    // UX (prefix picker). Computed from the row's domain via PSL so
    // multi-label TLDs are correct; suggestion is conflict-specific.
    const registrableDomain = parse(row2.domain).domain ?? null;
    const suggestedSubdomain =
      row2.lastErrorReason === 'DNS_CNAME_CONFLICTS_WITH_A' && registrableDomain
        ? `portfolio.${registrableDomain}`
        : null;

    return {
      domain: row2.domain,
      status: row2.status,
      scheme: row2.scheme,
      verificationToken: row2.status === 'pending' || row2.status === 'error'
        ? row2.verificationToken
        : null,
      dnsRecords: row2.status !== 'active'
        ? {
            txt: txtRecord,
            cname: { host: row2.domain, target: row2.expectedCname },
          }
        : null,
      verifiedAt: row2.verifiedAt,
      lastError: row2.lastError,
      lastErrorReason: row2.lastErrorReason,
      registrableDomain,
      suggestedSubdomain,
      certificateReady: cert.ready,
      certificateError: cert.fetchError ?? null,
      url: row2.status === 'active' && cert.ready ? `https://${row2.domain}` : null,
    };
  }

  private emptyInfo(): DomainInfo {
    return {
      domain: null,
      status: null,
      scheme: null,
      verificationToken: null,
      dnsRecords: null,
      verifiedAt: null,
      lastError: null,
      lastErrorReason: null,
      registrableDomain: null,
      suggestedSubdomain: null,
      certificateReady: false,
      certificateError: null,
      url: null,
    };
  }
}
