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
  DeploymentsEnvelope
} from './deployments.types';
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
    // ApplicationSet template. Prefer that when present; fall back to
    // repoURL for the swkoo.kr-self app whose source == deploy repo.
    const sourceAnnotation =
      application.metadata?.annotations?.['swkoo.kr/source-repo'];
    let owner: string | null = null;
    let repo: string | null = null;
    if (sourceAnnotation && /^[^/]+\/[^/]+$/.test(sourceAnnotation)) {
      [owner, repo] = sourceAnnotation.split('/');
    } else {
      const repoUrl = application.spec.source?.repoURL ?? null;
      const parsed = repoUrl
        ? this.parseGitHubRepoUrl(repoUrl)
        : { owner: null, repo: null };
      owner = parsed.owner;
      repo = parsed.repo;
    }

    const ghOwner = this.githubCfg.owner ?? owner;
    const ghRepo = this.githubCfg.repo ?? repo;

    // Argo CD's history.revision is the *manifest* commit (the auto-commit
    // CI made when it bumped image tags), not the source commit a human
    // pushed. The manifest commit's message follows the pattern
    //   "chore: update image tags to <40-char-source-sha>"
    // so we lift the source SHA out of it. If extraction fails (manifest
    // edited by hand, different message format), we fall back to the
    // manifest commit so the lifecycle still shows something.
    const manifestCommits = await Promise.all(
      history.map((h) =>
        ghOwner && ghRepo && h.revision
          ? this.githubClient.fetchCommit({ owner: ghOwner, repo: ghRepo, sha: h.revision })
          : Promise.resolve(null)
      )
    );

    const sourceShas = manifestCommits.map((mc) => (mc ? this.extractSourceSha(mc.message) : null));

    const sourceCommits = await Promise.all(
      sourceShas.map((sha) =>
        sha && ghOwner && ghRepo
          ? this.githubClient.fetchCommit({ owner: ghOwner, repo: ghRepo, sha })
          : Promise.resolve(null)
      )
    );

    // For each resolved source commit, find the GitHub Actions run that built
    // its image. CI is keyed on head_sha so this is a single lookup per entry.
    const workflowRuns = await Promise.all(
      sourceShas.map((sha) =>
        sha && ghOwner && ghRepo
          ? this.githubClient.fetchWorkflowRunForSha({ owner: ghOwner, repo: ghRepo, sha })
          : Promise.resolve(null)
      )
    );

    const argocdBaseUrl = this.config.baseUrl ?? null;
    const deployments: DeploymentLifecycle[] = history.map((h, i) =>
      this.toDeploymentLifecycle(
        name,
        h,
        sourceCommits[i] ?? manifestCommits[i],
        workflowRuns[i],
        argocdBaseUrl
      )
    );

    return {
      configured: true,
      fetchedAt: new Date().toISOString(),
      pipeline: name,
      deployments
    };
  }

  private extractSourceSha(commitMessage: string): string | null {
    const match = commitMessage.match(/update image tags? to ([0-9a-f]{7,40})/i);
    return match ? match[1] : null;
  }

  private toDeploymentLifecycle(
    name: string,
    history: { revision?: string; deployedAt?: string },
    commit: CommitInfo | null,
    workflowRun: WorkflowRun | null,
    argocdBaseUrl: string | null
  ): DeploymentLifecycle {
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
      events
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
