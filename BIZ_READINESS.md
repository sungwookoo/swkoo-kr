# BIZ_READINESS

> 이 문서는 swkoo.kr 프로젝트가 **유료 모델로 전환**할 때 진실이 되어야 하는 것들을 추적한다. friend-only 베타 가정의 [`docs/deploy-vision.md`](./docs/deploy-vision.md) 와 짝을 이룬다. §0 활성화 신호가 발생하면 본격 갱신·실행한다.

이 문서는 [VISION.md](./VISION.md)와 다르다. VISION은 *지금 만드는 것의 정체성*이고, 이 문서는 *돈을 받기 시작하면 진실이 되는 것*이다. 두 문서가 충돌하는 항목은 의도된 — VISION의 non-goal 중 일부가 사업화 시점에 깨져야 함을 명시적으로 추적하는 게 이 문서의 역할.

---

## 0. 활성화 신호

이 중 하나가 발생하면 §1·§2를 본격 점검·실행 시점:

- 친구 아닌 외부 사용자의 등록 시도(allowlist 거절 로그)가 한 달 5건 이상
- 베타 사용 친구가 "내 친구도 써도 되냐" 묻기 시작
- 사용 중인 친구가 "유료라도 쓰겠다"고 말함
- 1인 운영 부담이 가시화 (Observatory 알람 응답 시간 30분 초과 빈발)

그 전엔 친구용 Phase 2 v0 운영하며 신호 수집.

---

## 1. P0 — 사업 진입 전 반드시 해결

### 1.1 단일 노드 = SLA 불가

OCI Always Free A1은 단일 노드 천장 (4 OCPU/24GB). 노드 down = 모든 고객 down. 실효 가용성 ~95% — 유료 고객 기대치 99% 미만.

**해결 경로 (택1)**:
- Free 떠남: OCI Paid 또는 관리형 k8s (~$50-200/월 시작)
- "Asia-only beta · best-effort SLA" 명시 후 가격 낮추기
- Hard pivot: Fly.io / Railway 같은 외부 플랫폼 위에 메타 레이어로 (자체호스팅 정체성 포기)

**현재 deploy-vision §3 명문**: "SLA 보장 ❌". 이 문장을 깰 자원·운영 계획 없이 사업 시작 ❌.

### 1.2 멀티테넌트 격리 강도

현재 안전망: namespace + NetworkPolicy + ResourceQuota + LimitRange. 빠진 것:
- 이미지 스캔 (Trivy 등) — 친구가 악성 이미지 push 시 그대로 실행
- Pod Security Admission (PSA) `restricted` profile enforce 없음
- CNI 단일 평면 — 다른 tenant 패킷 가시성

**해결 (P0 블로커는 아니지만 강력 권장)**:
- Trivy admission webhook (HIGH 이상 차단)
- PSA `restricted` namespace label 강제
- 진짜 강격리 필요 시 vCluster 또는 Kamaji (전용 control plane per tenant)

**현재 Phase에서 할 일**: 사용자 코드 책임 명시 — T&C에 "사용자 작성 코드의 보안·법적 책임은 사용자에게 있다" 조항 필요.

### 1.3 매니페스트 repo 단일성

현재 `swkoo-kr/deploy/users/*` 에 모든 친구 매니페스트. 사업화 시 문제:
- 고객 A의 git diff에서 고객 B 매니페스트 노출 가능
- repo public이면 모든 metadata.yaml 외부 검색됨
- 한 commit 사고가 모든 tenant 영향

**Phase 2에서 즉시 할 일**:
- `swkoo-kr` repo 공개 여부 확인 → public이면 **private 전환 검토**
- 코드에서 `getUserManifestPath(login)` 같은 함수로 경로 추상화 한 겹 — 차후 per-tenant repo 분리 시 한 곳만 수정

**사업화 시 본격 해결**: per-tenant 매니페스트 repo, 또는 DB-backed 설정 + ApplicationSet plugin generator.

---

## 2. P1 — 한 방향 결정 회피 (Phase 2 빌드 시 적용)

이 항목들은 Phase 2 빌드 중 **약간의 추가 설계만으로** 사업화 시 갈아엎을 일을 줄인다.

### 2.1 백엔드 권한 비대화

Phase 2 백엔드가 갖게 될 권한:
- swkoo-kr 쓰기 (manifest commit)
- 사용자 repo 쓰기 (Dockerfile/workflow commit)
- k8s API (Secret 생성)

한 군데 뚫리면 모든 고객 GitHub repo + 클러스터 전체 노출.

