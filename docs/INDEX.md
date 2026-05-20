# 📚 swkoo-kr 문서 인덱스

> 이 문서는 프로젝트 문서들의 역할과 위치를 정리합니다.

## 문서 구조

```
swkoo.kr/
├── 작업컨텍스트.md              # 🔧 전체 인프라 컨텍스트 (운영자용)
├── terraform-k3s/
│   └── AGENTS.md               # AI 에이전트 Terraform 가이드
└── swkoo-kr/
    ├── VISION.md               # 🎯 정체성·고유가치·non-goal (기준선)
    ├── README.md               # 📋 Observatory 앱 로드맵 & 개요
    ├── BIZ_READINESS.md        # 💼 친구 베타 → 유료 SaaS 전환 사전 조건
    ├── CLAUDE.md               # 🤖 AI 에이전트 작업 가이드라인
    ├── deploy/
    │   └── README.md           # Kustomize 배포 구조 + 운영자 runbook
    └── docs/                   # 📁 활성 기술 문서
        ├── INDEX.md            # 이 파일
        ├── deploy-vision.md    # /deploy PaaS 정체성·아키텍처·Phase 표
        └── REFACTORING_PROMPT.md  # (historical) 페이지 카피 origin reference
```

## 문서별 역할

### 운영 문서 (루트 레벨)

| 문서 | 위치 | 역할 | 대상 |
|------|------|------|------|
| **작업컨텍스트.md** | `/` | 인프라 전체 현황, 변수, 자격증명 메모 | 운영자/AI |
| **AGENTS.md** | `/terraform-k3s/` | Terraform 작업용 AI 가이드 | AI 에이전트 |

### 프로젝트 문서

| 문서 | 위치 | 역할 |
|------|------|------|
| **VISION.md** | `/swkoo-kr/` | 정체성·고유 가치·non-goal·성공 기준 (모든 결정의 기준선) |
| **README.md** | `/swkoo-kr/` | Observatory 앱 로드맵, 기술 스택, 빌드 방법 |
| **BIZ_READINESS.md** | `/swkoo-kr/` | 친구 베타 → 유료 SaaS 전환 시 사전 조건 + 진척 체크리스트 |
| **CLAUDE.md** | `/swkoo-kr/` | AI 에이전트 작업 가이드라인 (단순성·외과적 변경·목표 기반) |
| **deploy/README.md** | `/swkoo-kr/deploy/` | Kustomize 배포 구조 + 운영자 runbook (Secret·백업·복구·알람 라우팅) |

### 활성 기술 문서 (`/swkoo-kr/docs/`)

| 문서 | 역할 | 상태 |
|------|------|------|
| **deploy-vision.md** | `/deploy` 친구한정 PaaS 정체성·아키텍처·Phase 표 | ✅ Phase 1·2·3.1·3.2·3.3 + Step 1·2 (sub-slug, 테스트, 백업, 알람 라우팅) 완료 |
| **REFACTORING_PROMPT.md** | 페이지 카피 origin reference (자체 "Superseded by VISION" 명시) | 📜 historical |

### 진실의 위치 (Source of truth)

설계 문서가 코드와 갈라지는 것을 막기 위해, *현재 상태* 의 진실은 다음 위치에 있습니다:

| 영역 | 진실 위치 |
|------|----------|
| Observatory 앱 로드맵 | `README.md` |
| `/deploy` PaaS Phase 표 + 미해결 결정 | `docs/deploy-vision.md` |
| 친구 베타 → 유료 전환 사전 조건 | `BIZ_READINESS.md` |
| 배포 매니페스트 + 운영자 runbook (Secret·백업·복구·알람) | `deploy/README.md` |
| 백엔드 코드 동작 (templates, validators, services) | `apps/backend/src/` |
| 알람 룰 본문 | `deploy/observability/*-alerts.yaml` |

## 문서 업데이트 규칙

1. **새 기능 구현 시**: 진실 위치를 갱신. 별도 설계 문서는 *최소화* (시간이 지나면 코드와 어긋남)
2. **인프라 변경 시**: `작업컨텍스트.md` 갱신
3. **로드맵 진행 시**: `README.md` 또는 `docs/deploy-vision.md` 갱신
4. **배포·운영 절차 변경 시**: `deploy/README.md` 갱신

## 변경 이력

| 날짜 | 작업 | 관련 문서 |
|------|------|----------|
| 2025-12-22 | 프로젝트 리팩토링 프롬프트 작성 | `REFACTORING_PROMPT.md` |
| 2025-12-22 | 문서 구조 정리, INDEX.md 생성 | `INDEX.md` |
| 2026-05-20 | Step 1·2 묶음 반영. deploy-vision.md 상태 갱신 (Phase 1~3.3 + Step 1·2 완료). VISION/BIZ_READINESS/CLAUDE 인덱스에 추가. | 다수 |
| 2026-05-20 (later) | 구현이 끝났거나 변경되어 stale 한 6개 문서 삭제: `gitops-integration.md`, `github-actions-integration.md`, `alerting-implementation-plan.md`, `registry.md`(평문 토큰 포함), `onboarding-friend.md`(Phase 1 수동 절차, Phase 2 self-serve 로 대체), `templates/` 디렉토리(`apps/backend/src/deploy/templates.ts` 가 권위). 진실의 위치 매트릭스 추가. | INDEX |
