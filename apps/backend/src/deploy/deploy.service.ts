import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { PatchStrategy, setHeaderOptions } from '@kubernetes/client-node';
import axios from 'axios';

import { onboardingConfig } from '../config/onboarding.config';
import { CustomDomainsRepository } from '../domain/domain.repository';
import { EmailService } from '../email/email.service';
import { KubeClient } from '../kube/kube.client';
import { AuthService } from '../onboarding/auth.service';
import { UsersRepository } from '../onboarding/users.repository';
import { ArgoCdClient } from '../pipelines/services/argo-cd.client';
import { GithubAppService } from '../github-app/github-app.service';
import {
  subdomainErrorMessage,
  validateSubdomainFormat,
} from './subdomain';
import {
  getUserDeployRepoName,
  getUserRegistrationPath,
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
    | 'repo_casing';
  status: 'pass' | 'warn' | 'fail';
  label: string;
  message: string;
  userAction?: string;
}

export type StackPreview =
  | {
      stack: 'nextjs';
      packageName: string | null;
      port: number;
      nodeEngine: string | null;
      checks: PreviewCheck[];
    }
  | { stack: 'unsupported'; reason: string; checks: PreviewCheck[] };

interface GithubRepo {
  name: string;
  full_name: string;
  description: string | null;
  language: string | null;
  default_branch: string;
  html_url: string;
  updated_at: string;
  fork: boolean;
  private: boolean;
}

interface GithubContent {
  content: string;
  encoding: 'base64' | string;
}

export interface RegisterRequest {
  fullName: string; // "owner/repo"
  subdomain?: string; // optional user-chosen sub-slug for <slug>.apps.swkoo.kr
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
}

export interface DeploymentStatus {
  login: string;
  repo: string;
  appName: string;
  liveUrl: string;
  stages: {
    manifests: StageInfo;
    build: StageInfo;
    imageDetected: StageInfo;
    deploy: StageInfo;
    live: StageInfo;
  };
}

interface GhaRunSummary {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_sha: string;
  created_at: string;
}

@Injectable()
export class DeployService {
  private readonly logger = new Logger(DeployService.name);
  // (login/repo → last GHA runId we already notified about). In-memory: on
  // backend restart we may double-fire once if the user reloads the progress
  // page right after; acceptable for an operator-side alert.
  private readonly notifiedFailures = new Map<string, number>();

  constructor(
    private readonly auth: AuthService,
    private readonly githubApp: GithubAppService,
    private readonly users: UsersRepository,
    private readonly argo: ArgoCdClient,
    private readonly kube: KubeClient,
    private readonly email: EmailService,
    private readonly customDomains: CustomDomainsRepository,
    @Inject(onboardingConfig.KEY)
    private readonly config: ConfigType<typeof onboardingConfig>
  ) {}

