'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSWRConfig } from 'swr';

import { acceptConsent, ME_SWR_KEY, useMe } from '@/lib/auth';

type SafeRoute = '/deploy' | '/admin';
const SAFE_REDIRECTS: SafeRoute[] = ['/deploy', '/admin'];

function safeRedirect(target: string | null): SafeRoute {
  if (!target) return '/deploy';
  return (SAFE_REDIRECTS as string[]).includes(target)
    ? (target as SafeRoute)
    : '/deploy';
}

export function ConsentPageClient(): import("react").ReactNode {
  const { me, isLoading } = useMe();
  const router = useRouter();
  const params = useSearchParams();
  const { mutate } = useSWRConfig();
  const next = safeRedirect(params.get('next'));

  const [checked, setChecked] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If the user lands here already past consent (e.g. typed the URL),
  // bounce them onwards.
  useEffect(() => {
    if (!isLoading && me && !me.requiresConsent) {
      router.replace(next);
    }
  }, [isLoading, me, next, router]);

  if (isLoading) {
    return <Shell><p className="text-zinc-500">Loading…</p></Shell>;
  }

  if (!me) {
    // No session — send them to /deploy which renders the Sign in screen.
    if (typeof window !== 'undefined') router.replace('/deploy');
    return <Shell><p className="text-zinc-500">Redirecting…</p></Shell>;
  }

  const handleAccept = async (): Promise<void> => {
    if (!checked) return;
    setPending(true);
    setError(null);
    try {
      await acceptConsent(me.policyVersion);
      await mutate(ME_SWR_KEY);
      router.push(next);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setPending(false);
    }
  };

  return (
    <Shell>
      <div className="w-full max-w-2xl space-y-8">
        <header className="space-y-2 border-b border-zinc-900 pb-6">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-zinc-500">
            Consent
          </p>
          <h1 className="display-tight text-balance text-3xl font-semibold text-zinc-50 sm:text-4xl">
            약관 동의
          </h1>
          <p className="text-sm text-zinc-400">
            서비스 이용을 위해 개인정보 처리방침과 이용약관 확인이 필요합니다.
            아래 두 문서를 검토하신 뒤 동의해 주세요.
          </p>
        </header>

        <section className="space-y-3">
          <PolicyLink
            href="/privacy"
            title="개인정보 처리방침"
            description="수집하는 정보, 처리 목적, 보유 기간, 처리 위탁, 사용자 권리"
          />
          <PolicyLink
            href="/terms"
            title="이용약관"
            description="서비스 범위, 가용성, 사용자 자격, 금지 행위, 자원 한도"
          />
        </section>

        <section className="rounded-md border border-zinc-900 bg-zinc-950 p-4 text-xs leading-relaxed text-zinc-500">
          <p>
            <strong className="text-zinc-300">짧게 요약:</strong> swkoo.kr은 GitHub OAuth 정보(로그인·이메일·아바타),
            배포 메타데이터, 사용자가 직접 입력한 환경변수만 저장합니다. 분석·광고 추적
            없음. 외부 판매·제공 없음. 계정 삭제 시 감사 로그는 30일 익명화 보존 후 완전 삭제,
            그 외 데이터는 즉시 삭제됩니다.
          </p>
        </section>

        <section className="space-y-4">
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-zinc-900 bg-zinc-950 p-4 text-sm text-zinc-300 hover:border-zinc-800">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              disabled={pending}
              className="mt-0.5 size-4 cursor-pointer accent-zinc-200"
            />
            <span>
              위 <strong className="text-zinc-100">개인정보 처리방침</strong>과{' '}
              <strong className="text-zinc-100">이용약관</strong>을 모두 읽었고 이에 동의합니다.
            </span>
          </label>

          {error && <p className="text-xs text-amber-400">동의 실패: {error}</p>}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-zinc-500">
              정책 버전: <code className="font-mono">{me.policyVersion}</code>
            </p>
            <div className="flex gap-2">
              <Link
                href="/"
                className="rounded-md px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200"
              >
                나중에
              </Link>
              <button
                type="button"
                onClick={handleAccept}
                disabled={!checked || pending}
                className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {pending ? '처리 중…' : '동의하고 계속'}
              </button>
            </div>
          </div>
        </section>
      </div>
    </Shell>
  );
}

function PolicyLink({
  href,
  title,
  description,
}: {
  href: '/privacy' | '/terms';
  title: string;
  description: string;
}): import("react").ReactNode {
  return (
    <Link
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex items-start justify-between gap-4 rounded-md border border-zinc-900 bg-zinc-950 p-4 transition-colors hover:border-zinc-800"
    >
      <div className="space-y-1">
        <p className="text-sm font-medium text-zinc-100">{title}</p>
        <p className="text-xs text-zinc-500">{description}</p>
      </div>
      <span className="font-mono text-xs text-zinc-500">↗</span>
    </Link>
  );
}

function Shell({ children }: { children: React.ReactNode }): import("react").ReactNode {
  return (
    <main className="relative isolate min-h-[calc(100vh-12rem)] w-full px-6 py-16 sm:py-20">
      <div className="mx-auto flex w-full justify-center">{children}</div>
    </main>
  );
}
