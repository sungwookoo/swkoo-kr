import { Injectable, Logger } from '@nestjs/common';

import { GithubAppService } from '../github-app/github-app.service';
import {
  ProvenanceConfidence,
  ProvenanceMethod,
  ProvenanceRepository,
  ProvenanceRow,
} from './provenance.repository';
import { GitHubClient } from './services/github.client';

const SHA_HEX_40 = /^[0-9a-f]{40}$/i;

export interface ProvenanceResult {
  imageOwner: string;
  imageName: string;
  digest: string;
  sourceSha: string | null;
  sourceRunUrl: string | null;
  method: ProvenanceMethod;
  evidence: string;
  confidence: ProvenanceConfidence;
}

export interface DeploymentTimeContext {
  /** When the deployment landed (Argo history.deployedAt). Used by the
   * time-window fallback to pick the temporally-nearest workflow run. */
  deployedAt: string | null;
}

@Injectable()
export class ProvenanceService {
  private readonly logger = new Logger(ProvenanceService.name);

  constructor(
    private readonly repo: ProvenanceRepository,
    private readonly githubApp: GithubAppService,
    private readonly githubClient: GitHubClient
  ) {}

  /** Public surface used by PipelinesService. Returns cached row when fresh,
   * resolves on cache miss or staleness. Never throws — failures yield
   * `unknown` so the deployments endpoint stays available even if GitHub is
   * down. */
  async resolve(args: {
    imageOwner: string;
    imageName: string;
    digest: string;
    timeContext?: DeploymentTimeContext;
  }): Promise<ProvenanceResult> {
    const { imageOwner, imageName, digest } = args;
    const cached = this.repo.find(imageOwner, imageName, digest);
    if (cached && !this.repo.isStale(cached)) {
      return this.toResult(cached);
    }
    try {
      return await this.resolveFresh(args);
    } catch (err) {
      this.logger.warn(
        `provenance.resolve failed for ${imageOwner}/${imageName}@${digest.slice(0, 16)}: ${(err as Error).message}`
      );
      // Persist an unknown row so we don't hammer GitHub on every render.
      return this.persistAndReturn({
        imageOwner,
        imageName,
        digest,
        sourceSha: null,
        sourceRunUrl: null,
        method: 'none',
        evidence: `error:${(err as Error).message.slice(0, 80)}`,
        confidence: 'unknown',
      });
    }
  }

  private async resolveFresh(args: {
    imageOwner: string;
    imageName: string;
    digest: string;
    timeContext?: DeploymentTimeContext;
  }): Promise<ProvenanceResult> {
    const { imageOwner, imageName, digest, timeContext } = args;

    let token: string;
    try {
      // The App needs to be installed on the *image* repo (where the build
      // workflow runs) to query its packages and workflow runs. For most
      // user apps imageRepo == sourceRepo; the rare case where they diverge
      // (stale yaml, image renamed) just means we look up the right place.
      token = await this.githubApp.getInstallationTokenForRepo(imageOwner, imageName);
    } catch (err) {
      this.logger.warn(
        `no App installation for ${imageOwner}/${imageName}: ${(err as Error).message}`
      );
      return this.timeWindowFallback({ imageOwner, imageName, digest, timeContext });
    }

    const versions = await this.githubApp.listUserPackageVersions({
      owner: imageOwner,
      packageName: imageName,
      token,
      perPage: 50,
    });

    if (versions === null) {
      // 404/403 — package not visible to the App (likely org-owned). Fall
      // back to time heuristic.
      return this.timeWindowFallback({ imageOwner, imageName, digest, timeContext });
    }

    const matched = versions.find((v) => v.name === digest);
    if (!matched) {
      // Image GC'd or never reached GHCR. Heuristic is best we can do.
      return this.timeWindowFallback({ imageOwner, imageName, digest, timeContext });
    }

    // First 40-char hex tag is the github.sha pushed by the build workflow
    // (renderBuildWorkflow always tags both :<github.sha> and :latest).
    const shaTag = matched.metadata.container.tags.find((t) => SHA_HEX_40.test(t));
    if (!shaTag) {
      // No SHA tag — manual push or workflow change. Heuristic fallback.
      return this.timeWindowFallback({ imageOwner, imageName, digest, timeContext });
    }

    // Run URL is informational only — failure to fetch shouldn't degrade
    // confidence below verified, since digest↔SHA mapping is already proven
    // by GHCR. SHA belongs to the *image* repo (the one whose workflow
    // tagged it with github.sha).
    const run = await this.githubClient
      .fetchWorkflowRunForSha({ owner: imageOwner, repo: imageName, sha: shaTag })
      .catch(() => null);

    return this.persistAndReturn({
      imageOwner,
      imageName,
      digest,
      sourceSha: shaTag,
      sourceRunUrl: run?.htmlUrl ?? null,
      method: 'gh_package_tag_digest',
      evidence: 'gh_package_tag_digest',
      confidence: 'verified',
    });
  }