  async listRepos(userId: number): Promise<RepoSummary[]> {
    const accessToken = await this.auth.getValidAccessToken(userId);
    const resp = await axios.get<GithubRepo[]>('https://api.github.com/user/repos', {
      params: {
        affiliation: 'owner',
        sort: 'updated',
        direction: 'desc',
        per_page: 30,
      },
      headers: {
        Authorization: `token ${accessToken}`,
        Accept: 'application/vnd.github+json',
      },
    });
    return resp.data.map((r) => ({
      name: r.name,
      fullName: r.full_name,
      description: r.description,
      language: r.language,
      defaultBranch: r.default_branch,
      htmlUrl: r.html_url,
      updatedAt: r.updated_at,
      isFork: r.fork,
      isPrivate: r.private,
    }));
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
    };
  }

  /** Allowlist-gated full registration. Three commits, in order:
   *   1. User source repo: Dockerfile + GHA workflow.
   *   2. Per-user deploy repo (<deployOwner>/<login>, created if missing):
   *      all k8s manifests at the repo root.
   *   3. Control repo (swkoo-kr): a single registration file
   *      deploy/users/<login>.yaml that the ApplicationSet `files`
   *      generator reads to materialize the Application.
   *
   * Re-running for the same user overwrites stable-path files in place;
   * the deploy repo persists across re-deploys. Phase 1 caps one app per user. */
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

    const [owner, repo] = req.fullName.split('/');
    if (!owner || !repo) {
      throw new ForbiddenException({ reason: 'INVALID_REPO', message: 'invalid fullName' });
    }

    // Self-only ownership: the JWT identifies *who* is deploying, the body
    // says *what* — without this check, A could register B's repo by
    // crafting a request body even though detectStack would later reject
    // it (defense in depth + clean 403 boundary).
    if (owner.toLowerCase() !== loginLc) {
      this.users.audit({
        actor: userLogin,
        action: 'ACCESS_DENIED',
        target: req.fullName,
        reason: 'NOT_REPO_OWNER',
        metaJson: null,
      });
      throw new ForbiddenException({
        reason: 'NOT_REPO_OWNER',
        message: '본인 GitHub 계정 소유의 repo만 배포할 수 있습니다.',
      });
    }

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

    const appName = sanitizeName(repo);
    const subdomain = this.claimSubdomainOrDefault(user, loginLc, appName, req.subdomain);
    const deployRepoName = getUserDeployRepoName(loginLc);
    const deployRepoFullName = `${this.config.deployOwner}/${deployRepoName}`;
    // Preserve an in-place custom domain across redeploys. The guard in
    // findForRender returns rows whose manifest commit has already
    // landed (status in applying|active, OR applied_commit set even on
    // error) — pending rows are excluded since their ingress is not
    // yet in the deploy repo. Without this, every redeploy would
    // silently wipe the custom-domain Ingress + Cert.
    const existingDomain = this.customDomains.findForRender(loginLc, appName);
    const params = {
      login: loginLc,
      appName,
      imageRepo: `ghcr.io/${loginLc}/${repo.toLowerCase()}`,
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
    };

    const userRepoFiles = renderUserRepoFiles(params);
    const deployRepoFiles = renderDeployRepoFiles(params);
    const registrationContent = renderUserRegistration(params);

    // 1. Commit to user repo (creates/updates Dockerfile + workflow).
    let userRepoCommit: string;
    try {
      const userRepoToken = await this.githubApp.getInstallationTokenForRepo(owner, repo);
      userRepoCommit = await this.githubApp.commitFilesAtomic({
        owner,
        repo,
        branch: 'main',
        files: userRepoFiles,
        message: `chore: swkoo.kr auto-deploy setup (Dockerfile + workflow)\n\nGenerated by https://swkoo.kr/deploy`,
        token: userRepoToken,
      });
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
      throw err;
    }

    // 2. Ensure the per-user deploy repo exists (idempotent) and commit
    //    manifests at its root.
    let deployRepoCommit: string;
    try {
      const orgToken = await this.githubApp.getInstallationTokenForOrg(this.config.deployOwner);
      await this.githubApp.ensureRepoInOrg({
        org: this.config.deployOwner,
        name: deployRepoName,
        description: `swkoo.kr deploy manifests for ${loginLc}/${repo}. Managed by https://swkoo.kr/deploy — do not edit by hand.`,
        token: orgToken,
      });
      deployRepoCommit = await this.githubApp.commitFilesAtomic({
        owner: this.config.deployOwner,
        repo: deployRepoName,
        branch: 'main',
        files: deployRepoFiles,
        message: `feat: deploy ${appName}\n\nImage: ${params.imageRepo}:latest\nURL: https://${subdomain}.${this.config.appsDomain}`,
        token: orgToken,
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
    const [manifestOwner, manifestRepo] = this.config.manifestRepo.split('/');
    let manifestRepoCommit: string;
    try {
      const manifestToken = await this.githubApp.getInstallationTokenForRepo(
        manifestOwner,
        manifestRepo
      );
      manifestRepoCommit = await this.githubApp.commitFilesAtomic({
        owner: manifestOwner,
        repo: manifestRepo,
        branch: this.config.manifestBranch,
        files: { [getUserRegistrationPath(loginLc)]: registrationContent },
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

    this.users.audit({
      actor: userLogin,
      action: 'DEPLOY_REGISTER',
      target: req.fullName,
      reason: null,
      metaJson: JSON.stringify({
        subdomain,
        appName,
        userRepoCommit,
        deployRepoFullName,
        deployRepoCommit,
        manifestRepoCommit,
      }),
    });

    // Nudge ArgoCD to pick up the new metadata.yaml immediately instead of
    // waiting for the default ~3 min git poll. Failure is non-fatal — the
    // poll still gets it eventually.
    void this.refreshUsersApplicationSet();

    return {
      ok: true,
      fullName: req.fullName,
      subdomain,
      liveUrl: `https://${subdomain}.${this.config.appsDomain}`,
      userRepoCommit,
      manifestRepoCommit,
    };
  }

  /** Returns the user's currently-registered deployment, if any.
   * Source-of-truth is deploy/users/<login>.yaml in the control repo (git is
   * authoritative); ArgoCD app data is layered in for sync/health/state.
   * After a delete the registration file is gone immediately, but the ArgoCD
   * app lingers ~1-3 min until ApplicationSet prunes it — that window is
   * exposed as state === 'deleting'. */
  async getCurrentDeployment(login: string): Promise<CurrentDeployment | null> {
    const loginLc = login.toLowerCase();
    const [manifestOwner, manifestRepoName] = this.config.manifestRepo.split('/');

    const registrationContent = await this.readManifestFile(
      manifestOwner,
      manifestRepoName,
      getUserRegistrationPath(loginLc)
    );
    const app = await this.argo
      .getApplication(`swkoo-user-${loginLc}`)
      .catch(() => null);

    if (!registrationContent && !app) {
      return null;
    }

    // Derive repo from the registration file if present; fall back to ArgoCD
    // annotation (useful during the deleting window when the file is already gone).
    let userRepo: string | null = null;
    if (registrationContent) {
      const m = registrationContent.match(/repo:\s*ghcr\.io\/[^/]+\/(\S+)/);
      userRepo = m?.[1] ?? null;
    }
    if (!userRepo && app) {
      const imageList = app.metadata?.annotations?.['argocd-image-updater.argoproj.io/image-list'];
      const m = imageList?.match(/=ghcr\.io\/([^/]+)\/([^:]+)/);
      userRepo = m?.[2] ?? null;
    }
    if (!userRepo) return null;

    const appName = sanitizeName(userRepo);
    const user = this.users.findByLogin(loginLc);
    const subdomain = this.resolveSubdomain(user, loginLc, appName);
    const state: CurrentDeployment['state'] = registrationContent ? 'active' : 'deleting';

    return {
      login: loginLc,
      repo: userRepo,
      fullName: `${loginLc}/${userRepo}`,
      appName,
      liveUrl: `https://${subdomain}.${this.config.appsDomain}`,
      syncStatus: app?.status?.sync?.status ?? null,
      healthStatus: app?.status?.health?.status ?? null,
      state,
    };
  }

  private async readManifestFile(
    owner: string,
    repo: string,
    path: string
  ): Promise<string | null> {
    try {
      const token = await this.githubApp.getInstallationTokenForRepo(owner, repo);
      const resp = await axios.get<{ content: string; encoding: string }>(
        `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
        {
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github+json',
          },
          params: { ref: this.config.manifestBranch },
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
  async deleteDeployment(userLogin: string): Promise<{ commit: string }> {
    const loginLc = userLogin.toLowerCase();
    const user = this.users.findByLogin(userLogin);
    if (!user || !user.isAllowed) {
      throw new ForbiddenException({ reason: 'NOT_ALLOWED', message: '액세스 권한이 없습니다.' });
    }
    const [owner, repo] = this.config.manifestRepo.split('/');
    let commit: string;
    try {
      const token = await this.githubApp.getInstallationTokenForRepo(owner, repo);
      commit = await this.githubApp.commitFilesAtomic({
        owner,
        repo,
        branch: this.config.manifestBranch,
        files: {},
        message: `feat(deploy): unregister ${loginLc} via swkoo.kr/deploy\n\nUser-initiated removal.`,
        token,
        deletePaths: [getUserRegistrationPath(loginLc)],
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
    const orphanRows = this.customDomains.findByLogin(loginLc);
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
      this.customDomains.deleteByLogin(loginLc);
    }

    // Archive the deploy repo. Best-effort: log and continue if it fails —
    // the registration file is already gone so the user view is consistent.
    try {
      const deployRepoName = getUserDeployRepoName(loginLc);
      const orgToken = await this.githubApp.getInstallationTokenForOrg(this.config.deployOwner);
      await this.githubApp.archiveRepo({
        owner: this.config.deployOwner,
        repo: deployRepoName,
        token: orgToken,
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

    void this.refreshUsersApplicationSet();

    return { commit };
  }

  /** Annotates the swkoo-users ApplicationSet with
   * `argocd.argoproj.io/refresh=hard` so ArgoCD reconciles immediately
   * after a register/delete commit. RBAC for this lives in
   * deploy/argocd/swkoo-backend-applicationset-rbac.yaml — operator must
   * have applied that once. Best-effort: 3 min poll fallback covers us
   * if this fails. */
  private async refreshUsersApplicationSet(): Promise<void> {
    if (!this.kube.available()) return;
    try {
      await this.kube.custom!.patchNamespacedCustomObject(
        {
          group: 'argoproj.io',
          version: 'v1alpha1',
          namespace: 'argocd',
          plural: 'applicationsets',
          name: 'swkoo-users',
          body: {
            metadata: {
              annotations: { 'argocd.argoproj.io/refresh': 'hard' },
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
    const appName = sanitizeName(repo);
    const user = this.users.findByLogin(loginLc);
    const subdomain = this.resolveSubdomain(user, loginLc, appName);
    const liveUrl = `https://${subdomain}.${this.config.appsDomain}`;

    const [manifestsStage, buildStage, app, liveStage] = await Promise.all([
      this.checkManifestStage(loginLc),
      this.checkBuildStage(requestingUserId, login, repo),
      this.argo.getApplication(`swkoo-user-${loginLc}`).catch(() => null),
      this.checkLiveStage(liveUrl),
    ]);

    const imageDetectedStage = this.checkImageDetectedStage(app);
    const deployStage = this.checkDeployStage(app);

    // Fire deploy-success email when liveStage flips to success for a
    // *new* image digest. Polling endpoint hit on every front-end tick
    // so we have to dedup; persisted in users.last_notified_image_sha
    // to survive backend restarts.
    if (user && user.email && liveStage.status === 'success') {
      void this.maybeNotifyDeploySuccess(user.id, user.email, loginLc, repo, liveUrl, app);
    }

    return {
      login: loginLc,
      repo,
      appName,
      liveUrl,
      stages: {
        manifests: manifestsStage,
        build: buildStage,
        imageDetected: imageDetectedStage,
        deploy: deployStage,
        live: liveStage,
      },
    };
  }

  private async maybeNotifyDeploySuccess(
    userId: number,
    email: string,
    login: string,
    repo: string,
    liveUrl: string,
    app: unknown
  ): Promise<void> {
    if (!this.email.enabled()) return;
    const digest = this.extractImageDigest(app);
    if (!digest) return;
    const last = this.users.getLastNotifiedImageSha(userId);
    if (last === digest) return;
    // Set FIRST, send second — if Resend hangs, the next poll won't
    // re-fire while the first request is in flight. Worst case on
    // network failure: one missed notification (better than spam).
    this.users.setLastNotifiedImageSha(userId, digest);
    await this.email.sendDeploySuccess({
      to: email,
      login,
      repo,
      liveUrl,
      imageDigest: digest.length > 19 ? `sha256:${digest.slice(7, 19)}…` : digest,
    });
    this.users.audit({
      actor: login,
      action: 'DEPLOY_NOTIFY',
      target: repo,
      reason: null,
      metaJson: JSON.stringify({ digest }),
    });
  }

  private extractImageDigest(app: unknown): string | null {
    const imagesField = (app as {
      spec?: { source?: { kustomize?: { images?: string[] } } };
    } | null)?.spec?.source?.kustomize?.images;
    const images = Array.isArray(imagesField) ? imagesField : [];
    const pinned = images.find((entry) => entry.includes('@sha256:'));
    if (!pinned) return null;
    const idx = pinned.indexOf('sha256:');
    return idx >= 0 ? pinned.slice(idx) : null;
  }

  private async checkManifestStage(login: string): Promise<StageInfo> {
    const [owner, name] = this.config.manifestRepo.split('/');
    try {
      const token = await this.githubApp.getInstallationTokenForRepo(owner, name);
      await axios.get(
        `https://api.github.com/repos/${owner}/${name}/contents/${getUserRegistrationPath(login)}`,
        {
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github+json',
          },
          params: { ref: this.config.manifestBranch },
        }
      );
      return { status: 'success', message: '매니페스트 등록 완료' };
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 404) {
        return { status: 'pending', message: '매니페스트 등록 대기 중' };
      }
      return { status: 'pending', message: '매니페스트 상태 확인 중' };
    }
  }

  private async checkBuildStage(
    userId: number,
    owner: string,
    repo: string
  ): Promise<StageInfo> {
    let accessToken: string;
    try {
      accessToken = await this.auth.getValidAccessToken(userId);
    } catch {
      return { status: 'pending', message: '빌드 상태 확인 권한 없음 (재로그인 필요)' };
    }
    try {
      const resp = await axios.get<{ workflow_runs: GhaRunSummary[] }>(
        `https://api.github.com/repos/${owner}/${repo}/actions/runs`,
        {
          headers: {
            Authorization: `token ${accessToken}`,
            Accept: 'application/vnd.github+json',
          },
          params: { branch: 'main', per_page: 1 },
        }
      );
      const run = resp.data.workflow_runs[0];
      if (!run) {
        return { status: 'pending', message: '빌드 대기 중 (워크플로 실행 기록 없음)' };
      }
      if (run.status === 'completed' && run.conclusion === 'success') {
        return {
          status: 'success',
          message: `빌드 완료 (${run.head_sha.slice(0, 7)})`,
          link: run.html_url,
        };
      }
      if (run.status === 'completed') {
        this.maybeNotifyBuildFailure(owner, repo, run);
        const classified = await this.classifyBuildFailure(accessToken, owner, repo, run);
        return {
          status: 'failed',
          message: classified.message,
          link: run.html_url,
          reason: classified.reason,
          userAction: classified.userAction,
          operatorHint: classified.operatorHint,
        };
      }
      return { status: 'running', message: `이미지 빌드 중 (${run.status})`, link: run.html_url };
    } catch (err) {
      this.logger.warn(`checkBuildStage failed: ${(err as Error).message}`);
      return { status: 'pending', message: '빌드 상태 확인 중' };
    }
  }

  /** Best-effort classification of a *completed-but-failed* GHA run.
   * Two probes:
   *   1. The user's build.yml — if it still uses the legacy
   *      `${{ github.repository }}` tag (pre c98b452 fix), the build
   *      will fail with "repository name must be lowercase" on any
   *      mixed-case repo. Re-running register on swkoo.kr regenerates
   *      the workflow with `params.imageRepo` (already lower-cased).
   *   2. The run's jobs endpoint — failed step name carries enough
   *      signal to classify without downloading the log zip. Step
   *      names come from our generated workflow (renderBuildWorkflow)
   *      so they're stable; users who hand-edit the workflow can fall
   *      through to UNKNOWN_BUILD_FAILURE.
   * Any classification failure (token issue, jobs 404, regex miss)
   * returns UNKNOWN_BUILD_FAILURE so the UI still surfaces a useful
   * "open the log" link. */
  private async classifyBuildFailure(
    accessToken: string,
    owner: string,
    repo: string,
    run: GhaRunSummary
  ): Promise<{
    message: string;
    reason: StageReason;
    userAction?: StageAction;
    operatorHint?: string;
  }> {
    const headers = {
      Authorization: `token ${accessToken}`,
      Accept: 'application/vnd.github+json',
    };
    const conclusion = run.conclusion ?? 'unknown';

    // ---- Probe 1: legacy workflow template ----
    // Only the failure surface is interesting — a "matched" template
    // means we know the workflow needs regenerating. We narrow further
    // for the mixed-case repo case (the original symptom). Other
    // legacy quirks may exist but we don't enumerate them here.
    try {
      const wfResp = await axios.get<GithubContent>(
        `https://api.github.com/repos/${owner}/${repo}/contents/.github/workflows/build.yml`,
        { headers }
      );
      const wfContent = Buffer.from(wfResp.data.content, 'base64').toString('utf8');
      const legacyTagPattern = /ghcr\.io\/\$\{\{\s*github\.repository\s*\}\}/;
      const hasLegacyTag = legacyTagPattern.test(wfContent);
      if (hasLegacyTag) {
        const mixedCase = /[A-Z]/.test(repo);
        const mixedCaseSuffix = mixedCase
          ? ' (repo 이름에 대문자가 포함되어 있어 lowercase GHCR 태그 규칙을 위반합니다)'
          : '';
        return {
          message: `빌드 실패: ${conclusion} — 구버전 workflow 템플릿을 사용 중입니다${mixedCaseSuffix}.`,
          reason: 'WORKFLOW_OLD_TEMPLATE',
          userAction: {
            label: 'swkoo.kr에서 다시 배포 시작 (workflow 자동 갱신)',
            href: '/deploy',
            kind: 'link',
          },
        };
      }
    } catch (err) {
      // Workflow file unreadable — possibly the user deleted it or
      // the install token is missing. Skip this probe and try step
      // classification.
      this.logger.warn(
        `classifyBuildFailure workflow probe failed for ${owner}/${repo}: ${(err as Error).message}`
      );
    }

    // ---- Probe 2: failed step name ----
    // The jobs endpoint is cheap relative to the log zip and carries
    // step-level conclusions. We look for the *first* failed step and
    // match against a small set of patterns tied to our generated
    // template (checkout/buildx/login-action/build-push-action).
    interface GhaJobStep {
      name: string;
      status: string;
      conclusion: string | null;
    }
    interface GhaJob {
      name: string;
      status: string;
      conclusion: string | null;
      steps?: GhaJobStep[];
    }
    try {
      const jobsResp = await axios.get<{ jobs: GhaJob[] }>(
        `https://api.github.com/repos/${owner}/${repo}/actions/runs/${run.id}/jobs`,
        { headers }
      );
      const failedStep = jobsResp.data.jobs
        .flatMap((j) => j.steps ?? [])
        .find((s) => s.conclusion === 'failure');
      const stepName = failedStep?.name.toLowerCase() ?? '';

      // login-action failure → token / packages: write missing.
      if (stepName.includes('login') && stepName.includes('ghcr')) {
        return {
          message: `빌드 실패: ${conclusion} — GHCR 로그인 단계 실패.`,
          reason: 'GHCR_PUSH_FAILED',
          userAction: {
            label: 'GitHub Actions 로그 보기',
            href: run.html_url,
            kind: 'link',
          },
          operatorHint: 'workflow의 permissions.packages 또는 GITHUB_TOKEN 권한 확인이 필요할 수 있습니다.',
        };
      }
      // build-push-action / Build and push → docker build failed.
      if (
        stepName.includes('build') &&
        (stepName.includes('push') || stepName.includes('docker'))
      ) {
        return {
          message: `빌드 실패: ${conclusion} — Docker 빌드/푸시 단계 실패.`,
          reason: 'DOCKER_BUILD_FAILED',
          userAction: {
            label: 'GitHub Actions 로그 보기',
            href: run.html_url,
            kind: 'link',
          },
        };
      }
    } catch (err) {
      this.logger.warn(
        `classifyBuildFailure jobs probe failed for ${owner}/${repo}#${run.id}: ${(err as Error).message}`
      );
    }

    // ---- Fallback ----
    return {
      message: `빌드 실패: ${conclusion}`,
      reason: 'UNKNOWN_BUILD_FAILURE',
      userAction: {
        label: 'GitHub Actions 로그 보기',
        href: run.html_url,
        kind: 'link',
      },
    };
  }

  private maybeNotifyBuildFailure(
    owner: string,
    repo: string,
    run: GhaRunSummary
  ): void {
    const url = this.config.discordBuildFailureWebhookUrl;
    if (!url) return;
    if (run.conclusion === 'success') return;
    const key = `${owner.toLowerCase()}/${repo}`;
    if (this.notifiedFailures.get(key) === run.id) return;
    this.notifiedFailures.set(key, run.id);

    const lines = [
      '🔴 빌드 실패',
      `**${owner}/${repo}** @ ${run.head_sha.slice(0, 7)}`,
      `결론: ${run.conclusion ?? 'unknown'}`,
      `로그: ${run.html_url}`,
    ];
    void axios
      .post(url, { content: lines.join('\n') }, { timeout: 5000 })
      .catch((err) => {
        this.logger.error(`Build-failure Discord webhook failed: ${(err as Error).message}`);
      });
  }

  private checkImageDetectedStage(app: unknown): StageInfo {
    const imagesField = (app as {
      spec?: { source?: { kustomize?: { images?: string[] } } };
    } | null)?.spec?.source?.kustomize?.images;
    const images = Array.isArray(imagesField) ? imagesField : [];
    const pinned = images.find((entry) => entry.includes('@sha256:'));
    if (pinned) {
      const digest = pinned.split('@sha256:')[1]?.slice(0, 12);
      return { status: 'success', message: `새 이미지 감지 (sha256:${digest}…)` };
    }
    return { status: 'pending', message: '새 이미지 감지 대기 중' };
  }

  private checkDeployStage(app: unknown): StageInfo {
    const a = app as
      | { status?: { sync?: { status?: string }; health?: { status?: string } } }
      | null;
    if (!a) {
      return { status: 'pending', message: 'ArgoCD Application 감지 대기 중' };
    }
    const sync = a.status?.sync?.status;
    const health = a.status?.health?.status;
    if (sync === 'Synced' && health === 'Healthy') {
      return { status: 'success', message: '배포 완료 (Synced / Healthy)' };
    }
    if (health === 'Degraded') {
      return {
        status: 'failed',
        message: `배포 실패 (Health=${health})`,
        reason: 'ARGO_SYNC_FAILED',
        userAction: {
          label: 'GitHub Actions 로그로 빌드 결과 먼저 확인',
          kind: 'docs',
        },
        operatorHint:
          'Pod 이벤트(kubectl describe / kubectl logs)로 ImagePullBackOff, CrashLoopBackOff 여부를 확인하세요.',
      };
    }
    return {
      status: 'running',
      message: `배포 진행 중 (Sync=${sync ?? '?'} / Health=${health ?? '?'})`,
    };
  }

  private async checkLiveStage(liveUrl: string): Promise<StageInfo> {
    try {
      const resp = await axios.get(liveUrl, {
        timeout: 3000,
        validateStatus: () => true,
        maxRedirects: 3,
      });
      if (resp.status >= 200 && resp.status < 400) {
        return { status: 'success', message: `${liveUrl} 응답 정상`, link: liveUrl };
      }
      // 5xx (or persistent non-success) is treated as pending here on
      // purpose — the live URL flips through 5xx briefly while the
      // ingress + new pod are settling, and we don't want to flash a
      // hard 'failed' state during a normal rollout. Only mark failed
      // if the Argo deploy stage has settled as Degraded (handled in
      // checkDeployStage) — the live row stays in pending until either
      // a 2xx-3xx response or the operator intervenes.
      return {
        status: 'pending',
        message: `${liveUrl} HTTP ${resp.status}`,
        link: liveUrl,
      };
    } catch {
      return { status: 'pending', message: '라이브 URL 응답 대기 중', link: liveUrl };
    }
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
