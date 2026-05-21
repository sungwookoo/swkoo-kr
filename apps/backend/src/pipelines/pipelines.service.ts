import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import { pipelinesConfig } from '../config/pipelines.config';
import type { ArgoCdApplication } from './types/argo-cd.types';
import type { CommitInfo, WorkflowRun, WorkflowsEnvelope } from './types/github.types';
import type { PipelineSummary, PipelinesEnvelope } from './pipelines.types';
import type {
  DeploymentEvent,
  DeploymentLifecycle,
  DeploymentsEnvelope,
  RevisionConfidence
} from './deployments.types';
import { ProvenanceService } from './provenance.service';
import { ArgoCdClient } from './services/argo-cd.client';
import { GitHubClient } from './services/github.client';

interface PipelinesCache {
  fetchedAt: number;
  data: PipelineSummary[];
}

interface GetWorkflowsOptions {
  workflow?: string;
  page?: number;
  perPage?: number;
}

@Injectable()
export class PipelinesService {
  private readonly logger = new Logger(PipelinesService.name);
  private cache: PipelinesCache | null = null;

  constructor(
    private readonly argoCdClient: ArgoCdClient,
    private readonly githubClient: GitHubClient,
    private readonly provenance: ProvenanceService,
    @Inject(pipelinesConfig.KEY)
    private readonly config: ConfigType<typeof pipelinesConfig>
  ) {}

  async getPipelines(): Promise<PipelinesEnvelope> {
    if (!this.argoCdClient.isConfigured()) {
      return {
        configured: false,
        fetchedAt: null,
        pipelines: []
      };
    }

    const ttl = (this.config.cacheTtl ?? 15) * 1000;
    const now = Date.now();

    if (this.cache && now - this.cache.fetchedAt < ttl) {
      return {
        configured: true,
        fetchedAt: new Date(this.cache.fetchedAt).toISOString(),
        pipelines: this.cache.data
      };
    }

    const applications = await this.argoCdClient.listApplications();
    const pipelines = applications.map((app) => this.toPipelineSummary(app));

    this.cache = {
      fetchedAt: now,
      data: pipelines
    };

    return {
      configured: true,
      fetchedAt: new Date(now).toISOString(),
      pipelines
    };
  }

  async getPipeline(name: string): Promise<PipelineSummary> {
    if (!this.argoCdClient.isConfigured()) {
      throw new ServiceUnavailableException('Pipelines module is not yet configured');
    }

    const application = await this.argoCdClient.getApplication(name);

    if (!application) {
      throw new NotFoundException(`Pipeline ${name} not found`);
    }

    return this.toPipelineSummary(application);
  }

  async getWorkflows(name: string, options: GetWorkflowsOptions = {}): Promise<WorkflowsEnvelope> {
    if (!this.githubClient.isConfigured()) {
      return {
        configured: false,
        repoUrl: null,
        workflows: [],
        runs: [],
        pagination: { page: 1, perPage: 10, total: 0 }
      };
    }

    // Get pipeline to extract repoUrl
    const pipeline = await this.getPipeline(name);
    const repoUrl = pipeline.repoUrl;

    if (!repoUrl) {
      this.logger.warn(`Pipeline ${name} does not have a repository URL`);
      return {
        configured: true,
        repoUrl: null,
        workflows: [],
        runs: [],
        pagination: { page: 1, perPage: 10, total: 0 }
      };
    }

    // Extract owner and repo from repoUrl
    const { owner, repo } = this.parseGitHubRepoUrl(repoUrl);

    if (!owner || !repo) {
      this.logger.warn(`Could not parse GitHub repository from URL: ${repoUrl}`);
      return {
        configured: true,
        repoUrl,
        workflows: [],
        runs: [],
        pagination: { page: 1, perPage: 10, total: 0 }
      };
    }

    return this.githubClient.fetchWorkflows({
      owner,
      repo,
      workflow: options.workflow,
      page: options.page,
      perPage: options.perPage
    });
  }

