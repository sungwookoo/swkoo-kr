'use client';

import { useState } from 'react';

import { useSWRConfig } from 'swr';

import {
  CustomDomainStatus,
  DomainInfo,
  deleteDomain,
  domainSwrKey,
  panelErrorText,
  registerDomain,
  useDomain,
  verifyDomain,
} from '@/lib/domain';

interface DomainPanelProps {
  login: string;
  repo: string;
  /** The user's default <slug>.apps.swkoo.kr URL — always rendered so
   *  custom-domain failure never hides the base URL the user can still
   *  share. */
  fallbackLiveUrl: string;
}

export function DomainPanel({ login, repo, fallbackLiveUrl }: DomainPanelProps): import('react').ReactNode {
  const { domain, error: loadError } = useDomain(login, repo);
  const { mutate } = useSWRConfig();
  const refresh = (): Promise<void> => mutate(domainSwrKey(login, repo)).then(() => undefined);

  // The current-deployment guard returns 404 NO_DEPLOYMENT pre-deploy
  // and on the deleting window. We don't want to render the whole panel
  // in that case — but we DO want to render the default URL even
  // outside this panel (StatusClient does that in its Header). So when
  // the guard rejects, hide the panel entirely.
  if (loadError?.reason === 'NO_DEPLOYMENT' || loadError?.reason === 'REPO_NOT_CURRENT') {
    return null;
  }

  return (
    <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/30 p-4">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-slate-300">커스텀 도메인</h3>
        <span className="font-mono text-[10px] uppercase tracking-wide text-slate-600">
          v0 · subdomain only
        </span>
      </header>

      <p className="text-xs text-slate-500">
        기본 URL <span className="font-mono text-slate-400">{fallbackLiveUrl}</span> 는 항상 활성입니다.
        본인 소유 서브도메인(예: <span className="font-mono">app.your-domain.com</span>)을 추가로 연결할 수 있습니다.
        루트 도메인(<span className="font-mono">example.com</span>)은 v0에서 지원하지 않습니다.
      </p>

      {loadError && (
        <p className="text-sm text-amber-400">
          {panelErrorText(loadError) ?? loadError.message}
        </p>
      )}

      {!domain || !domain.status ? (
        <EmptyState login={login} repo={repo} onChanged={refresh} />
      ) : domain.status === 'pending' || domain.status === 'error' ? (
        <PendingState
          login={login}
          repo={repo}
          info={domain}
          onChanged={refresh}
        />
      ) : domain.status === 'verified' || domain.status === 'applying' ? (
        <ApplyingState info={domain} onRefresh={refresh} />
      ) : (
        <ActiveState
          login={login}
          repo={repo}
          info={domain}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

// ---------- empty (no domain yet) ----------

function EmptyState({
  login,
  repo,
  onChanged,
}: {
  login: string;
  repo: string;
  onChanged: () => Promise<void>;
}): import('react').ReactNode {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleSubmit = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await registerDomain(login, repo, input.trim());
      await onChanged();
      setInput('');
    } catch (e) {
      const reasoned = e as Error & { reason?: string; status?: number };
      setErr(panelErrorText(reasoned) ?? reasoned.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 border-t border-slate-900 pt-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="app.your-domain.com"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          className="flex-1 rounded-md border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 placeholder-slate-700 focus:border-slate-600 focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy && input.trim()) handleSubmit();
          }}
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={busy || !input.trim()}
          className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
        >
          {busy ? '추가 중…' : '도메인 추가'}
        </button>
      </div>
      <p className="text-[11px] text-slate-600">
        placeholder는 예시입니다. 본인이 소유한 서브도메인을 입력해야 DNS 확인이 통과합니다.
      </p>
      {err && <p className="text-sm text-amber-400">{err}</p>}
    </div>
  );
}

// ---------- pending / error: show DNS guidance ----------

function PendingState({
  login,
  repo,
  info,
  onChanged,
}: {
  login: string;
  repo: string;
  info: DomainInfo;
  onChanged: () => Promise<void>;
}): import('react').ReactNode {
  const [verifying, setVerifying] = useState(false);
  const [verifyErr, setVerifyErr] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const isError = info.status === 'error';
  const records = info.dnsRecords;

  const handleVerify = async (): Promise<void> => {
    setVerifying(true);
    setVerifyErr(null);
    try {
      await verifyDomain(login, repo);
      await onChanged();
    } catch (e) {
      const reasoned = e as Error & { reason?: string; status?: number };
      setVerifyErr(panelErrorText(reasoned) ?? reasoned.message);
    } finally {
      setVerifying(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!confirm(`도메인 ${info.domain}을(를) 삭제하시겠습니까?`)) return;
    setDeleting(true);
    try {
      await deleteDomain(login, repo);
      await onChanged();
    } catch (e) {
      setVerifyErr((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-3 border-t border-slate-900 pt-3">
      <StatusLine status={info.status as CustomDomainStatus} domain={info.domain ?? ''} />

      {isError && info.lastError && (
        <p className="rounded-md border border-amber-900/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
          {info.lastError}
        </p>
      )}

      {records && (
        <div className="space-y-3">
          <DnsRecordRow
            label="1️⃣ TXT 레코드"
            host={records.txt.host}
            value={records.txt.value}
          />
          <DnsRecordRow
            label="2️⃣ CNAME 레코드"
            host={records.cname.host}
            value={records.cname.target}
          />
        </div>
      )}

      <p className="text-[11px] text-slate-600">
        DNS 전파는 보통 1-5분, 길게는 수십 분 걸립니다. 추가 후 잠시 뒤에 [확인] 을 눌러주세요.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleVerify}
          disabled={verifying || deleting}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
        >
          {verifying ? 'DNS 확인 중…' : '확인'}
        </button>
        <button
          type="button"
          onClick={handleDelete}
          disabled={verifying || deleting}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:border-red-700/40 hover:text-red-400 disabled:cursor-not-allowed disabled:text-slate-600"
        >
          {deleting ? '삭제 중…' : '삭제'}
        </button>
        {verifyErr && <span className="text-xs text-amber-400">{verifyErr}</span>}
      </div>
    </div>
  );
}

function DnsRecordRow({
  label,
  host,
  value,
}: {
  label: string;
  host: string;
  value: string;
}): import('react').ReactNode {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-slate-300">{label}</p>
      <CopyableField label="Host" content={host} />
      <CopyableField label="Value" content={value} />
    </div>
  );
}

function CopyableField({
  label,
  content,
}: {
  label: string;
  content: string;
}): import('react').ReactNode {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // older browsers / insecure contexts — silently fail; user can
      // select+copy manually.
    }
  };

  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[10px] uppercase tracking-wide text-slate-600">
        {label}
      </span>
      <code className="flex-1 truncate rounded-md border border-slate-800 bg-slate-950 px-2 py-1 font-mono text-xs text-slate-200">
        {content}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        className="shrink-0 rounded-md border border-slate-800 px-2 py-1 text-[10px] text-slate-500 hover:border-slate-700 hover:text-slate-300"
        aria-label="복사"
      >
        {copied ? '✓ 복사됨' : '📋 복사'}
      </button>
    </div>
  );
}

// ---------- verified / applying: cert issuing ----------

function ApplyingState({
  info,
  onRefresh,
}: {
  info: DomainInfo;
  onRefresh: () => Promise<void>;
}): import('react').ReactNode {
  return (
    <div className="space-y-2 border-t border-slate-900 pt-3">
      <p className="text-sm text-slate-300">
        🔵 <span className="font-mono">{info.domain}</span>{' '}
        <span className="text-slate-500">인증서 발급 중 — 보통 1-2분</span>
      </p>
      <p className="text-[11px] text-slate-600">
        cert-manager가 Let&apos;s Encrypt에서 인증서를 받고 있습니다. 발급이 끝나면 자동으로 활성 상태로 전환됩니다.
      </p>
      <button
        type="button"
        onClick={() => void onRefresh()}
        className="text-xs text-slate-400 hover:text-slate-200"
      >
        ↻ 상태 새로고침
      </button>
    </div>
  );
}

// ---------- active ----------

function ActiveState({
  login,
  repo,
  info,
  onChanged,
}: {
  login: string;
  repo: string;
  info: DomainInfo;
  onChanged: () => Promise<void>;
}): import('react').ReactNode {
  const [deleting, setDeleting] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);

  const handleDelete = async (): Promise<void> => {
    if (!confirm(`도메인 ${info.domain}을(를) 삭제하시겠습니까?`)) return;
    setDeleting(true);
    setDelErr(null);
    try {
      await deleteDomain(login, repo);
      await onChanged();
    } catch (e) {
      setDelErr((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  // Cert downgrade — the DB row stays `active` per design, but the cert
  // is no longer Ready. Surface explicitly so the user knows the green
  // URL is misleading. Doesn't auto-revert status; the next renewal /
  // restart should heal.
  const certIssue = !info.certificateReady;

  return (
    <div className="space-y-3 border-t border-slate-900 pt-3">
      {certIssue ? (
        <p className="rounded-md border border-amber-900/40 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
          ⚠️ 도메인은 활성 상태로 등록되어 있지만 현재 인증서 상태 확인이 필요합니다.
          {info.certificateError && (
            <span className="ml-1 text-amber-400/80">({info.certificateError})</span>
          )}
        </p>
      ) : (
        <p className="text-sm text-emerald-300">
          ✅{' '}
          <a
            href={info.url ?? `https://${info.domain}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-emerald-300 underline-offset-2 hover:text-emerald-200 hover:underline"
          >
            {info.url ?? `https://${info.domain}`}
          </a>
        </p>
      )}

      {info.verifiedAt && (
        <p className="text-[11px] text-slate-600">
          DNS 확인 완료: {new Date(info.verifiedAt).toLocaleString('ko-KR')}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:border-red-700/40 hover:text-red-400 disabled:cursor-not-allowed disabled:text-slate-600"
        >
          {deleting ? '삭제 중…' : '도메인 삭제'}
        </button>
        {delErr && <span className="text-xs text-amber-400">{delErr}</span>}
      </div>
    </div>
  );
}

// ---------- shared ----------

function StatusLine({
  status,
  domain,
}: {
  status: CustomDomainStatus;
  domain: string;
}): import('react').ReactNode {
  const label =
    status === 'pending'
      ? '🟡 DNS 확인 대기'
      : status === 'verified'
      ? '🔵 인증서 발급 시작'
      : status === 'applying'
      ? '🔵 인증서 발급 중'
      : status === 'active'
      ? '✅ 활성'
      : '❌ 오류';
  return (
    <p className="text-sm text-slate-300">
      {label}{' '}
      <span className="font-mono text-slate-400">{domain}</span>
    </p>
  );
}
