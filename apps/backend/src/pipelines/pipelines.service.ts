import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import { githubConfig } from '../config/github.config';
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
    private readonly config: ConfigType<typeof pipelinesConfig>,
    @Inject(githubConfig.KEY)
    private readonly githubCfg: ConfigType<typeof githubConfig>
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
      owner: this.githubCfg.owner ?? owner,
      repo: this.githubCfg.repo ?? repo,
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
    // user's source repo (where workflow lives) is recorded as the
    // `swkoo.kr/source-repo` annotation on the Application by the
    // ApplicationSet template. Presence of this annotation distinguishes
    // user apps (use provenance lookup) from the swkoo-self app
    // (use chore-commit parsing).
    const sourceAnnotation =
      application.metadata?.annotations?.['swkoo.kr/source-repo'];
    const isUserApp = Boolean(
      sourceAnnotation && /^[^/]+\/[^/]+$/.test(sourceAnnotation)
    );

    if (isUserApp) {
      const [sourceOwner, sourceRepoName] = (sourceAnnotation as string).split('/');
      return this.buildUserAppDeployments({
        name,
        application,
        history,
        sourceOwner,
        sourceRepo: sourceRepoName,
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
    const ghOwner = this.githubCfg.owner ?? parsed.owner;
    const ghRepo = this.githubCfg.repo ?? parsed.repo;

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
   * just for the latest. */
  private async buildUserAppDeployments(args: {
    name: string;
    application: ArgoCdApplication;
    history: NonNullable<ArgoCdApplication['status']>['history'];
    sourceOwner: string;
    sourceRepo: string;
  }): Promise<DeploymentsEnvelope> {
    const { name, application, history, sourceOwner, sourceRepo } = args;
    const list = history ?? [];

    const provenanceResults = await Promise.all(
      list.map(async (h) => {
        const digest = this.extractDeployedDigest(
          h.source?.kustomize?.images,
          application.status?.summary?.images
        );
        if (!digest) {
          return null;
        }
        return this.provenance.resolve({
          sourceOwner,
          sourceRepo,
          digest,
          timeContext: { deployedAt: h.deployedAt ?? null },
        });
      })
    );

    // For each resolved source SHA, fetch the commit + run from the *source*
    // repo (annotation owner) for the timeline display.
    const sourceCommits = await Promise.all(
      provenanceResults.map((p) =>
        p?.sourceSha
          ? this.githubClient.fetchCommit({
              owner: sourceOwner,
              repo: sourceRepo,
              sha: p.sourceSha,
            })
          : Promise.resolve(null)
      )
    );
    const workflowRuns = await Promise.all(
      provenanceResults.map((p) =>
        p?.sourceSha
          ? this.githubClient.fetchWorkflowRunForSha({
              owner: sourceOwner,
              repo: sourceRepo,
              sha: p.sourceSha,
            })
          : Promise.resolve(null)
      )
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

  /** Pulls the `sha256:<digest>` out of either `spec.source.kustomize.images`
   * (preferred — written directly by argocd-image-updater) or
   * `status.summary.images` (fallback). Tolerant of multiple images on an
   * Application; we only track the first since user apps deploy a single
   * container. */
  private extractDeployedDigest(
    kustomizeImages: string[] | undefined,
    summaryImages: string[] | undefined
  ): string | null {
    const candidates = [kustomizeImages, summaryImages]
      .filter((arr): arr is string[] => Array.isArray(arr) && arr.length > 0)
      .flat();
    for (const img of candidates) {
      const at = img.indexOf('@sha256:');
      if (at >= 0) {
        const digest = img.slice(at + 1);
        if (/^sha256:[0-9a-f]{64}$/i.test(digest)) return digest;
      }
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
    // getWorkflows() which uses it to query GitHub Actions. For
    // user apps the Application's spec.source.repoURL is the per-user
    // *deploy* repo (manifests only, no GHA). The source repo lives
    // in the swkoo.kr/source-repo annotation; surface that here so
    // every downstream consumer sees the right URL.
    const sourceAnnotation =
      application.metadata?.annotations?.['swkoo.kr/source-repo'];
    const repoUrl =
      sourceAnnotation && /^[^/]+\/[^/]+$/.test(sourceAnnotation)
        ? `https://github.com/${sourceAnnotation}.git`
        : application.spec.source?.repoURL ?? null;

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