  async getDeployments(name: string, limit = 5): Promise<DeploymentsEnvelope> {
    if (!this.argoCdClient.isConfigured()) {
      return { configured: false, fetchedAt: null, pipeline: name, deployments: [] };
    }

    const application = await this.argoCdClient.getApplication(name);
    if (!application) {
      throw new NotFoundException(`Pipeline ${name} not found`);
    }

    const history = (application.status?.history ?? []).slice(-limit).reverse();
    if (history.length === 0) {
      return {
        configured: true,
        fetchedAt: new Date().toISOString(),
        pipeline: name,
        deployments: []
      };
    }

    // Phase 3.1 split: user app's `spec.source.repoURL` points to the
    // per-user *deploy* repo (just k8s manifests, no GHA workflow). The
    // `swkoo.kr/source-repo` annotation is a render-time *hint* about
    // where the user's build workflow lives — used only to classify
    // user app vs swkoo-self. For actual GHCR + commit + run lookups
    // we trust the deployed image repo (see buildUserAppDeployments).
    const sourceAnnotation =
      application.metadata?.annotations?.['swkoo.kr/source-repo'];
    const isUserApp = Boolean(
      sourceAnnotation && /^[^/]+\/[^/]+$/.test(sourceAnnotation)
    );

    if (isUserApp) {
      return this.buildUserAppDeployments({
        name,
        application,
        history,
      });
    }

    return this.buildSelfAppDeployments({ name, application, history });
  }

  /** Self app (swkoo-portfolio): source repo == deploy repo. Argo history's
   * `revision` is the chore commit; lift the source SHA out of its message
   * and resolve commit + run. `verified` only when the source commit itself
   * exists on GitHub; degrade to `unknown` on parsing/lookup failures. */
  private async buildSelfAppDeployments(args: {
    name: string;
    application: ArgoCdApplication;
    history: NonNullable<ArgoCdApplication['status']>['history'];
  }): Promise<DeploymentsEnvelope> {
    const { name, application, history } = args;
    const repoUrl = application.spec.source?.repoURL ?? null;
    const parsed = repoUrl
      ? this.parseGitHubRepoUrl(repoUrl)
      : { owner: null, repo: null };
    const ghOwner = parsed.owner;
    const ghRepo = parsed.repo;

    const list = history ?? [];
    const manifestCommits = await Promise.all(
      list.map((h) =>
        ghOwner && ghRepo && h.revision
          ? this.githubClient.fetchCommit({ owner: ghOwner, repo: ghRepo, sha: h.revision })
          : Promise.resolve(null)
      )
    );
    const sourceShas = manifestCommits.map((mc) =>
      mc ? this.extractSourceSha(mc.message) : null
    );
    const sourceCommits = await Promise.all(
      sourceShas.map((sha) =>
        sha && ghOwner && ghRepo
          ? this.githubClient.fetchCommit({ owner: ghOwner, repo: ghRepo, sha })
          : Promise.resolve(null)
      )
    );
    const workflowRuns = await Promise.all(
      sourceShas.map((sha) =>
        sha && ghOwner && ghRepo
          ? this.githubClient.fetchWorkflowRunForSha({ owner: ghOwner, repo: ghRepo, sha })
          : Promise.resolve(null)
      )
    );

    const argocdBaseUrl = this.config.baseUrl ?? null;
    const deployments: DeploymentLifecycle[] = list.map((h, i) => {
      const sourceSha = sourceShas[i];
      const sourceCommit = sourceCommits[i];
      const run = workflowRuns[i];
      // For self app, `verified` requires us to have actually resolved the
      // source commit AND run. Either missing → unknown (the surfaced
      // commit is informational only).
      const confidence: RevisionConfidence =
        sourceSha && sourceCommit && run ? 'verified' : 'unknown';
      return this.toDeploymentLifecycle({
        name,
        history: h,
        commit: sourceCommit ?? manifestCommits[i],
        workflowRun: run,
        argocdBaseUrl,
        revisionConfidence: confidence,
        sourceSha: sourceSha ?? null,
        sourceRunUrl: run?.htmlUrl ?? null,
      });
    });

    return {
      configured: true,
      fetchedAt: new Date().toISOString(),
      pipeline: name,
      deployments,
    };
  }

