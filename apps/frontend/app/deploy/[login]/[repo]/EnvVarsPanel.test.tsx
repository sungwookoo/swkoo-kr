import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

// Same Next/SWR stubs as the StageRow tests. We're testing the env
// panel in isolation so we don't need real auth/router/SWR machinery.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// Stub SWR. useEnvVars() consumes useSWR(); return a STABLE empty-vars
// payload — a fresh `{ vars: {} }` per render would change the object
// identity each pass, retrigger the panel's useEffect → setRows, and
// loop until heap exhaustion. The vitest worker actually OOMs in that
// case, which is how this footgun was found.
vi.mock('swr', () => {
  const STABLE_VARS = { vars: {} };
  const STABLE_RESULT = {
    data: STABLE_VARS,
    error: undefined,
    isLoading: false,
  };
  return {
    default: () => STABLE_RESULT,
    useSWRConfig: () => ({ mutate: vi.fn() }),
  };
});

// page.client.tsx pulls in DomainPanel which transitively imports the
// domain library + a few other heavy modules. Stub it — the env panel
// is the only export we exercise from this file.
vi.mock('@/components/DomainPanel', () => ({
  DomainPanel: () => null,
}));
vi.mock('@/lib/account', () => ({
  useLatestScan: () => ({ scan: null, isLoading: false, error: undefined }),
  deleteMyAccount: vi.fn(),
  exportMyData: vi.fn(),
}));

import type { StorageProfile } from '@/lib/deploy';
import { EnvVarsPanel } from './page.client';

const PRISMA: StorageProfile = {
  type: 'prisma-sqlite',
  size: '1Gi',
  mountPath: '/data',
  databaseUrl: 'file:/data/app.db',
  initMode: 'db-push',
};

describe('EnvVarsPanel — DATABASE_URL guard', () => {
  it('shows the platform-managed banner when storageProfile=prisma-sqlite', () => {
    render(<EnvVarsPanel login="alice" repo="sample" storageProfile={PRISMA} />);
    expect(screen.getByRole('note')).toHaveTextContent('Prisma SQLite');
    expect(screen.getByRole('note')).toHaveTextContent('file:/data/app.db');
    expect(screen.getByRole('note')).toHaveTextContent(
      /플랫폼이.+관리하므로 여기서 따로 추가할 수 없습니다/
    );
  });

  it('does NOT show the banner when no storageProfile is set', () => {
    render(<EnvVarsPanel login="alice" repo="sample" />);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('typing DATABASE_URL into a new row disables Save + shows the reserved warning', async () => {
    const user = userEvent.setup();
    render(<EnvVarsPanel login="alice" repo="sample" storageProfile={PRISMA} />);

    // Add a new env row and type DATABASE_URL as the key.
    await user.click(screen.getByRole('button', { name: /Add variable/ }));
    const keyInput = screen.getByPlaceholderText('APP_BASE_URL');
    await user.type(keyInput, 'DATABASE_URL');

    expect(keyInput).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/플랫폼이 관리하는 키는 추가할 수 없어요/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled();
  });

  it('typing an unrelated key (APP_BASE_URL) does NOT mark the row reserved', async () => {
    const user = userEvent.setup();
    render(<EnvVarsPanel login="alice" repo="sample" storageProfile={PRISMA} />);

    await user.click(screen.getByRole('button', { name: /Add variable/ }));
    const keyInput = screen.getByPlaceholderText('APP_BASE_URL');
    await user.type(keyInput, 'APP_BASE_URL');

    expect(keyInput).toHaveAttribute('aria-invalid', 'false');
    expect(screen.queryByText(/플랫폼이 관리하는 키는 추가할 수 없어요/)).not.toBeInTheDocument();
  });

  it('without storageProfile, DATABASE_URL is just an ordinary key (no reservation)', async () => {
    const user = userEvent.setup();
    render(<EnvVarsPanel login="alice" repo="sample" />);

    await user.click(screen.getByRole('button', { name: /Add variable/ }));
    const keyInput = screen.getByPlaceholderText('APP_BASE_URL');
    await user.type(keyInput, 'DATABASE_URL');

    // No storageProfile → not reserved. Save button is constrained only
    // by the dirty/invalid checks, not by reservation.
    expect(keyInput).toHaveAttribute('aria-invalid', 'false');
  });
});
