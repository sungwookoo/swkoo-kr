import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import axios from 'axios';
import { onboardingConfig } from '../config/onboarding.config';
import { AuthService } from '../onboarding/auth.service';
import { GithubAppService } from '../github-app/github-app.service';
import { ArgoCdClient } from '../pipelines/services/argo-cd.client';
import type { ArgoCdApplication } from '../pipelines/types/argo-cd.types';
import { KubeClient } from '../kube/kube.client';
import type { DeploymentStatus, StageInfo, StageAction, StageReason } from './deploy.service';
import { getUserRegistrationPath, sanitizeName } from './templates';
import { readyImageDigest } from './deployment-readiness';

interface GithubContent { content: string }
interface GhaRunSummary {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_sha: string;
  created_at: string;
  event?: string;
}

@Injectable()
export class DeployStatusService {
  private readonly logger = new Logger(DeployStatusService.name);
  private readonly notifiedFailures = new Map<string, number>();
  constructor(
    private readonly auth: AuthService,
    private readonly githubApp: GithubAppService,
    private readonly argo: ArgoCdClient,
    private readonly kube: KubeClient,
    @Inject(onboardingConfig.KEY) private readonly config: ConfigType<typeof onboardingConfig>
  ) {}

  async getStages(userId: number, login: string, repo: string, liveUrl: string): Promise<DeploymentStatus['stages']> {
    const [manifests, build, app] = await Promise.all([
      this.checkManifestStage(login), this.checkBuildStage(userId, login, repo),
      this.argo.getApplication(`swkoo-user-${login}`).catch(() => null),
    ]);
    const waiting: StageInfo = { status: 'pending', message: '최신 빌드 확인 후 진행합니다.' };
    const stages = { manifests, build, imageDetected: waiting, deploy: waiting, live: waiting };
    if (manifests.status !== 'success' || build.status !== 'success' || !build.sourceSha) return stages;

    let expected: string | undefined;
    try {
      const token = await this.githubApp.getInstallationTokenForRepo(login, repo);
      const versions = await this.githubApp.listUserPackageVersions({
        owner: login, packageName: repo.toLowerCase(), token,
      });
      expected = versions?.find((v) => v.metadata.container.tags.includes(build.sourceSha!))?.name;
    } catch {
      // Missing registry evidence must never be replaced by a time-based guess.
    }
    const imageRepo = `ghcr.io/${login}/${repo}`.toLowerCase();
    const desired = app?.spec.source?.kustomize?.images?.find((i) =>
      i.startsWith(`${imageRepo}:`) || i.startsWith(`${imageRepo}@`));
    if (!expected || !/^sha256:[a-f0-9]{64}$/.test(expected) || !desired?.endsWith(`@${expected}`)) {
      stages.imageDetected = { status: 'pending', reason: 'IMAGE_UPDATER_PENDING',
        message: '최신 빌드 이미지가 클러스터에 반영되기를 기다리는 중입니다.' };
      return stages;
    }
    stages.imageDetected = { status: 'success', message: `최신 빌드 이미지 확인 (${expected.slice(0, 19)}…)` };
    stages.deploy = this.checkDeployStage(app);
    if (stages.deploy.status === 'failed') return stages;
    const runtime = await this.checkRuntime(login, repo, expected);
    if (runtime.status === 'failed') { stages.deploy = runtime; return stages; }
    if (readyImageDigest(app, login, repo) !== expected) {
      stages.deploy = { status: 'running', message: '최신 이미지의 Argo CD 동기화 완료를 기다리는 중입니다.' };
      return stages;
    }
    stages.deploy = runtime;
    if (stages.deploy.status !== 'success') return stages;
    stages.live = await this.checkLiveStage(liveUrl);
    if (stages.live.status !== 'success') {
      stages.live = { ...stages.live, status: 'failed', reason: 'LIVE_HEALTHCHECK_FAILED',
        message: `앱 응답 오류: ${stages.live.message}` };
    }
    return stages;
  }