  /** User app: use deployed image digest to look up the source SHA via
   * GitHub Packages. Each history entry carries its own
   * `source.kustomize.images[]` so we get per-deployment provenance, not
   * just for the latest. The `swkoo.kr/source-repo` annotation is only a
   * hint for what swkoo.kr *thinks* the source is — the deployed image's
   * own owner/name (parsed from the image string) is what GHCR will know
   * about and what GHA's `github.sha` refers to. When the two disagree
   * (stale yaml, renamed repo), trusting the image is more correct. */
  private async buildUserAppDeployments(args: {
    name: string;
    application: ArgoCdApplication;
    history: NonNullable<ArgoCdApplication['status']>['history'];
  }): Promise<DeploymentsEnvelope> {
    const { name, application, history } = args;
    const list = history ?? [];

    const perDeployImageInfo = list.map((h) =>
      this.extractDeployedImageInfo(
        h.source?.kustomize?.images,
        application.status?.summary?.images
      )
    );

    const provenanceResults = await Promise.all(
      perDeployImageInfo.map(async (info, i) => {
        if (!info) return null;
        return this.provenance.resolve({
          imageOwner: info.owner,
          imageName: info.name,
          digest: info.digest,
          timeContext: { deployedAt: list[i].deployedAt ?? null },
        });
      })
    );

    // For each resolved source SHA, fetch the commit + run from the *image*
    // repo — that's where github.sha points (the workflow that built the
    // tag runs in that repo).
    const sourceCommits = await Promise.all(
      provenanceResults.map((p, i) => {
        const info = perDeployImageInfo[i];
        return p?.sourceSha && info
          ? this.githubClient.fetchCommit({
              owner: info.owner,
              repo: info.name,
              sha: p.sourceSha,
            })
          : Promise.resolve(null);
      })
    );
    const workflowRuns = await Promise.all(
      provenanceResults.map((p, i) => {
        const info = perDeployImageInfo[i];
        return p?.sourceSha && info
          ? this.githubClient.fetchWorkflowRunForSha({
              owner: info.owner,
              repo: info.name,
              sha: p.sourceSha,
            })
          : Promise.resolve(null);
      })
    );

    const argocdBaseUrl = this.config.baseUrl ?? null;
    const deployments: DeploymentLifecycle[] = list.map((h, i) => {
      const prov = provenanceResults[i];
      return this.toDeploymentLifecycle({
        name,
        history: h,
        commit: sourceCommits[i],
        workflowRun: workflowRuns[i],
        argocdBaseUrl,
        revisionConfidence: prov?.confidence ?? 'unknown',
        sourceSha: prov?.sourceSha ?? null,
        sourceRunUrl: prov?.sourceRunUrl ?? null,
      });
    });

    return {
      configured: true,
      fetchedAt: new Date().toISOString(),
      pipeline: name,
      deployments,
    };
  }

  /** Parses `ghcr.io/<owner>/<name>:<tag>@sha256:<64hex>` into the owner,
   * name, and digest used for provenance lookup. Prefers
   * `spec.source.kustomize.images` (written directly by
   * argocd-image-updater) over `status.summary.images` (Argo summary,
   * eventually consistent). User apps deploy a single container so we
   * pick the first image with a parseable digest. */
  private extractDeployedImageInfo(
    kustomizeImages: string[] | undefined,
    summaryImages: string[] | undefined
  ): { owner: string; name: string; digest: string } | null {
    const candidates = [kustomizeImages, summaryImages]
      .filter((arr): arr is string[] => Array.isArray(arr) && arr.length > 0)
      .flat();
    // ghcr.io/owner/name:tag@sha256:<64hex>
    const re = /^ghcr\.io\/([^/]+)\/([^:@]+)(?::[^@]+)?@(sha256:[0-9a-f]{64})$/i;
    for (const img of candidates) {
      const m = img.match(re);
      if (m) return { owner: m[1], name: m[2], digest: m[3] };
    }
    return null;
  }

