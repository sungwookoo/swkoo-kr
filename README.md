# swkoo.kr 애플리케이션 개요

> **방향 기준선:** [VISION.md](./VISION.md) ← 이 저장소의 모든 결정은 여기에서 파생됩니다.
> README는 VISION의 구체적 로드맵 표현입니다. 충돌하면 VISION이 우선합니다.

이 디렉터리(`swkoo-kr/`)는 `https://swkoo.kr`에 배포되는 **Observatory** 애플리케이션의 저장소 루트입니다. 백엔드는 NestJS, 프론트엔드는 Next.js(App Router) + TypeScript + Tailwind CSS를 사용합니다.

## Observatory는 무엇인가

**"Commit → CI Build → Registry Push → Argo Sync → Pod Ready" 한 번의 배포 생명주기를 단일 운영자 시점의 한 타임라인으로 엮고, 그 위에 활성 알람을 겹쳐 운영 판단을 가속하는** 관측 도구.

- **관측(observation)과 판단(decision)만** 담당. 조작(action)은 원천 도구(Argo CD/GitHub/Grafana)로 위임.
- 고유 가치: Argo CD UI / Grafana / GitHub Actions 사이의 **경계를 잇는 cross-tool 타임라인**.
- 자세한 정체성·non-goal·성공 기준은 [VISION.md](./VISION.md) 참조.

## 기능 심사 3질문 (모든 로드맵 항목에 적용)

새 항목을 추가하거나 체크리스트를 조정할 때는 먼저 VISION §5의 심사를 통과해야 합니다:

1. 이 기능은 Argo CD / Grafana / GitHub 중 하나가 이미 잘 하는가? → **링크**로 위임, 재구현 금지.
2. 이 기능은 위 세 도구 사이의 **경계를 잇는가?** → 이 앱의 핵심.
3. 이 기능은 조작인가 관측인가? → **조작이면 거절**한다.

---

## 로드맵

### Phase 1 – 기본 토대 ✅ 완료

1. **Monorepo 구조**
   - `apps/backend` : NestJS API
   - `apps/frontend`: Next.js(SSR) 프론트엔드
2. **최소 Landing + Observatory 페이지**
3. **기본 API**: `GET /health`, `GET /overview`

### Phase 2 – 읽기 전용 통합 ✅ 대부분 완료

| 항목 | 상태 | 심사 결과 |
|---|---|---|
| Argo CD API 연동 (`GET /api/pipelines`, `GET /api/pipelines/:name`) | ✅ | ② 경계 잇기 — 핵심 |
| GitHub API 연동 (`GET /api/pipelines/:name/workflows`) | ✅ | ② 경계 잇기 — 핵심 |
| 인메모리 캐시 + TTL (`PIPELINES_CACHE_TTL`) | ✅ | 내부 구현 |
| Pipeline Observatory UI (상태 배지/타임라인 카드) | ✅ | ③ 관측 — OK |
| GitHub Actions run 요약 표시 | ✅ | ③ 관측 — OK |
| Mermaid 아키텍처 다이어그램 | ✅ | A(설계 설명) — OK |
| Alertmanager → Discord 연동 | ✅ | 인프라 측 |
| swkoo + ArgoCD + backend SLO 알람 규칙 (총 13개) | ✅ | 인프라 측 — `deploy/observability/` 별도 Argo CD app 으로 관리 |
| Backend `/metrics` (prom-client) + ServiceMonitor | ✅ | 인프라 측 — http_requests_total / http_request_duration_seconds |
| ArgoCD 메트릭 ServiceMonitor 3종 (controller / server / repo) | ✅ | 인프라 측 |

### Phase 2.5 – 고유 가치 확립 ✅ 완료

VISION §2의 핵심(cross-tool 타임라인 + 알람 overlay)에 가장 직접 닿는 항목들.

| 항목 | 상태 | 심사 결과 |
|---|---|---|
| 활성 알람 overlay를 Observatory에 표시 (Alertmanager API) | ✅ | ② 경계 잇기 — **핵심** |
| 배포 1건 단위로 `commit → run → image → sync → pod` 연결 뷰 | ✅ | ② 경계 잇기 — **핵심** |

