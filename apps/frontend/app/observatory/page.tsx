import type { Metadata } from 'next';
import clsx from 'clsx';

import {
  fetchAlerts,
  fetchDeployments,
  fetchEventSummary,
  fetchPipelines,
  fetchWorkflows,
} from '@/lib/api';
import { AlertList } from '@/components/AlertList';
import { PipelineSection } from '@/components/PipelineSection';
import { ScopeToggle } from '@/components/ScopeToggle';
import { emptyStates, hero, legend, statsLabels } from '@/content/observatory';

export const metadata: Metadata = {
  title: 'Observatory — swkoo.kr',
  description: 'GitOps 파이프라인과 런타임 상태를 한 화면에서 보는 운영 콘솔.',
};

// Observatory is data-only after the About split: pipeline cards,
// timeline, workflow runs, alerts, legend. Problem definition,
// design principles, architecture diagram, CI/CD scenarios,
// observability rationale, and trade-offs all moved to /about.

function formatTimestamp(timestamp: string | null | undefined) {
  if (!timestamp) {
    return null;
  }

  try {
    return new Intl.DateTimeFormat('ko-KR', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(timestamp));
  } catch (error) {
    console.warn('Failed to format timestamp', error);
    return timestamp;
  }
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <span className={clsx('inline-flex size-2 rounded-full', color)}></span>
      <span>{label}</span>
    </li>
  );
}