**Phase 2 적용 사항**:
- ✅ **GitHub App 사용** (PAT 아님) — installation token 자동 rotation, repo-scoped, 비용 동일
- ✅ **k8s namespace-scoped Role** — 백엔드 SA는 secrets 관리 전용, 다른 권한 없음
- ✅ **백엔드 commit author = `swkoo.kr deploy bot <bot@swkoo.kr>`** — 사용자 본인 commit과 분리, audit 추적

### 2.2 Image Updater + ApplicationSet race

현재 `ignoreApplicationDifferences`로 봉합. 사업 시 디버깅 헬.

**전환 경로 (Phase 3쯤)**: git write-back으로 — Image Updater가 매니페스트 직접 commit, 모든 배포 git history. SSH key/PAT 추가 필요.

**Phase 2에서 미리**: `metadata.yaml`에 `updateStrategy` 외 `writeBackMethod` 필드 자리 만들어 두기 — 전환 시 ApplicationSet 템플릿만 갈아끼우면 끝.

### 2.3 Audit log 부재

누가·언제·뭐 배포/삭제했는지 집중 검색 불가 (git log + ArgoCD 이벤트 분산).

**Phase 2에서 적용**: 기존 SQLite 이벤트 스토어에 사용자 액션 추가:
```
actor=<github_login> action=DEPLOY|DELETE|ACCESS_REQUEST repo=<x> at=<ts>
```
한 줄이면 끝. 차후 영업·법무 검토에 그대로 쓰임.

### 2.4 브랜딩 결합

"swkoo.kr"가 곳곳에 hardcoded — VISION.md, README, manifest 라벨, 도메인. 사업체명 결정 시 광범위 치환 필요.

**Phase 2에서**: `BRAND_NAME` / `BRAND_DOMAIN` 환경변수로 빼고 페이지 footer/title 등에서 변수 참조. 단, 인프라 도메인(swkoo.kr 자체)은 그대로 — 갈아끼우는 비용 큼.

---

## 3. 이미 사업화 정렬된 부분 (재작업 불필요)

- **Pure GitOps** — audit·rollback이 git log로 자연스럽고, 매니페스트 외 상태 거의 없음
- **모노레포 경계** (`apps/backend`, `apps/frontend`, `deploy/`) — 분리 시점에 깔끔히 떼어낼 수 있음
- **Observability 풀세트** — Prometheus + Alertmanager + Grafana + 이벤트 스토어. 고객 SLA 리포팅 day 1 가능
- **GHCR 친구 자기 계정** — image storage 비용 swkoo가 책임 안 짐, 좋은 모델
- **Image Updater pull-based** — 친구 빌드가 swkoo 인프라 쓰기 권한 안 가짐
- **Allowlist를 deploy 단계 차단** — 인증/티어 분리, SaaS 표준 패턴

---

## 4. Phase 2 빌드 체크리스트 (이 문서의 약속)

Phase 2 빌드 중 적용할 "사업 전환 준비" 패턴:

