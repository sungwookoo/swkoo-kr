import clsx from 'clsx';

import type {
  Alert,
  DeploymentLifecycle,
  DeploymentEvent,
  RevisionConfidence,
} from '@/lib/types';
import { deployments as content } from '@/content/observatory';

interface DeploymentListProps {
  configured: boolean;
  pipeline: string;
  namespace: string | null;
  deployments: DeploymentLifecycle[];
  alerts: Alert[];
}

function buildGrafanaLink(d: DeploymentLifecycle, namespace: string): string {
  const { dashboardUrl, preWindowMs, postWindowMs } = content.grafanaLink;
  const startMs = new Date(d.startedAt).getTime() - preWindowMs;
  const endMs =
    (d.endedAt ? new Date(d.endedAt).getTime() : Date.now()) + postWindowMs;
  const params = new URLSearchParams({
    from: String(startMs),
    to: String(endMs),
    'var-namespace': namespace,
  });
  return `${dashboardUrl}?${params.toString()}`;
}

function alertsInWindow(d: DeploymentLifecycle, alerts: Alert[]): Alert[] {
  const start = new Date(d.startedAt).getTime();
  const end = (d.endedAt ? new Date(d.endedAt).getTime() : Date.now()) + 5 * 60 * 1000;
  if (Number.isNaN(start)) return [];
  return alerts.filter((a) => {
    if (!a.startsAt) return false;
    const t = new Date(a.startsAt).getTime();
    return t >= start && t <= end;
  });
}

function confidenceBadge(confidence: RevisionConfidence): {
  label: string;
  className: string;
  title: string;
} | null {
  // Default 'verified' is the boring case — don't draw attention to it.
  // Only show badge when something is uncertain, so reviewers know to
  // double-check before drawing conclusions from the source SHA.
  if (confidence === 'verified') return null;
  if (confidence === 'estimated') {
    return {
      label: '~ 추정',
      className: 'border-amber-700/60 bg-amber-900/30 text-amber-200',
      title:
        '시간 기반 매칭. 배포 시점과 가장 가까운 성공 빌드를 추정함. GHCR digest 매칭이 안 됐을 때의 fallback.',
    };
  }
  return {
    label: '? 미확인',
    className: 'border-slate-700 bg-slate-800/50 text-slate-400',
    title: 'source commit을 확인하지 못했습니다.',
  };
}

function eventColor(e: DeploymentEvent): string {
  if (e.status === 'failure') return 'bg-rose-400';
  if (e.status === 'in_progress') return 'bg-amber-400 animate-pulse';
  return 'bg-emerald-400';
}

function alertColor(severity: Alert['severity']): string {
  switch (severity) {
    case 'critical':
      return 'bg-rose-500 ring-rose-500/40';
    case 'warning':
      return 'bg-amber-400 ring-amber-400/40';
    case 'info':
      return 'bg-sky-400 ring-sky-400/40';
    default:
      return 'bg-slate-400 ring-slate-400/40';
  }
}

function formatRelative(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const delta = Math.floor((Date.now() - t) / 1000);
  if (delta < 60) return `${delta}초 전`;
  if (delta < 3600) return `${Math.floor(delta / 60)}분 전`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}시간 전`;
  return `${Math.floor(delta / 86400)}일 전`;
}

function formatDuration(startIso: string, endIso: string | null): string | null {
  if (!endIso) return null;
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}초`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
  return `${Math.floor(seconds / 3600)}시간 ${Math.floor((seconds % 3600) / 60)}분`;
}

