'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSWRConfig } from 'swr';

import {
  CURRENT_SWR_KEY,
  deleteCurrentDeployment,
  DeploymentStatus,
  envSwrKey,
  saveEnvVars,
  StageInfo,
  StageStatus,
  useDeploymentStatus,
  useEnvVars,
} from '@/lib/deploy';
import { LatestScan, ScanFinding, useLatestScan } from '@/lib/account';

interface StatusClientProps {
  login: string;
  repo: string;
}

const STAGE_ORDER: Array<{ key: keyof DeploymentStatus['stages']; label: string }> = [
  { key: 'manifests', label: '매니페스트 등록' },
  { key: 'build', label: '이미지 빌드' },
  { key: 'imageDetected', label: '새 이미지 감지' },
  { key: 'deploy', label: '클러스터 배포' },
  { key: 'live', label: '라이브 응답' },
];

export function StatusClient({ login, repo }: StatusClientProps): import("react").ReactNode {
  const { status, isLoading, error } = useDeploymentStatus(login, repo);

  return (
    <main className="relative isolate min-h-[calc(100vh-12rem)] w-full px-6 py-16 sm:py-20">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[42rem] bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,0.08),transparent_60%)]"
      />
      <div className="mx-auto w-full max-w-3xl space-y-8">
        <Header login={login} repo={repo} status={status} />

        {isLoading && !status && <p className="text-slate-500">상태 조회 중…</p>}
        {error && (
          <p className="text-sm text-amber-400">
            상태 조회 실패: {error.message}
          </p>
        )}
        {status && <Checklist status={status} />}

        {status && <EnvVarsPanel login={login} repo={repo} />}

        {status && <ScanPanel />}

        {status && <DeleteCard login={login} repo={repo} />}

        <footer className="border-t border-slate-800 pt-6">
          <Link
            href="/deploy"
            className="text-sm text-slate-500 transition-colors hover:text-slate-300"
          >
            ← 다른 repo 보기
          </Link>
        </footer>
      </div>
    </main>
  );
}

interface EnvRow {
  id: string;
  key: string;
  value: string;
  revealed: boolean;
}

const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

