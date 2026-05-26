import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import axios from 'axios';
import { randomUUID } from 'node:crypto';

import { onboardingConfig } from '../config/onboarding.config';
import {
  getCustomDomainIngressPath,
  sanitizeName,
} from '../deploy/templates';
import { GithubAppService } from '../github-app/github-app.service';
import { UsersRepository } from '../onboarding/users.repository';
import { CertStatusCache } from './cert-status-cache';
import { DnsResolver } from './dns-resolver';
import {
  CustomDomainRow,
  CustomDomainStatus,
  CustomDomainsRepository,
} from './domain.repository';
import {
  REJECT_MESSAGES,
  RejectReason,
  validateCustomDomain,
} from './validation';

const TXT_PREFIX = '_swkoo-challenge.';
const TXT_VALUE_PREFIX = 'swkoo-domain-verification=';
const TOKEN_PREFIX = 'sk-';

export interface DomainInfo {
  domain: string | null;
  status: CustomDomainStatus | null;
  verificationToken: string | null;
  dnsRecords: {
    txt: { host: string; value: string };
    cname: { host: string; target: string };
  } | null;
  verifiedAt: string | null;
  lastError: string | null;
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

  constructor(
    private readonly repo: CustomDomainsRepository,
    private readonly dns: DnsResolver,
    private readonly githubApp: GithubAppService,
    private readonly certCache: CertStatusCache,
    private readonly users: UsersRepository,
    @Inject(onboardingConfig.KEY)
    private readonly config: ConfigType<typeof onboardingConfig>
  ) {}

  async get(login: string, repo: string): Promise<DomainInfo> {
    const appName = sanitizeName(repo);
    const row = this.repo.findByLoginApp(login, appName);
    if (!row) {
      return this.emptyInfo();
    }
    return this.toInfo(row);
  }

  async register(args: {
    userId: number;
    login: string;
    repo: string;
    domain: string;
  }): Promise<DomainInfo> {
    const { userId, login, repo, domain } = args;
    const appName = sanitizeName(repo);

    const validation = validateCustomDomain(domain);
    if (!validation.ok) {
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

    const subdomain = this.subdomainForUserApp(userId, login, appName);
    const expectedCname = `${subdomain}.${this.config.appsDomain}`;
    const token = TOKEN_PREFIX + randomUUID().replace(/-/g, '');

    const row = this.repo.create({
      userId,
      login,
      appName,
      domain: normalized,
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
  async verify(login: string, repo: string): Promise<DomainInfo> {
    const appName = sanitizeName(repo);
    const row = this.repo.findByLoginApp(login, appName);
    if (!row) {
      throw new NotFoundException({
        reason: 'DOMAIN_NOT_REGISTERED',
        message: '등록된 도메인이 없습니다. 먼저 도메인을 추가하세요.',
      });
    }
    if (row.status === 'applying' || row.status === 'active') {
      return this.toInfo(row);
    }

    // DNS step. We surface DNS_NOT_FOUND vs DNS_MISMATCH separately so
    // the panel can guide the user (propagation lag vs wrong target).
    const dnsErr = await this.checkDns(row);
    if (dnsErr) {
      const errored = this.repo.updateStatus(row.id, 'error', {
        lastError: dnsErr.message,
      });
      this.users.audit({
        actor: login,
        action: 'DOMAIN_VERIFY_FAILED',
        target: `${login}/${appName}:${row.domain}`,
        reason: dnsErr.reason,
        metaJson: null,
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
      return this.toInfo(errored ?? row);
    }
  }

  /** Removes the custom-domain ingress from the deploy repo (single
   *  commit), then drops the DB row. If the manifest commit fails the
   *  row stays — better to leak a deploy-repo file than to claim a
   *  domain is gone while it's still routing traffic. */
  async delete(login: string, repo: string): Promise<void> {
    const appName = sanitizeName(repo);
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

    let cnameRecords: string[] = [];
    try {
      cnameRecords = await this.dns.resolveCname(row.domain);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOTFOUND' || code === 'ENODATA') {
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

  private async commitCustomDomainIngress(row: CustomDomainRow): Promise<string> {
    const deployOrg = this.config.deployOwner;
    const deployRepo = row.login;
    const token = await this.githubApp.getInstallationTokenForRepo(deployOrg, deployRepo);
    const path = getCustomDomainIngressPath(row.appName);

    // Render the new Ingress (custom-domain only). Build a minimal
    // RenderParams shim — only login/appName are referenced by
    // renderCustomDomainIngress, but the type is broader so we satisfy it
    // with safe defaults that go unread.
    const ingressYaml = this.renderIngressSnippet(row);
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

  private renderIngressSnippet(row: CustomDomainRow): string {
    // Inlined so we don't import renderCustomDomainIngress (it's private
    // to templates.ts). Mirrors that function's output exactly — kept in
    // sync via the templates.custom-domain.spec.ts snapshot tests.
    return `# Generated by swkoo.kr — do not edit; re-deploy from https://swkoo.kr/deploy to regenerate.
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${row.appName}-custom-domain
  namespace: user-${row.login}
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    traefik.ingress.kubernetes.io/router.entrypoints: websecure
  labels:
    app: ${row.appName}
    swkoo.kr/user: ${row.login}
spec:
  ingressClassName: traefik
  tls:
    - hosts:
        - ${row.domain}
      secretName: ${row.appName}-custom-domain-tls
  rules:
    - host: ${row.domain}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${row.appName}
                port:
                  number: 80
`;
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

  private subdomainForUserApp(userId: number, login: string, appName: string): string {
    const user = this.users.findById(userId);
    return user?.subdomain ?? sanitizeName(`${login}-${appName}`, 53);
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

    return {
      domain: row2.domain,
      status: row2.status,
      verificationToken: row2.status === 'pending' || row2.status === 'error'
        ? row2.verificationToken
        : null,
      dnsRecords: row2.status !== 'active'
        ? {
            txt: {
              host: `_swkoo-challenge.${row2.domain}`,
              value: `swkoo-domain-verification=${row2.verificationToken}`,
            },
            cname: { host: row2.domain, target: row2.expectedCname },
          }
        : null,
      verifiedAt: row2.verifiedAt,
      lastError: row2.lastError,
      certificateReady: cert.ready,
      certificateError: cert.fetchError ?? null,
      url: row2.status === 'active' && cert.ready ? `https://${row2.domain}` : null,
    };
  }

  private emptyInfo(): DomainInfo {
    return {
      domain: null,
      status: null,
      verificationToken: null,
      dnsRecords: null,
      verifiedAt: null,
      lastError: null,
      certificateReady: false,
      certificateError: null,
      url: null,
    };
  }
}
