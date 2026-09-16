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
      '영구 저장공간 ✅ — 지원되는 Prisma SQLite 앱에 1GiB 제공. 외부 DB는 공개 HTTPS API 방식으로 연결 가능. 일반 PostgreSQL·MySQL 포트 연결은 현재 지원하지 않음',
      '앱당 공유 CPU 예약 0.1코어·최대 0.5코어, 메모리 예약 256MiB·최대 512MiB',
      '사용자 앱 DB 자동 백업은 제공하지 않습니다. 영구 저장공간은 백업과 다르며, 앱 제거 시 연결된 DB도 삭제됩니다',
      '자원 상한은 자동으로 늘어나지 않습니다. 상향이 필요하면 운영자에게 문의해 주세요',
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
      '빌드 성공 후 `<slug>.apps.swkoo.kr` 로 자동 배포 (소요 시간은 빌드와 인프라 상태에 따라 달라짐) — 슬러그는 Deploy 화면에서 직접 입력 가능, 비우면 `<login>-<repo>` 기본값',
    ],
  },
  {
    n: 4,
    title: '본인 도메인 연결 (선택) — CNAME 한 줄',
    body: '기본 URL은 그대로 두고, 본인 소유 도메인의 서브도메인을 추가로 연결할 수 있습니다. 배포 후 /deploy/<login>/<repo> 페이지의 "커스텀 도메인" 패널에서 진행합니다.',
    bullets: [
      '연결은 CNAME 한 줄로 끝납니다 — DNS 관리 화면에서 패널에 표시된 Host/Target 값을 그대로 추가하면 됩니다. DNS 확인 후 인증서를 자동 발급하며, DNS 전파와 인증기관 상태에 따라 지연될 수 있습니다',
      '루트 도메인(`example.com`)은 직접 연결을 지원하지 않습니다 — 입력 시 `www.example.com` 같은 서브도메인 사용을 안내해 드립니다',
      '이미 Vercel/Netlify 등에 연결된 `www`는 그대로 두고 `portfolio.your-domain.com` 같은 새 서브도메인을 쓰는 걸 추천합니다 — 같은 host에 A 레코드와 CNAME은 공존할 수 없습니다',
      'DNS 업체별로 zone file import를 지원하면 [DNS 레코드 파일 다운로드]로 한 번에 적용할 수 있습니다 (Cloudflare, Route 53 등). 미지원이면 패널의 값을 그대로 복사해 직접 입력',
      'Cloudflare를 쓴다면 인증서 발급 전까지 CNAME은 DNS only(회색 구름) 권장',
    ],
    after:
      '기존에 TXT+CNAME 두 레코드로 연결돼 있는 도메인은 자동으로 계속 동작합니다. 새 등록은 CNAME 한 줄이면 됩니다.',
  },
  {
    n: 5,
    title: '보안 수정은 직접 요청하고 PR로 검토합니다',
    body: '관리 화면의 보안 수정 PR 요청에서 수정안 준비와 초안 PR 생성을 각각 선택할 수 있습니다. 배포 등록이나 스캔만으로 의존성 버전이 자동 변경되지는 않습니다.',
    bullets: [
      '공개 npm 패키지·단일 프로젝트·lockfile v2/v3 지원. 현재 버전 범위 안의 package-lock.json 변경만 제안합니다',
      '수정안 준비 시 의존성 이름·버전을 npm 공개 레지스트리에 보내 검사합니다. GitHub 저장소는 아직 변경하지 않습니다',
      '변경 목록을 확인하고 동의하면 별도 브랜치와 초안 PR을 생성합니다. 메이저 및 0.x minor 업그레이드·앱 코드·DB·Dockerfile·workflow 변경은 제외합니다',
      '앱 테스트·프로덕션 빌드·DB 연결은 미검증입니다. 직접 검증하고 병합 여부를 결정하세요. 병합 시 기존 자동 배포가 실행될 수 있습니다',
      '서비스의 자동 병합은 없습니다. 수정안은 24시간 후 만료되며 열린 보안 PR이 있으면 중복 생성을 막습니다',
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
            배포 전에 확인할 준비사항과 현재 지원 범위를 안내합니다.
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
