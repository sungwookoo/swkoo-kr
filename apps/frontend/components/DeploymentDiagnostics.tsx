'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { API_BASE_URL } from '@/lib/api-base';

interface Diagnostics {
  checkedAt: string;
  state: string;
  restarts: number;
  usage: null | { cpuMillicores: number | null; memoryMiB: number | null; cpuLimit: string | null; memoryLimit: string | null };
  logs: string | null;
  logSource: 'app' | 'initialization' | null;
  logError: string | null;
}

async function read(url: string): Promise<Diagnostics> {
  const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new Error('앱 실행 정보를 불러오지 못했습니다. 현재 로그인과 배포 상태를 확인해 주세요.');
  return response.json();
}

export function DeploymentDiagnostics({ login, repo }: { login: string; repo: string }) {
  const url = `${API_BASE_URL}/deploy/diagnostics/${encodeURIComponent(login)}/${encodeURIComponent(repo)}`;
  const { data, error } = useSWR<Diagnostics>(url, read, { refreshInterval: 30_000 });
  const [logs, setLogs] = useState<Diagnostics | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function loadLogs() {
    setLoading(true); setLogs(null); setLogError(null);
    try { setLogs(await read(`${url}?logs=1`)); }
    catch (err) { setLogError((err as Error).message); }
    finally { setLoading(false); }
  }
  const cpu = data?.usage?.cpuMillicores;
  const memory = data?.usage?.memoryMiB;
  const limit = data?.usage?.cpuLimit;
  const cpuLimit = limit && /^\d+(?:\.\d+)?m?$/.test(limit) ? Number(limit.replace(/m$/, '')) / (limit.endsWith('m') ? 1000 : 1) : null;
  return <section aria-label="앱 실행 정보" className="space-y-4 rounded border border-slate-800 p-5">
    <h2 className="text-lg font-semibold text-slate-100">실행 상태·사용량</h2>
    {error ? <p className="text-sm text-amber-300">{error.message}</p> : !data ? <p className="text-sm text-slate-400">실행 정보를 확인 중입니다.</p> : <>
      <div className="grid gap-3 text-sm sm:grid-cols-3">
        <p>실행 상태 <span className="text-slate-300">{data.state === 'Running' ? '실행 중' : data.state === 'Pending' ? '준비 중' : data.state === 'Failed' ? '실행 실패' : data.state}</span></p>
        <p>CPU <span className="text-slate-300">{cpu == null ? '측정 대기' : `${cpu / 1000}코어`}{cpuLimit != null ? ` / 최대 ${cpuLimit}코어` : ''}</span></p>
        <p>메모리 <span className="text-slate-300">{memory == null ? '측정 대기' : `${memory}MiB`}{data.usage?.memoryLimit ? ` / 최대 ${data.usage.memoryLimit.replace(/Mi$/, 'MiB').replace(/Gi$/, 'GiB')}` : ''}</span></p>
      </div>
      <p className="text-xs text-slate-500">재시작 {data.restarts}회 · 최근 관측값이며 표시가 지연될 수 있습니다. {new Date(data.checkedAt).toLocaleTimeString('ko-KR')} 확인</p>
      <button type="button" onClick={loadLogs} disabled={loading} className="rounded border border-slate-600 px-3 py-2 text-sm disabled:opacity-50">{loading ? '로그 확인 중…' : logs ? '로그 다시 불러오기' : '최근 실행 로그 보기'}</button>
      {(logs || logError) && <div className="space-y-3 text-sm">
        <p className="text-xs text-slate-400">요청할 때만 최근 1시간·최대 100줄을 조회합니다. 일부 인증 정보는 숨기지만 모든 민감정보를 탐지할 수는 없으므로 공유 전 내용을 확인해 주세요.</p>
        {(logs?.logError || logError) && <p role="alert" className="text-amber-300">{logs?.logError ?? logError}</p>}
        {logs?.logs !== null && logs?.logs !== undefined && <>
          <p className="text-slate-400">{logs.logSource === 'initialization' ? '앱 초기화 로그' : '앱 실행 로그'}</p>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-950 p-3 text-xs text-slate-300">{logs.logs || '최근 실행 로그가 없습니다.'}</pre>
        </>}
        <button type="button" onClick={() => { setLogs(null); setLogError(null); }} className="text-xs text-slate-400 underline">로그 닫기</button>
      </div>}
    </>}
  </section>;
}
