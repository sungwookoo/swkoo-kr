import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: '만든 서비스를 계속 운영한다는 것 — swkoo.kr',
  description: '사용자 동의, 보안 개선, 운영 검증으로 돌아본 배포 플랫폼 사이드 프로젝트의 운영 기록.',
};

export default function OperationsCaseStudy() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-20 sm:py-24">
      <Link href="/about" className="text-sm text-slate-400 underline-offset-4 hover:underline">← About</Link>
      <article className="mt-10 break-keep">
        <p className="font-mono text-xs tracking-widest text-slate-500">OPERATIONS NOTE · <time dateTime="2026-10-27">2026.10.27</time></p>
        <h1 className="mt-4 text-balance text-3xl font-semibold leading-tight text-slate-100 sm:text-4xl">만든 서비스를 계속 운영한다는 것</h1>
        <p className="mt-5 text-lg leading-relaxed text-slate-300">배포 플랫폼 사이드 프로젝트에서 사용자 동의와 보안 개선, 운영 검증을 다룬 기록.</p>
        <p className="mt-5 leading-relaxed text-slate-400">swkoo.kr은 GitHub 저장소를 연결해 앱을 배포하는 1인 운영 사이드 프로젝트다. 다른 사람의 저장소와 인증 정보를 다루면서, 기능의 편리함뿐 아니라 변경 권한과 실패했을 때의 동작도 제품 설계의 일부가 됐다.</p>

        <div className="mt-12 space-y-10 border-t border-slate-800 pt-10">
          <section>
            <h2 className="text-xl font-semibold text-slate-100">01. 문제 — 동작하는 기능에도 설명이 필요했다</h2>
            <p className="mt-4 leading-relaxed text-slate-400">로그인하지 않은 이용자가 조회 오류를 만났고, 보안 수정 기능에서는 지원 범위와 변경 기준을 이해하기 어렵다는 피드백이 있었다. 운영 과정에서는 화면의 자원 안내와 실제 제공 내용도 일치시킬 필요가 있었다.</p>
            <p className="mt-4 leading-relaxed text-slate-400">오류를 하나씩 고치는 것과 함께, 플랫폼이 무엇을 대신 결정해도 되는지와 이용자에게 어떤 근거를 보여줄지를 다시 정리했다.</p>
          </section>
          <section>
            <h2 className="text-xl font-semibold text-slate-100">02. 판단 — 자동화의 범위를 먼저 정했다</h2>
            <h3 className="mt-5 font-medium text-slate-200">저장소 변경은 동의와 검토를 거친다</h3>
            <p className="mt-3 leading-relaxed text-slate-400">보안 개선이라는 이유만으로 이용자의 앱 버전을 강제로 올리면 호환성과 서비스 동작을 깨뜨릴 수 있다. 사용자가 요청하면 지원 범위 안에서 수정안을 준비하고, 변경 내용을 확인한 뒤 초안 PR을 만드는 흐름으로 정리했다. 서비스가 자동으로 병합하지 않으며, 준비한 뒤 원본이 바뀌었다면 다시 확인한다.</p>
            <h3 className="mt-5 font-medium text-slate-200">검사 결과에는 대상과 시점이 있어야 한다</h3>
            <p className="mt-3 leading-relaxed text-slate-400">같은 이미지 태그도 나중에는 다른 내용을 가리킬 수 있다. 실행 중인 이미지의 고유 식별값을 기준으로 점검하고, 현재 앱과 다른 결과이거나 오래된 결과라면 구분해 표시하도록 개선했다. 결과의 숫자만으로 이용자가 현재 상태를 오해하지 않게 하는 선택이었다.</p>
          </section>
          <section>
            <h2 className="text-xl font-semibold text-slate-100">03. 개선 — 권한과 실패의 영향을 줄였다</h2>
            <p className="mt-4 leading-relaxed text-slate-400">점검·수정안 준비 작업의 실행 환경과 접근 권한을 분리하고, 로그인 세션과 저장된 인증 정보의 보호를 보강했다. 플랫폼 의존성을 패치하고, 인증서 관리와 운영 기반도 단계적으로 업데이트했다.</p>
            <p className="mt-4 leading-relaxed text-slate-400">로그아웃은 브라우저에서 쿠키를 지우는 데서 끝나지 않고 서버에서도 해당 세션을 폐기하도록 했다. 기존 세션을 그대로 유지하는 편의성보다 새 보호 정책을 일관되게 적용하는 쪽을 택했고, 재로그인이 필요할 수 있다는 안내를 함께 제공했다.</p>
          </section>
          <section>
            <h2 className="text-xl font-semibold text-slate-100">04. 검증 — 배포한 환경에서 다시 확인했다</h2>
            <p className="mt-4 leading-relaxed text-slate-400">2026년 10월 27일 보안 개선 배포 기준으로 백엔드 테스트 326개, 프런트엔드 테스트 95개, 브라우저 테스트 20개가 통과했다. 이 수치는 제품 전체에 대한 검증 범위를 나타내며, 모두 보안 전용 테스트라는 뜻은 아니다.</p>
            <ul className="mt-5 list-disc space-y-3 pl-5 leading-relaxed text-slate-400">
              <li>운영 환경에서 로그아웃한 세션의 재사용이 거부되는지 확인했다.</li>
              <li>허용된 작업은 실행되고, 허용하지 않은 권한과 접근은 차단되는지 확인했다.</li>
              <li>기존 인증서 상태뿐 아니라 별도 테스트 도메인의 신규 인증서 발급도 확인했다.</li>
              <li>실제 운영 이미지와 주요 화면을 점검하고, 모바일 표시와 브라우저 보호 설정의 영향을 확인했다.</li>
            </ul>
            <p className="mt-4 leading-relaxed text-slate-400">설정 파일에 제한이 적혀 있다는 사실만으로 실제 차단을 단정하지 않았다. 통신 검사에서 기대와 다른 결과를 발견했을 때는 방어를 보강하고, 필요한 기존 연동도 유지되는지 함께 재검증했다. 이번 플랫폼 보안 배포에서 이용자의 앱 저장소는 수정하지 않았다.</p>
          </section>
          <section>
            <h2 className="text-xl font-semibold text-slate-100">05. 남은 한계와 배운 점</h2>
            <p className="mt-4 leading-relaxed text-slate-400">이번 점검은 외부 전문 침투 시험이나 모든 계정·운영 조건을 포괄하는 검증이 아니다. 여러 실제 사용자 계정의 로그인까지 포함한 교차 계정 시험과 인프라 계정 권한 전체 감사는 별도 범위로 남아 있다. 점검 시점의 결과가 앞으로 발견될 취약점까지 보증하지도 않는다.</p>
            <p className="mt-4 leading-relaxed text-slate-400">구현과 점검에는 AI 코딩 도구를 활용했다. 도구가 제안한 수정도 사용자 동의 범위, 운영 영향, 테스트와 배포 후 확인이라는 기준을 거치도록 작업을 진행했다.</p>
            <p className="mt-4 leading-relaxed text-slate-300">이 과정에서 남긴 것은 패치 목록뿐 아니라 변경을 결정하는 기준과 검증 기록이다. 작은 서비스라도 이용자의 자원을 다룬다면, 자동화의 경계를 정하고 실제 동작을 확인하는 일까지 개발에 포함된다.</p>
          </section>
        </div>
        <footer className="mt-12 border-t border-slate-800 pt-6">
          <Link href="/notices/2026-10-27-security-update" className="text-sm text-slate-400 underline-offset-4 hover:underline">이용자용 업데이트 공지 보기 →</Link>
        </footer>
      </article>
    </main>
  );
}
