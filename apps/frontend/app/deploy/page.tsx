import { Suspense } from 'react';

import { DeployPageClient } from './page.client';

export default function DeployPage(): import("react").ReactNode {
  return (
    <Suspense fallback={<DeployFallback />}>
      <DeployPageClient />
    </Suspense>
  );
}

function DeployFallback(): import("react").ReactNode {
  return (
    <main className="flex min-h-[calc(100vh-12rem)] w-full items-center justify-center px-6 py-24">
      <p className="text-slate-500">Loading…</p>
    </main>
  );
}
