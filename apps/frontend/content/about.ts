// About page content. Kept terse on purpose — the UX brief is
// "curiosity-inducing keywords, click to expand", not a marketing
// long-read. Each tech entry stays at ~1 sentence per field so the
// detail panel never feels heavy. New keywords go in `techMatrix`;
// new design themes go in `systemPatterns`.

export interface TechItem {
  id: string;
  label: string;
  what: string;
  usedFor: string;
  whyItMatters: string;
}

export interface PatternItem {
  id: string;
  label: string;
  body: string;
}

export const hero = {
  eyebrow: 'ABOUT',
  // English headline — calm, technical. The spec offered a Korean
  // alternative; we picked English for the H1 to match the file's
  // tone (claims/patterns all read as labels first, prose second).
  title: 'A GitOps deployment system, running on a free-tier cloud.',
  subtitle:
    'GitHub App, Kubernetes, ArgoCD, OCI 를 엮어 단일 운영자가 다수 앱을 배포·관측하는 사이드 프로젝트.',
  meta: 'OCI A1.Flex (4 OCPU · 24 GB) · single-node k3s · zero managed services',
} as const;

export const claims: ReadonlyArray<{ label: string; body: string }> = [
  {
    label: 'Repo to Runtime',
    body: 'GitHub repo 를 선택하면 Dockerfile · GitHub Actions workflow · k8s manifest · ArgoCD Application 까지 자동으로 만들어진다.',
  },
  {
    label: 'GitOps by Default',
    body: '클러스터 상태는 git commit + ArgoCD Application 의 함수. 롤백은 git revert 한 줄.',
  },
  {
    label: 'Tenant-aware',
    body: '사용자별 namespace + NetworkPolicy default-deny + Pod Security Admission restricted + ResourceQuota.',
  },
  {
    label: 'Observable Operations',
    body: 'pipeline timeline · image scan · resource report · OCIR retention · Discord alert.',
  },
];

