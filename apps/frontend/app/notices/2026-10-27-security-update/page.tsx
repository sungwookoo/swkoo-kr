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
          <p className="font-mono text-xs text-zinc-500">2026.10.28 · 후속 개선</p>
          <h2 className="mt-3 text-lg font-medium text-zinc-200">파일 처리와 장애 안내 개선</h2>
          <p className="mt-3 leading-relaxed text-zinc-400">엑셀 데모에 압축 파일 검사와 처리 시간 제한을 추가했습니다. 배포 화면에서는 메모리 한도 초과와 서버 자원 대기를 구분해 다음 조치를 안내합니다. 환경변수 저장·앱 제거 실패 후 재시도와 데이터 유지 동작도 검증했습니다.</p>
          <p className="mt-3 leading-relaxed text-zinc-400">GitHub 연결 권한을 작업별로 좁히고, 상태 저장 앱의 새 버전 배포 후 데이터 유지·삭제 과정을 실제 환경에서 확인했습니다. 배포 후 보안 점검 결과와 현재 앱 버전의 비교 안내도 자동으로 갱신하도록 개선했습니다.</p>
          <p className="mt-3 leading-relaxed text-zinc-400">변경 요청이 겹칠 때의 보호와 신규 배포 전 서버 여유 확인을 추가했습니다. 배포 관리 화면에서는 본인 앱의 최근 사용량과 요청한 실행 로그를 확인할 수 있습니다.</p>
          <p className="mt-3 text-sm leading-relaxed text-zinc-500">이번 후속 작업에서도 이용자의 앱 저장소를 수정하지 않았습니다. 파일은 계속 브라우저 안에서만 처리합니다.</p>
        </section>
        <section className="mt-10 border-t border-zinc-800 pt-8">
          <p className="font-mono text-xs text-zinc-500">2026.10.29 · 운영 보호 보완</p>
          <h2 className="mt-3 text-lg font-medium text-zinc-200">저장공간 확인과 배포 후 검증</h2>
          <p className="mt-3 leading-relaxed text-zinc-400">새 앱을 받을 때 데이터 저장공간과 임시 저장공간의 여유를 나누어 확인하고, 파일 개수 부족도 확인하도록 보완했습니다. 신규 배포 앱에는 임시 파일·로그 사용 한도를 추가했습니다. 영구 저장공간의 앱별 초과 쓰기 차단은 아직 제공하지 않으며 이용 안내에도 이 한계를 명시했습니다.</p>
          <p className="mt-3 leading-relaxed text-zinc-400">배포 도중 남은 예약을 안전 조건을 확인한 후 복구하는 관리 기능과, 배포된 버전·HTTPS·주요 페이지를 확인하는 자동 점검을 추가했습니다. 이번 작업에서 이용자의 앱 저장소는 수정하지 않았습니다.</p>
        </section>
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
