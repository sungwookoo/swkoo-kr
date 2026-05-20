'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useSWRConfig } from 'swr';
import clsx from 'clsx';

import { ME_SWR_KEY, logout, useMe } from '@/lib/auth';

const navItems = [
  { href: '/' as const, label: 'Home' },
  { href: '/deploy' as const, label: 'Deploy', emphasis: true },
  { href: '/observatory' as const, label: 'Observatory' },
];

export function Header() {
  const pathname = usePathname();
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <header
      className={clsx(
        'fixed left-0 right-0 top-0 z-50 transition-all duration-300',
        isScrolled
          ? 'border-b border-zinc-900 bg-black/80 backdrop-blur-md'
          : 'bg-transparent'
      )}
    >
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        {/* Logo */}
        <Link
          href="/"
          className="flex items-center gap-2 text-lg font-bold text-zinc-100 transition-colors hover:text-white"
        >
          <span className="text-xl">🐟</span>
          <span>swkoo.kr</span>
        </Link>

        {/* Navigation */}
        <nav className="flex items-center gap-6">
          <ul className="flex items-center gap-1">
            {navItems.map((item) => {
              const isActive =
                item.href === '/'
                  ? pathname === '/'
                  : pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={clsx(
                      'rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-zinc-900 text-zinc-50'
                        : item.emphasis
                          ? 'text-zinc-100 hover:bg-zinc-900 hover:text-white'
                          : 'text-zinc-500 hover:bg-zinc-900/50 hover:text-zinc-100'
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>

          <div className="border-l border-zinc-900 pl-4">
            <UserMenu />
          </div>
        </nav>
      </div>
    </header>
  );
}

function UserMenu(): import("react").ReactNode {
  const { me, isLoading } = useMe();
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent): void => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (isLoading) {
    // Reserve width so the header doesn't reflow once /auth/me resolves.
    return <div className="size-8 rounded-full bg-zinc-900/40" aria-hidden />;
  }

  if (!me) {
    return (
      <Link
        href="/deploy"
        className="rounded-md px-3 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-900/50 hover:text-zinc-100"
      >
        Sign in
      </Link>
    );
  }

  const handleLogout = async (): Promise<void> => {
    setOpen(false);
    await logout();
    await mutate(ME_SWR_KEY, null, { revalidate: false });
    router.push('/');
    router.refresh();
  };

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-full p-0.5 text-sm text-zinc-300 outline-none transition-colors hover:bg-zinc-900/50 focus-visible:ring-2 focus-visible:ring-zinc-700"
      >
        {me.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={me.avatarUrl}
            alt=""
            className="size-8 rounded-full border border-zinc-900"
          />
        ) : (
          <span className="flex size-8 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 text-xs font-medium text-zinc-300">
            {me.githubLogin.slice(0, 2).toUpperCase()}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-56 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950 shadow-lg shadow-black/40"
        >
          <div className="border-b border-zinc-900 px-3 py-3">
            <p className="font-mono text-sm text-zinc-100">@{me.githubLogin}</p>
            {me.name && (
              <p className="truncate text-xs text-zinc-500">{me.name}</p>
            )}
          </div>
          <div className="py-1">
            <MenuLink href="/deploy" onClick={() => setOpen(false)}>
              내 배포
            </MenuLink>
            {me.isAdmin && (
              <MenuLink href="/admin" onClick={() => setOpen(false)}>
                관리자
              </MenuLink>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={handleLogout}
              className="block w-full px-3 py-2 text-left text-sm text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-100"
            >
              로그아웃
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuLink({
  href,
  onClick,
  children,
}: {
  href: '/deploy' | '/admin';
  onClick: () => void;
  children: React.ReactNode;
}): import("react").ReactNode {
  return (
    <Link
      href={href}
      role="menuitem"
      onClick={onClick}
      className="block px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-900 hover:text-zinc-100"
    >
      {children}
    </Link>
  );
}