### Phase 3 – 이벤트 스토어 & 히스토리 ✅ 완료

"실시간"은 과잉 주장이므로 **near-real-time**으로 정직하게 표기. 진짜 WebSocket 스트리밍은 non-goal.

| 항목 | 상태 | 심사 결과 |
|---|---|---|
| Argo CD Webhook → 경량 이벤트 스토어(SQLite 수준) | ✅ | 관측 인프라 — argocd-notifications + better-sqlite3 |
| GitHub Actions Webhook 수신 | ✅ | 관측 인프라 — workflow_run 이벤트 HMAC 검증 |
| 배포 이벤트 히스토리(최근 N회, MTTR 추이) | ✅ | ② 경계 잇기 — **핵심** — `/api/pipelines/:name/event-summary` |
| Grafana 패널 **임베드/링크** | ✅ | ① 재구현 금지, 링크만 — DeploymentList에서 시간 윈도우 deep link |
| (보너스) ArgoCD 이벤트를 Discord에도 fan-out | ✅ | 인프라 측 — argocd-notifications service 추가 |

### Non-goals (의도적으로 안 만듦)

VISION §3 전체가 여기로 매핑됨. 요약:

- ❌ **Argo CD UI 조작 기능 재구현** (Sync/Refresh 버튼, 리소스 편집 등)
- ❌ **Grafana 차트 재구현** (CPU/Mem/지연 시계열)
- ❌ **진짜 실시간(WebSocket/SSE) 스트리밍 주장** — Webhook + 폴링까지만
- ❌ **오픈소스 제품화 / 설정 외부화** (현 단계에서 Application/Repo 목록은 하드코딩 유지)

이 목록은 기능 제안이 왔을 때 **가장 먼저** 확인합니다.

---

## 기술 스택

- **Backend**: NestJS, TypeScript, Axios, class-validator
- **Frontend**: Next.js(App Router) + TypeScript + Tailwind CSS + SWR + Zustand + Mermaid
- **통신**: REST. Webhook 수신은 Phase 3에 도입 예정.
- **테스트**: Jest (Nest)

## 컨테이너 빌드

- 백엔드: `scripts/build-backend.sh <이미지태그>` → `apps/backend/Dockerfile`
- 프론트엔드: `scripts/build-frontend.sh <이미지태그>` → `apps/frontend/Dockerfile`
- 런타임 환경변수
  - Backend: `PORT`, `ARGOCD_BASE_URL`, `ARGOCD_AUTH_TOKEN`, `PIPELINES_CACHE_TTL`
  - Frontend: `PORT`, `NEXT_PUBLIC_API_BASE_URL`

## CI/CD 파이프라인

- GitHub Actions: `.github/workflows/docker-publish.yml`
  - 기본 브랜치 푸시 시 백/프론트 이미지를 빌드 후 OCIR로 푸시
  - 시크릿/절차는 [`docs/registry.md`](./docs/registry.md) 참고

## 문서 구조

- [`VISION.md`](./VISION.md) — **기준선**. 정체성·고유가치·non-goal·성공 기준.
- `README.md` (이 파일) — Observatory 앱 로드맵의 구체 표현.
- [`BIZ_READINESS.md`](./BIZ_READINESS.md) — 친구 베타 → 유료 SaaS 전환 사전 조건 + 진척 체크리스트.
- [`docs/INDEX.md`](./docs/INDEX.md) — 기술 문서 인덱스.
- [`docs/deploy-vision.md`](./docs/deploy-vision.md) — `/deploy` PaaS Phase 표 + 아키텍처 (이 README 의 Observatory 로드맵과 별개).
- [`docs/REFACTORING_PROMPT.md`](./docs/REFACTORING_PROMPT.md) — 과거 리팩토링 지시서 (VISION에 종속).
- [`deploy/README.md`](./deploy/README.md) — Kustomize 배포 구조 + 운영자 runbook (Secret · 백업 · 복구 · 알람 라우팅).
