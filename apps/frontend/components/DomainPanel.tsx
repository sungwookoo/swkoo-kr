'use client';

import { useState } from 'react';

import {
  CustomDomainStatus,
  DomainDnsRecords,
  DomainInfo,
  ReasonedError,
  buildZoneFile,
  deleteDomain,
  panelErrorText,
  registerDomain,
  useDomain,
  verifyDomain,
  zoneFileName,
} from '@/lib/domain';

interface DomainPanelProps {
  login: string;
  repo: string;
  /** The user's default <slug>.apps.swkoo.kr URL — always rendered so
   *  custom-domain failure never hides the base URL the user can still
   *  share. */
  fallbackLiveUrl: string;
}

/** Reasons that mean "user can't act here" — show message, no form.
 *  Distinct from NO_DEPLOYMENT / REPO_NOT_CURRENT which hide the whole
 *  panel (those are about the wrong page; these are about the wrong
 *  user). */
const PERMISSION_REASONS = new Set(['NOT_OWNER', 'NOT_ALLOWED']);

export function DomainPanel({ login, repo, fallbackLiveUrl }: DomainPanelProps): import('react').ReactNode {
  const { domain, error: loadError, refresh } = useDomain(login, repo);
  // SWR-aware revalidator — used by child components after mutations
  // so the panel re-reads the row without a hard page reload.
  const onChanged = (): Promise<void> => refresh().then(() => undefined);

  // The current-deployment guard returns 404 NO_DEPLOYMENT pre-deploy
  // and on the deleting window. Hide the panel entirely — the base URL
  // is still rendered by StatusClient's Header so the user isn't lost.
  if (loadError?.reason === 'NO_DEPLOYMENT' || loadError?.reason === 'REPO_NOT_CURRENT') {
    return null;
  }

  // 401 has no `reason` field (Nest's auth guard returns plain text);
  // route by status. Permission errors get a tip-only treatment so the
  // user doesn't see an empty input that will only ever fail.
  const isPermissionError =
    loadError?.status === 401 ||
    (loadError?.reason !== undefined && PERMISSION_REASONS.has(loadError.reason));

  return (
    <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/30 p-4">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-slate-300">커스텀 도메인</h3>
        <span className="font-mono text-[10px] uppercase tracking-wide text-slate-600">
          v0.2 · CNAME 1줄
        </span>
      </header>

      <p className="text-xs text-slate-500">
        기본 URL <span className="font-mono text-slate-400">{fallbackLiveUrl}</span> 는 항상 활성입니다.
        본인 소유 서브도메인(예: <span className="font-mono">app.your-domain.com</span>)을 추가로 연결할 수 있습니다.
        루트 도메인(<span className="font-mono">example.com</span>)은 v0에서 지원하지 않습니다.
      </p>

      {loadError && isPermissionError && (
        // Permission errors: message-only. No retry button — the next
        // refresh of the page will pick up the user's session change.
        <p className="rounded-md border border-amber-900/40 bg-amber-950/30 px-3 py-2 text-sm text-amber-300">
          {panelErrorText(loadError) ?? loadError.message}
        </p>
      )}
      {loadError && !isPermissionError && (
        // Transient errors (502, network, etc.): message + retry. Don't
        // render the EmptyState form below since we don't know if the
        // user already has a row.
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-900/40 bg-amber-950/30 px-3 py-2 text-sm text-amber-300">
          <span>{panelErrorText(loadError) ?? loadError.message}</span>
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded-md border border-amber-700/50 px-2 py-0.5 text-xs text-amber-200 hover:bg-amber-900/40"
          >
            다시 시도
          </button>
        </div>
      )}

      {/* Only render interactive state once GET succeeded. loadError ⇒
          no domain shape we can trust, so suppress the form/buttons. */}
      {!loadError && (!domain || !domain.status) && (
        <EmptyState login={login} repo={repo} onChanged={onChanged} />
      )}
      {!loadError && domain && (domain.status === 'pending' || domain.status === 'error') && (
        <PendingState login={login} repo={repo} info={domain} onChanged={onChanged} />
      )}
      {!loadError && domain && domain.status === 'verified' && (
        // verified = DNS check passed, manifest commit interrupted before
        // it could land. GET refresh alone won't recover it (no commit
        // retry on the server side); the user must re-trigger POST /verify
        // which idempotently re-runs the DNS check + commit. Different
        // copy + different action from `applying`.
        <VerifiedNeedsRetryState
          login={login}
          repo={repo}
          info={domain}
          onChanged={onChanged}
        />
      )}
      {!loadError && domain && domain.status === 'applying' && (
        // applying = manifest landed, cert-manager working. Just keep
        // refreshing; useDomain's auto-poll @ 5s handles this without
        // user action.
        <ApplyingState info={domain} onRefresh={onChanged} />
      )}
      {!loadError && domain && domain.status === 'active' && (
        <ActiveState login={login} repo={repo} info={domain} onChanged={onChanged} />
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
  const [err, setErr] = useState<ReasonedError | null>(null);

  const submit = async (value: string): Promise<void> => {
    const v = value.trim();
    if (!v) return;
    setBusy(true);
    setErr(null);
    try {
      await registerDomain(login, repo, v);
      await onChanged();
      setInput('');
    } catch (e) {
      setErr(e as ReasonedError);
    } finally {
      setBusy(false);
    }
  };

  const isApex = err?.reason === 'APEX_NOT_SUPPORTED';

  return (
    <div className="space-y-2 border-t border-slate-900 pt-3">
      <p className="text-sm text-slate-200">
        도메인 앞에 붙일 이름을 정하세요.
        <span className="text-slate-400"> DNS 관리 화면에서 CNAME 한 줄만 추가하면 됩니다.</span>
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="www.your-domain.com 또는 portfolio.your-domain.com"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          className="min-w-0 flex-1 rounded-md border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 placeholder-slate-700 focus:border-slate-600 focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy && input.trim()) void submit(input);
          }}
        />
        <button
          type="button"
          onClick={() => void submit(input)}
          disabled={busy || !input.trim()}
          className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
        >
          {busy ? '추가 중…' : '도메인 추가'}
        </button>
      </div>
      <p className="text-[11px] text-slate-600">
        예시는 placeholder일 뿐입니다. 본인이 소유한 도메인의 서브도메인을 입력하세요.
        루트 도메인(<span className="font-mono">example.com</span>)을 입력하면{' '}
        &lsquo;www 사용하기&rsquo;를 안내해 드립니다.
      </p>

      <details className="group rounded-md border border-slate-800/60 bg-slate-950/40 text-xs text-slate-400 open:bg-slate-950/60">
        <summary className="cursor-pointer list-none px-3 py-2 text-slate-300 hover:text-slate-100 marker:hidden">
          <span className="select-none">DNS 설정 방법 — 처음 해보시나요?</span>
          <span className="ml-2 text-slate-600 group-open:hidden">▾</span>
          <span className="ml-2 hidden text-slate-600 group-open:inline">▴</span>
        </summary>
        <ul className="space-y-1.5 border-t border-slate-800/60 px-3 py-2.5 leading-relaxed">
          <li>
            도메인을 구매한 곳(또는 네임서버를 관리하는 곳)의 <span className="text-slate-300">DNS 관리</span> 화면에서 CNAME 레코드를 추가합니다.
            대표적으로 Cloudflare, Namecheap, GoDaddy, AWS Route 53, 가비아 등이 있습니다.
          </li>
          <li>
            서브도메인만 지원합니다 — <span className="font-mono text-slate-300">app.example.com</span> ✅,{' '}
            <span className="font-mono text-slate-500">example.com</span>(루트 도메인) ❌.
            루트 도메인을 입력하면 <span className="font-mono">www.example.com</span> 사용을 안내해 드립니다.
          </li>
          <li>
            입력란에 도메인을 넣을 때는 <span className="font-mono">https://</span> 또는 슬래시 없이 도메인만 입력하세요.
            (예: <span className="font-mono">app.your-domain.com</span>)
          </li>
          <li>
            이미 Vercel/Netlify 등에 연결된 <span className="font-mono">www</span> 또는 루트 도메인은
            그대로 두고, <span className="font-mono">portfolio.your-domain.com</span> 같은 새 서브도메인을
            쓰는 것을 추천합니다. 기존 서비스와 충돌하지 않습니다.
          </li>
        </ul>
      </details>

      {err && isApex && (
        <div className="space-y-2 rounded-md border border-sky-900/40 bg-sky-950/30 px-3 py-2.5 text-sm text-sky-200">
          <p>
            {err.registrableDomain ?? '이 도메인'}는 루트 도메인이라 직접 연결할 수 없습니다.
            보통 웹사이트 주소로는 <span className="font-mono">{err.suggestedSubdomain ?? `www.${err.registrableDomain ?? ''}`}</span>를 사용합니다.
          </p>
          <div className="flex flex-wrap items-start gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const sug = err.suggestedSubdomain ?? `www.${err.registrableDomain ?? ''}`;
                setInput(sug);
                void submit(sug);
              }}
              className="max-w-full rounded-md bg-emerald-600 px-3 py-1.5 text-left text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-700"
            >
              <span className="break-all font-mono">
                {err.suggestedSubdomain ?? `www.${err.registrableDomain ?? ''}`}
              </span>{' '}
              사용하기
            </button>
            <button
              type="button"
              onClick={() => {
                setErr(null);
                setInput(err.suggestedSubdomain ?? '');
              }}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              다른 이름 직접 입력
            </button>
          </div>
        </div>
      )}
      {err && !isApex && (
        <p className="text-sm text-amber-400">{panelErrorText(err) ?? err.message}</p>
      )}
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

      {records && records.txt === null && (
        <p className="text-sm font-medium text-emerald-300">CNAME 한 줄만 추가하면 됩니다.</p>
      )}

      {records && (
        <div className="space-y-3">
          {records.txt && (
            <DnsRecordRow
              label="1️⃣ TXT 레코드"
              host={records.txt.host}
              value={records.txt.value}
              valueLabel="Value"
            />
          )}
          <DnsRecordRow
            label={records.txt ? '2️⃣ CNAME 레코드' : 'CNAME 레코드'}
            host={records.cname.host}
            value={records.cname.target}
            valueLabel="Target"
          />
        </div>
      )}

      {records && info.domain && (
        <ZoneFileDownload domain={info.domain} records={records} />
      )}

      {/* Conflict recovery: existing A record (Vercel/etc.) blocks the
          CNAME. Offer the recommended subdomain + a free-form prefix so
          the user can pick their own, then re-register. */}
      {info.lastErrorReason === 'DNS_CNAME_CONFLICTS_WITH_A' && info.registrableDomain && (
        <ConflictRecovery
          login={login}
          repo={repo}
          registrable={info.registrableDomain}
          suggested={info.suggestedSubdomain}
          onChanged={onChanged}
        />
      )}

      {records && info.domain && (
        <RecordEntryHints domain={info.domain} hasTxt={records.txt !== null} />
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

/** Shown when verify failed with an A-record conflict. Lets the user
 *  switch to a non-conflicting subdomain: the recommended one, or any
 *  prefix they type. "Switch" = delete the current row + register the
 *  new domain (one-app-one-domain, so we free the slot first). Full
 *  free-form re-entry stays available via the panel's normal delete →
 *  re-add path, surfaced here as the fallback note. */
function ConflictRecovery({
  login,
  repo,
  registrable,
  suggested,
  onChanged,
}: {
  login: string;
  repo: string;
  registrable: string;
  suggested: string | null;
  onChanged: () => Promise<void>;
}): import('react').ReactNode {
  const [prefix, setPrefix] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const switchTo = async (newDomain: string): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      // One domain per app — remove the conflicting registration before
      // claiming the new one.
      await deleteDomain(login, repo);
      await registerDomain(login, repo, newDomain);
      await onChanged();
    } catch (e) {
      const reasoned = e as ReasonedError;
      setErr(panelErrorText(reasoned) ?? reasoned.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-slate-800/60 bg-slate-950/40 px-3 py-2.5 text-xs text-slate-400">
      <p className="text-slate-300">기존 사이트를 유지하려면 새 주소를 사용하는 것을 추천합니다.</p>
      {suggested && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void switchTo(suggested)}
          className="max-w-full rounded-md bg-emerald-600 px-3 py-1.5 text-left text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-700"
        >
          <span className="break-all font-mono">{suggested}</span> 사용하기
        </button>
      )}
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        <span className="text-slate-500">또는 원하는 이름:</span>
        <input
          type="text"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          placeholder="app"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          className="w-24 rounded-md border border-slate-800 bg-slate-950 px-2 py-1 font-mono text-xs text-slate-100 placeholder-slate-700 focus:border-slate-600 focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy && prefix.trim()) {
              void switchTo(`${prefix.trim()}.${registrable}`);
            }
          }}
        />
        <span className="font-mono text-slate-500">.{registrable}</span>
        <button
          type="button"
          disabled={busy || !prefix.trim()}
          onClick={() => void switchTo(`${prefix.trim()}.${registrable}`)}
          className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:border-slate-600 hover:bg-slate-800/50 disabled:cursor-not-allowed disabled:text-slate-600"
        >
          이 주소로 시도
        </button>
      </div>
      <p className="text-[11px] text-slate-600">
        다른 도메인을 쓰려면 [삭제] 후 전체 주소로 다시 추가하세요.
      </p>
      {err && <p className="text-amber-400">{err}</p>}
    </div>
  );
}