function EnvVarsPanel({ login, repo }: { login: string; repo: string }): import("react").ReactNode {
  const { vars: serverVars, isLoading, error } = useEnvVars(login, repo);
  const { mutate } = useSWRConfig();
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!serverVars) return;
    setRows(
      Object.entries(serverVars).map(([k, v], i) => ({
        id: `s-${i}-${k}`,
        key: k,
        value: v,
        revealed: false,
      }))
    );
  }, [serverVars]);

  const dirty = useMemo(() => {
    const cleaned: Record<string, string> = {};
    for (const r of rows) {
      if (r.key) cleaned[r.key] = r.value;
    }
    const sv = serverVars ?? {};
    const ck = Object.keys(cleaned);
    const sk = Object.keys(sv);
    if (ck.length !== sk.length) return true;
    return ck.some((k) => cleaned[k] !== sv[k]);
  }, [rows, serverVars]);

  const hasInvalidKey = rows.some((r) => r.key && !KEY_PATTERN.test(r.key));

  const handleAdd = (): void => {
    setRows((prev) => [
      ...prev,
      { id: `new-${Date.now()}-${prev.length}`, key: '', value: '', revealed: true },
    ]);
  };

  const handleRemove = (id: string): void => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  };

  const handleField = (id: string, field: 'key' | 'value', v: string): void => {
    setRows((prev) =>
      prev.map((r) =>
        r.id === id ? { ...r, [field]: v, ...(field === 'value' ? { revealed: true } : {}) } : r
      )
    );
  };

  const toggleReveal = (id: string): void => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, revealed: !r.revealed } : r)));
  };

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      const vars: Record<string, string> = {};
      for (const r of rows) {
        if (!r.key) continue;
        vars[r.key] = r.value;
      }
      await saveEnvVars(login, repo, vars);
      await mutate(envSwrKey(login, repo));
      setRows((prev) => prev.map((r) => ({ ...r, revealed: false })));
      setLastSavedAt(Date.now());
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const rbacErr = error?.message.includes('RBAC') || error?.message.includes('403');

  return (
    <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/30 p-4">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-slate-300">환경변수</h3>
        {lastSavedAt && !dirty && !saving && (
          <span className="text-xs text-emerald-400">✓ 적용됨 · ~10초 안에 Pod 재시작</span>
        )}
      </header>
      <p className="text-xs text-slate-500">
        Pod 런타임 env. 키는 대문자/숫자/언더스코어 (<span className="font-mono">^[A-Z_][A-Z0-9_]*$</span>).
        Save 시 매니페스트의 envFrom Secret이 갱신되고 Pod이 자동 재시작됩니다.
      </p>

      {rbacErr && (
        <p className="text-sm text-amber-400">
          이 namespace에 아직 권한이 없습니다 — `/deploy`에서 한 번 재배포하면 RBAC이 생성되어
          이 패널이 활성화됩니다.
        </p>
      )}
      {error && !rbacErr && (
        <p className="text-sm text-amber-400">조회 실패: {error.message}</p>
      )}
      {isLoading && !serverVars && !error && (
        <p className="text-xs text-slate-500">불러오는 중…</p>
      )}

      {!rbacErr && (serverVars !== undefined) && (
        <>
          {rows.length === 0 ? (
            <p className="text-xs text-slate-600">등록된 환경변수가 없습니다.</p>
          ) : (
            <div className="space-y-2">
              {rows.map((r) => {
                const keyInvalid = Boolean(r.key) && !KEY_PATTERN.test(r.key);
                return (
                  <div key={r.id} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={r.key}
                      onChange={(e) => handleField(r.id, 'key', e.target.value)}
                      placeholder="DATABASE_URL"
                      spellCheck={false}
                      autoComplete="off"
                      className={`w-44 rounded-md border bg-slate-950 px-2 py-1 font-mono text-xs text-slate-100 placeholder-slate-700 focus:outline-none focus:border-slate-600 ${keyInvalid ? 'border-amber-500/50' : 'border-slate-800'}`}
                    />
                    <input
                      type={r.revealed ? 'text' : 'password'}
                      value={r.value}
                      onChange={(e) => handleField(r.id, 'value', e.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                      className="flex-1 rounded-md border border-slate-800 bg-slate-950 px-2 py-1 font-mono text-xs text-slate-100 focus:outline-none focus:border-slate-600"
                    />
                    <button
                      type="button"
                      onClick={() => toggleReveal(r.id)}
                      className="rounded-md border border-slate-800 px-2 py-1 text-[10px] text-slate-500 hover:border-slate-700 hover:text-slate-300"
                      aria-label={r.revealed ? 'Hide value' : 'Show value'}
                    >
                      {r.revealed ? 'Hide' : 'Show'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemove(r.id)}
                      className="rounded-md border border-slate-800 px-2 py-1 text-[10px] text-slate-500 hover:border-red-700/40 hover:text-red-400"
                      aria-label="Remove"
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-900 pt-3">
            <button
              type="button"
              onClick={handleAdd}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              + Add variable
            </button>
            <div className="flex items-center gap-2">
              {saveError && <span className="text-xs text-amber-400">{saveError}</span>}
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || !dirty || hasInvalidKey}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
              >
                {saving ? '저장 중…' : 'Save'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ScanPanel(): import("react").ReactNode {
  const { scan, isLoading, error } = useLatestScan(true);

  return (
    <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/30 p-4">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-slate-300">이미지 스캔</h3>
        <span className="font-mono text-[10px] uppercase tracking-wide text-slate-600">
          Trivy · daily 03:00 KST
        </span>
      </header>

      {isLoading && !scan && !error && (
        <p className="text-xs text-slate-500">불러오는 중…</p>
      )}
      {error && (
        <p className="text-sm text-amber-400">조회 실패: {error.message}</p>
      )}

      {!isLoading && !error && !scan && (
        <p className="text-xs text-slate-500">
          아직 스캔 결과가 없습니다. 매일 03:00 KST에 본인 GHCR 이미지를 자동으로 스캔합니다.
        </p>
      )}

      {scan && <ScanResult scan={scan} />}
    </div>
  );
}

function ScanResult({ scan }: { scan: LatestScan }): import("react").ReactNode {
  const hasAction = scan.critical > 0 || scan.high > 0;
  const [open, setOpen] = useState(false);
  const findings = scan.findings ?? [];
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <SeverityChip label="Critical" count={scan.critical} tone="critical" />
        <SeverityChip label="High" count={scan.high} tone="high" />
        <SeverityChip label="Medium" count={scan.medium} tone="medium" />
      </div>
      <p className="text-xs text-slate-500">
        <span className="font-mono text-slate-400">{scan.image}</span>{' '}
        · 스캔: {formatScanRelative(scan.scannedAt)}
      </p>
      {hasAction && (
        <p className="text-xs text-amber-400/90">
          base image 또는 의존성을 최신으로 업그레이드한 뒤 재배포하면 다음 스캔에서 반영됩니다.
          현재 결과는 보고용이며, 배포 자체는 차단되지 않습니다.
        </p>
      )}
      {findings.length > 0 && (
        <div className="space-y-2 pt-1">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-xs text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline"
          >
            {open ? '상세 숨기기' : `상세 보기 (${findings.length}건${findings.length < scan.critical + scan.high ? ', critical+high 일부' : ''})`}
          </button>
          {open && <FindingsList findings={findings} />}
        </div>
      )}
    </>
  );
}

function FindingsList({ findings }: { findings: ScanFinding[] }): import("react").ReactNode {
  return (
    <ul className="space-y-2 border-t border-slate-800 pt-3">
      {findings.map((f, i) => (
        <li
          key={`${f.id}-${f.pkg}-${i}`}
          className="space-y-1 rounded-md border border-slate-800 bg-slate-950/40 p-2.5"
        >
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
            <SeverityTag severity={f.severity} />
            <span className="font-mono text-slate-200">{f.pkg}</span>
            <span className="text-slate-500">
              {f.installed}
              {f.fixed && (
                <>
                  <span className="px-1 text-slate-600">→</span>
                  <span className="text-emerald-300">{f.fixed}</span>
                </>
              )}
              {!f.fixed && (
                <span className="ml-1 text-slate-600">(fix 미공개)</span>
              )}
            </span>
          </div>
          {f.title && (
            <p className="text-xs text-slate-400 leading-relaxed">{f.title}</p>
          )}
          <div className="flex flex-wrap gap-2 text-[10px]">
            {f.url ? (
              <a
                href={f.url}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline"
              >
                {f.id} ↗
              </a>
            ) : (
              <span className="font-mono text-slate-500">{f.id}</span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function SeverityTag({ severity }: { severity: ScanFinding['severity'] }): import("react").ReactNode {
  const cls =
    severity === 'CRITICAL'
      ? 'bg-red-950/60 text-red-300 border-red-800'
      : severity === 'HIGH'
      ? 'bg-amber-950/60 text-amber-300 border-amber-800'
      : 'bg-slate-900 text-slate-400 border-slate-800';
  return (
    <span
      className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${cls}`}
    >
      {severity}
    </span>
  );
}

function SeverityChip({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: 'critical' | 'high' | 'medium';
}): import("react").ReactNode {
  const active = count > 0;
  const activeCls =
    tone === 'critical'
      ? 'border-red-600/50 bg-red-950/40 text-red-200'
      : tone === 'high'
      ? 'border-amber-600/50 bg-amber-950/30 text-amber-200'
      : 'border-slate-700 bg-slate-900/50 text-slate-300';
  const inactiveCls = 'border-slate-800 bg-slate-900/30 text-slate-500';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs ${
        active ? activeCls : inactiveCls
      }`}
    >
      <span className="text-[10px] uppercase tracking-wide">{label}</span>
      <span className="font-mono font-medium">{count}</span>
    </span>
  );
}

function formatScanRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  return `${days}일 전`;
}

type DeleteState =
  | { kind: 'idle' }
  | { kind: 'confirming' }
  | { kind: 'pending' }
  | { kind: 'error'; message: string };

function DeleteCard({ login, repo }: { login: string; repo: string }): import("react").ReactNode {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const [state, setState] = useState<DeleteState>({ kind: 'idle' });

  const handleConfirm = async (): Promise<void> => {
    setState({ kind: 'pending' });
    try {
      await deleteCurrentDeployment();
      await mutate(CURRENT_SWR_KEY, null, { revalidate: false });
      router.push('/deploy?removed=1');
    } catch (err) {
      setState({ kind: 'error', message: (err as Error).message });
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/30 p-4">
      <p className="text-sm font-medium text-slate-300">위험 영역</p>
      {state.kind === 'idle' && (
        <button
          type="button"
          onClick={() => setState({ kind: 'confirming' })}
          className="text-sm text-red-400 underline-offset-2 hover:text-red-300 hover:underline"
        >
          이 앱 제거하기
        </button>
      )}
      {state.kind === 'confirming' && (
        <div className="space-y-3">
          <p className="text-sm text-slate-300">
            <span className="font-mono">{login}/{repo}</span>의 매니페스트가 swkoo-kr에서
            삭제되고 ~1-3분 안에 라이브 URL이 다운됩니다.
          </p>
          <p className="text-xs text-slate-500">
            본인 repo의 Dockerfile + workflow는 그대로 남습니다 — 필요하면 GitHub에서 직접 삭제하세요.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleConfirm}
              className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-500"
            >
              제거 확정
            </button>
            <button
              type="button"
              onClick={() => setState({ kind: 'idle' })}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:border-slate-600 hover:bg-slate-800/50"
            >
              취소
            </button>
          </div>
        </div>
      )}
      {state.kind === 'pending' && <p className="text-sm text-slate-400">제거 중…</p>}
      {state.kind === 'error' && (
        <div className="space-y-2">
          <p className="text-sm text-amber-400">제거 실패: {state.message}</p>
          <button
            type="button"
            onClick={() => setState({ kind: 'idle' })}
            className="text-xs text-slate-500 hover:text-slate-300"
          >
            돌아가기
          </button>
        </div>
      )}
    </div>
  );
}

function Header({
  login,
  repo,
  status,
}: {
  login: string;
  repo: string;
  status?: DeploymentStatus;
}): import("react").ReactNode {
  const liveReady = status?.stages.live.status === 'success';
  return (
    <header className="space-y-3">
      <p className="text-xs uppercase tracking-wide text-slate-500">deployment</p>
      <h1 className="font-mono text-2xl text-slate-100">
        {login}/{repo}
      </h1>
      {status && (
        <p className="text-sm text-slate-400">
          {liveReady ? '✓ 라이브 — ' : '⏳ 배포 진행 중 — '}
          <a
            href={status.liveUrl}
            target="_blank"
            rel="noreferrer"
            className={
              liveReady
                ? 'font-mono text-emerald-300 hover:text-emerald-200 underline-offset-2 hover:underline'
                : 'font-mono text-slate-400 hover:text-slate-200 underline-offset-2 hover:underline'
            }
          >
            {status.liveUrl}
          </a>
        </p>
      )}
    </header>
  );
}

function Checklist({ status }: { status: DeploymentStatus }): import("react").ReactNode {
  return (
    <ol className="space-y-2">
      {STAGE_ORDER.map(({ key, label }) => (
        <StageRow key={key} label={label} stage={status.stages[key]} />
      ))}
    </ol>
  );
}

function StageRow({ label, stage }: { label: string; stage: StageInfo }): import("react").ReactNode {
  return (
    <li className="flex items-start gap-4 rounded-md border border-slate-800 bg-slate-900/30 p-4">
      <StatusIcon status={stage.status} />
      <div className="flex-1 space-y-0.5">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-slate-200">{label}</p>
          <StatusBadge status={stage.status} />
        </div>
        <p className="text-xs text-slate-400">{stage.message}</p>
        {stage.link && (
          <a
            href={stage.link}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline"
          >
            {stage.link.includes('github.com/') && stage.link.includes('/actions/')
              ? 'GitHub Actions 로그 보기'
              : stage.link.startsWith('https://') && stage.link.includes('.apps.')
              ? '라이브 URL 열기'
              : '자세히 보기'}
          </a>
        )}
      </div>
    </li>
  );
}

function StatusIcon({ status }: { status: StageStatus }): import("react").ReactNode {
  const cls =
    status === 'success'
      ? 'border-emerald-500/60 bg-emerald-500/20 text-emerald-300'
      : status === 'failed'
      ? 'border-red-500/60 bg-red-500/20 text-red-300'
      : status === 'running'
      ? 'border-slate-500/60 bg-slate-700/40 text-slate-300'
      : 'border-slate-700 bg-slate-900/40 text-slate-600';
  const glyph =
    status === 'success' ? '✓' : status === 'failed' ? '✕' : status === 'running' ? '◐' : '·';
  return (
    <span
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-sm ${cls}`}
      aria-hidden
    >
      <span className={status === 'running' ? 'animate-pulse' : ''}>{glyph}</span>
    </span>
  );
}

function StatusBadge({ status }: { status: StageStatus }): import("react").ReactNode {
  const text =
    status === 'success'
      ? '완료'
      : status === 'failed'
      ? '실패'
      : status === 'running'
      ? '진행 중'
      : '대기';
  const cls =
    status === 'success'
      ? 'text-emerald-400'
      : status === 'failed'
      ? 'text-red-400'
      : status === 'running'
      ? 'text-slate-300'
      : 'text-slate-600';
  return <span className={`text-[10px] uppercase tracking-wide ${cls}`}>{text}</span>;
}