  private async timeWindowFallback(args: {
    imageOwner: string;
    imageName: string;
    digest: string;
    timeContext?: DeploymentTimeContext;
  }): Promise<ProvenanceResult> {
    const { imageOwner, imageName, digest, timeContext } = args;
    if (!timeContext?.deployedAt || !this.githubClient.isConfigured()) {
      return this.persistAndReturn({
        imageOwner,
        imageName,
        digest,
        sourceSha: null,
        sourceRunUrl: null,
        method: 'none',
        evidence: 'none',
        confidence: 'unknown',
      });
    }

    const deployedAt = new Date(timeContext.deployedAt).getTime();
    const candidate = await this.findClosestSuccessRun({
      owner: imageOwner,
      repo: imageName,
      deployedAt,
    });

    if (!candidate) {
      return this.persistAndReturn({
        imageOwner,
        imageName,
        digest,
        sourceSha: null,
        sourceRunUrl: null,
        method: 'none',
        evidence: 'none',
        confidence: 'unknown',
      });
    }

    return this.persistAndReturn({
      imageOwner,
      imageName,
      digest,
      sourceSha: candidate.headSha,
      sourceRunUrl: candidate.htmlUrl,
      method: 'time_window',
      evidence: 'time_window_estimate',
      confidence: 'estimated',
    });
  }

  private async findClosestSuccessRun(args: {
    owner: string;
    repo: string;
    deployedAt: number;
  }): Promise<{ headSha: string; htmlUrl: string } | null> {
    const { owner, repo, deployedAt } = args;
    const window = await this.githubClient.fetchSuccessfulRunsWithin({
      owner,
      repo,
      perPage: 10,
    });
    if (!window || window.length === 0) return null;

    // Take the run with min |run.updatedAt - deployedAt|, preferring runs
    // that finished *before* the deploy (build → image push → updater → sync
    // is causal so build can't be after deploy).
    let best: { headSha: string; htmlUrl: string; delta: number } | null = null;
    for (const r of window) {
      const t = new Date(r.updatedAt).getTime();
      const delta = deployedAt - t; // positive if build before deploy
      if (delta < 0) continue;
      if (!best || delta < best.delta) {
        best = { headSha: r.headSha, htmlUrl: r.htmlUrl, delta };
      }
    }
    if (best) return { headSha: best.headSha, htmlUrl: best.htmlUrl };
    // No run before deploy — degenerate; return null.
    return null;
  }

  private persistAndReturn(row: {
    imageOwner: string;
    imageName: string;
    digest: string;
    sourceSha: string | null;
    sourceRunUrl: string | null;
    method: ProvenanceMethod;
    evidence: string;
    confidence: ProvenanceConfidence;
  }): ProvenanceResult {
    const stored = this.repo.upsert(row);
    return this.toResult(stored);
  }

  private toResult(row: ProvenanceRow): ProvenanceResult {
    return {
      imageOwner: row.imageOwner,
      imageName: row.imageName,
      digest: row.digest,
      sourceSha: row.sourceSha,
      sourceRunUrl: row.sourceRunUrl,
      method: row.method,
      evidence: row.evidence,
      confidence: row.confidence,
    };
  }
}
