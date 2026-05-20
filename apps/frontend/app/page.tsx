import Link from 'next/link';
import clsx from 'clsx';

import { fetchAlerts, fetchPipelines } from '@/lib/api';
import {
  builders,
  hero,
  howItWorks,
  liveStatus,
  steps,
  trust,
} from '@/content/landing';

export default async function Home() {
  const [pipelinesEnvelope, alertsEnvelope] = await Promise.all([
    fetchPipelines(),
    fetchAlerts(),
  ]);

  const totalPipelines = pipelinesEnvelope.pipelines.length;
  const healthyCount = pipelinesEnvelope.pipelines.filter(
    (p) => p.healthStatus === 'Healthy'
  ).length;
  const activeAlerts = alertsEnvelope.alerts.length;
  const allHealthy =
    totalPipelines > 0 && healthyCount === totalPipelines && activeAlerts === 0;
  const showStatus = pipelinesEnvelope.configured && totalPipelines > 0;

  return (
    <main className="relative isolate w-full">
      <Hero />
      <HowItWorks />
      <Transparency
        showStatus={showStatus}
        totalPipelines={totalPipelines}
        healthyCount={healthyCount}
        activeAlerts={activeAlerts}
        allHealthy={allHealthy}
      />
      <UnderTheHood />
    </main>
  );
}

/* ─────────────── HERO ─────────────── */

function Hero(): import("react").ReactNode {
  return (
    <section className="relative w-full overflow-hidden px-6 pt-24 pb-32 sm:pt-32 sm:pb-40">
      {/* Single subtle top-center radial — Vercel-style atmospherics */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[42rem] bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.05),transparent_60%)]"
      />

      <div className="mx-auto grid w-full max-w-6xl grid-cols-12 gap-y-12 lg:gap-x-8">
        {/* Left: copy */}
        <div className="col-span-12 flex flex-col items-start gap-8 lg:col-span-8">
          <h1 className="display-tight max-w-3xl whitespace-pre-line text-balance text-left text-5xl font-semibold leading-[1.02] text-zinc-50 sm:text-6xl lg:text-7xl">
            <AnimatedLines text={hero.title} startDelay={80} step={120} />
          </h1>

          <p
            className="animate-fade-in-up max-w-xl text-balance text-left text-lg leading-relaxed text-zinc-400 sm:text-xl"
            style={{ animationDelay: '380ms' }}
          >
            {hero.tagline}
          </p>

          <p
            className="animate-fade-in-up max-w-xl text-balance text-left text-base leading-relaxed text-zinc-500"
            style={{ animationDelay: '480ms' }}
          >
            {hero.description}
          </p>

          <div
            className="animate-fade-in-up mt-2 flex flex-col items-start gap-3 sm:flex-row sm:items-center"
            style={{ animationDelay: '580ms' }}
          >
            <Link
              href={hero.primaryCta.href}
              className="group inline-flex items-center gap-2 rounded-md bg-white px-5 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-zinc-200"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.111.82-.261.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.4 3-.405 1.02.005 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
              </svg>
              <span>{hero.primaryCta.label}</span>
              <span className="transition-transform group-hover:translate-x-1">→</span>
            </Link>
            <Link
              href={hero.secondaryCta.href}
              className="group inline-flex items-center gap-2 px-1 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-100"
            >
              <span className="border-b border-dashed border-zinc-700 pb-0.5 group-hover:border-zinc-500">
                {hero.secondaryCta.label}
              </span>
              <span className="text-zinc-500 transition-transform group-hover:translate-x-0.5">
                →
              </span>
            </Link>
          </div>
        </div>

        {/* Right: spec strip — mono terminal mock, offset down */}
        <div
          className="animate-fade-in col-span-12 mt-4 lg:col-span-4 lg:mt-24"
          style={{ animationDelay: '700ms' }}
        >
          <SpecCard />
        </div>
      </div>
    </section>
  );
}

function AnimatedLines({
  text,
  startDelay,
  step,
}: {
  text: string;
  startDelay: number;
  step: number;
}): import("react").ReactNode {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, i) => (
        <span
          key={i}
          className="animate-fade-in-up display-gradient block"
          style={{ animationDelay: `${startDelay + i * step}ms` }}
        >
          {line}
        </span>
      ))}
    </>
  );
}

