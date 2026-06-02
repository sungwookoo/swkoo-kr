import type { Metadata } from 'next';

import { ArchitectureDiagram } from '@/components/ArchitectureDiagram';
import { PatternList } from '@/components/about/PatternList';
import { TechMatrix } from '@/components/about/TechMatrix';
import {
  architecture,
  claims,
  hero,
  systemPatterns,
  techMatrix,
  tradeOffs,
} from '@/content/about';

export const metadata: Metadata = {
  title: 'About — swkoo.kr',
  description:
    'GitHub App, Kubernetes, ArgoCD, OCI 를 엮어 단일 운영자가 다수 앱을 배포·관측하는 사이드 프로젝트의 설계 노트.',
};

export default function AboutPage(): import('react').ReactNode {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-20 sm:py-24">
      {/* Hero — single column, calm. No gradient blobs / hero card. */}
      <section className="space-y-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-slate-500">
          {hero.eyebrow}
        </p>
        <h1 className="text-3xl font-semibold leading-tight text-slate-100 sm:text-4xl">
          {hero.title}
        </h1>
        <p className="text-base leading-relaxed text-slate-400">{hero.subtitle}</p>
        <p className="pt-2 font-mono text-xs text-slate-600">{hero.meta}</p>
      </section>

      {/* Claims — 2-column on sm+, no cards, just labelled paragraphs. */}
      <section aria-labelledby="claims-heading" className="mt-16">
        <h2 id="claims-heading" className="sr-only">
          Core claims
        </h2>
        <ul role="list" className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
          {claims.map((claim) => (
            <li key={claim.label}>
              <h3 className="text-sm font-semibold text-emerald-300">{claim.label}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{claim.body}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* Technology matrix — interactive chip grid. */}
      <section aria-labelledby="tech-heading" className="mt-20">
        <header className="mb-5">
          <h2 id="tech-heading" className="text-lg font-semibold text-slate-100">
            Technology
          </h2>
          <p className="text-sm text-slate-500">키워드를 누르면 어디에 쓰였는지 펼쳐진다.</p>
        </header>
        <TechMatrix items={techMatrix} />
      </section>

      {/* System patterns — accordion of design themes. */}
      <section aria-labelledby="patterns-heading" className="mt-20">
        <header className="mb-5">
          <h2 id="patterns-heading" className="text-lg font-semibold text-slate-100">
            System patterns
          </h2>
          <p className="text-sm text-slate-500">설계 의도와 그 결과를 항목별로.</p>
        </header>
        <PatternList items={systemPatterns} />
      </section>

      {/* Architecture — diagram + brief flow notes (moved from Observatory). */}
      <section aria-labelledby="architecture-heading" className="mt-20">
        <header className="mb-5">
          <h2 id="architecture-heading" className="text-lg font-semibold text-slate-100">
            {architecture.title}
          </h2>
          <p className="text-sm text-slate-500">{architecture.subtitle}</p>
        </header>
        {/* No outer wrapper — ArchitectureDiagram already frames its
            own diagram container, so a second border just added
            visual noise (and squeezed the mermaid extra on mobile). */}
        <ArchitectureDiagram />
        <div className="mt-6 grid gap-8 sm:grid-cols-2">
          <FlowList
            title={architecture.dataFlow.title}
            steps={architecture.dataFlow.steps}
            accent="emerald"
          />
          <FlowList
            title={architecture.failureFlow.title}
            steps={architecture.failureFlow.steps}
            accent="rose"
          />
        </div>
      </section>

      {/* Trade-offs — compact end section. Not an accordion; small enough
          to stay open. Heavy on "what we DIDN'T pick" because that's
          usually more interesting than the picks. */}
      <section aria-labelledby="tradeoffs-heading" className="mt-20">
        <header className="mb-5">
          <h2 id="tradeoffs-heading" className="text-lg font-semibold text-slate-100">
            {tradeOffs.title}
          </h2>
          <p className="text-sm text-slate-500">{tradeOffs.subtitle}</p>
        </header>
        <ul role="list" className="space-y-4">
          {tradeOffs.items.map((item) => (
            <li
              key={item.title}
              className="border-l-2 border-slate-800 pl-4 text-sm"
            >
              <p className="font-medium text-slate-200">{item.title}</p>
              <p className="mt-1 text-slate-400 leading-relaxed">{item.reason}</p>
              <p className="mt-1 font-mono text-[11px] text-slate-600">↳ {item.risk}</p>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function FlowList({
  title,
  steps,
  accent,
}: {
  title: string;
  steps: ReadonlyArray<string>;
  accent: 'emerald' | 'rose';
}): import('react').ReactNode {
  const dotCls = accent === 'emerald' ? 'bg-emerald-400/80' : 'bg-rose-400/80';
  return (
    <div>
      <h3 className="text-sm font-medium text-slate-200">{title}</h3>
      <ol role="list" className="mt-3 space-y-2.5 text-sm text-slate-400">
        {steps.map((step) => (
          <li key={step} className="flex items-start gap-2.5 leading-relaxed">
            <span className={`mt-2 inline-block size-1.5 shrink-0 rounded-full ${dotCls}`} />
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
