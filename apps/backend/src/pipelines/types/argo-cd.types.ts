export interface ArgoCdApplication {
  metadata: {
    name: string;
    namespace?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: {
    project: string;
    destination?: {
      namespace?: string;
      server?: string;
    };
    source?: {
      repoURL?: string;
      targetRevision?: string;
      kustomize?: {
        // image-updater write-back-method=argocd writes the digest here as
        // "<repo>:<tag>@sha256:<digest>". Primary source for deployed digest.
        images?: string[];
      };
    };
  };
  status?: {
    sync?: {
      status?: string;
      revision?: string;
      comparedTo?: {
        destination?: {
          namespace?: string;
        };
      };
    };
    health?: {
      status?: string;
      message?: string;
    };
    reconciledAt?: string;
    operationState?: {
      phase?: string;
      startedAt?: string;
      finishedAt?: string;
      syncResult?: {
        revision?: string;
      };
    };
    // Argo CD-computed summary, populated post-sync. Fallback digest source
    // when kustomize.images is missing.
    summary?: {
      images?: string[];
      externalURLs?: string[];
    };
    history?: Array<{
      revision?: string;
      deployedAt?: string;
      // Argo records per-deployment source snapshot — gives us the digest
      // for *each* historical deployment, not just the latest.
      source?: {
        kustomize?: { images?: string[] };
        repoURL?: string;
      };
    }>;
  };
}

export interface ArgoCdApplicationListResponse {
  items?: ArgoCdApplication[];
}
