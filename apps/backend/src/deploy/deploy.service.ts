import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { PatchStrategy, setHeaderOptions } from '@kubernetes/client-node';
import axios from 'axios';

import { onboardingConfig } from '../config/onboarding.config';
import { KubeClient } from '../kube/kube.client';
import { AuthService } from '../onboarding/auth.service';
import { UsersRepository } from '../onboarding/users.repository';
import { ArgoCdClient } from '../pipelines/services/argo-cd.client';
import { GithubAppService } from './github-app.service';
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

export type StackPreview =
  | { stack: 'nextjs'; packageName: string | null; port: number; nodeEngine: string | null }
  | { stack: 'unsupported'; reason: string };

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

export interface StageInfo {
  status: StageStatus;
  message: string;
  link?: string;
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

    // Default branch must be 'main' — the generated workflow triggers on
    // pushes to main, so non-main repos would never build. Catch it here so
    // the preview surfaces the issue before the user clicks Deploy.
    try {
      const repoResp = await axios.get<{ default_branch: string }>(
        `https://api.github.com/repos/${owner}/${repo}`,
        { headers }
      );
      if (repoResp.data.default_branch !== 'main') {
        return {
          stack: 'unsupported',
          reason: `기본 브랜치가 'main'이어야 합니다 (현재: '${repoResp.data.default_branch}'). repo Settings → Branches에서 변경 후 다시 시도해주세요.`,
        };
      }
    } catch (err) {
      this.logger.warn(
        `detectStack repo metadata failed for ${owner}/${repo}: ${(err as Error).message}`
      );
      return { stack: 'unsupported', reason: 'repo metadata를 읽을 수 없습니다.' };
    }

    let pkg: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; engines?: { node?: string } };
    try {
      const resp = await axios.get<GithubContent>(
        `https://api.github.com/repos/${owner}/${repo}/contents/package.json`,
        { headers }
      );
      const content = Buffer.from(resp.data.content, 'base64').toString('utf8');
      pkg = JSON.parse(content);
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 404) {
        return { stack: 'unsupported', reason: 'package.json not found in repo root' };
      }
      this.logger.warn(`detectStack failed for ${owner}/${repo}: ${(err as Error).message}`);
      return { stack: 'unsupported', reason: 'package.json could not be read' };
    }

    const hasNext = Boolean(
      pkg.dependencies?.['next'] ?? pkg.devDependencies?.['next']
    );
    if (!hasNext) {
      return {
        stack: 'unsupported',
        reason: 'No Next.js dependency detected (v0 supports Next.js only)',
      };
    }

    return {
      stack: 'nextjs',
      packageName: pkg.name ?? null,
      port: 3000,
      nodeEngine: pkg.engines?.node ?? null,
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
    const params = {
      login: loginLc,
      appName,
      imageRepo: `ghcr.io/${loginLc}/${repo.toLowerCase()}`,
      subdomain,
      port: preview.port,
      uid: 1000,
      deployRepoFullName,
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
        return {
          status: 'failed',
          message: `빌드 실패: ${run.conclusion ?? 'unknown'}`,
          link: run.html_url,
        };
      }
      return { status: 'running', message: `이미지 빌드 중 (${run.status})`, link: run.html_url };
    } catch (err) {
      this.logger.warn(`checkBuildStage failed: ${(err as Error).message}`);
      return { status: 'pending', message: '빌드 상태 확인 중' };
    }
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
      return { status: 'failed', message: `배포 실패 (Health=${health})` };
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