- [x] **GitHub App** (OAuth App 아님) — `github-app.service.ts` (JWT RS256 + installation token)
- [x] **사용자 record DB**: OAuth 통과한 모든 사용자 기록 (allowlist 통과 전부터) — `users` 테이블 (Phase 2.7부터 `is_allowed` 컬럼 추가, env는 시드 전용)
- [x] **백엔드 git author** 명시 분리 — `swkoo.kr deploy bot <bot@swkoo.kr>` (`github-app.service.ts:39`)
- [x] **manifest 경로 함수 추상화** (`getUserManifestPath(login)`) — Phase 2.10. `templates.ts` 에 헬퍼 추출, 5 군데 호출부 일괄 교체. 차후 per-tenant repo 분리 시 한 곳만 수정
- [x] **사용자 액션 이벤트 로그** — `audit_log` 테이블 + `users.audit()` (deploy.service / auth.service 7 곳에서 기록)
- [x] **에러 응답 `reason` 코드** — `BETA_ALLOWLIST`, `STACK_UNSUPPORTED`, `NO_USER`, `INVALID_REPO`, `APP_NOT_INSTALLED_*`, `NO_EXISTING_DEPLOYMENT`. Phase 2.7에서 `BETA_ALLOWLIST` → `NOT_ALLOWED` 으로 이름 변경
- [x] **`BRAND_NAME` 환경변수** — `onboarding.config.ts:29`, `/me` 응답에 포함
- [x] **T&C / Privacy Policy** — Phase 2.10 베타 스텁 → Phase 3.2 production-tone 텍스트로 교체 (K-PIPA Art.30 + GDPR Art.13 항목 충족, 베타/무상 표현 제거, 단 SLA % 등 코드에 없는 약속은 미포함)
- [x] **이미지 스캔 — 실제 동작**: Phase 3.3. 매일 03:00 Trivy K8s Job 디스패치 → `scan_results` 테이블에 critical/high/medium count + scanned_at 저장. `/account/export` 응답에 latestScan 노출. (UI 표면화는 후속)
- [x] **`writeBackMethod` 필드 자리** — Phase 2.10. metadata.yaml `image.writeBackMethod: argocd-image-updater` (현재값). 차후 git write-back으로 교체 가능
- [x] **Observatory per-viewer 데이터 격리** — Phase 2.11. 3-tier 가시성(비로그인=operator만 / 로그인=operator+본인 / admin=전체). 유료 전환 시 multi-tenant SaaS의 기본 전제 충족 ([deploy-vision §6 2.11](./docs/deploy-vision.md))
- [x] **per-tenant 매니페스트 repo 분리** — Phase 3.1. `swkoo-deploy` GitHub Org에 사용자별 private repo. 기존 §5 결정 항목 1을 이쪽으로 이관 완료.
- [x] **사용자 데이터 수명주기 (K-PIPA 권리)** — Phase 3.2. `DELETE /account` 익명화 + deploy repo archive + 환경변수 정리. `GET /account/export` 데이터 이동권. `/consent` 게이트 + `policy_version` 추적. 30일 보존 후 자동 hard delete (Phase 3.3 cron).
- [x] **운영 데이터 복구 능력** — Step 2.2 (2026-05-20). `BackupService` 가 매일 04:00 KST SQLite 전체 스냅샷을 OCI Object Storage 로 업로드 (Instance Principal, lifecycle 90일). PVC 복원 dry-run 으로 runbook 검증 — 다운타임 ~1분. 백업 retention 은 `/privacy` §3 에 명시. *유료 사용자 첫 결제 후 데이터 손실은 신뢰 영구 손상* → 결제 도입 전 사전 조건 충족.
- [x] **사용자 URL 자율성 — sub-slug** — Step 1 (2026-05-20). `users.subdomain` 컬럼 + 예약어/포맷 검증 + 가용성 체크 endpoint + Deploy 화면 입력 필드. 친구 인터뷰 *"도메인 바꾸고싶다"* ask 의 첫 단계. 다음 단계(사용자 본인 도메인 연결) 가 첫 paid feature 후보.
- [x] **알람 → 운영자 통로 검증** — Step 2.3 (2026-05-20). Alertmanager → Discord 통로가 22일+ 비어있던 silent failure 발견·해결. 13개 룰 중 `SwkooBackendDown` 표현식 버그 (`up == 0` 만으로는 target-missing 못 잡음) 도 동시 수정. *유료 SLA 약속 전 알람 채널 작동은 필수*.
- [x] **사용자 측 deploy 완료 알림** — C 작업 (2026-05-20). Resend API 통해 OAuth email 로 자동 발송. `users.last_notified_image_sha` 컬럼 dedup → 같은 이미지엔 한 번만, 새 push 마다 한 번. `noreply@swkoo.kr` 발신. 친구 ask 와 직접 연결된 *진짜 사용자 가치* — 진행도 페이지 안 켜놔도 deploy 완료 알 수 있음.
- [x] **major dep 일괄 upgrade** — Frontend Next 14→16 / React 18→19 / ESLint 8→10 / TS 5→6, Backend NestJS 10→11 (2026-05-20). Next 14 의 critical authz bypass + content injection CVE 해결. 친구 베타가 *가장 안전한 major upgrade 윈도우* 라는 판단 — paid 진입 후엔 동일 작업 비용 훨씬 큼.
- [x] **운영 hygiene 묶음** — 2026-05-20 오후 B 묶음. GHA `update-manifests` race 자동 retry, `/api/auth` rate limit (`@nestjs/throttler`), `/deploy` 0-repo 빈 상태 안내, 에러 메시지 친화화, 운영자 자체 이미지 (swkoo-backend·frontend) Trivy 스캔 추가.

---

## 4a. v0 출시 후 폴리시 — 사용자 마찰 줄이기

Phase 2 셀프서비스가 동작하면서 노출된, 사업화 전이라도 손볼 만한 소규모 UX 항목:

