import Link from 'next/link';

export const metadata = {
  title: '시작 가이드 — swkoo.kr',
  description: 'swkoo.kr 배포 전 준비사항과 자동으로 처리되는 일.',
};

const sections = [
  {
    n: 1,
    title: 'Next.js 앱이 GitHub repo에 있어야 합니다',
    body: '본인 owner인 repo에 Next.js 앱이 푸시돼 있어야 합니다. 두 가지 경로:',
    templateUrl: 'https://github.com/sungwookoo/nextjs-sample/generate',
    templateLabel: 'Use this template — sungwookoo/nextjs-sample 복제',
    code: 'npx create-next-app@latest my-app',
    after:
      '템플릿은 swkoo.kr에서 바로 동작하도록 검증된 구성. 직접 만드셔도 `output: "standalone"` 같은 특수 설정은 불필요합니다.',
  },
  {
    n: 2,
    title: '지원 범위 — 미리 알아두실 것',
    body: '지원하는/지원하지 않는 항목:',
    bullets: [
      '런타임 환경변수 ✅ — 배포 후 `/deploy/<login>/<repo>` 페이지의 "환경변수" 패널에서 추가. Save 시 Pod 자동 재시작',
      '클러스터 내 영속 스토리지 ❌ — Supabase·Neon 같은 외부 DB 연결은 자유 (위의 환경변수로 URL/key 주입)',
      '한 사용자당 앱 1개 (재배포는 같은 앱 슬롯을 덮어씁니다)',
    ],
  },
  {
    n: 3,
    title: 'Deploy 클릭 시 자동으로 일어나는 일',
    body: '아래는 모두 자동입니다 — 사용자가 만들거나 만질 필요 없음:',
    bullets: [
      '본인 repo에 빌드 설정 파일 자동 commit (`main`/`master` 어느 쪽이든 OK)',
      '클러스터 자원 (namespace · 자원 한도 · 네트워크 정책) 자동 생성',
      'GitHub Actions가 이미지 빌드 → 본인 GHCR로 push',
      '약 5분 안에 `<slug>.apps.swkoo.kr` 로 라이브 배포 — 슬러그는 Deploy 화면에서 직접 입력 가능, 비우면 `<login>-<repo>` 기본값',
    ],
  },
] as const;

export default function GettingStartedPage(): import("react").ReactNode {
  return (
    <main className="relative isolate w-full px-6 py-20 sm:py-24">
      <div className="mx-auto w-full max-w-3xl space-y-12">
        <header className="space-y-4">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-zinc-500">
            Getting started
          </p>
          <h1 className="display-tight display-gradient text-balance text-4xl font-semibold leading-[1.05] sm:text-5xl">
            처음 배포하시나요?
          </h1>
          <p className="text-balance text-lg leading-relaxed text-zinc-400">
            5분 안에 끝납니다. 그 전에 알아두면 좋은 것들 몇 가지.
          </p>
        </header>

        <ol className="flex flex-col">
          {sections.map((s) => (
            <li
              key={s.n}
              className="grid grid-cols-12 items-start gap-y-3 border-t border-zinc-900 py-10 lg:gap-x-8"
            >
              <div className="col-span-12 lg:col-span-2">
                <span className="font-mono text-xs uppercase tracking-[0.18em] text-zinc-500">
                  Step / {String(s.n).padStart(2, '0')}
                </span>
              </div>
              <div className="col-span-12 space-y-3 lg:col-span-10">
                <h2 className="display-tight text-balance text-xl font-semibold text-zinc-50 sm:text-2xl">
                  {s.title}
                </h2>
                <p className="text-balance text-base leading-relaxed text-zinc-400">
                  {s.body}
                </p>
                {'templateUrl' in s && s.templateUrl && (
                  <div className="flex flex-wrap items-center gap-3">
                    <a
                      href={s.templateUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="group inline-flex items-center gap-2 rounded-md bg-white px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-zinc-200"
                    >
                      <span>{s.templateLabel ?? 'Use this template'}</span>
                      <span className="transition-transform group-hover:translate-x-0.5">↗</span>
                    </a>
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-600">
                      또는
                    </span>
                  </div>
                )}
                {'code' in s && s.code && (
                  <pre className="overflow-x-auto rounded-md border border-zinc-900 bg-zinc-950 p-3 font-mono text-xs text-zinc-300">
                    <span className="text-zinc-600">$ </span>
                    {s.code}
                  </pre>
                )}
                {'after' in s && s.after && (
                  <p className="text-sm leading-relaxed text-zinc-500">{s.after}</p>
                )}
                {'bullets' in s && s.bullets && (
                  <ul className="space-y-2 pt-1">
                    {s.bullets.map((b) => (
                      <li
                        key={b}
                        className="flex items-start gap-3 text-sm leading-relaxed text-zinc-400"
                      >
                        <span className="mt-2 inline-block size-1 shrink-0 rounded-full bg-zinc-600" />
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
          <li className="border-t border-zinc-900" />
        </ol>

        <div className="flex flex-wrap items-center gap-4 pt-2">
          <Link
            href="/deploy"
            className="group inline-flex items-center gap-2 rounded-md bg-white px-5 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-zinc-200"
          >
            <span>Deploy 시작하기</span>
            <span className="transition-transform group-hover:translate-x-1">→</span>
          </Link>
          <Link
            href="/"
            className="text-sm text-zinc-500 transition-colors hover:text-zinc-100"
          >
            ← 홈으로
          </Link>
        </div>
      </div>
    </main>
  );
}
