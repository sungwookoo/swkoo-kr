import { Suspense } from 'react';

import { ConsentPageClient } from './page.client';

export const metadata = {
  title: '약관 동의 — swkoo.kr',
  description: 'swkoo.kr 이용 전 개인정보 처리방침 및 이용약관 동의.',
};

export default function ConsentPage(): import("react").ReactNode {
  return (
    <Suspense fallback={<Fallback />}>
      <ConsentPageClient />
    </Suspense>
  );
}

function Fallback(): import("react").ReactNode {
  return (
    <main className="flex min-h-[calc(100vh-12rem)] w-full items-center justify-center px-6 py-24">
      <p className="text-zinc-500">Loading…</p>
    </main>
  );
}