// Technology matrix — flat list, single source for the chip grid AND
// the detail panel. The order here is the render order, so we lead
// with the highest-signal items (delivery surface first, runtime
// after, supporting infra last).
export const techMatrix: ReadonlyArray<TechItem> = [
  {
    id: 'github-app',
    label: 'GitHub App',
    what: '사용자 repo 에 설치되는 OAuth + repo-level credential.',
    usedFor: '사용자별 토큰 발급 · repo 쓰기 · workflow commit.',
    whyItMatters: 'PAT 공유보다 권한 범위가 좁고 회전/철회가 즉시.',
  },
  {
    id: 'github-actions',
    label: 'GitHub Actions',
    what: 'repo-scoped CI/CD 러너.',
    usedFor: 'backend/frontend 이미지 빌드 + manifest 자동 갱신 commit.',
    whyItMatters: '별도 CI 서버 없이 git → registry → cluster 가 한 줄로 이어진다.',
  },
  {
    id: 'ghcr-ocir',
    label: 'GHCR / OCIR',
    what: 'GitHub Container Registry + Oracle Container Registry.',
    usedFor: '사용자 앱 → GHCR (user-owned), swkoo 인프라 → OCIR (cloud-owned).',
    whyItMatters: '권한 경계를 registry 단에서 분리. 운영자 실수로 사용자 이미지를 못 만진다.',
  },
  {
    id: 'kubernetes-k3s',
    label: 'Kubernetes / k3s',
    what: '단일 노드 경량 Kubernetes 디스트리뷰션.',
    usedFor: '모든 워크로드 호스팅 — backend · frontend · ArgoCD · Prometheus · 사용자 앱.',
    whyItMatters: '풀 K8s 의미를 유지하면서 control plane 비용은 0.',
  },
  {
    id: 'argocd',
    label: 'ArgoCD',
    what: 'GitOps continuous delivery controller.',
    usedFor: 'Application = git path → cluster namespace, automated sync + selfHeal.',
    whyItMatters: '클러스터 상태가 git 의 함수가 된다. kubectl apply 흔적 추적할 일 없음.',
  },
  {
    id: 'argocd-image-updater',
    label: 'ArgoCD Image Updater',
    what: 'GHCR/OCIR tag 변경을 polling 해서 Application image 를 갱신.',
    usedFor: '사용자 앱 (latest tag) 의 자동 롤아웃.',
    whyItMatters: '사용자가 push 한 이미지가 별도 git commit 없이 cluster 로 흘러간다.',
  },
  {
    id: 'cert-traefik',
    label: 'cert-manager / Traefik',
    what: 'TLS 인증서 자동 발급 + ingress 라우터.',
    usedFor: "Let's Encrypt HTTP-01/DNS-01, custom domain TLS 자동 갱신.",
    whyItMatters: '인증서 만료를 잊을 일 없음. 도메인별 발급으로 wildcard 의존 제거.',
  },
  {
    id: 'cname-token',
    label: 'Custom Domain CNAME-token',
    what: '사용자 도메인 검증 시 발급되는 1줄 CNAME 타깃.',
    usedFor: '도메인 소유 증명 + 트래픽 라우팅을 같은 레코드로.',
    whyItMatters: 'TXT/CNAME 2단계 검증 대신 한 줄로 끝. 사용자 onboarding 마찰 ↓.',
  },
  {
    id: 'sqlite',
    label: 'SQLite',
    what: '단일 파일 RDBMS, better-sqlite3 (sync FFI).',
    usedFor: 'users · audit_log · custom_domains.',
    whyItMatters: '단일 인스턴스 백엔드에 맞고, 백업은 cp 한 번. 마이그레이션 비용 0.',
  },
  {
    id: 'nestjs',
    label: 'NestJS',
    what: 'TypeScript backend 프레임워크.',
    usedFor: 'REST API + Kubernetes/ArgoCD/GitHub 클라이언트 통합.',
    whyItMatters: '모듈/DI 가 운영 로직 (auth · deploy · domain · email) 분리에 잘 맞는다.',
  },
  {
    id: 'nextjs',
    label: 'Next.js',
    what: 'React 19 + App Router.',
    usedFor: '정적 · SSR · 클라이언트 혼합 — landing 정적, /deploy SSR, /observatory dynamic.',
    whyItMatters: '같은 코드베이스에서 페이지마다 렌더 전략을 골라 쓸 수 있다.',
  },
  {
    id: 'prometheus-grafana',
    label: 'Prometheus / Grafana',
    what: '메트릭 수집 + 대시보드.',
    usedFor: 'backend SLI (5xx, P95) · Pod 재시작 · ArgoCD sync 지연.',
    whyItMatters: '클라우드 모니터링 없이도 SLO 정의 가능. 알람 룰은 git 으로 관리.',
  },
  {
    id: 'trivy',
    label: 'Trivy',
    what: '이미지 취약점 스캐너.',
    usedFor: '사용자 GHCR 이미지 daily scan, 결과는 deploy status 패널에 노출.',
    whyItMatters: '보안 보고를 별도 인프라 없이 같은 cluster 안에서 한다.',
  },
  {
    id: 'discord-webhook',
    label: 'Discord Webhook',
    what: 'channel-scoped POST webhook.',
    usedFor: 'build failure · resource report · OCIR retention · ArgoCD alert.',
    whyItMatters: 'PagerDuty 급 인프라 없이 핸드폰까지 도달. 채널을 분리해 노이즈 격리.',
  },
  {
    id: 'oci-free-tier',
    label: 'OCI Free Tier',
    what: 'Oracle Cloud 의 Always Free 자원 풀.',
    usedFor: 'A1.Flex 4 OCPU/24 GB · 200 GB block · 20 GB object storage.',
    whyItMatters: '평생 무료 ARM compute. 사이드 프로젝트 baseline 비용을 0 으로 깐다.',
  },
  {
    id: 'resource-monitoring',
    label: 'Resource Monitoring',
    what: 'nightly host + cluster vitals → Discord report.',
    usedFor: 'disk · RAM · PVC · containerd cache · Argo Synced/Healthy 수치.',
    whyItMatters: 'Free Tier 한도 초과를 사전에 잡는다. Prometheus 위 1단계 요약.',
  },
  {
    id: 'ocir-retention',
    label: 'OCIR Retention',
    what: '주간 OCIR cleanup workflow.',
    usedFor: 'backend/frontend SHA tag pruning · latest + 현재 배포 + N개 최신 보존.',
    whyItMatters: 'main push 마다 새 SHA 가 쌓이는 구조의 자연스러운 GC.',
  },
  {
    id: 'csrf-cors',
    label: 'CSRF / CORS hardening',
    what: 'SameSite=Lax cookie + 명시적 origin allowlist + per-route CSRF guard.',
    usedFor: '/api/* 의 mutating endpoint.',
    whyItMatters: '토큰 leak 위험을 origin/cookie 경계에서 한 번 더 줄인다.',
  },
  {
    id: 'pod-security',
    label: 'Pod Security Admission',
    what: 'namespace-level pod 보안 표준 강제.',
    usedFor: '모든 user-* namespace → restricted profile.',
    whyItMatters: '사용자 앱이 host 권한 escalation 못 함. seccomp · capabilities · runAsNonRoot 자동 검증.',
  },
  {
    id: 'network-policy',
    label: 'NetworkPolicy',
    what: 'namespace 간 트래픽 차단/허용 규칙.',
    usedFor: 'user namespace egress 차단 — DNS + 443/80 외부만 허용, RFC1918 + IMDS 차단.',
    whyItMatters: '사용자 앱이 cluster 내부 호출 또는 cloud metadata exfil 못 한다.',
  },
];