function SpecCard(): import("react").ReactNode {
  return (
    <div className="overflow-hidden rounded-md border border-zinc-900 bg-zinc-950 font-mono text-xs leading-relaxed text-zinc-400">
      <div className="flex items-center gap-1.5 border-b border-zinc-900 px-3 py-2">
        <span className="size-2 rounded-full bg-zinc-800" />
        <span className="size-2 rounded-full bg-zinc-800" />
        <span className="size-2 rounded-full bg-zinc-800" />
        <span className="ml-2 text-[10px] uppercase tracking-wider text-zinc-600">
          swkoo deploy
        </span>
      </div>
      <pre className="overflow-x-auto whitespace-pre p-4 text-[11px] sm:text-xs">
        <span className="text-zinc-500">$ </span>
        <span className="text-zinc-100">deploy</span>{' '}
        <span className="text-zinc-300">sungwookoo/your-app</span>
        {'\n\n'}
        <span className="text-emerald-400">✓</span>{' '}
        <span className="text-zinc-300">Dockerfile generated</span>
        {'\n'}
        <span className="text-emerald-400">✓</span>{' '}
        <span className="text-zinc-300">workflow committed</span>
        {'\n'}
        <span className="text-emerald-400">✓</span>{' '}
        <span className="text-zinc-300">manifests pushed</span>
        {'\n'}
        <span className="text-amber-400">⟳</span>{' '}
        <span className="text-zinc-300">building on GHA</span>
        {'\n'}
        <span className="text-zinc-700">·</span>{' '}
        <span className="text-zinc-600">argocd picking up</span>
        {'\n\n'}
        <span className="text-zinc-600">→ </span>
        <span className="text-emerald-300/90">your-app.apps.swkoo.kr</span>
      </pre>
    </div>
  );
}

/* ───────── HOW IT WORKS ───────── */

function HowItWorks(): import("react").ReactNode {
  return (
    <section className="w-full border-t border-zinc-900 px-6 py-24 sm:py-32">
      <div className="mx-auto w-full max-w-6xl">
        <SectionHeader
          eyebrow="How it works"
          title={howItWorks.title}
          subtitle={howItWorks.subtitle}
        />

        <ol className="mt-16 flex flex-col">
          {steps.map((step) => (
            <li
              key={step.n}
              className="grid grid-cols-12 items-start gap-y-3 border-t border-zinc-900 py-10 lg:gap-x-8"
            >
              <div className="col-span-12 lg:col-span-3">
                <span className="font-mono text-xs uppercase tracking-[0.18em] text-zinc-500">
                  Step / {String(step.n).padStart(2, '0')}
                </span>
              </div>
              <div className="col-span-12 space-y-3 lg:col-span-8 lg:col-start-4">
                <h3 className="display-tight text-balance text-2xl font-semibold text-zinc-50 sm:text-3xl">
                  {step.title}
                </h3>
                <p className="max-w-2xl text-balance text-base leading-relaxed text-zinc-400">
                  {step.body}
                </p>
              </div>
            </li>
          ))}
          <li className="border-t border-zinc-900" />
        </ol>
      </div>
    </section>
  );
}

/* ───────── TRANSPARENCY ───────── */

