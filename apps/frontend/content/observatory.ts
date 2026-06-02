// Observatory copy — data-only labels. The narrative copy (problem
// definition, design principles, architecture/CI-CD prose, observability
// rationale, trade-offs) moved to apps/frontend/content/about.ts when
// the About page was split out.

export const hero = {
  emoji: '🐟',
  title: 'Pipeline Observatory',
  subtitle:
    'GitOps 파이프라인과 런타임 상태를 한 화면에서 판단하는 운영 콘솔',
} as const;

export const statsLabels = {
  totalPipelines: '총 파이프라인',
  healthy: '정상',
  synced: '동기화 완료',
  lastUpdatedPrefix: '마지막 업데이트:',
} as const;

export const alerts = {
  title: '활성 알람',
  subtitle: 'Alertmanager로부터 현재 발화 중인 알람 목록',
  empty: '현재 활성 알람 없음',
  unconfigured: 'Alertmanager 자격 증명이 설정되지 않았습니다.',
  unconfiguredHint:
    '백엔드 환경 변수 ALERTMANAGER_BASE_URL 을 지정하면 활성 알람이 여기 표시됩니다.',
  severityLabel: {
    critical: 'Critical',
    warning: 'Warning',
    info: 'Info',
    unknown: 'Unknown',
  },
  pipelineCardBadge: '알람',
  consoleLink: {
    label: 'Grafana 알림 목록',
    url: 'https://grafana.swkoo.kr/alerting/list',
  },
  namespaceLabel: 'namespace',
} as const;

export const deployments = {
  title: '최근 배포',
  subtitle: 'Argo CD 동기화 이력에 GitHub commit 메타데이터를 결합',
  empty: '아직 배포 이력이 없습니다',
  unconfigured: 'Argo CD 자격 증명이 설정되지 않았습니다.',
  unconfiguredHint: '백엔드 환경 변수 ARGOCD_BASE_URL / ARGOCD_AUTH_TOKEN 을 지정해주세요.',
  stageLabel: {
    commit: 'commit',
    build: 'CI build',
    sync: 'Argo synced',
  },
  buildDuration: 'commit → ready',
  grafanaLink: {
    label: 'Grafana 메트릭',
    dashboardUrl:
      'https://grafana.swkoo.kr/d/85a562078cdf77779eaa1add43ccec1e/kubernetes-compute-resources-namespace-pods',
    preWindowMs: 5 * 60 * 1000,
    postWindowMs: 10 * 60 * 1000,
  },
} as const;

export const legend = {
  title: '상태 범례',
  sections: [
    {
      title: '파이프라인',
      items: [
        { color: 'bg-emerald-400', label: '성공' },
        { color: 'bg-rose-400', label: '실패' },
        { color: 'bg-sky-400', label: '실행 중' },
        { color: 'bg-slate-500', label: '대기' },
      ],
    },
    {
      title: '동기화',
      items: [
        { color: 'bg-emerald-400/90', label: '동기화 완료' },
        { color: 'bg-amber-400/90', label: '동기화 필요' },
      ],
    },
    {
      title: '헬스',
      items: [
        { color: 'bg-emerald-400/90', label: '정상' },
        { color: 'bg-amber-400/90', label: '저하' },
        { color: 'bg-rose-400/90', label: '미확인' },
      ],
    },
  ],
} as const;

export const emptyStates = {
  unconfiguredTitle: 'Argo CD 자격 증명이 설정되지 않았습니다.',
  unconfiguredHintPrefix: '백엔드 환경 변수',
  unconfiguredHintEnvVars: ['ARGOCD_BASE_URL', 'ARGOCD_AUTH_TOKEN'] as const,
  unconfiguredHintSuffix: '을 지정해주세요.',
  noPipelinesTitle: '파이프라인이 아직 없습니다',
  noPipelinesHint: 'Argo CD에 Application을 추가하면 여기에 표시됩니다.',
} as const;
