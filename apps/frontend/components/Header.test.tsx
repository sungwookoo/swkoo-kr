import { render, screen } from '@testing-library/react';
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

describe('Header', () => {
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
