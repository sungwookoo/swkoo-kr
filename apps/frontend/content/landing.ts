export const hero = {
  // Two lines for visual rhythm; rendered with whitespace-pre-line.
  title: 'GitHub repo가\n라이브 앱이 됩니다.',
  tagline: '그 인프라까지 모두 공개됩니다.',
  description:
    'GitHub에 연결하면 Dockerfile부터 Kubernetes 매니페스트까지 자동으로 생성·commit되고, ArgoCD가 배포합니다. Next.js 앱을 지원합니다.',
  primaryCta: { label: 'Deploy with GitHub', href: '/deploy' as const },
  secondaryCta: { label: '운영 콘솔 (Observatory)', href: '/observatory' as const },
} as const;

export const howItWorks = {
  title: '세 단계로 배포가 끝납니다',
  subtitle: 'GitHub 로그인부터 라이브 URL까지, 사람이 개입하지 않습니다.',
} as const;

export const steps = [
  {
    n: 1,
    title: 'GitHub 로그인',
    body: 'GitHub App을 통해 repo 목록을 가져옵니다. 권한은 등록한 repo에만 부여됩니다.',
  },
  {
    n: 2,
    title: 'repo 선택 · 스택 자동 감지',
    body: 'package.json으로 스택을 식별하고, 포트·이미지 경로·서브도메인은 자동으로 결정됩니다.',
  },
  {
    n: 3,
    title: 'Deploy 클릭',
    body: 'Dockerfile과 GitHub Actions workflow는 사용자 repo에, Kubernetes 매니페스트는 운영 repo에 commit됩니다. ArgoCD가 5분 안에 라이브로 올립니다.',
  },
] as const;

export const trust = {
  title: '숨기는 인프라는 없습니다',
  description:
    'Observatory에서 배포 파이프라인, 활성 알람, MTTR을 실시간으로 추적할 수 있습니다. 클러스터 상태는 그대로 공개되어 있습니다.',
} as const;

export const builders = {
  title: '어떻게 만들어졌나',
  description:
    '단일 노드 k3s 기반 GitOps 풀스택입니다. 격리와 관측 정책은 운영자가 직접 관리합니다.',
  bullets: [
    'OCI A1.Flex (4 OCPU · 24GB · ARM64) 단일 노드 k3s',
    'Argo CD + ApplicationSet + Image Updater (digest 자동 추적)',
    'cert-manager DNS-01 wildcard + per-app TLS',
    'per-tenant ResourceQuota · LimitRange · NetworkPolicy',
    'Prometheus + Alertmanager → 운영자 Discord (arm64 변환 sidecar 자체 구현)',
    '일일 SQLite 백업 → OCI Object Storage (Instance Principal, 90일 retention)',
  ],
} as const;

export const liveStatus = {
  healthyLabel: 'Healthy',
  alertsLabel: '활성 알람',
  fetchFailed: '상태를 불러오지 못했습니다.',
} as const;