- ~~**ApplicationSet 강제 refresh on register/delete**~~ — ✅ Phase 2.9. 백엔드 `swkoo-backend` SA + `deploy/argocd/swkoo-backend-applicationset-rbac.yaml` Role로 register/delete 끝에 `argocd.argoproj.io/refresh=hard` patch 호출.
- ~~**Re-deploy 시 user repo no-op 감지**~~ — ✅ Phase 2.10. `commitFilesAtomic`이 새 tree-sha가 base와 동일하면 commit/ref-patch 건너뜀 (GitHub blob dedupe 활용). git history 노이즈 + GHA 빌드 사이클 절약.
- ~~**Build 실패 시 명시적 알림**~~ — ✅ Phase 2.9 (운영자 한정). 진행도 페이지 폴링이 빌드 'failed' 감지 시 `DISCORD_BUILD_FAILURE_WEBHOOK_URL`로 한 번만 알림. 사용자 직접 알림 채널은 별도 작업.

---

## 5. 사업 전환 시 큰 결정 (지금 결정 안 해도 됨)

| 결정 | 영향 | 미루는 비용 |
|---|---|---|
| ~~매니페스트 repo per-tenant 분리~~ | ~~코드 변경 다수, 마이그레이션~~ | ✅ Phase 3.1에서 결정·실행 완료 (§4 참조) |
| 다중 노드 / 관리형 k8s | 인프라 비용 발생 | 결정 늦춰도 코드 변경 거의 없음 |
| 결제 (Stripe 등) | 모듈 통째 추가 | 0 — 완전 별개 |
| 다중 region | 클러스터 패턴 큰 변경 | 매우 큼, 일찍 결정해야 함 |
| 회사 entity 설립 | 법률·세무·계좌 | 결정 시점에 30일 |
| K-PIPA / GDPR 컴플라이언스 (절차) | DPO 지정, 침해 통지 절차, 국외 이전 동의 | 핵심 데이터 권리(열람·삭제·동의)는 Phase 3.2에서 완료. 외국인 고객·결제 도입 시 절차적 부분 시급 |

---

## 변경 이력

| 날짜 | 작업 |
|------|------|
| 2026-05-08 | 초안 작성 — Phase 2 빌드 직전, 사업전환 고려사항 외부 분리 |
| 2026-05-12 | Phase 2.10 위생 패스 — §4 체크리스트 4개 항목 ✅ (manifest 경로 헬퍼, T&C/Privacy 스텁, scanResult/writeBackMethod 필드). §4a no-op commit ✅. |
| 2026-05-14 | Phase 1 종료(친구 2명 + 본인 부계정 실배포 검증). Phase 2.11 — Observatory per-viewer 데이터 격리 §4 추가. |
| 2026-05-14 (later) | Phase 3 일괄 반영. §4: per-tenant repo 분리(3.1) · K-PIPA 데이터 권리(3.2) · 실제 Trivy 스캔(3.3) · T&C/Privacy production-tone 항목 추가. §5: per-tenant repo 행 ✅ 해소, K-PIPA 행은 절차적 부분만 잔존으로 분리. |
| 2026-05-18 | 스캔 UI 노출(`/account/scan` + `<ScanPanel />`) + critical/high 신규 발견 시 운영자 Discord 알림(`DISCORD_SCAN_WEBHOOK_URL`). Phase 3.3 행동 트리거 마무리. repo `swkoo-portfolio` → `swkoo-kr` rename. |
| 2026-05-20 | Step 1·2 묶음 — paid 진입 전 사전 조건 정리. §4 체크리스트에 *복구 능력 (백업)*, *URL 자율성 (sub-slug)*, *알람 통로 검증* 3건 ✅ 추가. /privacy §3에 백업 retention(최대 90일) 명시 — K-PIPA Art.30 보강. Step 2.3 audit 으로 silent failure 3건 발견·해결 (SwkooBackendDown · null receiver · InfoInhibitor 누수). |
| 2026-05-20 (오후) | Pre-Step-3 보강 + 사용자 가치 작업. §4 체크리스트 추가 4건: *deploy 완료 이메일* (C, 친구 ask 직접 답), *major dep 일괄 upgrade* (Next 16 / React 19 / NestJS 11), *운영 hygiene 묶음* (B: GHA race / throttler / 0-repo / 친화화 / op-scan). /privacy rev 2: Resend 처리위탁자 추가. OCI auth token 회수 (docs/registry.md 평문 leak 정리) + 클러스터 imagePullSecret 갱신. stale 설계문서 6개 삭제. |
