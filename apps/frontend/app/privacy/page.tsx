export const metadata = {
  title: '개인정보 처리방침 — swkoo.kr',
  description: 'swkoo.kr이 수집·저장하는 정보와 그 용도.',
};

export default function PrivacyPage(): JSX.Element {
  return (
    <main className="relative isolate w-full px-6 py-20 sm:py-24">
      <div className="mx-auto w-full max-w-3xl space-y-8">
        <header className="space-y-3 border-b border-zinc-900 pb-6">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-zinc-500">
            Privacy
          </p>
          <h1 className="display-tight text-balance text-3xl font-semibold text-zinc-50 sm:text-4xl">
            개인정보 처리방침
          </h1>
          <p className="text-xs text-zinc-500">시행일자: 2026-05-20</p>
        </header>

        <section className="space-y-3 text-sm leading-relaxed text-zinc-400">
          <p>
            swkoo.kr(이하 “서비스”)는 GitHub 연동 기반의 GitOps PaaS입니다.
            본 처리방침은 개인정보 보호법(K-PIPA) 제30조 및 GDPR Art.13에 준해
            서비스가 수집·이용하는 개인정보를 고지합니다.
          </p>
        </section>

        <Section title="1. 수집하는 개인정보 항목">
          <p>서비스는 다음 항목을 수집·저장합니다.</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong className="text-zinc-300">GitHub OAuth 사인인 정보</strong>:
              GitHub 사용자 ID, 로그인 핸들, 이름, 이메일(GitHub이 제공하는 경우),
              아바타 URL
            </li>
            <li>
              <strong className="text-zinc-300">OAuth refresh token</strong>:
              사용자 repo 정보 조회(스택 자동 감지·빌드 상태 폴링)에 사용. 백엔드 DB에 암호화 저장
            </li>
            <li>
              <strong className="text-zinc-300">감사 로그(audit_log)</strong>:
              사인인·배포 등록/해제·관리자 액션 시각, 행위자 GitHub 로그인, 액션 종류
            </li>
            <li>
              <strong className="text-zinc-300">배포 메타데이터</strong>: 등록한
              repo 식별자, 자동 생성된 Kubernetes 매니페스트(namespace·이미지 경로 등)
            </li>
            <li>
              <strong className="text-zinc-300">사용자 환경변수</strong>: 배포 설정
              페이지에서 사용자가 입력한 값 — Kubernetes Secret으로 클러스터에만 저장.
              DB·감사 로그에는 키 이름만 기록되고 값은 평문 저장하지 않음
            </li>
          </ul>
          <p>분석·광고 추적 쿠키 사용 없음.</p>
        </Section>

        <Section title="2. 수집·이용 목적">
          <ul className="list-disc space-y-1 pl-5">
            <li>GitHub 계정 기반 인증·세션 유지</li>
            <li>사용자 repo의 빌드·배포 파이프라인 자동 구성</li>
            <li>서비스 운영 및 장애 대응을 위한 모니터링(Observatory 콘솔)</li>
            <li>오·남용 방지를 위한 감사 로그 보관</li>
          </ul>
        </Section>

        <Section title="3. 보유 및 이용 기간">
          <ul className="list-disc space-y-1 pl-5">
            <li>계정 활성 상태: 사용자 본인이 계정을 삭제하기 전까지 보유</li>
            <li>
              계정 삭제 직후: 사용자 식별 정보(이름·이메일·아바타·OAuth 토큰)·
              환경변수·매니페스트는 즉시 삭제. 감사 로그는 익명화(개인 식별자 제거)
              상태로 보존
            </li>
            <li>
              계정 삭제 30일 후: 익명화된 감사 로그도 완전 삭제
            </li>
            <li>
              <strong className="text-zinc-300">일일 백업 스냅샷</strong>:
              운영 데이터(SQLite)는 매일 1회 OCI Object Storage(일본 도쿄)에
              스냅샷으로 저장되어 최대 90일 보존 후 자동 삭제됩니다. 계정 삭제 후
              새로 생성되는 백업은 익명화된 형태만 포함하지만, 삭제 *이전* 에 만들어진
              백업에는 retention 만료(최대 90일)까지 식별 정보가 잔존할 수 있습니다.
              백업은 운영자만 접근하며 사고 복구 목적 외에 사용되지 않습니다
            </li>
            <li>
              사용자가 push한 컨테이너 이미지(GHCR): 사용자 본인 GitHub
              계정에 저장되므로 운영자에게 보유·삭제 권한 없음
            </li>
          </ul>
        </Section>

        <Section title="4. 제3자 제공">
          <p>
            서비스는 사용자의 개인정보를 외부에 판매·제공하지 않습니다.
            법령에 의한 수사기관 요청 등 의무적 제공 사유 발생 시 사전에 사용자에게
            통지합니다(법적으로 통지가 금지된 경우 제외).
          </p>
        </Section>

        <Section title="5. 처리 위탁">
          <p>서비스 운영을 위해 다음 처리자에게 데이터 처리를 위탁합니다.</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong className="text-zinc-300">GitHub, Inc.</strong> — OAuth
              인증, 사용자 repo 코드·이미지 호스팅(GHCR)
            </li>
            <li>
              <strong className="text-zinc-300">Oracle Cloud Infrastructure
              (일본 도쿄 리전)</strong> — 컴퓨트 노드, 컨테이너 이미지 저장(OCIR),
              일일 운영 데이터 백업(Object Storage)
            </li>
            <li>
              <strong className="text-zinc-300">Let&apos;s Encrypt</strong> —
              TLS 인증서 발급
            </li>
            <li>
              <strong className="text-zinc-300">Discord</strong> — 운영자 알림 채널
              (사용자 식별 정보 미전송, 빌드·배포 이벤트만)
            </li>
          </ul>
        </Section>

        <Section title="6. 사용자 권리">
          <p>K-PIPA 제35~37조 및 GDPR Art.15~22에 따라 사용자는 다음 권리를 행사할 수 있습니다.</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>개인정보 열람 요구</li>
            <li>오류 정정·삭제 요구</li>
            <li>처리 정지 요구</li>
            <li>계정 삭제 요청</li>
            <li>데이터 이동권(보유 정보 JSON 내보내기)</li>
          </ul>
          <p>권리 행사는 서비스 내 기능 또는 아래 책임자 연락처로 요청 가능합니다.</p>
        </Section>

        <Section title="7. 안전성 확보 조치">
          <ul className="list-disc space-y-1 pl-5">
            <li>세션은 HTTP-only 쿠키 + 서명된 JWT(HS256)로 관리</li>
            <li>OAuth refresh token은 DB에 저장, 운영자만 접근 가능</li>
            <li>사용자 환경변수는 Kubernetes Secret으로만 저장 — 네임스페이스별 RBAC로 격리</li>
            <li>GitHub App 권한은 최소 범위(scoped to selected repos)로 운영</li>
            <li>전 구간 HTTPS 강제 (Let&apos;s Encrypt 인증서)</li>
          </ul>
        </Section>

        <Section title="8. 쿠키">
          <p>서비스는 필수 쿠키 1개만 사용합니다.</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <code className="font-mono text-zinc-300">swkoo_session</code> —
              사인인 세션. HTTP-only, Secure, 30일 만료. 비활성화 시 사인인 불가.
            </li>
          </ul>
        </Section>

        <Section title="9. 개인정보 보호 책임자">
          <ul className="list-disc space-y-1 pl-5">
            <li>이름: Sungwoo Koo</li>
            <li>
              연락처: <a href="mailto:sungwookoo.dev@gmail.com" className="text-zinc-300 underline-offset-2 hover:text-zinc-100 hover:underline">sungwookoo.dev@gmail.com</a>
            </li>
          </ul>
        </Section>

        <Section title="10. 처리방침 변경">
          <p>
            법령 또는 서비스 변경에 따라 본 처리방침이 변경될 경우, 변경 7일 전
            서비스 내 공지로 안내합니다. 중대한 변경은 30일 전 통지합니다.
          </p>
        </Section>
      </div>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="space-y-3 text-sm leading-relaxed text-zinc-400">
      <h2 className="text-base font-semibold text-zinc-200">{title}</h2>
      {children}
    </section>
  );
}
