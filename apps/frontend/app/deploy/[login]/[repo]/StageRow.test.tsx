import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Stub Next's <Link> — same passthrough pattern used elsewhere; we
// don't need real routing for component-level assertions.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

// useDeploymentStatus / useEnvVars / useLatestScan are SWR-backed and
// the page imports them at module top level — we don't render the
// full StatusClient, only StageRow, but the module's imports still
// execute. Stub everything that touches network.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('swr', () => ({
  default: () => ({ data: undefined, error: undefined, isLoading: false }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));

import type { StageInfo } from '@/lib/deploy';
import { StageRow } from './page.client';

describe('StageRow', () => {
  it('renders message and a GitHub Actions link for the legacy success-with-link case', () => {
    const stage: StageInfo = {
      status: 'success',
      message: '빌드 완료 (abc1234)',
      link: 'https://github.com/alice/sample/actions/runs/777',
    };
    render(<ol><StageRow label="이미지 빌드" stage={stage} /></ol>);
    expect(screen.getByText('이미지 빌드')).toBeInTheDocument();
    expect(screen.getByText(/빌드 완료/)).toBeInTheDocument();
    expect(screen.getByText('GitHub Actions 로그 보기')).toBeInTheDocument();
  });

  it('failed stage with reason+userAction renders the "다음 조치" CTA', () => {
    const stage: StageInfo = {
      status: 'failed',
      message: '빌드 실패: failure — 구버전 workflow 템플릿을 사용 중입니다.',
      link: 'https://github.com/alice/sample/actions/runs/999',
      reason: 'WORKFLOW_OLD_TEMPLATE',
      userAction: {
        label: 'swkoo.kr에서 다시 배포 시작 (workflow 자동 갱신)',
        href: '/deploy',
        kind: 'link',
      },
    };
    render(<ol><StageRow label="이미지 빌드" stage={stage} /></ol>);
    expect(screen.getByText('다음 조치')).toBeInTheDocument();
    const cta = screen.getByText(/swkoo\.kr에서 다시 배포 시작/);
    expect(cta).toBeInTheDocument();
    // Internal href uses Next Link (which our mock renders as <a>).
    expect(cta.closest('a')).toHaveAttribute('href', '/deploy');
    // The status badge still shows 실패.
    expect(screen.getByText('실패')).toBeInTheDocument();
  });

  it('userAction with external http(s) href renders as external link (new tab)', () => {
    const stage: StageInfo = {
      status: 'failed',
      message: '빌드 실패: failure',
      link: 'https://github.com/alice/sample/actions/runs/999',
      reason: 'UNKNOWN_BUILD_FAILURE',
      userAction: {
        label: 'GitHub Actions 로그 보기',
        href: 'https://github.com/alice/sample/actions/runs/999',
        kind: 'link',
      },
    };
    render(<ol><StageRow label="이미지 빌드" stage={stage} /></ol>);
    const cta = screen.getByText(/GitHub Actions 로그 보기/);
    const anchor = cta.closest('a');
    expect(anchor).toHaveAttribute('target', '_blank');
    expect(anchor).toHaveAttribute('href', 'https://github.com/alice/sample/actions/runs/999');
    // De-dup: the userAction shares its href with stage.link, so the
    // generic "GitHub Actions 로그 보기" link below should NOT render
    // a second anchor pointing at the same URL.
    const anchorsToRun = screen
      .getAllByRole('link')
      .filter((a) => a.getAttribute('href') === stage.link);
    expect(anchorsToRun).toHaveLength(1);
  });

  it('operatorHint renders as a subdued "[운영자 확인]" line', () => {
    const stage: StageInfo = {
      status: 'failed',
      message: '배포 실패 (Health=Degraded)',
      reason: 'ARGO_SYNC_FAILED',
      operatorHint: 'Pod 이벤트로 ImagePullBackOff, CrashLoopBackOff 여부를 확인하세요.',
    };
    render(<ol><StageRow label="클러스터 배포" stage={stage} /></ol>);
    expect(screen.getByText(/운영자 확인/)).toBeInTheDocument();
    expect(screen.getByText(/ImagePullBackOff/)).toBeInTheDocument();
  });

  it('stage without reason renders exactly as before — no "다음 조치" or "[운영자 확인]"', () => {
    const stage: StageInfo = {
      status: 'running',
      message: '이미지 빌드 중 (in_progress)',
      link: 'https://github.com/alice/sample/actions/runs/777',
    };
    render(<ol><StageRow label="이미지 빌드" stage={stage} /></ol>);
    expect(screen.queryByText('다음 조치')).not.toBeInTheDocument();
    expect(screen.queryByText(/운영자 확인/)).not.toBeInTheDocument();
    // Legacy link rendering preserved.
    expect(screen.getByText('GitHub Actions 로그 보기')).toBeInTheDocument();
  });

  it('userAction without href renders as plain text (not a link)', () => {
    const stage: StageInfo = {
      status: 'failed',
      message: '배포 실패 (Health=Degraded)',
      reason: 'ARGO_SYNC_FAILED',
      userAction: {
        label: 'GitHub Actions 로그로 빌드 결과 먼저 확인',
        kind: 'docs',
      },
    };
    render(<ol><StageRow label="클러스터 배포" stage={stage} /></ol>);
    const txt = screen.getByText(/GitHub Actions 로그로 빌드 결과 먼저 확인/);
    expect(txt.closest('a')).toBeNull();
  });
});