  async checkRuntime(login: string, repo: string, digest: string): Promise<StageInfo> {
    const pending: StageInfo = { status: 'running', message: '최신 이미지의 컨테이너 준비를 기다리는 중입니다.' };
    if (!this.kube.core || !this.kube.apps) return { ...pending, message: '컨테이너 상태를 확인할 수 없습니다.' };
    const namespace = `user-${login}`;
    const appName = sanitizeName(repo);
    const matches = (image?: string) => Boolean(image?.startsWith(`ghcr.io/${login}/${repo.toLowerCase()}:`)
      && image.endsWith(`@${digest}`));
    try {
      const [deployment, pods] = await Promise.all([
        this.kube.apps.readNamespacedDeployment({ namespace, name: appName }),
        this.kube.core.listNamespacedPod({ namespace, labelSelector: `app=${appName}` }),
      ]);
      const current = pods.items.filter((p) => !p.metadata?.deletionTimestamp
        && p.spec?.containers.some((c) => c.name === appName && matches(c.image)));
      for (const pod of current) {
        const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
        const broken = statuses.find((c) => ['ImagePullBackOff', 'ErrImagePull', 'CrashLoopBackOff', 'CreateContainerConfigError'].includes(c.state?.waiting?.reason ?? '')
          || (c.state?.terminated && c.state.terminated.exitCode !== 0));
        if (broken) return { status: 'failed', reason: 'POD_NOT_READY',
          message: `컨테이너 시작 실패 (${broken.state?.waiting?.reason ?? broken.state?.terminated?.reason ?? 'Error'})`,
          operatorHint: '해당 Pod의 이벤트와 로그를 확인하세요.' };
      }
      const count = deployment.spec?.replicas ?? 1;
      if (count < 1 || (deployment.status?.observedGeneration ?? 0) < (deployment.metadata?.generation ?? 1)
        || !deployment.spec?.template.spec?.containers.some((c) => c.name === appName && matches(c.image))
        || deployment.status?.updatedReplicas !== count || deployment.status?.availableReplicas !== count
        || (deployment.status?.unavailableReplicas ?? 0) > 0 || current.length !== count) return pending;
      if (!current.every((p) => p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')
        && p.status?.containerStatuses?.some((c) => c.name === appName && c.ready && c.state?.running && c.imageID))) return pending;
      return { status: 'success', message: '최신 이미지 컨테이너 준비 완료' };
    } catch {
      return { ...pending, message: '컨테이너 상태 조회 중입니다.' };
    }
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
      const headers = { Authorization: `token ${accessToken}`, Accept: 'application/vnd.github+json' };
      const repository = await axios.get<{ default_branch: string }>(
        `https://api.github.com/repos/${owner}/${repo}`, { headers, timeout: 5000 });
      const branch = repository.data.default_branch;
      const head = await axios.get<{ sha: string }>(
        `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
        { headers, timeout: 5000 });
      const resp = await axios.get<{ workflow_runs: GhaRunSummary[] }>(
        `https://api.github.com/repos/${owner}/${repo}/actions/workflows/build.yml/runs`,
        {
          headers: {
            Authorization: `token ${accessToken}`,
            Accept: 'application/vnd.github+json',
          },
          params: { branch, head_sha: head.data.sha, per_page: 10 },
          timeout: 5000,
        }
      );
      const run = resp.data.workflow_runs.find((r) => r.head_sha === head.data.sha && (!r.event || ['push', 'workflow_dispatch'].includes(r.event)));
      if (!run) {
        return { status: 'pending', message: '빌드 대기 중 (워크플로 실행 기록 없음)' };
      }
      if (run.status === 'completed' && run.conclusion === 'success') {
        return {
          status: 'success',
          message: `빌드 완료 (${run.head_sha.slice(0, 7)})`,
          sourceSha: run.head_sha,
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
    if (health === 'Degraded' || ['Failed', 'Error'].includes((app as ArgoCdApplication)?.status?.operationState?.phase ?? '')) {
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

}
