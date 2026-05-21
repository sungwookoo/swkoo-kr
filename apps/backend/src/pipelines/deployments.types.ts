export type DeploymentStage = 'commit' | 'build' | 'sync';
export type DeploymentStageStatus = 'success' | 'failure' | 'in_progress';

export interface DeploymentEvent {
  stage: DeploymentStage;
  status: DeploymentStageStatus;
  timestamp: string;
  durationSeconds: number | null;
  label: string;
  href: string | null;
}

export type RevisionConfidence = 'verified' | 'estimated' | 'unknown';

export interface DeploymentLifecycle {
  pipeline: string;
  commitSha: string;
  commitShort: string;
  commitMessage: string;
  commitAuthor: string;
  commitAuthorAvatar: string | null;
  commitHref: string | null;
  startedAt: string;
  endedAt: string | null;
  events: DeploymentEvent[];
  /** verified: deployed digest matched a source SHA tag in GHCR;
   *  estimated: time-window heuristic; unknown: no match. */
  revisionConfidence: RevisionConfidence;
  /** Source repo SHA the deployed image was built from (when resolvable). */
  sourceSha: string | null;
  /** GitHub Actions run that built the deployed image (when resolvable). */
  sourceRunUrl: string | null;
}

export interface DeploymentsEnvelope {
  configured: boolean;
  fetchedAt: string | null;
  pipeline: string;
  deployments: DeploymentLifecycle[];
}