function DnsRecordRow({
  label,
  host,
  value,
  valueLabel,
}: {
  label: string;
  host: string;
  value: string;
  /** Display name for the value column — TXT uses "Value", CNAME uses
   *  "Target". Most DNS providers' UIs use these terms verbatim. */
  valueLabel: 'Value' | 'Target';
}): import('react').ReactNode {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-slate-300">{label}</p>
      <CopyableField label="Host" content={host} />
      <CopyableField label={valueLabel} content={value} />
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

  // Mobile-safety: `break-all` lets long TXT/CNAME values wrap inside
  // the code block instead of overflowing or being truncated invisibly.
  // `min-w-0` on the parent flex item prevents flex from refusing to
  // shrink past the intrinsic content width on narrow screens.
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[10px] uppercase tracking-wide text-slate-600">
        {label}
      </span>
      <code className="min-w-0 flex-1 break-all rounded-md border border-slate-800 bg-slate-950 px-2 py-1 font-mono text-xs text-slate-200">
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

/** Provider-agnostic DNS export: builds a standard BIND zone file from
 *  the panel's records and triggers a client-side download. Lets users
 *  with import-capable providers (Cloudflare, Route 53, etc.) skip
 *  hand-typing. Not a Cloudflare-specific feature — Cloudflare is named
 *  only as one example. */
function ZoneFileDownload({
  domain,
  records,
}: {
  domain: string;
  records: DomainDnsRecords;
}): import('react').ReactNode {
  const handleDownload = (): void => {
    const content = buildZoneFile(records);
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = zoneFileName(domain);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={handleDownload}
        className="inline-flex items-center gap-2 rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:border-slate-600 hover:bg-slate-800/50"
      >
        ⬇ DNS 레코드 파일 다운로드
      </button>
      <p className="text-[11px] leading-relaxed text-slate-600">
        Cloudflare, Route 53 등 zone file import를 지원하는 DNS 업체에서 사용할 수 있습니다.
        지원하지 않는 업체는 위 값을 직접 입력하세요.
      </p>
    </div>
  );
}

/** Provider-input hints shown next to the TXT/CNAME guidance. Most DNS
 *  UIs accept either the leaf label (`app`) or the fully-qualified
 *  name (`app.my-domain.com`); listing both forms in one place removes
 *  the trial-and-error that bites non-technical users. Computes the
 *  leaf label from the user's domain so the example is concrete to
 *  their case — fallback to generic text if the domain shape is
 *  unexpected. */
function RecordEntryHints({
  domain,
  hasTxt,
}: {
  domain: string;
  hasTxt: boolean;
}): import('react').ReactNode {
  // Conservative leaf extraction: the first label of the subdomain.
  // For `app.my-domain.com` → `app`. For `service.api.example.co.kr` →
  // `service`. (We don't have tldts on the frontend; if a user's setup
  // is deeper, the full Host value in the panel still works — most DNS
  // providers accept the FQDN form.)
  const labels = domain.split('.');
  const leaf = labels.length >= 3 ? labels[0] : null;
  // TXT shorthand only relevant for the legacy txt_cname scheme.
  const txtShort = hasTxt && leaf ? `_swkoo-challenge.${leaf}` : null;

  return (
    <details className="group rounded-md border border-slate-800/60 bg-slate-950/40 text-xs text-slate-400 open:bg-slate-950/60">
      <summary className="cursor-pointer list-none px-3 py-2 text-slate-300 hover:text-slate-100 marker:hidden">
        <span className="select-none">어디에 어떻게 입력하나요?</span>
        <span className="ml-2 text-slate-600 group-open:hidden">▾</span>
        <span className="ml-2 hidden text-slate-600 group-open:inline">▴</span>
      </summary>
      <ul className="space-y-2 border-t border-slate-800/60 px-3 py-2.5 leading-relaxed">
        {leaf && txtShort ? (
          <li>
            <span className="text-slate-300">Host / Name 칸:</span>{' '}
            CNAME에는 보통 <span className="font-mono text-slate-200">{leaf}</span>,
            TXT에는 보통 <span className="font-mono text-slate-200">{txtShort}</span>{' '}
            를 입력합니다. 일부 DNS 업체는 전체 이름(<span className="font-mono break-all">{domain}</span>)을 요구하니,
            잘 모르겠으면 위에 표시된 <span className="text-slate-300">전체 Host 값</span>을 그대로 복사해 넣어도 됩니다.
          </li>
        ) : (
          <li>
            <span className="text-slate-300">Host / Name 칸:</span>{' '}
            일부 DNS 업체는 짧은 이름(예: <span className="font-mono">app</span>)만, 일부는 전체 이름을 요구합니다.
            위에 표시된 <span className="text-slate-300">전체 Host 값</span>을 그대로 복사해 넣어도 보통 동작합니다.
          </li>
        )}
        <li>
          <span className="text-slate-300">Value / Target 칸:</span>{' '}
          위에 표시된 값을 그대로 복사해 넣습니다. 따옴표나 공백 추가 없이 동일하게 입력하세요.
        </li>
        <li>
          <span className="text-slate-300">Cloudflare 사용 시:</span>{' '}
          CNAME 레코드는 인증서 발급 전까지 <span className="font-mono">DNS only</span> (프록시 끔, 회색 구름)
          상태를 권장합니다. 프록시(주황 구름) 상태면 cert-manager가 HTTP-01 challenge를 통과하지 못합니다.
          인증서 발급이 완료된 뒤 프록시를 다시 켤 수 있습니다.
        </li>
        <li>
          <span className="text-slate-300">전파 시간:</span>{' '}
          DNS 전파는 보통 1-5분, 경우에 따라 더 오래(수십 분~몇 시간) 걸릴 수 있습니다.
          [확인]에서 실패하면 잠시 더 기다린 뒤 다시 시도하세요.
        </li>
        <li>
          <span className="text-slate-300">DNS 레코드 파일 import:</span>{' '}
          파일 import를 지원하는 업체라면 위 [DNS 레코드 파일 다운로드]로 받은 파일을 업로드할 수 있습니다.
          예를 들어 Cloudflare에서는 <span className="font-mono">DNS Records → Import and Export → Import DNS records</span>에서 업로드합니다.
          (지원하지 않는 업체는 위 레코드 값을 직접 입력하세요.)
        </li>
        <li>
          <span className="text-slate-300">이미 다른 서비스에 연결된 host:</span>{' '}
          Vercel/Netlify 등에 연결된 <span className="font-mono">www</span> 나 루트 도메인은 그대로 두고,
          <span className="font-mono">portfolio.your-domain.com</span> 같은 새 서브도메인을 쓰는 것을 추천합니다.
          이미 A 레코드가 있는 <span className="font-mono">www</span>에는 CNAME을 import해도 자동으로 해결되지 않습니다 —
          기존 서비스를 유지하려면 새 subdomain을 사용하세요(DNS 규칙상 A 레코드와 CNAME 공존 불가).
        </li>
      </ul>
    </details>
  );
}

// ---------- verified: DNS OK but commit interrupted; explicit retry ----------

/** Scenario this handles: /verify ran, DNS checks passed, the row was
 *  promoted to `verified`, then the manifest commit step crashed (network
 *  blip, GitHub 5xx, pod restart between two-step verified→applying).
 *  The DB row sits at `verified` with applied_commit=null. GET refresh
 *  alone won't drive forward — the server-side commit retry is bound
 *  to POST /verify. So this state surfaces a "DNS 완료 · 적용 재시도
 *  필요" message and a button that re-calls verifyDomain(), which is
 *  idempotent: it re-runs the DNS check and then re-attempts the
 *  commit, advancing to applying on success. */
function VerifiedNeedsRetryState({
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
  const [retrying, setRetrying] = useState(false);
  const [retryErr, setRetryErr] = useState<string | null>(null);

  const handleRetry = async (): Promise<void> => {
    setRetrying(true);
    setRetryErr(null);
    try {
      await verifyDomain(login, repo);
      await onChanged();
    } catch (e) {
      const reasoned = e as Error & { reason?: string; status?: number };
      setRetryErr(panelErrorText(reasoned) ?? reasoned.message);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="space-y-2 border-t border-slate-900 pt-3">
      <p className="text-sm text-slate-300">
        🟦 <span className="font-mono">{info.domain}</span>{' '}
        <span className="text-slate-500">DNS 확인 완료 · 적용 재시도 필요</span>
      </p>
      <p className="text-[11px] text-slate-600">
        DNS는 확인됐지만 매니페스트 적용 단계가 중단됐습니다. 아래 [적용 재시도]를 누르면
        DNS를 다시 한 번 확인하고 매니페스트 커밋을 재시도합니다. 보통 즉시 복구됩니다.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleRetry}
          disabled={retrying}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
        >
          {retrying ? '재시도 중…' : '적용 재시도'}
        </button>
        {retryErr && <span className="text-xs text-amber-400">{retryErr}</span>}
      </div>
    </div>
  );
}

// ---------- applying: cert issuing ----------

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
