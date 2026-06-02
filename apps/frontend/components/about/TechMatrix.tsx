'use client';

import { useState } from 'react';

import type { TechItem } from '@/content/about';

interface TechMatrixProps {
  items: ReadonlyArray<TechItem>;
}

/** Clickable chip grid + a single detail panel below it. Clicking
 * the same chip twice closes the panel. Buttons get keyboard focus
 * + `aria-pressed` so screen readers announce the selected state.
 * Single-open behaviour is deliberate — a multi-open chip grid quickly
 * stops being scannable. */
export function TechMatrix({ items }: TechMatrixProps): import('react').ReactNode {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = items.find((item) => item.id === selectedId) ?? null;

  return (
    <div className="space-y-5">
      <ul
        role="list"
        aria-label="Technology keywords"
        className="flex flex-wrap gap-1.5"
      >
        {items.map((item) => {
          const active = selectedId === item.id;
          return (
            <li key={item.id}>
              <button
                type="button"
                aria-pressed={active}
                aria-controls="tech-detail"
                onClick={() => setSelectedId(active ? null : item.id)}
                className={
                  'rounded-md border px-3 py-1.5 text-xs sm:text-sm transition-colors ' +
                  (active
                    ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-200'
                    : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:border-slate-700 hover:text-slate-100')
                }
              >
                {item.label}
              </button>
            </li>
          );
        })}
      </ul>

      {selected && (
        <dl
          id="tech-detail"
          aria-live="polite"
          className="space-y-3 rounded-md border border-slate-800 bg-slate-950/60 p-5 text-sm"
        >
          <Row term="What" def={selected.what} />
          <Row term="Used for" def={selected.usedFor} />
          <Row term="Why it matters" def={selected.whyItMatters} />
        </dl>
      )}
    </div>
  );
}

function Row({ term, def }: { term: string; def: string }): import('react').ReactNode {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[7.5rem_1fr] sm:gap-4">
      <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">
        {term}
      </dt>
      <dd className="text-slate-200 leading-relaxed">{def}</dd>
    </div>
  );
}