export function DeploymentList({ configured, pipeline, namespace, deployments, alerts }: DeploymentListProps) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-100">
            📦 {content.title}
            {configured && deployments.length > 0 && (
              <span className="ml-2 rounded-full bg-slate-700/60 px-2 py-0.5 text-sm text-slate-300">
                {deployments.length}
              </span>
            )}
          </h2>
          <p className="text-sm text-slate-400">{content.subtitle}</p>
        </div>
        <span className="text-xs text-slate-500 font-mono">{pipeline}</span>
      </div>

      {!configured ? (
        <div className="rounded-xl border border-dashed border-slate-800 p-6 text-center">
          <p className="text-slate-400">{content.unconfigured}</p>
          <p className="mt-2 text-sm text-slate-500">{content.unconfiguredHint}</p>
        </div>
      ) : deployments.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 p-6 text-center">
          <p className="text-slate-400">{content.empty}</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {deployments.map((d) => {
            const duration = formatDuration(d.startedAt, d.endedAt);
            const relative = formatRelative(d.endedAt ?? d.startedAt);
            const inWindow = alertsInWindow(d, alerts);
            const startMs = new Date(d.startedAt).getTime();
            const endMs = d.endedAt ? new Date(d.endedAt).getTime() : Date.now();
            const totalMs = Math.max(endMs - startMs, 1);
            const ratio = (iso: string) =>
              Math.max(
                0,
                Math.min(100, ((new Date(iso).getTime() - startMs) / totalMs) * 100)
              );
            const hasAnyFailure = d.events.some((e) => e.status === 'failure');
            return (
              <li
                key={`${d.commitSha}-${d.startedAt}`}
                className={clsx(
                  'rounded-xl border-l-2 bg-slate-950 p-4',
                  hasAnyFailure ? 'border-rose-500/60' : 'border-emerald-500/60'
                )}
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  {d.commitAuthorAvatar && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={d.commitAuthorAvatar}
                      alt=""
                      className="size-5 rounded-full"
                    />
                  )}
                  {d.commitHref ? (
                    <a
                      href={d.commitHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-xs text-sky-300 hover:text-sky-200"
                    >
                      {d.commitShort}
                    </a>
                  ) : (
                    <span className="font-mono text-xs text-slate-400">{d.commitShort}</span>
                  )}
                  {(() => {
                    const badge = confidenceBadge(d.revisionConfidence);
                    if (!badge) return null;
                    return (
                      <span
                        className={clsx(
                          'rounded border px-1.5 py-0.5 text-[10px] font-mono',
                          badge.className
                        )}
                        title={badge.title}
                      >
                        {badge.label}
                      </span>
                    );
                  })()}
                  <span className="text-sm text-slate-100 truncate" title={d.commitMessage}>
                    {d.commitMessage}
                  </span>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                  <span>@{d.commitAuthor}</span>
                  {relative && <span>· {relative}</span>}
                  {duration && (
                    <span>· {content.buildDuration} <span className="text-slate-300">{duration}</span></span>
                  )}
                  {namespace && (
                    <a
                      href={buildGrafanaLink(d, namespace)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-auto text-sky-300 hover:text-sky-200"
                      title={`${content.grafanaLink.label} — ${namespace} namespace, 배포 시간대`}
                    >
                      📊 {content.grafanaLink.label} ↗
                    </a>
                  )}
                </div>

                {d.events.length > 0 && (
                  <>
                    {/* Horizontal timeline bar */}
                    <div className="relative mt-4 h-8">
                      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-slate-800" />
                      {d.events.map((e, i) => {
                        const left = ratio(e.timestamp);
                        const stageLabel = content.stageLabel[e.stage] ?? e.label;
                        const dot = (
                          <>
                            <span
                              className={clsx(
                                'absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-slate-950',
                                eventColor(e)
                              )}
                            />
                            <span
                              className={clsx(
                                'absolute top-[calc(50%+0.65rem)] -translate-x-1/2 whitespace-nowrap text-[10px]',
                                e.status === 'failure' ? 'text-rose-300' : 'text-slate-500'
                              )}
                            >
                              {stageLabel}
                            </span>
                          </>
                        );
                        return (
                          <span key={`ev-${i}`} className="absolute inset-y-0" style={{ left: `${left}%` }}>
                            {e.href ? (
                              <a
                                href={e.href}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={`${stageLabel} — ${new Date(e.timestamp).toLocaleString('ko-KR')}`}
                                className="block size-full"
                              >
                                {dot}
                              </a>
                            ) : (
                              dot
                            )}
                          </span>
                        );
                      })}
                      {/* Alert overlay markers */}
                      {inWindow.map((a) => {
                        if (!a.startsAt) return null;
                        const left = ratio(a.startsAt);
                        return (
                          <span
                            key={a.fingerprint}
                            className="absolute top-1/2 -translate-x-1/2 -translate-y-[1.4rem] text-xs"
                            style={{ left: `${left}%` }}
                            title={`${a.alertname} — ${a.summary}`}
                          >
                            <span
                              className={clsx(
                                'inline-flex size-2 rounded-full ring-2',
                                alertColor(a.severity)
                              )}
                            />
                          </span>
                        );
                      })}
                    </div>

                    {/* Per-stage chips with duration */}
                    <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                      {d.events.map((e, i) => {
                        const durationText =
                          e.durationSeconds && e.durationSeconds > 0
                            ? e.durationSeconds < 60
                              ? `${e.durationSeconds}s`
                              : `${Math.floor(e.durationSeconds / 60)}m ${e.durationSeconds % 60}s`
                            : null;
                        if (!durationText) return null;
                        const stageLabel = content.stageLabel[e.stage] ?? e.label;
                        return (
                          <span key={`chip-${i}`}>
                            {stageLabel}: <span className="text-slate-300">{durationText}</span>
                          </span>
                        );
                      })}
                      {inWindow.length > 0 && (
                        <span className="text-amber-400">
                          ⚠ {inWindow.length} alert{inWindow.length > 1 ? 's' : ''} during deploy window
                        </span>
                      )}
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