function Transparency({
  showStatus,
  totalPipelines,
  healthyCount,
  activeAlerts,
  allHealthy,
}: {
  showStatus: boolean;
  totalPipelines: number;
  healthyCount: number;
  activeAlerts: number;
  allHealthy: boolean;
}): import("react").ReactNode {
  return (
    <section className="w-full border-t border-zinc-900 px-6 py-24 sm:py-32">
      <div className="mx-auto grid w-full max-w-6xl grid-cols-12 gap-y-12 lg:gap-x-8">
        <div className="col-span-12 lg:col-span-5">
          <SectionHeader
            eyebrow="Transparency"
            title={trust.title}
            subtitle={trust.description}
          />
        </div>
        <div className="col-span-12 flex flex-col justify-center gap-8 lg:col-span-7">
          {showStatus ? (
            <>
              <div className="flex flex-wrap items-baseline gap-x-12 gap-y-6">
                <Metric
                  label={liveStatus.healthyLabel}
                  value={`${healthyCount} / ${totalPipelines}`}
                  isAlert={!allHealthy}
                />
                <Metric
                  label={liveStatus.alertsLabel}
                  value={String(activeAlerts)}
                  isAlert={activeAlerts !== 0}
                />
              </div>
              <Link
                href="/observatory"
                className="group inline-flex w-fit items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-zinc-400 transition-colors hover:text-zinc-100"
              >
                <span className="border-b border-zinc-700 pb-0.5 group-hover:border-zinc-500">
                  Observatory 열기
                </span>
                <span className="transition-transform group-hover:translate-x-1">→</span>
              </Link>
            </>
          ) : (
            <div className="text-sm text-zinc-500">
              {liveStatus.fetchFailed}
              <Link
                href="/observatory"
                className="ml-3 text-zinc-300 hover:text-zinc-100"
              >
                Observatory 열기 →
              </Link>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  isAlert,
}: {
  label: string;
  value: string;
  isAlert: boolean;
}): import("react").ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <span
        className={clsx(
          'display-tight font-mono text-5xl font-semibold sm:text-6xl',
          isAlert ? 'text-amber-300' : 'text-zinc-50'
        )}
      >
        {value}
      </span>
      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-500">
        {label}
      </span>
    </div>
  );
}

/* ───────── UNDER THE HOOD ───────── */

function UnderTheHood(): import("react").ReactNode {
  return (
    <section className="w-full border-t border-zinc-900 px-6 py-24 sm:py-32">
      <div className="mx-auto w-full max-w-6xl">
        <SectionHeader
          eyebrow="Under the hood"
          title={builders.title}
          subtitle={builders.description}
        />

        <ul className="mt-12 grid grid-cols-1 divide-y divide-zinc-900 border-t border-zinc-900 sm:grid-cols-2 sm:divide-y-0 sm:divide-x">
          {builders.bullets.map((item, i) => (
            <li
              key={item}
              className={clsx(
                'flex items-start gap-3 px-0 py-4 text-sm text-zinc-300 sm:px-6',
                i === 0 && 'sm:pl-0',
                i === builders.bullets.length - 1 && 'sm:border-b sm:border-zinc-900'
              )}
            >
              <span className="mt-1 inline-block size-1.5 shrink-0 rounded-full bg-zinc-500" />
              <span className="leading-relaxed">{item}</span>
            </li>
          ))}
        </ul>

        <div className="mt-10 flex flex-wrap gap-x-6 gap-y-2 font-mono text-xs uppercase tracking-[0.18em]">
          <DocLink href="https://github.com/sungwookoo/swkoo-kr/blob/main/VISION.md">
            VISION
          </DocLink>
          <DocLink href="https://github.com/sungwookoo/swkoo-kr/blob/main/docs/deploy-vision.md">
            deploy-vision
          </DocLink>
          <DocLink href="https://github.com/sungwookoo/swkoo-kr/blob/main/BIZ_READINESS.md">
            BIZ_READINESS
          </DocLink>
          <DocLink href="https://github.com/sungwookoo/swkoo-kr">
            source
          </DocLink>
        </div>
      </div>
    </section>
  );
}

function DocLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}): import("react").ReactNode {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="group inline-flex items-center gap-1 text-zinc-500 transition-colors hover:text-zinc-100"
    >
      <span className="border-b border-dashed border-zinc-800 pb-0.5 group-hover:border-zinc-500">
        {children}
      </span>
      <span className="text-zinc-700 transition-transform group-hover:translate-x-0.5">↗</span>
    </a>
  );
}

/* ───────── shared ───────── */

function SectionHeader({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
}): import("react").ReactNode {
  return (
    <div className="max-w-2xl space-y-4">
      <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-zinc-500">
        {eyebrow}
      </p>
      <h2 className="display-tight display-gradient text-balance text-3xl font-semibold leading-[1.05] sm:text-4xl lg:text-5xl">
        {title}
      </h2>
      <p className="text-balance text-base leading-relaxed text-zinc-400">{subtitle}</p>
    </div>
  );
}
