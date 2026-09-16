'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { API_BASE_URL } from '@/lib/api-base';

interface Plan {
  id: string; repo: string; sha: string; base: string;
  state: 'preparing' | 'ready' | 'blocked' | 'failed' | 'creating' | 'pr';
  changes?: { path: string; from: string | null; to: string | null }[];
  before?: number; after?: number; message?: string; prUrl?: string;
}
const policy = 'npm-lockfile-v1';
async function request(url: string, body?: object): Promise<Plan | null> {
  const response = await fetch(url, { credentials: 'include', ...(body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : {}) });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(response.status === 401 ? '다시 로그인해 주세요.' :
      response.status === 403 ? '본인 배포 및 GitHub App 설치 권한을 확인해 주세요.' :
      typeof data?.message === 'string' ? data.message : '요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.');
  }
  return response.json();
}

export function SecurityPatchPanel({ repo }: { repo: string }) {
  const url = `${API_BASE_URL}/deploy/security-patch`;
  const { data: plan, error: loadError, isLoading, mutate } = useSWR<Plan | null>(`${url}?repo=${encodeURIComponent(repo)}`, request,
    { refreshInterval: data => data?.state === 'preparing' ? 5000 : 0, revalidateOnFocus: false, shouldRetryOnError: false });
  const [consent, setConsent] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function action(kind: 'prepare' | 'pr') {
    setBusy(true); setError('');
    try {
      await mutate(await request(`${url}/${kind}`, { repo, consent: policy, ...(kind === 'pr' ? { id: plan?.id } : {}) }), false);
      setReviewed(false);
    } catch (err) { setError((err as Error).message); await mutate(); }
    finally { setBusy(false); }
  }
  const canPrepare = !plan || ['blocked', 'failed', 'pr'].includes(plan.state);
  return <section className="space-y-4 rounded-xl border border-slate-800 p-5" aria-label="선택형 보안 패치">
    <h2 className="text-lg font-semibold text-slate-100">보안 수정 PR 요청</h2>
    <p className="text-sm text-slate-300">원할 때만 수정안을 준비하고, 변경 내용을 확인한 후 GitHub 초안 PR을 만들 수 있습니다. 서비스는 자동 병합하지 않습니다.</p>
    <p className="text-sm text-slate-400">현재는 공개 npm 패키지의 기존 버전 범위 안에서 package-lock.json만 수정합니다. 메이저 버전·0.x minor 업그레이드, 앱 코드·DB·Dockerfile 변경은 지원하지 않습니다.</p>
    {(error || loadError) && <p role="alert" className="text-sm text-amber-400">{error || loadError.message}</p>}
    {isLoading && <p className="text-sm text-slate-400">수정 요청 상태 확인 중…</p>}
    {plan?.state === 'pr' && plan.prUrl && <a className="inline-block text-emerald-300 underline" href={plan.prUrl} target="_blank" rel="noopener noreferrer">GitHub에서 생성된 PR 확인</a>}
    {canPrepare && !isLoading && !loadError && <>
      <label className="flex items-start gap-2 text-sm text-slate-300"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} className="mt-1" />
        <span>수정안 준비를 요청합니다. 의존성 이름·버전은 npm 공개 레지스트리에 전송되며, 준비 단계에서는 저장소를 변경하지 않습니다.</span>
      </label>
      <button className="rounded bg-slate-100 px-4 py-2 text-sm text-slate-950 disabled:opacity-40" disabled={!consent || busy} onClick={() => void action('prepare')}>보안 수정안 준비</button>
    </>}
    {plan?.state === 'preparing' && <p role="status" className="text-sm text-slate-300">격리된 환경에서 수정안을 준비하고 있습니다. 최대 약 7분이 소요되며 이 화면으로 돌아와 결과를 확인할 수 있습니다.</p>}
    {plan?.message && <p className="text-sm text-amber-300">{plan.message}</p>}
    {plan && ['ready', 'creating'].includes(plan.state) && <>
      <p className="text-sm text-slate-300">대상: {plan.repo} · {plan.base} · {plan.sha.slice(0, 7)}</p>
      <p className="text-sm text-slate-300">npm audit 취약점: {plan.before} → {plan.after} (운영 이미지 스캔과 별도 집계)</p>
      <div className="max-h-64 overflow-auto"><table className="w-full text-left text-xs text-slate-300"><thead><tr><th>패키지 경로</th><th>현재</th><th>제안</th></tr></thead><tbody>
        {plan.changes?.map(c => <tr key={c.path}><td className="break-all py-2 pr-2">{c.path}</td><td>{c.from ?? '없음'}</td><td>{c.to ?? '제거'}</td></tr>)}
      </tbody></table></div>
      <p className="text-sm text-amber-300">앱 테스트·프로덕션 빌드·DB 연결은 미검증입니다. 초안 PR에서 별도로 확인하세요. 병합하면 기존 자동 배포가 실행될 수 있습니다.</p>
      <label className="flex items-start gap-2 text-sm text-slate-300"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} className="mt-1" /><span>위 변경안으로 별도 브랜치와 초안 PR을 만드는 데 동의합니다. 병합은 직접 결정합니다.</span></label>
      <button className="rounded bg-emerald-300 px-4 py-2 text-sm text-slate-950 disabled:opacity-40" disabled={!reviewed || busy || !!loadError} onClick={() => void action('pr')}>{plan.state === 'creating' ? 'PR 생성 재시도' : '검토용 초안 PR 만들기'}</button>
    </>}
    <p className="text-xs text-slate-500">수정안은 24시간 후 만료되고 이후 1시간 안에 정리됩니다. PR 생성 시 기본 브랜치가 기준 commit과 같은지 다시 확인합니다. GitHub에 생성한 브랜치와 PR은 직접 관리할 수 있습니다.</p>
  </section>;
}