export default async function ObservatoryPage({
  searchParams,
}: {
  searchParams?: { scope?: string };
}) {
  const scope = searchParams?.scope === 'mine' ? 'mine' : undefined;
  const [pipelinesEnvelope, alertsEnvelope] = await Promise.all([
    fetchPipelines(scope),
    fetchAlerts(scope),
  ]);
  const pipelinesConfigured = pipelinesEnvelope.configured;
  const pipelines = pipelinesEnvelope.pipelines;
  const pipelinesFetchedAt = formatTimestamp(pipelinesEnvelope.fetchedAt);

  // Fetch workflows for each pipeline
  const workflowsMap = new Map<
    string,
    Awaited<ReturnType<typeof fetchWorkflows>>
  >();
  if (pipelinesConfigured && pipelines.length > 0) {
    const workflowsResults = await Promise.all(
      pipelines.map((p) => fetchWorkflows(p.name, { perPage: 5 }))
    );
    pipelines.forEach((p, i) => {
      workflowsMap.set(p.name, workflowsResults[i]);
    });
  }

  // Group alerts by associated pipeline for card-level overlay
  const alertsByPipeline = new Map<string, typeof alertsEnvelope.alerts>();
  for (const alert of alertsEnvelope.alerts) {
    if (alert.associatedPipeline) {
      const bucket = alertsByPipeline.get(alert.associatedPipeline) ?? [];
      bucket.push(alert);
      alertsByPipeline.set(alert.associatedPipeline, bucket);
    }
  }

  // Fetch recent deployment lifecycles for each pipeline (S1: simple list).
  const deploymentsByPipeline = new Map<
    string,
    Awaited<ReturnType<typeof fetchDeployments>>
  >();
  if (pipelinesConfigured && pipelines.length > 0) {
    const results = await Promise.all(pipelines.map((p) => fetchDeployments(p.name, 5)));
    pipelines.forEach((p, i) => {
      deploymentsByPipeline.set(p.name, results[i]);
    });
  }

  // Phase 3 S4-A: 7-day event-store summary per pipeline (count, last event).
  const eventSummaryByPipeline = new Map<
    string,
    Awaited<ReturnType<typeof fetchEventSummary>>
  >();
  if (pipelinesConfigured && pipelines.length > 0) {
    const results = await Promise.all(pipelines.map((p) => fetchEventSummary(p.name, 7)));
    pipelines.forEach((p, i) => {
      eventSummaryByPipeline.set(p.name, results[i]);
    });
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-12">
      {/* Hero */}
      <section className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-4xl">{hero.emoji}</span>
            <div>
              <h1 className="text-3xl font-bold text-slate-50">{hero.title}</h1>
              <p className="text-slate-400">{hero.subtitle}</p>
            </div>
          </div>
          <ScopeToggle currentScope={scope ?? null} />
        </div>
      </section>

      {/* Stats Bar */}
      {pipelinesConfigured && pipelines.length > 0 && (
        <section className="flex flex-wrap gap-4">
          <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3">
            <p className="text-2xl font-bold text-slate-100">{pipelines.length}</p>
            <p className="text-xs text-slate-500">{statsLabels.totalPipelines}</p>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3">
            <p className="text-2xl font-bold text-emerald-400">
              {pipelines.filter((p) => p.healthStatus === 'Healthy').length}
            </p>
            <p className="text-xs text-slate-500">{statsLabels.healthy}</p>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3">
            <p className="text-2xl font-bold text-emerald-400">
              {pipelines.filter((p) => p.syncStatus === 'Synced').length}
            </p>
            <p className="text-xs text-slate-500">{statsLabels.synced}</p>
          </div>
          {pipelinesFetchedAt && (
            <div className="flex items-center rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3">
              <p className="text-xs text-slate-500">
                {statsLabels.lastUpdatedPrefix} {pipelinesFetchedAt}
              </p>
            </div>
          )}
        </section>
      )}

      {/* Active Alerts Overlay */}
      <AlertList
        configured={alertsEnvelope.configured}
        alerts={alertsEnvelope.alerts}
      />

      {/* Pipelines — accordion list (one row per pipeline; auto-open on issues) */}
      <section className="space-y-3">
        {!pipelinesConfigured ? (
          <div className="rounded-xl border border-dashed border-slate-800 p-8 text-center">
            <p className="text-lg text-slate-400">
              {emptyStates.unconfiguredTitle}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              {emptyStates.unconfiguredHintPrefix}{' '}
              <code className="rounded bg-slate-800 px-1 py-0.5 text-xs text-slate-200">
                {emptyStates.unconfiguredHintEnvVars[0]}
              </code>{' '}
              과{' '}
              <code className="rounded bg-slate-800 px-1 py-0.5 text-xs text-slate-200">
                {emptyStates.unconfiguredHintEnvVars[1]}
              </code>
              {emptyStates.unconfiguredHintSuffix}
            </p>
          </div>
        ) : pipelines.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-800 p-8 text-center">
            <p className="text-lg text-slate-400">
              {emptyStates.noPipelinesTitle}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              {emptyStates.noPipelinesHint}
            </p>
          </div>
        ) : (
          pipelines.map((pipeline) => (
            <PipelineSection
              key={pipeline.name}
              pipeline={pipeline}
              workflowsEnvelope={
                workflowsMap.get(pipeline.name) ?? {
                  configured: false,
                  repoUrl: null,
                  workflows: [],
                  runs: [],
                  pagination: { page: 1, perPage: 10, total: 0 },
                }
              }
              deploymentsEnvelope={deploymentsByPipeline.get(pipeline.name)}
              eventSummary={eventSummaryByPipeline.get(pipeline.name) ?? null}
              relatedAlerts={alertsByPipeline.get(pipeline.name) ?? []}
            />
          ))
        )}
      </section>

      {/* Legend — compact footer reference for the status colours
          rendered above. Architecture / CI-CD / observability / trade-off
          prose moved to /about so this page stays purely operational. */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 text-sm text-slate-400">
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-500">
          {legend.title}
        </p>
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          {legend.sections.map((section) => (
            <div key={section.title} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-xs uppercase tracking-wider text-slate-500">
                {section.title}
              </span>
              <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-300">
                {section.items.map((item) => (
                  <LegendItem
                    key={`${section.title}-${item.label}`}
                    color={item.color}
                    label={item.label}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-slate-500">
          설계 노트 · 트레이드오프 · 아키텍처 다이어그램 →{' '}
          <a
            href="/about"
            className="text-slate-300 underline-offset-2 hover:text-slate-100 hover:underline"
          >
            About
          </a>
        </p>
      </section>
    </main>
  );
}
