# 📚 swkoo-kr 문서 인덱스

> 이 문서는 프로젝트 문서들의 역할과 위치를 정리합니다.

## 문서 구조

```
swkoo.kr/
├── 작업컨텍스트.md              # 🔧 전체 인프라 컨텍스트 (운영자용)
├── terraform-k3s/
│   └── AGENTS.md               # AI 에이전트 Terraform 가이드
└── swkoo-kr/
    ├── README.md               # 📋 프로젝트 로드맵 & 개요
    ├── deploy/
    │   └── README.md           # Kustomize 배포 가이드
    └── docs/                   # 📁 기술 문서 (중앙 저장소)
        ├── INDEX.md            # 이 파일 (문서 인덱스)
        ├── gitops-integration.md    # GitOps 통합 설계
        ├── github-actions-integration.md  # GitHub Actions 연동
        ├── alerting-implementation-plan.md # 알람 시스템 계획
        └── registry.md         # OCI Registry 설정
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

### 기술 문서 (`/swkoo-kr/docs/`)

| 문서 | 역할 | 상태 |
|------|------|------|
| **gitops-integration.md** | NestJS ↔ Argo CD 통합 설계 | ✅ 구현 완료 |
| **github-actions-integration.md** | GitHub Actions ↔ Backend 연동 | ✅ 구현 완료 |
| **alerting-implementation-plan.md** | Prometheus/Alertmanager 알람 설계 | ✅ Phase 1 완료 |
| **registry.md** | OCI Registry 설정 및 인증 | ✅ 완료 |
| **deploy-vision.md** | `/deploy` 친구한정 PaaS 정체성·아키텍처·Phase 표 | ✅ Phase 1·2·3.1·3.2·3.3 + Step 1·2 (sub-slug, 테스트, 백업, 알람 라우팅) 모두 완료 |
| **onboarding-friend.md** | 친구 1명 등록 단계별 체크리스트 (admin + friend 시점) | ✅ Phase 1.5 |
| **templates/friend-build-workflow.yml** | 친구 repo에 복사할 GitHub Actions 빌드 워크플로 | ✅ Phase 1.5 |
| **templates/Dockerfile.node.example** | Node.js 앱용 Dockerfile 예시 | ✅ Phase 1.5 |
| **REFACTORING_PROMPT.md** | 프로젝트 리팩토링 작업 프롬프트 | 📋 작업 지시서 |

## 문서 업데이트 규칙

1. **새 기능 구현 시**: `docs/` 폴더에 설계 문서 추가
2. **인프라 변경 시**: `작업컨텍스트.md` 업데이트
3. **로드맵 진행 시**: `swkoo-kr/README.md`의 체크박스 업데이트
4. **배포 방식 변경 시**: `deploy/README.md` 업데이트

## 변경 이력

| 날짜 | 작업 | 관련 문서 |
|------|------|----------|
| 2025-12-22 | 프로젝트 리팩토링 프롬프트 작성 | `REFACTORING_PROMPT.md` |
| 2025-12-22 | Mermaid 아키텍처 다이어그램 추가 | - |
| 2025-12-22 | Alertmanager Discord 연동 | `alerting-implementation-plan.md` |
| 2025-12-22 | GitHub Actions 워크플로 통합 | `github-actions-integration.md` |
| 2025-12-22 | 문서 구조 정리, INDEX.md 생성 | `INDEX.md` |
| 2026-05-20 | Step 1·2 묶음 반영. deploy-vision.md 상태 갱신 (Phase 1~3.3 + Step 1·2 완료). VISION/BIZ_READINESS/CLAUDE 문서 인덱스에 추가. | 다수 |

