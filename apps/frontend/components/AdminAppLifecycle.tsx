'use client';

import { useState } from 'react';
import { useSWRConfig } from 'swr';
import { AppLifecycleAction, changeAppLifecycle, useAdminDeployments, useAdminUsers, useDeploymentCapacity } from '@/lib/admin';

const button = 'rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50';

export function AdminAppLifecycle() {
  const { users, isLoading, error } = useAdminUsers(true);
  const [login, setLogin] = useState('');

  return (
    <section aria-labelledby="app-lifecycle-title" className="space-y-4 rounded-lg border border-zinc-800 p-5">
      <div className="space-y-1">
        <h2 id="app-lifecycle-title" className="text-base font-semibold text-zinc-100">배포 앱 관리</h2>
        <p className="text-sm text-zinc-400">일시 중지하면 CPU·메모리 예약을 반환합니다. 저장공간과 데이터, 앱 주소, 배포 슬롯은 유지됩니다.</p>
      </div>
      <label className="flex flex-wrap items-center gap-2 text-sm text-zinc-300">
        사용자 선택
        <select value={login} disabled={isLoading || Boolean(error)}
          onChange={event => setLogin(event.target.value)}
          className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2">
          <option value="">{isLoading ? '불러오는 중…' : 'GitHub 계정 선택'}</option>
          {users?.map(user => <option key={user.githubLogin} value={user.githubLogin}>{user.githubLogin}</option>)}
        </select>
      </label>
      {error && <p role="alert" className="text-sm text-amber-400">사용자 목록을 불러오지 못했습니다.</p>}
      {login && <AppList key={login} login={login} />}
    </section>
  );
}

function AppList({ login }: { login: string }) {
  const { data, error, isLoading, mutate } = useAdminDeployments(login);
  const { mutate: refreshCapacity } = useDeploymentCapacity();
  const [pending, setPending] = useState(false);
  const [selection, setSelection] = useState<{ key: string; action: 'pause' | 'delete' } | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [result, setResult] = useState<{ message: string; failed: boolean } | null>(null);

  async function change(key: string, action: AppLifecycleAction) {
    setPending(true);
    setResult(null);
    try {
      await changeAppLifecycle(login, key, action, action === 'delete' ? confirmation : undefined);
      setResult({ message: { pause: '일시 중지를 요청했습니다.', resume: '다시 시작을 요청했습니다.', delete: '영구 삭제를 요청했습니다.' }[action], failed: false });
      setSelection(null);
      setConfirmation('');
      await Promise.allSettled([mutate(), refreshCapacity()]);
    } catch (err) {
      setResult({ message: (err as Error).message, failed: true });
      void mutate().catch(() => {});
    } finally {
      setPending(false);
    }
  }

  if (isLoading) return <p className="text-sm text-zinc-400">배포 앱을 불러오는 중…</p>;
  return <div className="space-y-3">
    {result && <p role={result.failed ? 'alert' : 'status'} className={result.failed ? 'text-sm text-amber-400' : 'text-sm text-emerald-300'}>{result.message}</p>}
    {error && <p role="alert" className="text-sm text-amber-400">배포 앱 목록을 불러오지 못했습니다. 잠시 후 페이지를 새로고침해 주세요.</p>}
    {!error && data?.length === 0 && <p className="text-sm text-zinc-400">이 사용자의 배포 앱이 없습니다.</p>}
    {!error && data?.map(app => {
      const state = app.state === 'deleting' ? '삭제 중' : app.state === 'paused'
        ? app.stopped === null ? '중지 상태 확인 중' : app.stopped ? '일시 중지됨' : '중지 중'
        : app.ready ? '실행 중' : '배포 상태 확인 중';
      return (
        <article key={app.key} className="space-y-3 rounded border border-zinc-800 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="break-all font-mono text-sm text-zinc-100">{app.fullName}</h3>
            <span className="text-xs text-zinc-300">{state}</span>
          </div>
          <p className="break-all text-xs text-zinc-400">{app.liveUrl}</p>
          {app.state !== 'deleting' && <div className="flex flex-wrap gap-2">
            {app.state === 'active'
              ? <button className={button} disabled={pending} onClick={() => setSelection({ key: app.key, action: 'pause' })}>일시 중지</button>
              : <button className={button} disabled={pending || app.stopped !== true} onClick={() => void change(app.key, 'resume')}>다시 시작</button>}
            <button className={`${button} text-red-300`} disabled={pending} onClick={() => {
              setConfirmation('');
              setSelection({ key: app.key, action: 'delete' });
            }}>영구 삭제</button>
          </div>}
          {selection?.key === app.key && app.state !== 'deleting' && (
            <form className="space-y-3 border-t border-zinc-800 pt-3 text-sm text-zinc-300" onSubmit={event => {
              event.preventDefault();
              if (!pending && (selection.action === 'pause' || confirmation === app.fullName)) void change(app.key, selection.action);
            }}>
              {selection.action === 'delete' ? <>
                <p className="text-red-300">앱과 볼륨 데이터를 영구 삭제합니다. GitHub 원본 저장소와 빌드 이미지는 유지됩니다.</p>
                <label className="block">
                  삭제를 확인하려면 <code>{app.fullName}</code>을 입력하세요.
                  <input value={confirmation} onChange={event => setConfirmation(event.target.value)}
                    disabled={pending} autoComplete="off" spellCheck={false}
                    className="mt-1 block w-full max-w-sm rounded border border-zinc-700 bg-zinc-950 px-3 py-1.5" />
                </label>
              </> : <p>다시 시작할 때까지 이 앱에 접속할 수 없습니다.</p>}
              <div className="flex gap-2">
                <button className={button} disabled={pending || (selection.action === 'delete' && confirmation !== app.fullName)} type="submit">
                  {selection.action === 'delete' ? '삭제 확인' : '중지 확인'}
                </button>
                <button className={button} disabled={pending} type="button" onClick={() => setSelection(null)}>취소</button>
              </div>
            </form>
          )}
        </article>
      );
    })}
  </div>;
}
