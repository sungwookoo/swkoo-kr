import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, BadGatewayException } from '@nestjs/common';
import { Inject } from '@nestjs/common/decorators';
import { ConfigType } from '@nestjs/config';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';

import { githubConfig } from '../../config/github.config';
import type {
  CommitInfo,
  GitHubCommitResponse,
  GitHubWorkflowRunsResponse,
  GitHubWorkflowsResponse,
  WorkflowRun,
  WorkflowsEnvelope
} from '../types/github.types';

interface FetchWorkflowsOptions {
  owner: string;
  repo: string;
  workflow?: string;
  page?: number;
  perPage?: number;
}

interface FetchCommitOptions {
  owner: string;
  repo: string;
  sha: string;
}

@Injectable()
export class GitHubClient {
  private readonly logger = new Logger(GitHubClient.name);
  private readonly baseUrl = 'https://api.github.com';

  constructor(
    private readonly httpService: HttpService,
    @Inject(githubConfig.KEY)
    private readonly config: ConfigType<typeof githubConfig>
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.token);
  }

  async fetchWorkflows(options: FetchWorkflowsOptions): Promise<WorkflowsEnvelope> {
    const { owner, repo, workflow, page = 1, perPage = 10 } = options;

    if (!this.isConfigured()) {
      return {
        configured: false,
        repoUrl: null,
        workflows: [],
        runs: [],
        pagination: { page, perPage, total: 0 }
      };
    }

    const repoUrl = `https://github.com/${owner}/${repo}`;

    try {
      // Fetch available workflows
      const workflowsResponse = await this.fetchWorkflowList(owner, repo);
      const workflowNames = workflowsResponse.workflows.map((w) => w.name);

      // Fetch workflow runs
      const runsResponse = await this.fetchWorkflowRuns(owner, repo, workflow, page, perPage);

      const runs = runsResponse.workflow_runs.map((run) => this.toWorkflowRun(run));

      return {
        configured: true,
        repoUrl,
        workflows: workflowNames,
        runs,
        pagination: {
          page,
          perPage,
          total: runsResponse.total_count
        }
      };
    } catch (error: unknown) {
      this.handleError(error, 'fetching workflows');
    }
  }

  async fetchWorkflowRunForSha(
    options: { owner: string; repo: string; sha: string }
  ): Promise<WorkflowRun | null> {
    const { owner, repo, sha } = options;
    if (!this.isConfigured() || !sha) return null;

    const url = `${this.baseUrl}/repos/${owner}/${repo}/actions/runs`;
    try {
      const response = await firstValueFrom(
        this.httpService.get<GitHubWorkflowRunsResponse>(url, {
          headers: this.buildHeaders(),
          params: { head_sha: sha, per_page: 1 }
        })
      );
      const run = response.data?.workflow_runs?.[0];
      return run ? this.toWorkflowRun(run) : null;
    } catch (error: unknown) {
      this.logger.warn(`Failed to fetch workflow run for ${sha}: ${(error as Error).message}`);
      return null;
    }
  }

  /** Recent successful workflow runs for the repo. Used by provenance
   * time-window fallback when GHCR digest matching isn't possible.
   * Returns null when GitHub isn't configured at all. */
  async fetchSuccessfulRunsWithin(options: {
    owner: string;
    repo: string;
    perPage?: number;
  }): Promise<WorkflowRun[] | null> {
    const { owner, repo, perPage = 10 } = options;
    if (!this.isConfigured()) return null;
    const url = `${this.baseUrl}/repos/${owner}/${repo}/actions/runs`;
    try {
      const response = await firstValueFrom(
        this.httpService.get<GitHubWorkflowRunsResponse>(url, {
          headers: this.buildHeaders(),
          params: { status: 'success', per_page: perPage },
        })
      );
      return (response.data?.workflow_runs ?? []).map((r) => this.toWorkflowRun(r));
    } catch (error: unknown) {
      this.logger.warn(
        `Failed to fetch successful runs for ${owner}/${repo}: ${(error as Error).message}`
      );
      return null;
    }
  }

  async fetchCommit(options: FetchCommitOptions): Promise<CommitInfo | null> {
    const { owner, repo, sha } = options;
    if (!this.isConfigured() || !sha) return null;

    const url = `${this.baseUrl}/repos/${owner}/${repo}/commits/${sha}`;
    try {
      const response = await firstValueFrom(
        this.httpService.get<GitHubCommitResponse>(url, { headers: this.buildHeaders() })
      );
      const data = response.data;
      const authorMeta = data.commit.author ?? data.commit.committer;
      return {
        sha: data.sha,
        message: data.commit.message.split('\n')[0] ?? '',
        authorName: authorMeta?.name ?? data.author?.login ?? 'unknown',
        authorLogin: data.author?.login ?? null,
        authorAvatarUrl: data.author?.avatar_url ?? null,
        authoredAt: authorMeta?.date ?? '',
        htmlUrl: data.html_url
      };
    } catch (error: unknown) {
      if (isAxiosError(error) && error.response?.status === 404) {
        // Force-pushes / branch deletes can leave Argo CD history pointing at
        // a SHA that no longer exists on the repo. Return null instead of
        // failing the whole deployments query.
        return null;
      }
      this.logger.warn(`Failed to fetch commit ${sha}: ${(error as Error).message}`);
      return null;
    }
  }

  private async fetchWorkflowList(owner: string, repo: string): Promise<GitHubWorkflowsResponse> {
    const url = `${this.baseUrl}/repos/${owner}/${repo}/actions/workflows`;

    const response = await firstValueFrom(
      this.httpService.get<GitHubWorkflowsResponse>(url, {
        headers: this.buildHeaders()
      })
    );

    return response.data;
  }

  private async fetchWorkflowRuns(
    owner: string,
    repo: string,
    workflow?: string,
    page = 1,
    perPage = 10
  ): Promise<GitHubWorkflowRunsResponse> {
    let url = `${this.baseUrl}/repos/${owner}/${repo}/actions/runs`;

    const params: Record<string, string | number> = {
      page,
      per_page: perPage
    };

    // If workflow filter is specified, we need to get the workflow ID first
    if (workflow) {
      const workflows = await this.fetchWorkflowList(owner, repo);
      const matchedWorkflow = workflows.workflows.find(
        (w) => w.name.toLowerCase() === workflow.toLowerCase()
      );

      if (matchedWorkflow) {
        url = `${this.baseUrl}/repos/${owner}/${repo}/actions/workflows/${matchedWorkflow.id}/runs`;
      }
    }

    const response = await firstValueFrom(
      this.httpService.get<GitHubWorkflowRunsResponse>(url, {
        headers: this.buildHeaders(),
        params
      })
    );

    return response.data;
  }

  private toWorkflowRun(run: GitHubWorkflowRunsResponse['workflow_runs'][number]): WorkflowRun {
    let runDurationSeconds: number | null = null;

    if (run.run_started_at && run.status === 'completed') {
      const startTime = new Date(run.run_started_at).getTime();
      const endTime = new Date(run.updated_at).getTime();
      runDurationSeconds = Math.round((endTime - startTime) / 1000);
    }

    // Map GitHub conclusion to our simplified conclusion type
    let conclusion: WorkflowRun['conclusion'] = null;
    if (run.conclusion) {
      if (run.conclusion === 'success') {
        conclusion = 'success';
      } else if (run.conclusion === 'cancelled') {
        conclusion = 'cancelled';
      } else if (run.conclusion === 'skipped') {
        conclusion = 'skipped';
      } else {
        // neutral, timed_out, action_required, failure all map to failure
        conclusion = 'failure';
      }
    }

    return {
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion,
      headSha: run.head_sha,
      headBranch: run.head_branch,
      event: run.event,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      runDurationSeconds,
      htmlUrl: run.html_url
    };
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };

    if (this.config.token) {
      headers.Authorization = `Bearer ${this.config.token}`;
    }

    return headers;
  }

  private handleError(error: unknown, context: string): never {
    if (isAxiosError(error)) {
      const status = error.response?.status ?? 502;
      const message = error.response?.data?.message || error.message;
      this.logger.error(`GitHub API request failed while ${context}: ${message}`, error.stack);
      throw new BadGatewayException(`GitHub API request failed (${status})`);
    }

    this.logger.error(`Unexpected error while ${context}`, (error as Error)?.stack);
    throw new BadGatewayException('Unexpected error while communicating with GitHub API');
  }
}

