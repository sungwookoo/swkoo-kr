import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: '보안 및 안정성 업데이트 — swkoo.kr',
  description: '로그인 보호, 작업 환경 격리와 보안 점검 안내를 개선했습니다.',
};

export default function SecurityUpdatePage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-20 sm:py-24">
      <Link href="/notices" className="text-sm text-zinc-400 underline-offset-4 hover:underline">← 공지사항</Link>
      <article className="mt-10">
        <time dateTime="2026-10-27" className="font-mono text-xs text-zinc-500">2026.10.27 · 적용 완료</time>
        <h1 className="mt-4 text-3xl font-semibold leading-tight text-zinc-100 sm:text-4xl">보안 및 안정성 업데이트</h1>
        <p className="mt-6 leading-relaxed text-zinc-400">swkoo.kr 플랫폼을 점검하고, 확인된 개선 사항을 운영 서비스에 반영했습니다. 주요 변경 내용은 다음과 같습니다.</p>
        <div className="mt-10 space-y-8 border-t border-zinc-800 pt-8">
          <section>
            <h2 className="text-lg font-medium text-zinc-200">로그인과 연결 정보 보호</h2>
            <p className="mt-3 leading-relaxed text-zinc-400">로그인 세션 보호를 강화하고, 로그아웃한 세션은 서버에서도 폐기하도록 개선했습니다. 서비스 연결에 사용하는 인증 정보의 저장 보호도 보강했습니다.</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-zinc-200">작업 환경과 서비스 기반 보강</h2>
            <p className="mt-3 leading-relaxed text-zinc-400">보안 점검·수정안 준비 작업의 실행 환경과 접근 권한을 더 엄격하게 분리했습니다. 플랫폼 구성 요소의 보안 패치와 인증서 관리 업데이트를 적용하고, 브라우저 보호 설정을 보강했습니다.</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-zinc-200">더 정확한 점검 결과 안내</h2>
            <p className="mt-3 leading-relaxed text-zinc-400">보안 점검이 현재 실행 중인 앱 버전을 기준으로 이루어지도록 개선했습니다. 이전 버전의 결과이거나 오래된 결과인 경우 구분해 안내하며, 아직 점검 기록이 없을 때의 조회 오류도 수정했습니다.</p>
          </section>
        </div>
        <section className="mt-10 border-t border-zinc-800 pt-8">
          <h2 className="text-lg font-medium text-zinc-200">이용 시 참고해 주세요</h2>
          <ul className="mt-3 list-disc space-y-3 pl-5 leading-relaxed text-zinc-400">
            <li>로그인 보호 정책 변경으로 다시 로그인이 필요할 수 있습니다.</li>
            <li>이번 업데이트로 이용자의 앱 저장소를 수정하거나 앱 의존성을 자동으로 변경하지 않았습니다.</li>
            <li>변경 사항은 자동화 테스트와 운영 환경 확인을 거쳤습니다. 보안 점검은 점검 시점과 범위에 따른 결과이며, 모든 위험이 없음을 보증하는 것은 아닙니다.</li>
          </ul>
        </section>
      </article>
    </main>
  );
}