export const systemPatterns: ReadonlyArray<PatternItem> = [
  {
    id: 'gitops-control-plane',
    label: 'GitOps control plane',
    body: '클러스터 상태 = git commit + ArgoCD Application 의 함수. kubectl apply 흔적이 없으므로 drift 추적이 단순해지고, 롤백은 git revert 로 끝난다.',
  },
  {
    id: 'multi-tenant-isolation',
    label: 'Multi-tenant isolation',
    body: '사용자 namespace 마다 ResourceQuota · NetworkPolicy default-deny · PSA restricted 적용. 한 친구의 앱이 옆 친구의 앱이나 host 를 건드릴 수 없다.',
  },
  {
    id: 'deterministic-provenance',
    label: 'Deterministic provenance',
    body: '이미지 tag = main commit SHA. Deployment 의 image ref 가 정확히 어느 commit 을 빌드/배포했는지 1:1 매핑된다. "어느 버전 도는 중?" 의 모호함이 없다.',
  },
  {
    id: 'one-cname-verification',
    label: 'One-CNAME custom domain verification',
    body: 'TXT/CNAME 2단계 검증 대신 토큰이 박힌 CNAME 한 줄 (cd-sk-<token>.domains.swkoo.kr). 소유 증명과 트래픽 라우팅을 같은 레코드로 끝낸다.',
  },
  {
    id: 'cost-discipline',
    label: 'Operational cost discipline',
    body: 'Always-on 인프라는 0 원 (OCI Always Free). 정기 작업은 GitHub Actions free tier 분만 소비. daily Discord 요약으로 한도 초과 전 알람.',
  },
  {
    id: 'failure-aware-ux',
    label: 'Failure-aware UX',
    body: '배포 실패가 단순 message 가 아닌 reason + userAction 으로 구조화. 사용자가 본인 repo 의 어디를 고쳐야 하는지가 화면에 명시된다.',
  },
  {
    id: 'smoke-tested-flows',
    label: 'Smoke-tested frontend flows',
    body: 'Vitest 컴포넌트 테스트 + Playwright mock smoke 8 시나리오. 백엔드 호출은 page.route 로 가로채 외부 의존성 없이 UI 회귀를 잡는다.',
  },
];

// Architecture — short prose adjoining the mermaid diagram. The
// diagram component itself (ArchitectureDiagram) renders 3 tabs;
// these flow steps live on About so Observatory stays data-only.
export const architecture = {
  title: 'Architecture',
  subtitle: '코드 변경부터 운영 알람까지 한 흐름.',
  dataFlow: {
    title: '데이터/이벤트 흐름',
    steps: [
      'main push → GitHub Actions 가 backend/frontend 이미지 빌드, OCIR 로 push.',
      'workflow 가 deploy/base manifest 의 image tag 를 새 SHA 로 갱신 + commit.',
      'ArgoCD 가 새 commit 감지 → cluster sync.',
      'Prometheus 가 새 Pod 의 메트릭 수집 시작 → Observatory 가 timeline 으로 시각화.',
    ],
  },
  failureFlow: {
    title: '실패/알림 흐름',
    steps: [
      'CI 실패 → image 가 생성 안 됨, 다음 단계 자동 차단.',
      'sync 실패 / health 저하 → Alertmanager → Discord.',
      '/deploy/[login]/[repo] 상태 화면이 실패 reason 과 사용자 조치를 함께 표시.',
    ],
  },
} as const;

export const tradeOffs = {
  title: 'Trade-offs',
  subtitle: '선택하지 않은 옵션을 기록한다.',
  items: [
    {
      title: '고가용성 미구현',
      reason: '단일 노드 환경에서 운영 복잡도 대비 효과가 낮다.',
      risk: '노드 장애 시 서비스 중단을 감수.',
    },
    {
      title: 'Managed Kubernetes 미사용',
      reason: '운영 범위를 명확히 하고 비용 통제를 우선.',
      risk: '업그레이드/패치 책임이 운영자에게 집중.',
    },
    {
      title: '단일 클러스터 전략',
      reason: '리소스 제약과 운영 복잡도 최소화 우선.',
      risk: '테넌트 자원 격리에 한계가 존재.',
    },
    {
      title: 'Cloud Monitoring 미사용',
      reason: '관측 스택을 직접 운영해 알람 기준을 주도.',
      risk: '알람 튜닝과 노이즈 감소 책임을 직접 감당.',
    },
  ],
} as const;
