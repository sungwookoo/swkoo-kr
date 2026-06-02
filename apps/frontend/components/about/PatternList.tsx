'use client';

import { useState } from 'react';

import type { PatternItem } from '@/content/about';

interface PatternListProps {
  items: ReadonlyArray<PatternItem>;
}

/** Disclosure-style accordion. Multiple rows can be open at once
 * (the patterns are short enough that the page stays scannable even
 * with all 7 expanded) and each row is a button with
 * `aria-expanded` + `aria-controls` to its body. */
export function PatternList({ items }: PatternListProps): import('react').ReactNode {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = (id: string): void => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <ul role="list" className="divide-y divide-slate-900 rounded-md border border-slate-900">
      {items.map((item) => {
        const isOpen = open.has(item.id);
        const bodyId = `pattern-${item.id}-body`;
        return (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => toggle(item.id)}
              aria-expanded={isOpen}
              aria-controls={bodyId}
              className="flex w-full items-center justify-between gap-4 px-5 py-3.5 text-left transition-colors hover:bg-slate-900/40"
            >
              <span className="text-sm font-medium text-slate-200">{item.label}</span>
              <span
                aria-hidden
                className={
                  'text-slate-500 transition-transform ' +
                  (isOpen ? 'rotate-90' : '')
                }
              >
                ›
              </span>
            </button>
            {isOpen && (
              <p
                id={bodyId}
                className="px-5 pb-4 text-sm leading-relaxed text-slate-400"
              >
                {item.body}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
