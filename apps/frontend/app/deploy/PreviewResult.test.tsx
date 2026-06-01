import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Stub Next's <Link> — the "지원 스택" link uses it. In tests we don't
// need real routing; a passthrough <a> is enough.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

// Mock the navigation + SWR-backed hooks so DeployTrigger renders in
// isolation without touching network/router.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/lib/deploy', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/deploy')>();
  return {
    ...orig,
    checkSubdomain: vi.fn(async () => ({ available: true })),
    registerDeploy: vi.fn(async () => ({
      ok: true as const,
      fullName: 'alice/sample',
      subdomain: 'alice-sample',
      liveUrl: 'https://x.apps.swkoo.kr',
      userRepoCommit: 'a',
      manifestRepoCommit: 'b',
    })),
  };
});

import type { PreviewCheck, StackPreview } from '@/lib/deploy';

// Importing the page client pulls in a tree of components — that's fine,
// they're all client components and jsdom renders them.
import { _PreviewResultForTest as PreviewResult } from './page.client';

function passCheck(key: PreviewCheck['key'], label: string): PreviewCheck {
  return { key, status: 'pass', label, message: `${label} OK` };
}

const ALL_PASS: PreviewCheck[] = [
  passCheck('repo_access', 'GitHub repo 접근'),
  passCheck('default_branch', '기본 브랜치'),
  passCheck('package_json', 'package.json'),
  passCheck('next_dep', 'Next.js 의존성'),
  passCheck('build_script', 'scripts.build'),
  passCheck('package_lockfile', 'package-lock.json'),
  passCheck('repo_casing', 'Repo 이름 casing'),
];

describe('PreviewResult — checks list rendering', () => {
  it('renders the 배포 전 점검 header and one row per check', () => {
    const preview: StackPreview = {
      stack: 'nextjs',
      packageName: 'sample',
      port: 3000,
      nodeEngine: null,
      checks: ALL_PASS,
    };
    render(<PreviewResult fullName="alice/sample" preview={preview} />);

    expect(screen.getByText('배포 전 점검')).toBeInTheDocument();
    // Each label appears (label span + the synthetic message). Just
    // assert ≥1 occurrence per row — labels can legitimately appear in
    // multiple text nodes (e.g. message references the label).
    for (const c of ALL_PASS) {
      expect(
        screen.getAllByText(new RegExp(c.label.replace(/[.]/g, '\\.'))).length
      ).toBeGreaterThan(0);
    }
  });

  it('warn row shows the message AND the userAction hint', () => {
    const preview: StackPreview = {
      stack: 'nextjs',
      packageName: 'sample',
      port: 3000,
      nodeEngine: null,
      checks: [
        ...ALL_PASS.filter((c) => c.key !== 'package_lockfile'),
        {
          key: 'package_lockfile',
          status: 'warn',
          label: 'package-lock.json',
          message: 'package-lock.json이 없어요. npm ci를 사용합니다.',
          userAction: 'lockfile을 커밋해 주세요.',
        },
      ],
    };
    render(<PreviewResult fullName="alice/sample" preview={preview} />);

    expect(screen.getByText(/npm ci를 사용합니다/)).toBeInTheDocument();
    expect(screen.getByText(/lockfile을 커밋해 주세요/)).toBeInTheDocument();
  });

  it('fail check on a "nextjs" preview blocks the Deploy button + shows the gate copy', () => {
    // Synthetic: stack=nextjs but one check is fail. Production won't
    // emit this exact shape (a fail flips stack=unsupported) but the
    // gate must be defensive — the Deploy button reads check status,
    // not just preview.stack.
    const preview: StackPreview = {
      stack: 'nextjs',
      packageName: 'sample',
      port: 3000,
      nodeEngine: null,
      checks: [
        ...ALL_PASS.filter((c) => c.key !== 'default_branch'),
        {
          key: 'default_branch',
          status: 'fail',
          label: '기본 브랜치',
          message: "기본 브랜치가 'main'이 아닙니다.",
          userAction: "Settings → Branches에서 'main'으로 변경 후 다시 시도.",
        },
      ],
    };
    render(<PreviewResult fullName="alice/sample" preview={preview} />);

    const deploy = screen.getByRole('button', { name: /Deploy/ });
    expect(deploy).toBeDisabled();
    expect(
      screen.getByText(/위 점검에서 ✕ 항목이 있어 배포를 시작할 수 없습니다/)
    ).toBeInTheDocument();
    expect(screen.getByText(/Settings → Branches/)).toBeInTheDocument();
  });

  it('all-pass enables the Deploy button (no gate copy)', () => {
    const preview: StackPreview = {
      stack: 'nextjs',
      packageName: 'sample',
      port: 3000,
      nodeEngine: null,
      checks: ALL_PASS,
    };
    render(<PreviewResult fullName="alice/sample" preview={preview} />);

    expect(screen.getByRole('button', { name: /Deploy/ })).not.toBeDisabled();
    expect(
      screen.queryByText(/위 점검에서 ✕ 항목이 있어 배포를 시작할 수 없습니다/)
    ).not.toBeInTheDocument();
  });

  it('unsupported preview shows reason + the checks list (no Deploy button)', () => {
    const preview: StackPreview = {
      stack: 'unsupported',
      reason: 'repo 루트에 package.json이 없어요.',
      checks: [
        passCheck('repo_access', 'GitHub repo 접근'),
        passCheck('default_branch', '기본 브랜치'),
        {
          key: 'package_json',
          status: 'fail',
          label: 'package.json',
          message: 'repo 루트에 package.json이 없어요.',
        },
      ],
    };
    render(<PreviewResult fullName="alice/sample" preview={preview} />);

    expect(screen.getByText('⚠️ 지원하지 않는 스택')).toBeInTheDocument();
    expect(screen.getByText('배포 전 점검')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Deploy/ })).not.toBeInTheDocument();
  });

  it('mixed-case repo casing message names the original case + lowercase note', () => {
    const preview: StackPreview = {
      stack: 'nextjs',
      packageName: 'sample',
      port: 3000,
      nodeEngine: null,
      checks: [
        ...ALL_PASS.filter((c) => c.key !== 'repo_casing'),
        {
          key: 'repo_casing',
          status: 'pass',
          label: 'Repo 이름 casing',
          message:
            'GitHub repo 이름(PocketPlan)의 대소문자는 유지되고, GHCR image tag는 자동으로 소문자로 변환됩니다.',
        },
      ],
    };
    render(<PreviewResult fullName="hatbann/PocketPlan" preview={preview} />);

    expect(screen.getByText(/PocketPlan/)).toBeInTheDocument();
    expect(screen.getByText(/소문자로 변환/)).toBeInTheDocument();
  });
});

describe('PreviewResult — copy consistency', () => {
  it('does NOT show legacy "Next.js / Node 앱을 지원합니다" string in the success header', () => {
    const preview: StackPreview = {
      stack: 'nextjs',
      packageName: 'sample',
      port: 3000,
      nodeEngine: null,
      checks: ALL_PASS,
    };
    render(<PreviewResult fullName="alice/sample" preview={preview} />);
    expect(screen.queryByText(/Node 앱을 지원합니다/)).not.toBeInTheDocument();
    expect(screen.getByText(/Next\.js 앱으로 감지/)).toBeInTheDocument();
  });
});
