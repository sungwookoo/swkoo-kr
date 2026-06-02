import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

// Header uses next/navigation hooks; stub them so the component
// mounts cleanly under jsdom. SWR is also touched indirectly via
// useMe() — replace it with a static "not signed in" response so
// the test doesn't try to hit /api/auth/me.
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('swr', () => ({
  default: () => ({ data: null, error: undefined, isLoading: false }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { Header } from './Header';

describe('Header — desktop nav links', () => {
  it('includes the About link in the nav (regression for the split)', () => {
    render(<Header />);
    const about = screen.getByRole('link', { name: 'About' });
    expect(about).toHaveAttribute('href', '/about');
  });

  it('still includes Home, Deploy, and Observatory', () => {
    render(<Header />);
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Deploy' })).toHaveAttribute('href', '/deploy');
    expect(screen.getByRole('link', { name: 'Observatory' })).toHaveAttribute('href', '/observatory');
  });
});

describe('Header — mobile menu', () => {
  it('renders a hamburger trigger labelled "Open menu" initially', () => {
    render(<Header />);
    const trigger = screen.getByRole('button', { name: 'Open menu' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('aria-controls', 'mobile-nav');
  });

  it('mobile panel is absent until the trigger is clicked', () => {
    render(<Header />);
    // The mobile panel has id="mobile-nav". Before opening it should
    // not be in the DOM at all (we conditional-render, not just hide).
    expect(document.getElementById('mobile-nav')).toBeNull();
  });

  it('clicking the trigger opens the panel + flips aria-expanded + relabels to "Close menu"', async () => {
    const user = userEvent.setup();
    render(<Header />);

    await user.click(screen.getByRole('button', { name: 'Open menu' }));

    const trigger = screen.getByRole('button', { name: 'Close menu' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById('mobile-nav')).not.toBeNull();
  });

  it('opened panel contains the four nav links + a Sign in CTA (anonymous user)', async () => {
    const user = userEvent.setup();
    render(<Header />);
    await user.click(screen.getByRole('button', { name: 'Open menu' }));

    // Each nav label appears twice now (desktop nav + mobile panel),
    // so use getAllByRole and assert ≥2.
    for (const label of ['Home', 'Deploy', 'Observatory', 'About']) {
      const links = screen.getAllByRole('link', { name: label });
      expect(links.length).toBeGreaterThanOrEqual(2);
    }
    // Anonymous: Sign in CTA present in the mobile slab.
    expect(screen.getAllByRole('link', { name: 'Sign in' }).length).toBeGreaterThanOrEqual(1);
  });

  it('clicking the trigger again closes the panel', async () => {
    const user = userEvent.setup();
    render(<Header />);

    const trigger = () =>
      screen.getByRole('button', { name: /Open menu|Close menu/ });

    await user.click(trigger());
    expect(document.getElementById('mobile-nav')).not.toBeNull();

    await user.click(trigger());
    expect(document.getElementById('mobile-nav')).toBeNull();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('Header — Deploy emphasis vs active', () => {
  it('Deploy (non-active) uses emerald accent and has NO active background', () => {
    render(<Header />);
    // We mocked usePathname → '/', so Deploy is non-active.
    // Find the Deploy link inside the desktop ul (the first match).
    const deploy = screen.getAllByRole('link', { name: 'Deploy' })[0];
    expect(deploy).not.toHaveAttribute('aria-current');
    expect(deploy.className).toMatch(/text-emerald-300/);
    // Active state is "bg-zinc-900" as a base utility. The emphasis
    // non-active state may still use it under a `hover:` variant
    // (which is fine — only the base classes determine the
    // non-interactive appearance).
    const baseClasses = deploy.className.split(/\s+/).filter((c) => !c.includes(':'));
    expect(baseClasses).not.toContain('bg-zinc-900');
  });
});
