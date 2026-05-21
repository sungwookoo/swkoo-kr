export interface PortfolioOverview {
  owner: {
    name: string;
    domain: string;
    mission: string;
  };
  infrastructure: {
    cluster: {
      distribution: string;
      location: string;
      gitOpsTooling: string[];
    };
    controlPlane: string[];
  };
  gitopsVision: {
    description: string;
    roadmap: string[];
  };
}

export interface PipelineSummary {
  name: string;
  project: string;
  namespace: string | null;
  repoUrl: string | null;
  targetRevision: string | null;
  syncStatus: string;
  healthStatus: string;
  lastSyncedAt: string | null;
  lastDeployedAt: string | null;
  revision: string | null;
}

export interface PipelinesEnvelope {
  configured: boolean;
  fetchedAt: string | null;
  pipelines: PipelineSummary[];
}

// GitHub Workflow types
export interface WorkflowRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | null;
  headSha: string;
  headBranch: string;
  event: string;
  createdAt: string;
  updatedAt: string;
  runDurationSeconds: number | null;
  htmlUrl: string;
}

export interface WorkflowsEnvelope {
  configured: boolean;
  repoUrl: string | null;
  workflows: string[];
  runs: WorkflowRun[];
  pagination: {
    page: number;
    perPage: number;
    total: number;
  };
}

// Alertmanager types
export type AlertSeverity = 'critical' | 'warning' | 'info' | 'unknown';

export interface Alert {
  fingerprint: string;
  alertname: string;
  severity: AlertSeverity;
  summary: string;
  description: string | null;
  runbook: string | null;
  namespace: string | null;
  labels: Record<string, string>;
  startsAt: string | null;
  generatorURL: string | null;
  associatedPipeline: string | null;
}

export interface AlertsEnvelope {
  configured: boolean;
  fetchedAt: string | null;
  alerts: Alert[];
}

// Deployment lifecycle (cross-tool timeline)
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
  revisionConfidence: RevisionConfidence;
  sourceSha: string | null;
  sourceRunUrl: string | null;
}

export interface DeploymentsEnvelope {
  configured: boolean;
  fetchedAt: string | null;
  pipeline: string;
  deployments: DeploymentLifecycle[];
}

// Event store summary (from backend SQLite event store)
export interface EventSummary {
  pipelineName: string;
  windowDays: number;
  deployCount: number;
  failureCount: number;
  lastEventAt: string | null;
  lastEventType: string | null;
  mttrSeconds: number | null;
  avgIntervalSeconds: number | null;
}