  /** Like extractDeployedImageInfo but tolerant of images that haven't
   * been digest-pinned yet (newly-created app pre-first-deploy). Used by
   * the pipeline summary's repoUrl computation where we need to resolve
   * to *some* GitHub repo even before the first image lands. */
  private extractImageRepo(
    kustomizeImages: string[] | undefined,
    summaryImages: string[] | undefined
  ): { owner: string; name: string } | null {
    const candidates = [kustomizeImages, summaryImages]
      .filter((arr): arr is string[] => Array.isArray(arr) && arr.length > 0)
      .flat();
    // ghcr.io/owner/name[:tag][@sha256:<hex>]
    const re = /^ghcr\.io\/([^/]+)\/([^:@]+)/i;
    for (const img of candidates) {
      const m = img.match(re);
      if (m) return { owner: m[1], name: m[2] };
    }
    return null;
  }

  private extractSourceSha(commitMessage: string): string | null {
    const match = commitMessage.match(/update image tags? to ([0-9a-f]{7,40})/i);
    return match ? match[1] : null;
  }

  private toDeploymentLifecycle(args: {
    name: string;
    history: { revision?: string; deployedAt?: string };
    commit: CommitInfo | null;
    workflowRun: WorkflowRun | null;
    argocdBaseUrl: string | null;
    revisionConfidence: RevisionConfidence;
    sourceSha: string | null;
    sourceRunUrl: string | null;
  }): DeploymentLifecycle {
    const { name, history, commit, workflowRun, argocdBaseUrl } = args;
    // Prefer the commit we actually resolved (source if extractable, manifest
    // if fallback). Keeps shortSha + href + label consistent.
    const sha = commit?.sha ?? history.revision ?? '';
    const events: DeploymentEvent[] = [];

    if (commit?.authoredAt) {
      events.push({
        stage: 'commit',
        status: 'success',
        timestamp: commit.authoredAt,
        durationSeconds: null,
        label: `commit ${sha.slice(0, 7)}`,
        href: commit.htmlUrl
      });
    }

    if (workflowRun) {
      const buildStatus: DeploymentEvent['status'] =
        workflowRun.status !== 'completed'
          ? 'in_progress'
          : workflowRun.conclusion === 'success'
          ? 'success'
          : workflowRun.conclusion === 'failure' || workflowRun.conclusion === 'cancelled'
          ? 'failure'
          : 'success';
      events.push({
        stage: 'build',
        status: buildStatus,
        timestamp: workflowRun.updatedAt,
        durationSeconds: workflowRun.runDurationSeconds,
        label: workflowRun.name || 'CI build',
        href: workflowRun.htmlUrl
      });
    }

    if (history.deployedAt) {
      events.push({
        stage: 'sync',
        status: 'success',
        timestamp: history.deployedAt,
        durationSeconds: null,
        label: 'Argo CD synced',
        href: argocdBaseUrl ? `${argocdBaseUrl.replace(/\/$/, '')}/applications/${name}` : null
      });
    }

    const startedAt = commit?.authoredAt ?? history.deployedAt ?? '';
    const endedAt = history.deployedAt ?? null;

    return {
      pipeline: name,
      commitSha: sha,
      commitShort: sha.slice(0, 7),
      commitMessage: commit?.message ?? '(commit not found on GitHub)',
      commitAuthor: commit?.authorName ?? 'unknown',
      commitAuthorAvatar: commit?.authorAvatarUrl ?? null,
      commitHref: commit?.htmlUrl ?? null,
      startedAt,
      endedAt,
      events,
      revisionConfidence: args.revisionConfidence,
      sourceSha: args.sourceSha,
      sourceRunUrl: args.sourceRunUrl,
    };
  }

