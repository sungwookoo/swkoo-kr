export const metadata = {
  title: '이용약관 — swkoo.kr',
  description: 'swkoo.kr 이용약관.',
};

export default function TermsPage(): import("react").ReactNode {
  return (
    <main className="relative isolate w-full px-6 py-20 sm:py-24">
      <div className="mx-auto w-full max-w-3xl space-y-8">
        <header className="space-y-3 border-b border-zinc-900 pb-6">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-zinc-500">
            Terms
          </p>
          <h1 className="display-tight text-balance text-3xl font-semibold text-zinc-50 sm:text-4xl">
            이용약관
          </h1>
          <p className="text-xs text-zinc-500">시행일자: 2026-05-14</p>
        </header>

        <section className="space-y-3 text-sm leading-relaxed text-zinc-400">
          <p>
            본 약관은 swkoo.kr(이하 “서비스”)을 이용함에 있어 운영자와 사용자 간의
            권리·의무·책임 사항을 규정합니다. 사용자는 서비스 가입·이용 시 본 약관에
            동의한 것으로 간주됩니다.
          </p>
        </section>

        <Section title="1. 서비스의 성격">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              본 서비스는 GitHub 연동 기반의 GitOps PaaS로, 사용자의 GitHub repo에서
              빌드한 컨테이너 이미지를 Kubernetes 클러스터에 자동 배포합니다.
            </li>
            <li>사용자는 GitHub 계정으로 사인인하여 서비스를 이용할 수 있습니다.</li>
            <li>
              서비스 이용에 관한 요금·플랜·환불 정책은 별도 가격 안내 페이지를 참조합니다.
            </li>
          </ul>
        </Section>

        <Section title="2. 가용성 및 면책">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              운영자는 합리적인 노력으로 서비스의 안정성·가용성을 유지합니다.
            </li>
            <li>
              인프라 장애, 외부 종속성(GitHub·DNS·인증 기관 등) 장애, 또는 정기 점검으로 인한 일시적인 서비스 중단이 발생할 수 있으며,
              이로 인한 직·간접 손해에 대해 운영자는 별도 SLA로 명시된 범위를 초과하여 책임지지 않습니다.
            </li>
            <li>
              사용자 코드 자체의 결함·취약점으로 인한 손해에 대해 운영자는 책임지지 않습니다.
            </li>
          </ul>
        </Section>

        <Section title="3. 사용자 자격 및 등록">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              GitHub 계정으로 OAuth 사인인하여 서비스를 이용합니다.
            </li>
            <li>
              사용자는 본인 명의의 GitHub 계정만 사용해야 하며, 타인의 계정·repo를 도용할 수 없습니다.
            </li>
            <li>
              운영자는 본 약관 위반·법령 위반·인프라 오용이 확인된 경우 사용자 자격을 정지하거나
              해지할 수 있습니다.
            </li>
          </ul>
        </Section>

        <Section title="4. 금지 행위">
          <p>다음 행위를 금합니다. 적발 시 즉시 배포 중단 및 자격 정지·해지됩니다.</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>대한민국 법령 또는 관련 국가 법령 위반 콘텐츠 배포</li>
            <li>스팸 송신·암호화폐 채굴·DDoS 발신 등 인프라 오용</li>
            <li>의도적 자원 점유로 다른 사용자에게 영향을 미치는 행위</li>
            <li>운영자 또는 다른 사용자에 대한 공격·해킹·취약점 악용 시도</li>
            <li>저작권·상표권·개인정보 침해 콘텐츠 배포</li>
          </ul>
        </Section>

        <Section title="5. 자원 한도">
          <p>사용자 당 기본 한도가 적용됩니다(플랜별 상향 가능).</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>CPU: requests 0.5 core / limits 1 core</li>
            <li>RAM: requests 512MB / limits 1GB</li>
            <li>Pod: 3개</li>
            <li>PersistentVolumeClaim: 1개 / 1GB</li>
            <li>네트워크: NetworkPolicy로 사설 IP 대역 차단, DNS·HTTP/HTTPS만 허용</li>
          </ul>
          <p className="text-xs text-zinc-500">
            한도 초과 시 신규 Pod 생성이 거부됩니다. 한도 상향은 운영자에게 직접 요청하거나 상위 플랜으로 전환합니다.
          </p>
        </Section>

        <Section title="6. 콘텐츠 책임">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              사용자가 배포하는 콘텐츠·코드의 적법성·저작권·개인정보 처리에 대한 모든
              책임은 사용자 본인에게 있습니다.
            </li>
            <li>
              운영자는 사용자 콘텐츠를 사전 검열하지 않으나, 제3자 신고 또는 명백한 위법
              발견 시 사전 통보 없이 배포를 중단할 수 있습니다.
            </li>
          </ul>
        </Section>

        <Section title="7. 운영자의 권리">
          <ul className="list-disc space-y-1 pl-5">
            <li>운영자는 서비스 운영·점검·기능 변경을 사전 통보 후 수행합니다(긴급 점검 제외).</li>
            <li>본 약관 또는 법령 위반 시 사전 통보 없이 자격 정지·배포 제거할 수 있습니다.</li>
            <li>서비스 전체 종료 시 최소 30일 전 사전 공지합니다.</li>
          </ul>
        </Section>

        <Section title="8. 약관 변경">
          <p>
            본 약관 변경 시 변경 7일 전 서비스 내 공지합니다. 중대 변경은 30일 전 통지.
            변경 후 서비스 계속 사용은 변경된 약관에 대한 동의로 간주됩니다.
          </p>
        </Section>

        <Section title="9. 준거법 및 관할">
          <p>
            본 약관은 대한민국 법률에 따르며, 분쟁 발생 시 운영자 주소지 관할 법원을 1심
            전속 관할로 합니다.
          </p>
        </Section>

        <Section title="10. 문의">
          <p>
            연락처: <a href="mailto:sungwookoo.dev@gmail.com" className="text-zinc-300 underline-offset-2 hover:text-zinc-100 hover:underline">sungwookoo.dev@gmail.com</a>
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
}): import("react").ReactNode {
  return (
    <section className="space-y-3 text-sm leading-relaxed text-zinc-400">
      <h2 className="text-base font-semibold text-zinc-200">{title}</h2>
      {children}
    </section>
  );
}
