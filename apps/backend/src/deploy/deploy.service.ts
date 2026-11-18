import { ConflictException, ForbiddenException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { PatchStrategy, setHeaderOptions } from '@kubernetes/client-node';
import axios from 'axios';
import { createHash } from 'node:crypto';

import { onboardingConfig } from '../config/onboarding.config';
import { CustomDomainsRepository } from '../domain/domain.repository';
import { KubeClient } from '../kube/kube.client';
import { AuthService } from '../onboarding/auth.service';
import { UsersRepository } from '../onboarding/users.repository';
import { DeployStatusService } from './deploy-status.service';
import { ArgoCdClient } from '../pipelines/services/argo-cd.client';
import { GithubAppService } from '../github-app/github-app.service';
import { canDeploySource, SourceRepository, sourceRepository } from './repository-access';
import { GHCR_SECRET, privateImageDigest } from './private-image';
import { SourceSetup } from './source-setup';
import { DeploymentAdmissionService } from './deployment-admission.service';
import {
  subdomainErrorMessage,
  validateSubdomainFormat,
} from './subdomain';
import {
  getUserDeployRepoName,
  getUserRegistrationPath,
  parseStorageProfileBlock,
  renderDeployRepoFiles,
  renderUserRegistration,
  renderUserRepoFiles,
  sanitizeName,
} from './templates';

export interface RepoSummary {
  name: string;
  fullName: string;
  description: string | null;
  language: string | null;
  defaultBranch: string;
  htmlUrl: string;
  updatedAt: string;
  isFork: boolean;
  isPrivate: boolean;
}

/** Pre-deploy check surfaced to the user as part of /api/deploy/preview.
 * Non-developers shouldn't see raw API errors on first build — they should
 * see a checklist describing what's ready and what's missing. `userAction`
 * is the actionable suggestion shown next to a warn/fail row. */
export interface PreviewCheck {
  key:
    | 'repo_access'
    | 'default_branch'
    | 'package_json'
    | 'next_dep'
    | 'build_script'
    | 'package_lockfile'
    | 'repo_casing'
    | 'prisma_sqlite';
  status: 'pass' | 'warn' | 'fail';
  label: string;
  message: string;
  userAction?: string;
}

/** Persistent Storage Profile v0. The only supported profile today is
 * Prisma SQLite — a 1Gi local-path PVC mounted at /data, with
 * DATABASE_URL pinned to a file inside that mount. Detection happens
 * at preview-time; once an app is registered with a profile the next
 * register *preserves* it even if detection no longer fires (see the
 * preservation guard in registerForUser).
 *
 * Fields are intentionally narrow string literals so the renderer can
 * lean on type-level guarantees rather than runtime branching. New
 * profiles will widen `type` and the literal sets — not the shape. */
export interface StorageProfile {
  type: 'prisma-sqlite';
  size: '1Gi';
  mountPath: '/data';
  databaseUrl: 'file:/data/app.db';
  // initMode is informational metadata for preview + the status feed;
  // the init container itself does the same runtime probe (migrations
  // dir present? → migrate deploy; else → db push) so it's robust to
  // the user editing the field between deploys.
  initMode: 'migrate-deploy' | 'db-push';
  storageClassName?: 'local-path' | 'swkoo-user-quota';
}

export type StackPreview =
  | {
      stack: 'nextjs';
      packageName: string | null;
      port: number;
      nodeEngine: string | null;
      checks: PreviewCheck[];
      storageProfile?: StorageProfile;
    }
  | { stack: 'unsupported'; reason: string; checks: PreviewCheck[] };

interface GithubContent {
  content: string;
  encoding: 'base64' | string;
}

export interface RegisterRequest {
  fullName: string; // "owner/repo"
  subdomain?: string; // optional user-chosen sub-slug for <slug>.apps.swkoo.kr
  setupDigest?: string;
  setupConsent?: string;
  includePrivate?: boolean;
}

export interface RegisterResponse {
  ok: true;
  fullName: string;
  subdomain: string;
  liveUrl: string;
  userRepoCommit: string;
  manifestRepoCommit: string;
}

export type StageStatus = 'pending' | 'running' | 'success' | 'failed';

/** Machine-readable failure category for a stage. Frontend uses this to
 * select a userAction CTA and to keep copy stable across releases. New
 * values are additive — frontends ignore unknowns and fall through to
 * the message field. */
export type StageReason =
  | 'GITHUB_APP_NOT_INSTALLED'
  | 'WORKFLOW_OLD_TEMPLATE'
  | 'BUILD_SCRIPT_MISSING'
  | 'PACKAGE_LOCK_MISSING'
  | 'NPM_INSTALL_FAILED'
  | 'DOCKER_BUILD_FAILED'
  | 'GHCR_PUSH_FAILED'
  | 'IMAGE_UPDATER_PENDING'
  | 'POD_NOT_READY'
  | 'MEMORY_LIMIT_EXCEEDED'
  | 'CLUSTER_CAPACITY_PENDING'
  | 'ARGO_SYNC_FAILED'
  | 'LIVE_HEALTHCHECK_FAILED'
  | 'UNKNOWN_BUILD_FAILURE';

export interface StageAction {
  label: string;
  href?: string;
  kind?: 'link' | 'retry' | 'docs';
}

export interface StageInfo {
  status: StageStatus;
  message: string;
  link?: string;
  sourceSha?: string;
  imageDigest?: string;
  // New in Phase 3: structured failure cause + actionable CTA. All
  // optional — existing API consumers ignore unknown fields. Only set
  // when we have a deterministic signal; ambiguous build failures stay
  // as UNKNOWN_BUILD_FAILURE rather than guessing.
  reason?: StageReason;
  userAction?: StageAction;
  // Tone: shown subtly to non-developers, more prominent on Observatory.
  operatorHint?: string;
}

export interface CurrentDeployment {
  login: string;
  deploymentKey?: string;
  repo: string;
  fullName: string;
  appName: string;
  liveUrl: string;
  syncStatus: string | null;
  healthStatus: string | null;
  // 'active' — metadata.yaml exists.
  // 'deleting' — metadata.yaml is gone but the ArgoCD Application lingers
  // until ApplicationSet prunes it (~1-3 min).
  state: 'active' | 'deleting';
  privateImage?: boolean;
  imageRepo?: string;
  imageOrganization?: boolean;
}

export interface DeploymentStatus {
  login: string;
  deploymentKey?: string;
  repo: string;
  appName: string;
  liveUrl: string;
  privateImage?: boolean;
  imageRepo?: string;
  stages: {
    manifests: StageInfo;
    build: StageInfo;
    imageDetected: StageInfo;
    deploy: StageInfo;
    live: StageInfo;
  };
  // Surfaced for the env panel + UI banner. Sourced from the same
  // metadata.yaml `storage:` block the preservation guard reads.
  // Older clients ignore unknown fields.
  storageProfile?: StorageProfile;
}

@Injectable()
export class DeployService {
  private readonly logger = new Logger(DeployService.name);
  private readonly sourceSetup = new SourceSetup(this.githubApp);
  constructor(
    private readonly auth: AuthService,
    private readonly githubApp: GithubAppService,
    private readonly users: UsersRepository,
    private readonly argo: ArgoCdClient,
    private readonly kube: KubeClient,
    private readonly customDomains: CustomDomainsRepository,
    @Inject(onboardingConfig.KEY)
    private readonly config: ConfigType<typeof onboardingConfig>,
    private readonly statusService: DeployStatusService,
    private readonly admission: DeploymentAdmissionService
  ) {}

  async listRepos(userId: number, login: string, includePrivate = false): Promise<RepoSummary[]> {
    const accessToken = await this.auth.getValidAccessToken(userId);
    const allowPrivate = includePrivate && Boolean(this.config.privateManifestRepo);
    const repos: SourceRepository[] = [];
    for (let page = 1; page <= 10 && repos.length < 30; page++) {
      const { data } = await axios.get<SourceRepository[]>('https://api.github.com/user/repos', {
        params: {
          affiliation: this.config.privateManifestRepo ? 'owner,organization_member' : 'owner',
          visibility: allowPrivate ? 'all' : 'public',
          sort: 'updated', direction: 'desc', page, per_page: 100,
        },
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
        timeout: 5000,
      });
      repos.push(...data.filter(repo => canDeploySource(login, repo, allowPrivate)));
      if (data.length < 100) break;
    }
    return repos.slice(0, 30).map(r => ({
      name: r.name, fullName: r.full_name, description: r.description, language: r.language,
      defaultBranch: r.default_branch, htmlUrl: r.html_url, updatedAt: r.updated_at,
      isFork: r.fork, isPrivate: r.visibility !== 'public',
    }));
  }

  private async authorizeSource(userId: number, login: string, fullName: string, includePrivate: boolean) {
    if (!this.config.privateManifestRepo && fullName.split('/')[0].toLowerCase() !== login.toLowerCase()) {
      throw new ForbiddenException({ reason: 'NOT_REPO_OWNER', message: '본인 GitHub 계정 소유의 repo만 배포할 수 있습니다.' });
    }
    const token = await this.auth.getValidAccessToken(userId);
    const repo = await sourceRepository(token, login, fullName, includePrivate && Boolean(this.config.privateManifestRepo));
    const privateImage = repo.visibility !== 'public' || repo.owner.type === 'Organization';
    const packageName = privateImage ? `swkoo-${repo.id}` : repo.name.toLowerCase();
    return { repo, privateImage, imageRepo: `ghcr.io/${repo.owner.login.toLowerCase()}/${packageName}` };
  }

  async previewRepository(userId: number, login: string, fullName: string, includePrivate: boolean) {
    const source = await this.authorizeSource(userId, login, fullName, includePrivate);
    return this.detectStack(userId, source.repo.owner.login, source.repo.name);
  }

  async setRegistryCredential(userId: number, login: string, name: string, token: unknown) {
    if (typeof token !== 'string' || !/^ghp_[A-Za-z0-9]{36}$/.test(token)) {
      throw new ForbiddenException('GitHub 클래식 토큰에 read:packages 권한만 부여해 입력해 주세요.');
    }
    const app = await this.getCurrentDeployment(login, true, name);
    if (!app?.privateImage || !app.imageRepo || app.state !== 'active' || app.repo.toLowerCase() !== name.toLowerCase()) {
      throw new ForbiddenException('본인의 활성 비공개 이미지 배포만 설정할 수 있습니다.');
    }
    const source = await this.authorizeSource(userId, login, app.fullName, true);
    if (source.imageRepo !== app.imageRepo || !source.privateImage) throw new ForbiddenException('저장소 설정을 다시 확인해 주세요.');
    const auth = Buffer.from(`${login}:${token}`).toString('base64');
    try {
      const { data, headers } = await axios.get<{ login: string }>('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}` }, timeout: 5000, maxRedirects: 0,
      });
      if (data.login.toLowerCase() !== login.toLowerCase() || headers['x-oauth-scopes']?.trim() !== 'read:packages') {
        throw new Error('scope');
      }
      await privateImageDigest(app.imageRepo, 'latest', auth, source.repo.owner.type === 'Organization');
    } catch {
      throw new ForbiddenException('비공개 패키지를 가져올 수 없습니다. 첫 빌드 완료, 토큰 권한과 조직의 SSO 승인을 확인해 주세요.');
    }
    const core = this.kube.core;
    if (!core) throw new ServiceUnavailableException('배포 서버에 연결하지 못했습니다.');
    const namespace = `user-${app.deploymentKey ?? app.login}`;
    const secretName = GHCR_SECRET;
    const data = { '.dockerconfigjson': Buffer.from(JSON.stringify({ auths: { 'ghcr.io': { auth, username: login, password: token } } })).toString('base64') };
    try {
      const previous = await core.readNamespacedSecret({ namespace, name: secretName }).catch((error: { code?: number }) => {
        if (error.code === 404) return null;
        throw error;
      });
      const body = { metadata: { name: secretName, namespace, resourceVersion: previous?.metadata?.resourceVersion },
        type: 'kubernetes.io/dockerconfigjson', data };
      if (previous) await core.replaceNamespacedSecret({ namespace, name: secretName, body });
      else await core.createNamespacedSecret({ namespace, body });
    } catch {
      throw new ServiceUnavailableException('이미지 접근 권한을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
    return { ok: true };
  }

  async detectStack(userId: number, owner: string, repo: string): Promise<StackPreview> {
    const accessToken = await this.auth.getValidAccessToken(userId);
    const headers = {
      Authorization: `token ${accessToken}`,
      Accept: 'application/vnd.github+json',
    };

    const checks: PreviewCheck[] = [];

    // ----- 1. Repo access + default branch -----
    let defaultBranch: string | null = null;
    try {
      const repoResp = await axios.get<{ default_branch: string }>(
        `https://api.github.com/repos/${owner}/${repo}`,
        { headers }
      );
      defaultBranch = repoResp.data.default_branch;
      checks.push({
        key: 'repo_access',
        status: 'pass',
        label: 'GitHub repo 접근',
        message: '읽기 권한이 확인됐어요.',
      });
    } catch (err) {
      this.logger.warn(
        `detectStack repo metadata failed for ${owner}/${repo}: ${(err as Error).message}`
      );
      checks.push({
        key: 'repo_access',
        status: 'fail',
        label: 'GitHub repo 접근',
        message: 'repo metadata를 읽을 수 없습니다.',
        userAction:
          'swkoo-deploy GitHub App이 이 repo에 설치되어 있는지 확인해 주세요. 우상단 [Install on repo]에서 추가할 수 있어요.',
      });
      return {
        stack: 'unsupported',
        reason: 'repo metadata를 읽을 수 없습니다.',
        checks,
      };
    }

    // Strict "main only" — matches the existing behavior and keeps the
    // user gate aligned with what registerForUser actually deploys.
    // (The workflow templates listen on main *and* master, but other
    // automation assumes main.)
    if (defaultBranch === 'main') {
      checks.push({
        key: 'default_branch',
        status: 'pass',
        label: '기본 브랜치',
        message: "기본 브랜치가 'main'이에요.",
      });
    } else {
      checks.push({
        key: 'default_branch',
        status: 'fail',
        label: '기본 브랜치',
        message: `기본 브랜치가 'main'이 아닙니다 (현재: '${defaultBranch}').`,
        userAction:
          "GitHub repo Settings → Branches → Default branch에서 'main'으로 변경 후 다시 시도해 주세요.",
      });
    }

    // ----- 2. package.json existence + parse -----
    let pkg: {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
      engines?: { node?: string };
    } | null = null;
    try {
      const resp = await axios.get<GithubContent>(
        `https://api.github.com/repos/${owner}/${repo}/contents/package.json`,
        { headers }
      );
      const content = Buffer.from(resp.data.content, 'base64').toString('utf8');
      pkg = JSON.parse(content);
      checks.push({
        key: 'package_json',
        status: 'pass',
        label: 'package.json',
        message: 'repo 루트에 package.json이 있어요.',
      });
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      const msg =
        status === 404
          ? 'repo 루트에 package.json이 없어요.'
          : 'package.json을 읽을 수 없어요.';
      if (status !== 404) {
        this.logger.warn(`detectStack failed for ${owner}/${repo}: ${(err as Error).message}`);
      }
      checks.push({
        key: 'package_json',
        status: 'fail',
        label: 'package.json',
        message: msg,
        userAction:
          '프로젝트 최상단에 package.json을 두어 주세요. monorepo라면 Next.js 앱이 repo 루트에 있어야 해요.',
      });
    }

    // ----- 3. Next dependency + 4. build script (depend on pkg) -----
    if (pkg) {
      const hasNext = Boolean(
        pkg.dependencies?.['next'] ?? pkg.devDependencies?.['next']
      );
      checks.push(
        hasNext
          ? {
              key: 'next_dep',
              status: 'pass',
              label: 'Next.js 의존성',
              message: 'package.json에 next가 포함돼 있어요.',
            }
          : {
              key: 'next_dep',
              status: 'fail',
              label: 'Next.js 의존성',
              message: 'package.json에 next 의존성이 없습니다 (v0는 Next.js만 지원).',
              userAction: 'npm install next react react-dom 으로 의존성을 추가해 주세요.',
            }
      );

      const hasBuildScript = Boolean(pkg.scripts?.['build']);
      // Mark as warn (not fail) — Next.js's create-next-app sets this by
      // default, so missing it is recoverable; we don't want to block
      // someone with an intentionally custom build setup at preview.
      // The build will still fail at GHA if missing, but the userAction
      // copy here is loud enough.
      checks.push(
        hasBuildScript
          ? {
              key: 'build_script',
              status: 'pass',
              label: 'scripts.build',
              message: 'package.json에 build 스크립트가 있어요.',
            }
          : {
              key: 'build_script',
              status: 'warn',
              label: 'scripts.build',
              message:
                'package.json에 "build" 스크립트가 없어요. swkoo.kr 자동 빌드는 npm run build를 호출하므로 빌드가 실패할 가능성이 큽니다.',
              userAction:
                'package.json의 scripts에 "build": "next build"를 추가해 주세요.',
            }
      );
    }

    // ----- 5. package-lock.json existence (best-effort) -----
    let hasLockfile: boolean | null = null;
    try {
      await axios.get<GithubContent>(
        `https://api.github.com/repos/${owner}/${repo}/contents/package-lock.json`,
        { headers }
      );
      hasLockfile = true;
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 404) {
        hasLockfile = false;
      } else {
        // Don't fail the whole preview on a transient error here.
        this.logger.warn(
          `lockfile check failed for ${owner}/${repo}: ${(err as Error).message}`
        );
      }
    }
    if (hasLockfile === true) {
      checks.push({
        key: 'package_lockfile',
        status: 'pass',
        label: 'package-lock.json',
        message: 'lockfile이 커밋돼 있어요.',
      });
    } else if (hasLockfile === false) {
      // Warn (not fail) per spec preference, but the userAction states
      // explicitly that this is likely-fatal so the user knows to act.
      checks.push({
        key: 'package_lockfile',
        status: 'warn',
        label: 'package-lock.json',
        message:
          'package-lock.json이 없어요. swkoo.kr의 자동 빌드는 npm ci를 사용하기 때문에 lockfile이 없으면 빌드가 실패합니다.',
        userAction:
          '로컬에서 npm install 후 생성된 package-lock.json을 커밋해 주세요.',
      });
    }
    // hasLockfile === null → transient API error; skip the row entirely.

    // ----- 6. Repo casing (informational pass) -----
    const hasUpper = /[A-Z]/.test(repo);
    checks.push({
      key: 'repo_casing',
      status: 'pass',
      label: 'Repo 이름 casing',
      message: hasUpper
        ? `GitHub repo 이름(${repo})의 대소문자는 유지되고, GHCR image tag는 자동으로 소문자로 변환됩니다.`
        : 'lowercase repo 이름이에요. 별도 처리 필요 없어요.',
    });

    // ----- 7. Persistent storage: Prisma SQLite detection -----
    // Reads prisma/schema.prisma; if present, parses the datasource
    // block. Only "provider = sqlite" + "url = env(DATABASE_URL)" +
    // a package.json prisma/@prisma/client dep emits a storage profile.
    // Anything else either skips silently (no schema = no profile) or
    // surfaces a warn/fail check row.
    let storageProfile: StorageProfile | undefined;
    let schemaContent: string | null = null;
    try {
      const schemaResp = await axios.get<GithubContent>(
        `https://api.github.com/repos/${owner}/${repo}/contents/prisma/schema.prisma`,
        { headers }
      );
      schemaContent = Buffer.from(schemaResp.data.content, 'base64').toString('utf8');
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status !== 404) {
        // Transient — log and skip the row; don't fail the whole preview.
        this.logger.warn(
          `prisma schema probe failed for ${owner}/${repo}: ${(err as Error).message}`
        );
      }
    }

    if (schemaContent) {
      // Brace-scope the datasource block so a "sqlite" mention in
      // comments doesn't trigger detection.
      const dsMatch = schemaContent.match(/datasource\s+\w+\s*\{([^}]*)\}/);
      const dsBlock = dsMatch?.[1] ?? '';
      const hasSqliteProvider = /provider\s*=\s*"sqlite"/.test(dsBlock);
      const hasEnvDbUrl = /url\s*=\s*env\(\s*"DATABASE_URL"\s*\)/.test(dsBlock);
      const hasPrismaDep = Boolean(
        pkg?.dependencies?.['prisma'] ??
          pkg?.devDependencies?.['prisma'] ??
          pkg?.dependencies?.['@prisma/client'] ??
          pkg?.devDependencies?.['@prisma/client']
      );

      if (!hasSqliteProvider) {
        // Prisma schema present but not sqlite — v0 only auto-supports
        // sqlite. Warn instead of fail so the user can still deploy
        // (their other DB is presumably hosted externally).
        checks.push({
          key: 'prisma_sqlite',
          status: 'warn',
          label: 'Prisma SQLite',
          message:
            'Prisma schema 가 있지만 datasource provider 가 sqlite 가 아닙니다. v0 자동 영속 저장은 sqlite 만 지원합니다.',
          userAction:
            '다른 DB 는 외부 호스팅 + DATABASE_URL 을 swkoo.kr 환경변수 패널에 직접 설정해 주세요.',
        });
      } else if (!hasEnvDbUrl) {
        checks.push({
          key: 'prisma_sqlite',
          status: 'fail',
          label: 'Prisma SQLite',
          message:
            'datasource url 이 env("DATABASE_URL") 형식이 아닙니다. 자동 설정을 위해 env() 참조가 필요합니다.',
          userAction:
            'prisma/schema.prisma 의 datasource block 을 url = env("DATABASE_URL") 로 바꿔 주세요.',
        });
      } else if (!hasPrismaDep) {
        checks.push({
          key: 'prisma_sqlite',
          status: 'warn',
          label: 'Prisma SQLite',
          message:
            'schema.prisma 가 sqlite + env DATABASE_URL 형태로 정상이지만 package.json 에 prisma / @prisma/client 의존성이 없어요. 빌드 시 prisma generate 가 실패할 가능성이 큽니다.',
          userAction: 'npm install prisma @prisma/client 로 의존성을 추가해 주세요.',
        });
      } else {
        // All conditions met — enable storage profile. Detect migrations
        // dir for initMode metadata (the init container does its own
        // runtime check too).
        let initMode: 'migrate-deploy' | 'db-push' = 'db-push';
        try {
          const migResp = await axios.get<Array<{ name: string; type: string }>>(
            `https://api.github.com/repos/${owner}/${repo}/contents/prisma/migrations`,
            { headers }
          );
          const entries = Array.isArray(migResp.data) ? migResp.data : [];
          if (entries.some((e) => e.type === 'dir')) {
            initMode = 'migrate-deploy';
          }
        } catch (err) {
          const status = (err as { response?: { status?: number } }).response?.status;
          if (status !== 404) {
            this.logger.warn(
              `prisma migrations probe failed for ${owner}/${repo}: ${(err as Error).message}`
            );
          }
        }

        storageProfile = {
          type: 'prisma-sqlite',
          storageClassName: 'swkoo-user-quota',
          size: '1Gi',
          mountPath: '/data',
          databaseUrl: 'file:/data/app.db',
          initMode,
        };

        checks.push({
          key: 'prisma_sqlite',
          status: 'pass',
          label: 'Prisma SQLite',
          message: `SQLite 기반 Prisma 앱입니다. 1GiB persistent storage 가 /data 에 연결되고, DATABASE_URL 은 file:/data/app.db 로 자동 설정됩니다. (init: ${initMode})`,
        });
      }
    }

    // ----- Final classification -----
    const firstFail = checks.find((c) => c.status === 'fail');
    if (firstFail) {
      return {
        stack: 'unsupported',
        reason: firstFail.message,
        checks,
      };
    }
    // pkg is guaranteed non-null in the success branch (a missing
    // package.json would have fail'd the package_json check above).
    return {
      stack: 'nextjs',
      packageName: pkg?.name ?? null,
      port: 3000,
      nodeEngine: pkg?.engines?.node ?? null,
      checks,
      storageProfile,
    };
  }

  async previewSourceSetup(login: string, fullName: string, includePrivate = false) {
    const user = this.users.findByLogin(login);
    if (!user?.isAllowed) throw new ForbiddenException('배포 권한이 없습니다.');
    const source = await this.authorizeSource(user.id, login, fullName, includePrivate);
    const preview = await this.detectStack(user.id, source.repo.owner.login, source.repo.name);
    if (preview.stack !== 'nextjs') throw new ConflictException('배포 사전 점검을 먼저 해결해 주세요.');
    const plan = await this.sourceSetup.inspect(source.repo.full_name, renderUserRepoFiles({
      port: preview.port, imageRepo: source.imageRepo, privateImage: source.privateImage,
      organization: source.repo.owner.type === 'Organization',
    }));
    return { ...plan, ...(source.privateImage ? { privateImage: true } : {}) };
  }

  async requestSourceSetupPr(login: string, req: RegisterRequest) {
    const plan = await this.previewSourceSetup(login, req.fullName, req.includePrivate);
    this.sourceSetup.assertReviewed(plan, req.setupDigest, req.setupConsent);
    const result = await this.sourceSetup.createPr(plan);
    this.users.audit({ actor: login, action: 'DEPLOY_SETUP_PR', target: req.fullName, reason: 'user_requested',
      metaJson: JSON.stringify({ sha: plan.sha, digest: plan.digest, ...result }) });
    return result;
  }

  /** Allowlist-gated full registration. Three commits, in order:
   *   1. User source repo: Dockerfile + GHA workflow.
   *   2. Per-user deploy repo (<deployOwner>/<login>, created if missing):
   *      all k8s manifests at the repo root.
   *   3. Control repo (swkoo-kr): a single registration file
   *      deploy/users/<login>.yaml that the ApplicationSet `files`
   *      generator reads to materialize the Application.
   *
   * Source files are only created when absent, after explicit review;
   * differing existing files must go through a user-requested draft PR.
   * The deploy repo persists across re-deploys. */
  async registerForUser(userLogin: string, req: RegisterRequest): Promise<RegisterResponse> {
    // GitHub logins preserve case; k8s naming needs lowercase.
    const loginLc = userLogin.toLowerCase();

    const user = this.users.findByLogin(userLogin);
    if (!user) {
      throw new ForbiddenException({ reason: 'NO_USER', message: 'user record missing' });
    }
    if (!user.isAllowed) {
      this.users.audit({
        actor: userLogin,
        action: 'ACCESS_DENIED',
        target: req.fullName,
        reason: 'NOT_ALLOWED',
        metaJson: null,
      });
      throw new ForbiddenException({ reason: 'NOT_ALLOWED', message: '액세스 권한이 없습니다.' });
    }

    const source = await this.authorizeSource(user.id, userLogin, req.fullName, req.includePrivate === true)
      .catch(error => {
        if (error instanceof ForbiddenException) this.users.audit({
          actor: userLogin, action: 'ACCESS_DENIED', target: req.fullName, reason: 'NOT_REPO_OWNER', metaJson: null,
        });
        throw error;
      });
    const { privateImage, imageRepo } = source;
    const { name: repo, owner: { login: owner } } = source.repo;
    const privateManifestRepo = privateImage ? await this.requirePrivateManifestRepo() : undefined;

    // Re-detect stack to make sure preview wasn't stale.
    const preview = await this.detectStack(user.id, owner, repo);
    if (preview.stack !== 'nextjs') {
      this.users.audit({
        actor: userLogin,
        action: 'ACCESS_DENIED',
        target: req.fullName,
        reason: 'STACK_UNSUPPORTED',
        metaJson: JSON.stringify(preview),
      });
      throw new ForbiddenException({ reason: 'STACK_UNSUPPORTED', message: preview.reason });
    }

    const sourcePlan = await this.sourceSetup.inspect(source.repo.full_name, renderUserRepoFiles({
      port: preview.port, imageRepo, privateImage, organization: source.repo.owner.type === 'Organization',
    }));
    this.sourceSetup.assertReviewed(sourcePlan, req.setupDigest, req.setupConsent);
    if (sourcePlan.files.some(file => file.action === 'review')) throw new ConflictException('기존 파일 변경은 PR 검토가 필요합니다. 배포 설정을 다시 확인해 주세요.');

    const primary = await this.getCurrentDeployment(userLogin, true);
    const sourceRepo = source.repo.full_name.toLowerCase();
    const isAdmin = this.config.adminLogins?.some(login => login.toLowerCase() === loginLc);
    const extraRows = this.users.listAdditionalDeployments?.(user.id) ?? [];
    const existingExtra = extraRows.find(row => row.sourceRepo === sourceRepo);
    if (!isAdmin && !primary && !existingExtra && extraRows.length
        && (await this.listDeployments(userLogin, true)).length) {
      throw new ConflictException({ reason: 'APP_ALREADY_EXISTS', message: '계정당 앱은 1개입니다. 기존 앱을 제거한 뒤 다른 앱을 배포해 주세요.' });
    }
    const additional = Boolean(existingExtra || (isAdmin && primary?.fullName.toLowerCase() !== sourceRepo));
    if (extraRows.some(row => row.sourceRepo !== sourceRepo && row.sourceRepo.split('/')[1] === repo.toLowerCase())
        || (primary?.repo.toLowerCase() === repo.toLowerCase() && primary.fullName.toLowerCase() !== sourceRepo)) {
      throw new ConflictException('같은 이름으로 배포된 앱이 있습니다. 다른 저장소 이름을 사용해 주세요.');
    }
    const deploymentKey = existingExtra?.key ?? (additional
      ? `app--${sanitizeName(privateImage ? 'private' : repo, 18).replace(/-$/, '') || 'site'}-${createHash('sha256').update(`${user.id}:${sourceRepo}`).digest('hex').slice(0, 20)}`
      : loginLc);
    const appName = additional ? deploymentKey : sanitizeName(repo);
    const current = additional
      ? await this.readDeployment(loginLc, deploymentKey, true)
      : primary;
    if (additional && !isAdmin && !current) {
      throw new ForbiddenException('추가 앱을 신규 배포하려면 관리자 권한이 필요합니다.');
    }
    if (current && Boolean(current.privateImage) !== privateImage) {
      throw new ConflictException('기존 배포의 공개 설정과 다릅니다. 운영자에게 문의해 주세요.');
    }
    if (current?.state === 'deleting') throw new ConflictException({ reason: 'DEPLOYMENT_DELETING', message: '앱과 저장공간을 삭제 중입니다. 삭제가 완료된 뒤 다시 배포해 주세요.' });
    if (current && current.fullName.toLowerCase() !== sourceRepo) {
      if (additional) throw new ConflictException('이 배포 식별자는 다른 저장소에서 사용 중입니다.');
      throw new ConflictException({ reason: 'APP_ALREADY_EXISTS', message: '계정당 앱은 1개입니다. 기존 앱을 제거한 뒤 다른 앱을 배포해 주세요.' });
    }
    if (additional && req.subdomain?.trim()) {
      throw new ConflictException('추가 관리자 앱은 고유 주소를 자동으로 받습니다. 배포 후 별도 도메인을 연결할 수 있습니다.');
    }
    if (additional && this.users.findBySubdomain(deploymentKey)) {
      throw new ConflictException('자동으로 할당한 주소가 기존 앱과 충돌했습니다. 운영자에게 문의해 주세요.');
    }
    if (existingExtra && !current) await this.assertAdditionalStorageRemoved(deploymentKey);
    if (!current) await this.admission.reserve(deploymentKey);
    if (additional && !existingExtra) this.users.addAdditionalDeployment(user.id, deploymentKey, sourceRepo);

    const subdomain = additional ? deploymentKey : this.claimSubdomainOrDefault(user, loginLc, privateImage ? 'app' : appName, req.subdomain);
    const deployRepoName = getUserDeployRepoName(deploymentKey);
    const deployRepoFullName = `${this.config.deployOwner}/${deployRepoName}`;
    // Preserve an in-place custom domain across redeploys. The guard in
    // findForRender returns rows whose manifest commit has already
    // landed (status in applying|active, OR applied_commit set even on
    // error) — pending rows are excluded since their ingress is not
    // yet in the deploy repo. Without this, every redeploy would
    // silently wipe the custom-domain Ingress + Cert.
    const existingDomain = this.customDomains.findForRender(deploymentKey, appName);

    // Preserve an existing Persistent Storage Profile across redeploys.
    // Once an app was registered with a profile (PVC committed to the
    // deploy repo, /data populated with the user's DB), we must not
    // silently drop the profile just because detection no longer
    // fires this round — that would orphan the PVC and disconnect
    // /data from the app. Read the prior metadata.yaml; if it has a
    // `storage:` block, that wins over (or fills in for) detection.
    // Note: if detection now sees a DIFFERENT initMode (migrations
    // appeared/disappeared since last deploy), the detected value
    // takes precedence — the data on disk is unaffected, only the
    // init container's behaviour changes.
    const existingStorageProfile = await this.readExistingStorageProfile(deploymentKey, Boolean(additional));
    const detectedStorageProfile = preview.storageProfile;
    const selectedStorageProfile = detectedStorageProfile ?? existingStorageProfile;
    // PVC storageClassName is immutable. Legacy registered volumes retain
    // local-path; their existing directories receive a quota in place.
    const effectiveStorageProfile = selectedStorageProfile ? {
      ...selectedStorageProfile,
      storageClassName: existingStorageProfile ? (existingStorageProfile.storageClassName ?? 'local-path') : (selectedStorageProfile.storageClassName ?? 'swkoo-user-quota'),
    } : undefined;

    const params = {
      login: deploymentKey,
      appName,
      imageRepo,
      privateImage,
      imageOrganization: source.repo.owner.type === 'Organization',
      subdomain,
      port: preview.port,
      uid: 1000,
      deployRepoFullName,
      // Source repo (where the user's Dockerfile + GHA workflow live)
      // is distinct from deployRepo after Phase 3.1. Observatory reads
      // this to find the right GitHub Actions runs.
      sourceRepo: `${owner}/${repo}`,
      appsDomain: this.config.appsDomain,
      customDomain: existingDomain ? { domain: existingDomain.domain } : undefined,
      storageProfile: effectiveStorageProfile,
    };

    const deployRepoFiles = renderDeployRepoFiles(params);
    const registrationContent = renderUserRegistration(params);

    // 1. Create only missing, reviewed source files. Keep existing files.
    let userRepoCommit: string;
    try {
      userRepoCommit = await this.sourceSetup.createMissing(sourcePlan);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith('INSTALLATION_NOT_FOUND')) {
        throw new ForbiddenException({
          reason: 'APP_NOT_INSTALLED_ON_USER_REPO',
          message: `${owner}/${repo} 에 swkoo.kr GitHub App이 설치되어 있지 않습니다. 해당 repo에 App을 추가하고 다시 시도해주세요.`,
          installUrl: this.config.githubAppSlug
            ? `https://github.com/apps/${this.config.githubAppSlug}/installations/new`
            : undefined,
        });
      }
      if (msg.startsWith('SOURCE_CHANGED')) throw new ConflictException(msg);
      throw new ServiceUnavailableException({ reason: 'DEPLOY_SOURCE_UNCERTAIN',
        message: '소스 파일 생성 결과를 확인하지 못했습니다. 저장소의 최근 커밋과 파일을 다시 확인해 주세요. 배포 매니페스트 등록은 시작하지 않았고 URL 예약은 유지됩니다.',
        completed: ['URL 예약'], sourceUrl: `https://github.com/${owner}/${repo}/tree/main` });
    }

    const completed = ['소스 파일 생성 또는 기존 파일 유지 확인'];
    try {
      // 2. Ensure the per-user deploy repo exists (idempotent) and commit
      //    manifests at its root.
      let deployRepoCommit: string;
      try {
        const orgToken = await this.githubApp.getInstallationTokenForOrg(this.config.deployOwner, 'create-repository');
        await this.githubApp.ensureRepoInOrg({
          org: this.config.deployOwner,
          name: deployRepoName,
          description: 'Private swkoo.kr deployment manifests. Managed by https://swkoo.kr/deploy.',
          token: orgToken,
          ...(privateImage ? { requirePrivate: true } : {}),
        });
        const deployToken = await this.githubApp.getInstallationTokenForRepo(
          this.config.deployOwner, deployRepoName, { contents: 'write' });
        deployRepoCommit = await this.githubApp.commitFilesAtomic({
          owner: this.config.deployOwner,
          repo: deployRepoName,
          branch: 'main',
          files: deployRepoFiles,
          message: `feat: deploy ${appName}\n\nImage: ${params.imageRepo}:latest\nURL: https://${subdomain}.${this.config.appsDomain}`,
          token: deployToken,
        });
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.startsWith('INSTALLATION_NOT_FOUND')) {
          throw new ForbiddenException({
            reason: 'APP_NOT_INSTALLED_ON_DEPLOY_ORG',
            message: `swkoo-deploy GitHub App이 ${this.config.deployOwner} org에 설치되어 있지 않습니다. 운영자에게 알려주세요.`,
          });
        }
        throw err;
      }

      // 3. Commit the registration file to the control repo. ApplicationSet
      //    will materialize an Application that pulls from the deploy repo.
      completed.push('배포 매니페스트 저장');
      const [manifestOwner, manifestRepo] = (privateManifestRepo ?? this.config.manifestRepo).split('/');
      let manifestRepoCommit: string;
      try {
        const manifestToken = await this.githubApp.getInstallationTokenForRepo(
          manifestOwner,
          manifestRepo,
          { contents: 'write' }
        );
        manifestRepoCommit = await this.githubApp.commitFilesAtomic({
          owner: manifestOwner,
          repo: manifestRepo,
          branch: privateManifestRepo ? 'main' : this.config.manifestBranch,
          files: { [getUserRegistrationPath(deploymentKey)]: registrationContent },
          message: `feat(deploy): register ${loginLc}/${appName} via swkoo.kr/deploy\n\nUser: ${userLogin}\nApp: ${appName}\nDeployRepo: ${deployRepoFullName}\nURL: https://${subdomain}.${this.config.appsDomain}`,
          token: manifestToken,
        });
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.startsWith('INSTALLATION_NOT_FOUND')) {
          throw new ForbiddenException({
            reason: 'APP_NOT_INSTALLED_ON_MANIFEST_REPO',
            message: `swkoo-deploy GitHub App이 ${this.config.manifestRepo} 에 설치되어 있지 않습니다. 운영자에게 알려주세요.`,
          });
        }
        throw err;
      }

      completed.push('배포 등록 파일 저장');
      this.users.audit({
        actor: userLogin,
        action: 'DEPLOY_REGISTER',
        target: req.fullName,
        reason: null,
        metaJson: JSON.stringify({
          subdomain,
          appName,
          userRepoCommit,
          sourceReview: { sha: sourcePlan.sha, digest: sourcePlan.digest, files: sourcePlan.files.map(file => ({ path: file.path, action: file.action })) },
          deployRepoFullName,
          deployRepoCommit,
          manifestRepoCommit,
        }),
      });

      // Nudge ArgoCD to pick up the new metadata.yaml immediately instead of
      // waiting for the default ~3 min git poll. Failure is non-fatal — the
      // poll still gets it eventually.
      void this.refreshUsersApplicationSet(privateImage);

      return {
        ok: true,
        fullName: req.fullName,
        subdomain,
        liveUrl: `https://${subdomain}.${this.config.appsDomain}`,
        userRepoCommit,
        manifestRepoCommit,
      };
    } catch {
      throw new ServiceUnavailableException({ reason: 'DEPLOY_PARTIAL',
        message: '배포 등록을 완료하지 못했습니다. 아래 완료된 단계를 확인하세요. 변경은 자동 취소되지 않았습니다. 파일을 다시 조회하고 재시도하거나 운영자에게 문의하세요.',
        completed, sourceUrl: `https://github.com/${owner}/${repo}/commit/${userRepoCommit}` });
    }
  }

  /** Recovery must test file presence, even when a registration is malformed. */
  async getRecoveryRegistrationState(login: string): Promise<{ registration: boolean; application: boolean }> {
    if (!this.argo.isConfigured()) throw new ServiceUnavailableException('배포 상태 연결을 확인하지 못했습니다.');
    const [owner, repo] = this.config.manifestRepo.split('/');
    const [content, app] = await Promise.all([
      this.readManifestFile(owner, repo, getUserRegistrationPath(login)),
      this.argo.getApplication(`swkoo-user-${login}`, 'default'),
    ]);
    return { registration: content !== null, application: app !== null };
  }

  /** Returns the user's currently-registered deployment, if any.
   * Source-of-truth is deploy/users/<login>.yaml in the control repo (git is
   * authoritative); ArgoCD app data is layered in for sync/health/state.
   * After a delete the registration file is gone immediately, but the ArgoCD
   * app lingers ~1-3 min until ApplicationSet prunes it — that window is
   * exposed as state === 'deleting'. */
  async getCurrentDeployment(login: string, requireArgo = false, repo?: string): Promise<CurrentDeployment | null> {
    const loginLc = login.toLowerCase();
    if (repo) {
      const user = this.users.findByLogin(loginLc);
      const row = user && this.users.listAdditionalDeployments?.(user.id)
        ?.find(entry => entry.sourceRepo.split('/')[1] === repo.toLowerCase());
      if (row) return this.readDeployment(loginLc, row.key, requireArgo);
    }
    return this.readDeployment(loginLc, loginLc, requireArgo);
  }

  async listDeployments(login: string, requireArgo = false): Promise<CurrentDeployment[]> {
    const user = this.users.findByLogin(login);
    if (!user) return [];
    const primary = await this.getCurrentDeployment(login, requireArgo);
    const deployments = primary ? [primary] : [];
    for (const row of this.users.listAdditionalDeployments(user.id)) {
      const app = await this.readDeployment(login.toLowerCase(), row.key, requireArgo);
      if (app) deployments.push(app);
    }
    return deployments;
  }

  private async readDeployment(loginLc: string, deploymentKey: string, requireArgo: boolean): Promise<CurrentDeployment | null> {
    if (requireArgo && !this.argo.isConfigured()) throw new ServiceUnavailableException({ reason: 'DEPLOYMENT_STATE_UNAVAILABLE', message: '배포 상태 연결을 확인하지 못했습니다. 운영자에게 문의해 주세요.' });
    const { content: registrationContent, privateImage } = await this.readRegistration(deploymentKey);
    const app = await this.argo
      .getApplication(`swkoo-user-${deploymentKey}`, 'default')
      .catch(() => {
        if (requireArgo) throw new ServiceUnavailableException({ reason: 'DEPLOYMENT_STATE_UNAVAILABLE', message: '기존 배포 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
        return null;
      });

    if (registrationContent === null && !app) {
      return null;
    }
    const sourceRepo = registrationContent?.match(/^sourceRepo:\s*(\S+)$/m)?.[1]
      ?? app?.metadata?.annotations?.['swkoo.kr/source-repo'];
    const imageRepo = registrationContent?.match(/^  repo:\s*(ghcr\.io\/[^/\s]+\/[^\s:]+)$/m)?.[1]
      ?? app?.metadata?.annotations?.['argocd-image-updater.argoproj.io/image-list']?.match(/=([^:]+):latest$/)?.[1];
    const userRepo = sourceRepo?.split('/')[1] ?? imageRepo?.split('/')[2];
    if (deploymentKey !== loginLc && registrationContent !== null) {
      const user = this.users.findByLogin(loginLc);
      const row = user && this.users.listAdditionalDeployments(user.id).find(entry => entry.key === deploymentKey);
      const key = registrationContent.match(/^login:\s*(\S+)$/m);
      if (!row || row.sourceRepo !== sourceRepo?.toLowerCase() || key?.[1] !== deploymentKey) {
        throw new ServiceUnavailableException('추가 앱의 배포 등록 정보를 확인할 수 없습니다.');
      }
    }
    if (!userRepo) {
      if (requireArgo && deploymentKey !== loginLc) {
        throw new ServiceUnavailableException('추가 앱의 배포 등록 정보를 확인할 수 없습니다.');
      }
      return null;
    }

    const appName = deploymentKey === loginLc ? sanitizeName(userRepo) : deploymentKey;
    const user = this.users.findByLogin(loginLc);
    const subdomain = deploymentKey === loginLc
      ? this.resolveSubdomain(user, loginLc, privateImage ? 'app' : appName) : deploymentKey;
    const state: CurrentDeployment['state'] = registrationContent ? 'active' : 'deleting';

    return {
      login: loginLc,
      ...(deploymentKey !== loginLc ? { deploymentKey } : {}),
      repo: userRepo,
      fullName: sourceRepo ?? `${loginLc}/${userRepo}`,
      ...(privateImage ? { privateImage: true, imageRepo,
        imageOrganization: registrationContent?.includes('imageOrganization: true') } : {}),
      appName,
      liveUrl: `https://${subdomain}.${this.config.appsDomain}`,
      syncStatus: app?.status?.sync?.status ?? null,
      healthStatus: app?.status?.health?.status ?? null,
      state,
    };
  }

  private async assertAdditionalStorageRemoved(key: string): Promise<void> {
    const kube = this.kube.core;
    if (!kube) throw new ServiceUnavailableException('기존 앱 저장공간의 제거 여부를 확인할 수 없습니다.');
    const namespace = `user-${key}`;
    const [exists, volumes] = await Promise.all([
      kube.readNamespace({ name: namespace }).then(() => true).catch(error => {
        if (error?.code === 404 || error?.statusCode === 404 || error?.response?.statusCode === 404) return false;
        throw error;
      }),
      kube.listPersistentVolume(),
    ]);
    if (exists || volumes.items.some(volume => volume.spec?.claimRef?.namespace === namespace)) {
      throw new ConflictException('이전 배포의 네임스페이스 또는 저장공간이 정리 중입니다.');
    }
  }

  /** Reads the user's existing registration file (if any) from the
   *  control repo and parses the `storage:` block. Used by
   *  registerForUser as the preservation guard — if the user already
   *  has a stateful app on the cluster, we must keep their PVC + mount
   *  + init container even when fresh detection doesn't fire (e.g.
   *  they accidentally removed prisma/schema.prisma). Returns null
   *  for the (common) stateless case so the caller can fall through
   *  to the detected profile or undefined. */
  private async readExistingStorageProfile(
    loginLc: string,
    strict = false
  ): Promise<StorageProfile | null> {
    const { content } = await this.readRegistration(loginLc).catch(error => {
      if (strict) throw error;
      return { content: null };
    });
    if (!content) return null;
    return parseStorageProfileBlock(content) ?? null;
  }

  private async readRegistration(deploymentKey: string) {
    const [owner, name] = this.config.manifestRepo.split('/');
    const path = getUserRegistrationPath(deploymentKey);
    const publicContent = await this.readManifestFile(owner, name, path);
    if (publicContent !== null || !this.config.privateManifestRepo) {
      return { content: publicContent, privateImage: false };
    }
    const [privateOwner, privateName] = this.config.privateManifestRepo.split('/');
    const content = await this.readManifestFile(privateOwner, privateName, path, 'main');
    return { content, privateImage: content !== null };
  }

  private async requirePrivateManifestRepo() {
    const fullName = this.config.privateManifestRepo;
    if (fullName) {
      const [owner, repo] = fullName.split('/');
      try {
        const token = await this.githubApp.getInstallationTokenForRepo(owner, repo, { metadata: 'read' });
        const { data } = await axios.get<SourceRepository>(`https://api.github.com/repos/${fullName}`, {
          headers: { Authorization: `Bearer ${token}` }, timeout: 5000, maxRedirects: 0,
        });
        if (data.private && data.visibility === 'private' && data.full_name.toLowerCase() === fullName.toLowerCase()) {
          return fullName;
        }
      } catch {
        // Never write private app registration to the public control repository.
      }
    }
    throw new ServiceUnavailableException('비공개 배포 설정을 확인하지 못했습니다. 운영자에게 문의해 주세요.');
  }

  private async readManifestFile(
    owner: string,
    repo: string,
    path: string,
    branch = this.config.manifestBranch
  ): Promise<string | null> {
    try {
      const token = await this.githubApp.getInstallationTokenForRepo(owner, repo, { contents: 'read' });
      const resp = await axios.get<{ content: string; encoding: string }>(
        `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
        {
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github+json',
          },
          params: { ref: branch },
        }
      );
      return Buffer.from(resp.data.content, 'base64').toString('utf8');
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 404) return null;
      throw err;
    }
  }

  /** Removes the user's registration file from the control repo and archives
   * their deploy repo. ApplicationSet auto-prunes the matching Application on
   * next refresh (~3 min, or sooner via refreshUsersApplicationSet), cascading
   * to namespace deletion. The user's source repo (Dockerfile + workflow +
   * GHCR images) is untouched; the archived deploy repo is recoverable from
   * the GitHub UI. */
  async deleteDeployment(userLogin: string, repoName?: string): Promise<{ commit: string }> {
    const loginLc = userLogin.toLowerCase();
    const user = this.users.findByLogin(userLogin);
    if (!user || !user.isAllowed) {
      throw new ForbiddenException({ reason: 'NOT_ALLOWED', message: '액세스 권한이 없습니다.' });
    }
    let deploymentKey = loginLc;
    if (repoName) {
      const current = await this.getCurrentDeployment(loginLc, true, repoName);
      if (!current || current.state !== 'active' || current.repo.toLowerCase() !== repoName.toLowerCase()) {
        throw new ConflictException({ reason: 'DEPLOYMENT_NOT_CURRENT', message: '삭제할 앱을 확인할 수 없습니다.' });
      }
      deploymentKey = current.deploymentKey ?? loginLc;
    }
    const privateRegistration = Boolean(this.config.privateManifestRepo) && (await this.readRegistration(deploymentKey)).privateImage;
    const [owner, repo] = (privateRegistration ? this.config.privateManifestRepo! : this.config.manifestRepo).split('/');
    let commit: string;
    try {
      const token = await this.githubApp.getInstallationTokenForRepo(owner, repo, { contents: 'write' });
      commit = await this.githubApp.commitFilesAtomic({
        owner,
        repo,
        branch: privateRegistration ? 'main' : this.config.manifestBranch,
        files: {},
        message: `feat(deploy): unregister ${loginLc} via swkoo.kr/deploy\n\nUser-initiated removal.`,
        token,
        deletePaths: [getUserRegistrationPath(deploymentKey)],
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'NOTHING_TO_COMMIT') {
        this.users.audit({
          actor: userLogin,
          action: 'DEPLOY_UNREGISTER',
          target: null,
          reason: 'NO_EXISTING_DEPLOYMENT',
          metaJson: null,
        });
        throw new ForbiddenException({
          reason: 'NO_EXISTING_DEPLOYMENT',
          message: '제거할 배포가 없습니다.',
        });
      }
      throw err;
    }

    // Custom-domain orphan cleanup. Runs *after* the unregister commit
    // succeeded — if the commit fails the function has already thrown,
    // so the DB row stays consistent with the deploy-repo state. v0 is
    // one-app-per-user so cleaning by login is correct; row absence is
    // a no-op (most users never claim a custom domain).
    //
    // Without this cleanup, the row outlives the deployment: subsequent
    // /api/deploy/domain/:login/:repo calls 404 NO_DEPLOYMENT (can't
    // self-remove) AND the same domain can't be re-registered later
    // because of the global UNIQUE index.
    const orphanRows = this.customDomains.findByLogin(deploymentKey);
    for (const row of orphanRows) {
      this.users.audit({
        actor: userLogin,
        action: 'DOMAIN_DELETED_BY_DEPLOY_DELETE',
        target: `${row.login}/${row.appName}:${row.domain}`,
        reason: null,
        metaJson: JSON.stringify({ deployCommit: commit }),
      });
    }
    if (orphanRows.length > 0) {
      this.customDomains.deleteByLogin(deploymentKey);
    }

    // Archive the deploy repo. Best-effort: log and continue if it fails —
    // the registration file is already gone so the user view is consistent.
    try {
      const deployRepoName = getUserDeployRepoName(deploymentKey);
      const repoToken = await this.githubApp.getInstallationTokenForRepo(
        this.config.deployOwner, deployRepoName, { administration: 'write' });
      await this.githubApp.archiveRepo({
        owner: this.config.deployOwner,
        repo: deployRepoName,
        token: repoToken,
      });
    } catch (err) {
      this.logger.warn(`archiveRepo failed for ${loginLc}: ${(err as Error).message}`);
    }

    this.users.audit({
      actor: userLogin,
      action: 'DEPLOY_UNREGISTER',
      target: null,
      reason: null,
      metaJson: JSON.stringify({ commit }),
    });

    void this.refreshUsersApplicationSet(privateRegistration);

    this.users.releaseAdmissionReservation(deploymentKey);
    return { commit };
  }

  /** Annotates the swkoo-users ApplicationSet with
   * `argocd.argoproj.io/application-set-refresh=true` so ArgoCD reconciles immediately
   * after a register/delete commit. RBAC for this lives in
   * deploy/argocd/swkoo-backend-applicationset-rbac.yaml — operator must
   * have applied that once. Best-effort: 3 min poll fallback covers us
   * if this fails. */
  private async refreshUsersApplicationSet(privateImage = false): Promise<void> {
    if (!this.kube.available()) return;
    try {
      await this.kube.custom!.patchNamespacedCustomObject(
        {
          group: 'argoproj.io',
          version: 'v1alpha1',
          namespace: 'argocd',
          plural: 'applicationsets',
          name: privateImage ? 'swkoo-private-users' : 'swkoo-users',
          body: {
            metadata: {
              annotations: { 'argocd.argoproj.io/application-set-refresh': 'true' },
            },
          },
        },
        setHeaderOptions('Content-Type', PatchStrategy.MergePatch)
      );
    } catch (err) {
      this.logger.warn(`ApplicationSet refresh failed: ${(err as Error).message}`);
    }
  }

  /** Aggregated status for the progress page. Each stage is computed
   * independently and probes its own source (GitHub Actions, ArgoCD,
   * the live URL). Polled by the frontend every few seconds. */
  async getDeploymentStatus(
    requestingUserId: number,
    login: string,
    repo: string
  ): Promise<DeploymentStatus> {
    const loginLc = login.toLowerCase();
    const user = this.users.findByLogin(loginLc);
    const row = user && this.users.listAdditionalDeployments?.(user.id)
      ?.find(entry => entry.sourceRepo.split('/')[1] === repo.toLowerCase());
    const deploymentKey = row?.key ?? loginLc;
    const appName = row?.key ?? sanitizeName(repo);
    const subdomain = row?.key ?? this.resolveSubdomain(user, loginLc, appName);
    const liveUrl = `https://${subdomain}.${this.config.appsDomain}`;

    const current = this.config.privateManifestRepo ? await this.getCurrentDeployment(login, false, repo) : null;
    const protectedApp = current?.privateImage && current.repo.toLowerCase() === repo.toLowerCase() ? current : null;
    const [stages, storageProfile] = await Promise.all([
      protectedApp ? this.statusService.getStages(requestingUserId, loginLc, repo, protectedApp.liveUrl, deploymentKey, protectedApp)
        : row ? this.statusService.getStages(requestingUserId, loginLc, repo, liveUrl, deploymentKey)
        : this.statusService.getStages(requestingUserId, loginLc, repo, liveUrl),
      this.readExistingStorageProfile(deploymentKey),
    ]);
    return { login: loginLc, ...(row ? { deploymentKey } : {}), repo, appName, liveUrl: protectedApp?.liveUrl ?? liveUrl, stages,
      ...(protectedApp ? { privateImage: true, imageRepo: protectedApp.imageRepo } : {}),
      storageProfile: storageProfile ?? undefined };
  }

  /** Resolves the subdomain the user wants for *this* register call.
   * If they supplied one, validate + claim it (UNIQUE in DB). If they
   * didn't, preserve the slug they already own (so re-deploy keeps the
   * same URL) or fall back to the auto-derived `<login>-<repo>`. */
  private claimSubdomainOrDefault(
    user: { subdomain: string | null },
    loginLc: string,
    appName: string,
    requested: string | undefined
  ): string {
    const trimmed = requested?.trim().toLowerCase() ?? '';
    if (!trimmed) {
      return user.subdomain ?? sanitizeName(`${loginLc}-${appName}`, 53);
    }
    if (user.subdomain === trimmed) {
      return trimmed;
    }
    const format = validateSubdomainFormat(trimmed);
    if (!format.ok) {
      throw new ForbiddenException({
        reason: 'INVALID_SUBDOMAIN',
        message: subdomainErrorMessage(format.reason),
      });
    }
    const result = this.users.setSubdomain(loginLc, trimmed);
    if (result === 'taken') {
      throw new ForbiddenException({
        reason: 'SUBDOMAIN_TAKEN',
        message: subdomainErrorMessage('TAKEN'),
      });
    }
    if (result === 'no_user') {
      throw new ForbiddenException({ reason: 'NO_USER', message: 'user record missing' });
    }
    return trimmed;
  }

  /** Read-only sibling of claimSubdomainOrDefault — used by status / current
   * endpoints that must reflect the same host the manifests use. */
  private resolveSubdomain(
    user: { subdomain: string | null } | null | undefined,
    loginLc: string,
    appName: string
  ): string {
    return user?.subdomain ?? sanitizeName(`${loginLc}-${appName}`, 53);
  }
}