  private parseGitHubRepoUrl(url: string): { owner: string | null; repo: string | null } {
    // Handle both HTTPS and SSH URLs
    // https://github.com/owner/repo.git
    // git@github.com:owner/repo.git
    const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (httpsMatch) {
      return { owner: httpsMatch[1], repo: httpsMatch[2] };
    }

    const sshMatch = url.match(/github\.com:([^/]+)\/([^/.]+)/);
    if (sshMatch) {
      return { owner: sshMatch[1], repo: sshMatch[2] };
    }

    return { owner: null, repo: null };
  }

  private toPipelineSummary(application: ArgoCdApplication): PipelineSummary {
    const history = application.status?.history ?? [];
    const latestHistory = history.at(-1);

    const sync = application.status?.sync;
    const operation = application.status?.operationState;

    const namespace =
      application.spec.destination?.namespace ??
      sync?.comparedTo?.destination?.namespace ??
      null;

    const lastSyncedAt =
      application.status?.reconciledAt ?? operation?.finishedAt ?? latestHistory?.deployedAt ?? null;

    const lastDeployedAt = latestHistory?.deployedAt ?? operation?.finishedAt ?? null;

    const revision =
      operation?.syncResult?.revision ??
      latestHistory?.revision ??
      sync?.revision ??
      null;

    this.logger.debug(
      `Mapped Argo CD application ${application.metadata?.name ?? 'unknown'} to pipeline summary`
    );

    // `repoUrl` flows through to the frontend timeline + into
    // getWorkflows(), which uses it to query GitHub Actions. For
    // user apps the Application's spec.source.repoURL is the per-user
    // *deploy* repo (manifests only, no GHA workflow), so we must surface
    // the *image* repo where the build workflow actually lives.
    //
    // Priority (user apps):
    //   1. Parse from spec.source.kustomize.images / status.summary.images
    //      — the image-updater-written digest pin is ground truth for
    //      where the deployed binary actually came from.
    //   2. swkoo.kr/source-repo annotation — render-time hint from
    //      swkoo.kr; can drift from reality if the user renames their
    //      image repo (observed: hizieun annotation=portfolio but real
    //      image=my-arxiv).
    //   3. spec.source.repoURL — last resort; for user apps this is the
    //      deploy repo, not the source. Only correct for self-app.
    const sourceAnnotation =
      application.metadata?.annotations?.['swkoo.kr/source-repo'];
    const isUserApp = Boolean(
      sourceAnnotation && /^[^/]+\/[^/]+$/.test(sourceAnnotation)
    );
    let repoUrl: string | null;
    if (isUserApp) {
      const imageRepo = this.extractImageRepo(
        application.spec.source?.kustomize?.images,
        application.status?.summary?.images
      );
      if (imageRepo) {
        repoUrl = `https://github.com/${imageRepo.owner}/${imageRepo.name}.git`;
      } else if (sourceAnnotation) {
        // Pre-first-deploy: no image yet, annotation is our best hint.
        repoUrl = `https://github.com/${sourceAnnotation}.git`;
      } else {
        repoUrl = application.spec.source?.repoURL ?? null;
      }
    } else {
      // Self app: spec.source.repoURL is correct (source == deploy repo).
      repoUrl = application.spec.source?.repoURL ?? null;
    }

    return {
      name: application.metadata?.name ?? 'unknown',
      project: application.spec.project,
      namespace,
      repoUrl,
      targetRevision: application.spec.source?.targetRevision ?? null,
      syncStatus: sync?.status ?? 'Unknown',
      healthStatus: application.status?.health?.status ?? 'Unknown',
      lastSyncedAt,
      lastDeployedAt,
      revision
    };
  }
}
