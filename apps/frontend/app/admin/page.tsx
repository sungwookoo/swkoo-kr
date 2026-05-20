import { Suspense } from 'react';

import { AdminPageClient } from './page.client';

export default function AdminPage(): import("react").ReactNode {
  return (
    <Suspense fallback={<AdminFallback />}>
      <AdminPageClient />
    </Suspense>
  );
}

function AdminFallback(): import("react").ReactNode {
  return (
    <main className="flex min-h-[calc(100vh-12rem)] w-full items-center justify-center px-6 py-24">
      <p className="text-zinc-500">Loading…</p>
    </main>
  );
}
