'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSWRConfig } from 'swr';
import clsx from 'clsx';

import { useMe } from '@/lib/auth';
import { DeploymentRecovery } from '@/components/DeploymentRecovery';
import { DeploymentCapacity } from '@/components/DeploymentCapacity';
import { AdminAppLifecycle } from '@/components/AdminAppLifecycle';
import {
  ADMIN_USERS_SWR_KEY,
  AdminUser,
  setUserAllowed,
  setUserDeployPolicy,
  useAdminUsers,
} from '@/lib/admin';

export function AdminPageClient(): import("react").ReactNode {
  const { me, isLoading: meLoading } = useMe();
  const router = useRouter();

  // Bounce non-admins. We don't render anything admin-shaped for them, so
  // the URL doesn't leak structure. Signed-out → /deploy (sign-in lives there);
  // signed-in but not admin → /. Phase 3.2: admins also go through consent.
  useEffect(() => {
    if (meLoading) return;
    if (!me) {
      router.replace('/deploy');
    } else if (me.requiresConsent) {
      router.replace('/consent?next=/admin');
    } else if (!me.isAdmin) {
      router.replace('/');
    }
  }, [me, meLoading, router]);

  if (meLoading || !me || me.requiresConsent || !me.isAdmin) {
    return <Shell><p className="text-zinc-500">Loading…</p></Shell>;
  }

  return (
    <Shell>
      <div className="w-full max-w-5xl space-y-8">
        <header className="space-y-2 border-b border-zinc-900 pb-6">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-zinc-500">
            Admin
          </p>
          <h1 className="display-tight text-balance text-3xl font-semibold text-zinc-50 sm:text-4xl">
            사용자 관리
          </h1>
          <p className="text-sm text-zinc-400">
            배포 권한과 계정별 한도를 설정합니다. 앱 수 한도는 새 앱을 등록할 때,
            CPU·메모리 한도는 배포 화면에서 앱을 새로 등록하거나 다시 등록할 때 적용됩니다.
            한도를 저장해도 실행 중인 앱은 중단되지 않습니다.
          </p>
        </header>

        <DeploymentCapacity />
        <UsersTable />
        <AdminAppLifecycle />
        <DeploymentRecovery />
      </div>
    </Shell>
  );
}

