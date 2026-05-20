import { cookies } from 'next/headers';

import type {
  AlertsEnvelope,
  DeploymentsEnvelope,
  EventSummary,
  PipelinesEnvelope,
  PortfolioOverview,
  WorkflowsEnvelope
} from './types';
import { API_BASE_URL } from './api-base';

export { API_BASE_URL };

// Observatory/pipeline/alert endpoints now apply per-viewer filtering, so we
// need to forward the session cookie from the incoming request and skip the
// Next.js fetch cache (which keys by URL only and would leak responses
// across viewers). `cookies()` became async in Next 15+, so this helper has
// to be awaited at the call site.
async function serverFetchInit(): Promise<RequestInit> {
  const cookieHeader = (await cookies()).toString();
  return {
    cache: 'no-store',
    headers: cookieHeader ? { Cookie: cookieHeader } : undefined,
  };
}

function withScope(url: string, scope: string | undefined): string {
  if (!scope) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}scope=${encodeURIComponent(scope)}`;
}

export async function fetchOverview(): Promise<PortfolioOverview | null> {
  if (!API_BASE_URL) {
    return null;
  }

  try {
    const response = await fetch(`${API_BASE_URL}/overview`, {
      next: { revalidate: 60 }
    });

    if (!response.ok) {
      console.warn('Failed to load overview', response.statusText);
      return null;
    }

    return (await response.json()) as PortfolioOverview;
  } catch (error) {
    console.warn('Overview request failed', error);
    return null;
  }
}

export async function fetchPipelines(scope?: string): Promise<PipelinesEnvelope> {
  if (!API_BASE_URL) {
    return {
      configured: false,
      fetchedAt: null,
      pipelines: []
    };
  }

  try {
    const response = await fetch(
      withScope(`${API_BASE_URL}/pipelines`, scope),
      await serverFetchInit()
    );

    if (!response.ok) {
      console.warn('Failed to load pipelines', response.statusText);
      return {
        configured: false,
        fetchedAt: null,
        pipelines: []
      };
    }

    const payload = (await response.json()) as PipelinesEnvelope;

    return {
      configured: Boolean(payload.configured),
      fetchedAt: payload.fetchedAt ?? null,
      pipelines: Array.isArray(payload.pipelines) ? payload.pipelines : []
    };
  } catch (error) {
    console.warn('Pipelines request failed', error);
    return {
      configured: false,
      fetchedAt: null,
      pipelines: []
    };
  }
}

export async function fetchAlerts(scope?: string): Promise<AlertsEnvelope> {
  if (!API_BASE_URL) {
    return {
      configured: false,
      fetchedAt: null,
      alerts: []
    };
  }

  try {
    const response = await fetch(
      withScope(`${API_BASE_URL}/alerts`, scope),
      await serverFetchInit()
    );

    if (!response.ok) {
      console.warn('Failed to load alerts', response.statusText);
      return {
        configured: false,
        fetchedAt: null,
        alerts: []
      };
    }

    const payload = (await response.json()) as AlertsEnvelope;

    return {
      configured: Boolean(payload.configured),
      fetchedAt: payload.fetchedAt ?? null,
      alerts: Array.isArray(payload.alerts) ? payload.alerts : []
    };
  } catch (error) {
    console.warn('Alerts request failed', error);
    return {
      configured: false,
      fetchedAt: null,
      alerts: []
    };
  }
}

export async function fetchDeployments(
  pipelineName: string,
  limit = 5
): Promise<DeploymentsEnvelope> {
  const empty: DeploymentsEnvelope = {
    configured: false,
    fetchedAt: null,
    pipeline: pipelineName,
    deployments: []
  };

  if (!API_BASE_URL) return empty;

  try {
    const url = `${API_BASE_URL}/pipelines/${encodeURIComponent(pipelineName)}/deployments?limit=${limit}`;
    const response = await fetch(url, await serverFetchInit());

    if (!response.ok) {
      console.warn('Failed to load deployments', response.statusText);
      return empty;
    }

    const payload = (await response.json()) as DeploymentsEnvelope;
    return {
      configured: Boolean(payload.configured),
      fetchedAt: payload.fetchedAt ?? null,
      pipeline: payload.pipeline ?? pipelineName,
      deployments: Array.isArray(payload.deployments) ? payload.deployments : []
    };
  } catch (error) {
    console.warn('Deployments request failed', error);
    return empty;
  }
}

export async function fetchEventSummary(
  pipelineName: string,
  windowDays = 7
): Promise<EventSummary | null> {
  if (!API_BASE_URL) return null;
  try {
    const url = `${API_BASE_URL}/pipelines/${encodeURIComponent(pipelineName)}/event-summary?windowDays=${windowDays}`;
    const response = await fetch(url, await serverFetchInit());
    if (!response.ok) {
      console.warn('Failed to load event summary', response.statusText);
      return null;
    }
    return (await response.json()) as EventSummary;
  } catch (error) {
    console.warn('Event summary request failed', error);
    return null;
  }
}

export interface FetchWorkflowsOptions {
  workflow?: string;
  page?: number;
  perPage?: number;
}

export async function fetchWorkflows(
  pipelineName: string,
  options: FetchWorkflowsOptions = {}
): Promise<WorkflowsEnvelope> {
  if (!API_BASE_URL) {
    return {
      configured: false,
      repoUrl: null,
      workflows: [],
      runs: [],
      pagination: { page: 1, perPage: 10, total: 0 }
    };
  }

  try {
    const params = new URLSearchParams();
    if (options.workflow) params.set('workflow', options.workflow);
    if (options.page) params.set('page', String(options.page));
    if (options.perPage) params.set('per_page', String(options.perPage));

    const queryString = params.toString();
    const url = `${API_BASE_URL}/pipelines/${encodeURIComponent(pipelineName)}/workflows${queryString ? `?${queryString}` : ''}`;

    const response = await fetch(url, await serverFetchInit());

    if (!response.ok) {
      console.warn('Failed to load workflows', response.statusText);
      return {
        configured: false,
        repoUrl: null,
        workflows: [],
        runs: [],
        pagination: { page: 1, perPage: 10, total: 0 }
      };
    }

    return (await response.json()) as WorkflowsEnvelope;
  } catch (error) {
    console.warn('Workflows request failed', error);
    return {
      configured: false,
      repoUrl: null,
      workflows: [],
      runs: [],
      pagination: { page: 1, perPage: 10, total: 0 }
    };
  }
}
