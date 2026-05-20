'use client';

import Link from 'next/link';
import clsx from 'clsx';

import { useMe } from '@/lib/auth';

export function ScopeToggle({
  currentScope,
}: {
  currentScope: string | null;
}): import("react").ReactNode {
  const { me } = useMe();
  if (!me?.isAdmin) return null;

  const isMine = currentScope === 'mine';

  return (
    <div
      role="group"
      aria-label="Observatory 가시성 범위"
      className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-950 p-0.5 font-mono text-[11px] uppercase tracking-[0.18em]"
    >
      <ToggleLink href="/observatory" active={!isMine}>
        전체
      </ToggleLink>
      <ToggleLink href="/observatory?scope=mine" active={isMine}>
        운영자만
      </ToggleLink>
    </div>
  );
}

function ToggleLink({
  href,
  active,
  children,
}: {
  href: '/observatory' | '/observatory?scope=mine';
  active: boolean;
  children: React.ReactNode;
}): import("react").ReactNode {
  return (
    <Link
      href={href}
      className={clsx(
        'rounded px-3 py-1.5 transition-colors',
        active
          ? 'bg-zinc-900 text-zinc-100'
          : 'text-zinc-500 hover:text-zinc-200'
      )}
    >
      {children}
    </Link>
  );
}