function UsersTable(): import("react").ReactNode {
  const { users, isLoading, error } = useAdminUsers(true);

  if (isLoading) return <p className="text-zinc-500">사용자 목록을 가져오는 중…</p>;
  if (error) {
    return (
      <p className="text-sm text-amber-400">
        목록을 불러오지 못했습니다: {error.message}
      </p>
    );
  }
  if (!users || users.length === 0) {
    return <p className="text-zinc-500">아직 OAuth로 사인인한 사용자가 없습니다.</p>;
  }

  const pendingCount = users.filter((u) => !u.isAllowed).length;

  return (
    <div className="space-y-3">
      {pendingCount > 0 && (
        <div className="inline-flex items-center gap-2 rounded-md border border-amber-700/40 bg-amber-500/5 px-3 py-1.5">
          <span className="size-1.5 rounded-full bg-amber-400" />
          <span className="font-mono text-xs uppercase tracking-[0.18em] text-amber-200">
            승인 대기 {pendingCount}명
          </span>
        </div>
      )}
      <div className="overflow-x-auto rounded-md border border-zinc-900">
        <table className="w-full text-left text-sm">
        <thead className="border-b border-zinc-900 bg-zinc-950 text-xs uppercase tracking-wider text-zinc-500">
          <tr>
            <th className="px-4 py-3 font-medium">사용자</th>
            <th className="px-4 py-3 font-medium">가입</th>
            <th className="px-4 py-3 font-medium">최근 로그인</th>
            <th className="px-4 py-3 font-medium">배포 한도</th>
            <th className="px-4 py-3 font-medium text-right">배포 허용</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-900">
          {users.map((u) => (
            <UserRow key={u.githubLogin} user={u} />
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function UserRow({ user }: { user: AdminUser }): import("react").ReactNode {
  return (
    <tr className="text-zinc-300">
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          {user.avatarUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={user.avatarUrl} alt="" className="h-7 w-7 rounded-full" />
          )}
          <div className="flex flex-col">
            <span className="font-mono text-zinc-100">{user.githubLogin}</span>
            {user.name && <span className="text-xs text-zinc-500">{user.name}</span>}
          </div>
        </div>
      </td>
      <td className="px-4 py-3 font-mono text-xs text-zinc-500">
        {formatDate(user.createdAt)}
      </td>
      <td className="px-4 py-3 font-mono text-xs text-zinc-500">
        {formatRelative(user.lastLoginAt)}
      </td>
      <td className="px-4 py-3">
        <DeployPolicyForm key={JSON.stringify(user.deployPolicy)} user={user} />
      </td>
      <td className="px-4 py-3 text-right">
        <AllowToggle login={user.githubLogin} isAllowed={user.isAllowed} />
      </td>
    </tr>
  );
}

function DeployPolicyForm({ user }: { user: AdminUser }) {
  const { mutate } = useSWRConfig();
  const policy = user.deployPolicy ?? { maxApps: 1, cpuMillicores: 500, memoryMiB: 512 };
  const [apps, setApps] = useState(policy.maxApps === null ? '' : String(policy.maxApps));
  const [cpu, setCpu] = useState(String(policy.cpuMillicores));
  const [memory, setMemory] = useState(String(policy.memoryMiB));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  return <details>
    <summary className="cursor-pointer whitespace-nowrap text-sm">
      {policy.maxApps === null ? '앱 수 제한 없음' : `앱 최대 ${policy.maxApps}개`} · {policy.cpuMillicores / 1000}코어 · {policy.memoryMiB}MiB
    </summary>
    <form className="mt-2 min-w-56 space-y-2 text-xs" onSubmit={async event => {
      event.preventDefault();
      setPending(true);
      setError('');
      try {
        const saved = await setUserDeployPolicy(user.githubLogin, {
          maxApps: apps === '' ? null : Number(apps), cpuMillicores: Number(cpu), memoryMiB: Number(memory),
        });
        await mutate(ADMIN_USERS_SWR_KEY, (data?: { users: AdminUser[] }) => data && ({
          users: data.users.map(row => row.githubLogin === user.githubLogin ? { ...row, deployPolicy: saved } : row),
        }), { revalidate: false });
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setPending(false);
      }
    }}>
      <fieldset disabled={pending} className="grid grid-cols-2 items-center gap-2">
        <label htmlFor={`apps-${user.githubLogin}`}>최대 앱 수</label>
        <input id={`apps-${user.githubLogin}`} type="number" min="0" step="1" value={apps} placeholder="기본값"
          className="w-full rounded border border-zinc-700 bg-zinc-950 p-1" onChange={event => setApps(event.target.value)} />
        <label htmlFor={`cpu-${user.githubLogin}`}>앱당 CPU (m)</label>
        <input id={`cpu-${user.githubLogin}`} type="number" min="100" max="4000" step="1" required value={cpu}
          className="w-full rounded border border-zinc-700 bg-zinc-950 p-1" onChange={event => setCpu(event.target.value)} />
        <label htmlFor={`memory-${user.githubLogin}`}>앱당 메모리 (MiB)</label>
        <input id={`memory-${user.githubLogin}`} type="number" min="256" max="8192" step="1" required value={memory}
          className="w-full rounded border border-zinc-700 bg-zinc-950 p-1" onChange={event => setMemory(event.target.value)} />
      </fieldset>
      <p className="text-zinc-400">앱 수를 비우면 계정의 기본값으로 돌아갑니다. CPU 1000m는 1코어입니다.</p>
      {error && <p role="alert" className="text-amber-400">{error}</p>}
      <button disabled={pending} className="rounded border border-zinc-700 px-3 py-1 disabled:opacity-50">
        {pending ? '저장 중…' : '한도 저장'}
      </button>
    </form>
  </details>;
}

function AllowToggle({
  login,
  isAllowed,
}: {
  login: string;
  isAllowed: boolean;
}): import("react").ReactNode {
  const { mutate } = useSWRConfig();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = async (): Promise<void> => {
    const next = !isAllowed;
    setPending(true);
    setError(null);
    try {
      // Optimistic: flip locally, then revalidate to confirm.
      await mutate(
        ADMIN_USERS_SWR_KEY,
        async () => {
          await setUserAllowed(login, next);
          return undefined;
        },
        { revalidate: true }
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleToggle}
        disabled={pending}
        aria-pressed={isAllowed}
        className={clsx(
          'relative inline-flex h-6 w-11 items-center rounded-full border transition-colors disabled:opacity-50',
          isAllowed
            ? 'border-emerald-500/40 bg-emerald-500/20'
            : 'border-zinc-800 bg-zinc-900'
        )}
      >
        <span
          className={clsx(
            'inline-block h-4 w-4 transform rounded-full transition-transform',
            isAllowed ? 'translate-x-6 bg-emerald-300' : 'translate-x-1 bg-zinc-500'
          )}
        />
      </button>
      {error && <span className="text-[10px] text-amber-400">{error}</span>}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }): import("react").ReactNode {
  return (
    <main className="relative isolate min-h-[calc(100vh-12rem)] w-full px-6 py-16 sm:py-20">
      <div className="mx-auto flex w-full justify-center">{children}</div>
    </main>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}일 전`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}개월 전`;
  return `${Math.floor(months / 12)}년 전`;
}
