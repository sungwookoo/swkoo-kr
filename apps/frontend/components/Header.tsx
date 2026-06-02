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
  { href: '/about' as const, label: 'About' },
];

export function Header() {
  const pathname = usePathname();
  const [isScrolled, setIsScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Auto-close the mobile panel on navigation. Without this, tapping
  // a link keeps the overlay open while the next page mounts — feels
  // sticky and obscures the page content briefly.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  return (
    <header
      className={clsx(
        'fixed left-0 right-0 top-0 z-50 transition-all duration-300',
        isScrolled || mobileOpen
          ? 'border-b border-zinc-900 bg-black/80 backdrop-blur-md'
          : 'bg-transparent'
      )}
    >
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        {/* Brand */}
        <Link
          href="/"
          className="flex items-center gap-2 text-lg font-bold text-zinc-100 transition-colors hover:text-white"
        >
          <span className="text-xl">🐟</span>
          <span>swkoo.kr</span>
        </Link>

        {/* Desktop nav (md+). Hidden on small viewports to prevent
            horizontal overflow at 390 px — replaced by the hamburger
            below. */}
        <nav className="hidden items-center gap-6 md:flex">
          <ul className="flex items-center gap-1">
            {navItems.map((item) => (
              <li key={item.href}>
                <NavLink item={item} pathname={pathname} />
              </li>
            ))}
          </ul>

          <div className="border-l border-zinc-900 pl-4">
            <UserMenu />
          </div>
        </nav>

        {/* Mobile menu trigger (<md). Plain SVG icons — no library;
            stroke=currentColor so we inherit the link colour. */}
        <button
          type="button"
          aria-expanded={mobileOpen}
          aria-controls="mobile-nav"
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          onClick={() => setMobileOpen((v) => !v)}
          className="rounded-md p-2 text-zinc-300 transition-colors hover:bg-zinc-900/50 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-700 md:hidden"
        >
          {mobileOpen ? <CloseIcon /> : <MenuIcon />}
        </button>
      </div>

      {/* Mobile menu panel. Renders below the bar; only on <md.
          Tap-outside-to-close is intentionally NOT bound — the panel
          is full-width so an accidental tap is rare; explicit close
          via the icon or by tapping a link covers the dismissal. */}
      {mobileOpen && (
        <div
          id="mobile-nav"
          className="border-t border-zinc-900 bg-black/95 backdrop-blur-md md:hidden"
        >
          <nav className="mx-auto max-w-5xl px-6 py-4">
            <ul className="flex flex-col gap-1">
              {navItems.map((item) => (
                <li key={item.href}>
                  <NavLink item={item} pathname={pathname} block />
                </li>
              ))}
            </ul>
            <div className="mt-3 border-t border-zinc-900 pt-3">
              <MobileAccountSlab />
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}

interface NavItem {
  href: '/' | '/deploy' | '/observatory' | '/about';
  label: string;
  emphasis?: boolean;
}

/** Single source of truth for the active-vs-emphasis-vs-default
 *  styling. Active wins (it's the strongest state). Emphasis (Deploy)
 *  uses an emerald accent — chromatically distinct from active so
 *  the user can't mistake "primary CTA" for "I'm on this page". */
function NavLink({
  item,
  pathname,
  block,
}: {
  item: NavItem;
  pathname: string;
  block?: boolean;
}) {
  const isActive =
    item.href === '/'
      ? pathname === '/'
      : pathname === item.href || pathname.startsWith(`${item.href}/`);
  return (
    <Link
      href={item.href}
      aria-current={isActive ? 'page' : undefined}
      className={clsx(
        'rounded-md px-3 py-2 text-sm font-medium transition-colors',
        block ? 'block w-full' : '',
        isActive
          ? 'bg-zinc-900 text-zinc-50'
          : item.emphasis
            ? 'text-emerald-300 hover:bg-zinc-900/40 hover:text-emerald-200'
            : 'text-zinc-500 hover:bg-zinc-900/50 hover:text-zinc-100'
      )}
    >
      {item.label}
    </Link>
  );
}

function MobileAccountSlab(): import('react').ReactNode {
  const { me, isLoading } = useMe();
  const router = useRouter();
  const { mutate } = useSWRConfig();

  if (isLoading) {
    return <div className="h-9 rounded-md bg-zinc-900/40" aria-hidden />;
  }

  if (!me) {
    return (
      <Link
        href="/deploy"
        className="block rounded-md px-3 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-900/50 hover:text-zinc-100"
      >
        Sign in
      </Link>
    );
  }

  const handleLogout = async (): Promise<void> => {
    await logout();
    await mutate(ME_SWR_KEY, null, { revalidate: false });
    router.push('/');
    router.refresh();
  };

  return (
    <div className="space-y-1">
      <p className="px-3 py-1 font-mono text-xs text-zinc-500">@{me.githubLogin}</p>
      <Link
        href="/deploy"
        className="block rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-900/50 hover:text-zinc-100"
      >
        내 배포
      </Link>
      {me.isAdmin && (
        <Link
          href="/admin"
          className="block rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-900/50 hover:text-zinc-100"
        >
          관리자
        </Link>
      )}
      <button
        type="button"
        onClick={handleLogout}
        className="block w-full rounded-md px-3 py-2 text-left text-sm text-zinc-400 hover:bg-zinc-900/50 hover:text-zinc-100"
      >
        로그아웃
      </button>
    </div>
  );
}

function UserMenu(): import('react').ReactNode {
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
}): import('react').ReactNode {
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

function MenuIcon(): import('react').ReactNode {
  return (
    <svg
      aria-hidden
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <line x1="3" y1="6" x2="17" y2="6" />
      <line x1="3" y1="10" x2="17" y2="10" />
      <line x1="3" y1="14" x2="17" y2="14" />
    </svg>
  );
}

function CloseIcon(): import('react').ReactNode {
  return (
    <svg
      aria-hidden
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <line x1="5" y1="5" x2="15" y2="15" />
      <line x1="15" y1="5" x2="5" y2="15" />
    </svg>
  );
}
