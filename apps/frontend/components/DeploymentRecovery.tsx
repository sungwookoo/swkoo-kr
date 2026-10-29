'use client';

import { useEffect, useState } from 'react';
import { API_BASE_URL } from '@/lib/api-base';

type Reservation = { login: string; createdAt: number };
type Plan = { login: string; canRelease: boolean; digest: string; registration: boolean; application: boolean; namespace: boolean; persistentVolumes: number };
const base = `${API_BASE_URL}/admin/deployment-recovery`;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: 'include', cache: 'no-store' });
  const body = await response.text();
  let data;
  try { data = body ? JSON.parse(body) : null; } catch { throw new Error('서버 응답을 읽지 못했습니다. 다시 조회해 주세요.'); }
  if (!response.ok) throw new Error(typeof data?.message === 'string' ? data.message : `요청을 처리하지 못했습니다 (${response.status}).`);
  if (!data) throw new Error('서버 응답이 비어 있습니다. 다시 조회해 주세요.');
  return data as T;
}

export function DeploymentRecovery(): import('react').ReactNode {
  const [rows, setRows] = useState<Reservation[] | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function load() { setRows((await request<{ reservations: Reservation[] }>(base)).reservations); }
  useEffect(() => { load().catch(error => setMessage(error.message)); }, []);
  async function inspect(login: string) {
    setBusy(true); setPlan(null); setMessage('');
    try { setPlan(await request<Plan>(`${base}/${encodeURIComponent(login)}`)); }
    catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  async function release() {
    if (!plan?.canRelease) return;
    setBusy(true); setMessage('');
    const reviewed = plan; setPlan(null);
    try {
      await request(`${base}/${encodeURIComponent(reviewed.login)}/release`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ digest: reviewed.digest }) });
      setMessage('미사용 배포 예약을 해제했습니다.'); await load();
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="space-y-4 rounded-lg border border-zinc-800 p-5" aria-label="배포 예약 복구">
    <h2 className="text-lg font-semibold text-zinc-100">배포 예약 복구</h2>
    <p className="text-sm text-zinc-400">등록 도중 중단되어 남은 예약을 확인합니다. 앱 등록과 실행·저장 자원이 모두 없을 때만 예약을 해제할 수 있습니다. 저장 데이터는 삭제하지 않습니다.</p>
    <button type="button" disabled={busy} className="text-sm text-zinc-300 underline disabled:opacity-50" onClick={() => { setPlan(null); setMessage(''); load().catch(error => setMessage(error.message)); }}>예약 목록 새로고침</button>
    {rows === null && <p className="text-sm text-zinc-500">예약 목록을 확인하는 중…</p>}
    {rows?.length === 0 && <p className="text-sm text-zinc-500">남은 배포 예약이 없습니다.</p>}
    {rows?.map(row => <div key={row.login} className="flex items-center justify-between gap-4 text-sm text-zinc-300">
      <span>{row.login} · {new Date(row.createdAt).toLocaleString('ko-KR')}</span>
      {row.login.startsWith('deleted_') ? <span className="text-amber-300">익명화된 예약 · 운영자 별도 확인</span> : <button type="button" disabled={busy} onClick={() => inspect(row.login)} className="underline disabled:opacity-50">상태 확인</button>}
    </div>)}
    {plan && <div className="space-y-3 border-t border-zinc-800 pt-3 text-sm text-zinc-300">
      <p>{plan.login} — 등록 {plan.registration ? '있음' : '없음'} · 배포 관리 {plan.application ? '있음' : '없음'} · 실행 공간 {plan.namespace ? '있음' : '없음'} · 저장 볼륨 {plan.persistentVolumes}개</p>
      {plan.canRelease ? <button type="button" disabled={busy} onClick={release} className="rounded border border-amber-700 px-3 py-2 text-amber-200 disabled:opacity-50">미사용 예약 해제</button> : <p>예약을 유지합니다. 남은 배포는 기존 앱 관리 화면에서 재시도하거나 제거한 뒤 다시 확인해 주세요.</p>}
    </div>}
    {message && <p role="status" className="text-sm text-amber-300">{message}</p>}
  </section>;
}
