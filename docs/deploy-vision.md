# DEPLOY VISION

> 이 문서는 swkoo.kr **`/deploy`** 진입점(친구 한정 셀프호스트 PaaS 데모)의 정체성·non-goal·성공 기준을 담는다.
> Observatory(`/observatory`)의 [VISION.md](../VISION.md)와 별개이며, Observatory의 non-goals와 충돌하지 않는 범위에서 운영한다.

---

## 1. 한 문장 목적

**swkoo.kr 인프라(OCI A1 / k3s) 위에서 친구가 GitHub repo만 등록하면, 자동으로 빌드·배포돼 외부에서 접근 가능한 URL을 받는다.**

운영 책임은 swkoo 본인이 진다. "셀프호스트 GitOps 운영 사례"의 살아있는 증명으로서 Observatory와 같은 인프라를 공유하지만, 정체성은 다르다.

---

## 2. 청중과 사용 시나리오

- **청중**: swkoo 본인 + 친구 1~2명 (베타). 일반 공개 ❌.
- **이상 사용자**: 바이브코딩으로 작은 앱(Node/Python/Go static)을 만든 초보 개발자.
- **시나리오**:
  1. 친구가 GitHub에 작은 repo를 가지고 있다.
  2. swkoo가 그 repo를 manifests repo에 등록 (Phase 1은 admin 수동, Phase 2부터 OAuth 셀프 등록).
  3. 친구가 `git push` → CI(GitHub Actions, repo의 자체 워크플로) → 이미지 OCIR push → ArgoCD sync → Pod 노출.
  4. 친구는 `<appname>.apps.swkoo.kr` URL로 외부 접근.
  5. 운영자(swkoo)는 Observatory에서 친구의 파이프라인까지 함께 모니터링.

---

## 3. Non-goals — 의도적으로 안 만드는 것

- ❌ **일반 공개 / 셀프 가입** — 친구 1~2명 베타로 시작, 신뢰 기반 등록.
- ❌ **SLA 보장** — 단일 노드, 노드 장애 시 전부 다운.
- ❌ **Stateful 서비스 호스팅** — Phase 1에선 DB 등 stateful 컨테이너 ❌. Phase 2 이후 PV 정책과 함께 검토.
- ❌ **빌드 인프라 자체 운영** — 사용자 GitHub Actions에 위탁. 클러스터 안 자체 빌드(Tekton 등) 안 함.
- ❌ **결제 시스템** — quota는 정적 한도로 통제. 사용자 ↔ 운영자 사이 금전 거래 없음.
- ❌ **상용 PaaS 흉내** — Coolify/Heroku 대체가 아니라 사례 데모.
- ❌ **Observatory의 정체성 침범** — Observatory는 관측·판단 콘솔로 그대로. `/deploy`는 별도 페이지.

---

## 4. 성공 기준 — Phase 1 완료의 정의

1. 친구 1명의 GitHub repo가 등록되어 `git push` 만으로 자동 빌드 → 배포 → URL 노출 흐름 정상 동작. ✅ — 2026-05-14, 친구 2명 + 본인 부계정으로 Next.js 싱글페이지 배포 검증.
2. 사용자 namespace 격리 (NetworkPolicy egress 제한 + RBAC). ✅
3. 자원 한도 적용: 사용자당 CPU 0.5 / RAM 512MB / Pods 3 / PV 1GB. ✅
4. 본인 인프라(Observatory + 자체 앱) 영향 없음 — 격리 검증. ✅
5. 운영 비용 0원 유지 (Always Free 한도 안에서). ✅

**Phase 1 종료** (2026-05-14). 이후 작업은 friend-only 안정화 운영 또는 사업화 검토 ([`/BIZ_READINESS.md`](../BIZ_READINESS.md) §5)로 분기.

---

## 5. 아키텍처 (Phase 1, 가장 단순한 형태)

```
[친구의 GitHub repo]
   │  Dockerfile + .github/workflows/build.yml (운영자 제공 템플릿)
   ▼
[GitHub Actions (친구 분량)]
   │  build → push to OCIR (운영자 보조 secret 제공 또는 별도 OCIR 네임스페이스)
   ▼
[OCIR: <namespace>/users/<friend>/<app>:<sha>]
   ▼
[manifests repo: swkoo-kr (또는 별도)]
   │  CI bot이 image tag 갱신 (또는 Argo Image Updater)
   ▼
[ArgoCD Application: user-<friend>-<app>]
   │  destination: namespace user-<friend>
   ▼
[k3s namespace: user-<friend>]
   │  ResourceQuota / LimitRange / NetworkPolicy
   │  Deployment + Service + Ingress
   ▼
[Ingress: <appname>.apps.swkoo.kr  (wildcard TLS)]
```

핵심 결정 (Phase 1 단계에서 단순함 우선):
- **wildcard TLS**: cert-manager DNS-01 challenge with `*.apps.swkoo.kr` (별도 와일드카드 인증서)
- **namespace 네이밍**: `user-<github-login>` (1 사용자 = 1 namespace, 그 안에 여러 앱)
- **registry 분리**: swkoo 본인 image는 OCIR(`nrt.ocir.io/...`) 그대로, **친구 image는 친구의 GHCR(`ghcr.io/<friend>/<app>`)**. 친구는 GitHub 안에서 끝나고, swkoo OCI 한도(20GB Object Storage)는 친구가 늘어도 영향 없음.
- **이미지 빌드**: 친구 repo의 GitHub Actions가 자기 GHCR로 push (built-in `GITHUB_TOKEN`, 친구가 추가 secret 등록 불필요)
- **ArgoCD App per user-app**: ApplicationSet으로 자동 생성 (`deploy/users/*` 자동 발견)
- **manifests repo 위치**: 일단 `swkoo-kr/deploy/users/<friend>/<app>/` 하위에 두고, Phase 2 이후 별도 repo로 분리 검토

---

## 6. Phase 1 작업 분해

| # | 항목 | 상태 | 검증 |
|---|------|------|------|
| 1.1 | wildcard 도메인 `*.apps.swkoo.kr` + cert-manager DNS-01 | ✅ | `apps-wildcard-tls` Ready (90일 cert) |
| 1.2 | manifests repo 디렉토리 패턴 (`deploy/users/sample/`) | ✅ | kustomize render 정상 (7 리소스) |
| 1.3 | Per-user ResourceQuota / LimitRange / NetworkPolicy 템플릿 | ✅ | sample 디렉토리에 포함 |
| 1.4 | ArgoCD ApplicationSet (deploy/users/* 자동) + sample sync | ✅ | `https://sample-hello.apps.swkoo.kr` HTTP 200 |
| 1.5 | 사용자 GitHub Actions 빌드 템플릿 + onboarding 가이드 | ✅ | `docs/templates/friend-build-workflow.yml`, `docs/onboarding-friend.md` |
| 1.5b | 친구 push 후 자동 sync trigger | ✅ | argocd-image-updater (digest 전략 + argocd write-back) — 수동 rollout 불필요 |
| 1.6 | 친구 1명 실제 등록 + 검증 | ✅ | 2026-05-14, 외부 친구 2명 + 본인 부계정으로 Next.js 싱글페이지 배포 성공 (`<login>-<repo>.apps.swkoo.kr` 라이브) |
| 2.1 | GitHub App OAuth 셀프 등록 (Sign in with GitHub) | ✅ | `/deploy` 진입 → GitHub OAuth → JWT 쿠키 세션 |
| 2.2 | repo 목록 + 스택 자동 감지 | ✅ | `package.json` → Next.js 식별, 포트·이미지 경로·서브도메인 자동 결정 |
| 2.3 | 사용자 repo 자동 commit (Dockerfile + GHA workflow) | ✅ | `github-app.service.ts` atomic blobs/trees/commits/refs |
| 2.4 | 매니페스트 자동 commit (`deploy/users/<login>/`) | ✅ | namespace + quota + limit-range + netpol + kustomization + metadata + deployment/service/ingress |
| 2.5 | 진행도 페이지 (5-stage checklist) | ✅ | `/deploy/[login]/[repo]` |
| 2.6 | unregister 플로우 (배너 + 상세 페이지 카드) | ✅ | `DELETE /deploy` → 매니페스트 제거, ArgoCD prune, banner는 metadata.yaml/Application 상태 둘 다 추적 |
| 2.7 | 관리자 페이지 v0 (allowlist DB 이관 + `/admin` UI) | ✅ | `ADMIN_LOGINS` env로 게이팅, `users.is_allowed` 토글, audit_log 기록 |
| 2.8 | 사용자 env 패널 (`/deploy/<login>/<repo>` 환경변수 섹션) | ✅ | 백엔드 `swkoo-backend` SA + per-namespace RBAC, k8s Secret upsert + Deployment annotation patch로 자동 재시작 |
| 2.9 | 사용자 마찰 묶음 (ApplicationSet refresh + 빌드 실패 운영자 알림 + Starter 템플릿) | ✅ | argocd ns Role로 refresh=hard 호출 → ~3분 폴링 갭 제거. 빌드 'failed' 감지 시 `DISCORD_BUILD_FAILURE_WEBHOOK_URL`로 1회 알림. getting-started에 `sungwookoo/nextjs-sample` "Use this template" 버튼 |
| 2.10 | 위생 패스 (운영자 품질 + 사업 전환 자리) | ✅ | `/admin` 승인대기 카운트 뱃지, no-op commit 감지(tree-sha 동일 시 skip), `getUserManifestPath` 헬퍼 추출, metadata.yaml에 `scanResult`/`writeBackMethod` 필드 자리, `/terms` `/privacy` 베타 스텁 |
| 2.11 | Observatory per-viewer 가시성 (3-tier) + 헤더 user menu | ✅ | `OptionalJwtAuthGuard` + `viewer-scope` 헬퍼로 비로그인=operator만, 로그인=operator+본인, admin=전체+토글. 헤더 우상단 외부링크 제거 → user menu (avatar dropdown, 로그아웃 포함) |
| 3.1 | per-tenant 매니페스트 repo 분리 | ✅ | `swkoo-deploy` GitHub Org에 사용자별 private repo 생성. 백엔드: `ensureRepoInOrg`/`archiveRepo` 메서드, register/unregister 흐름이 deploy repo + 작은 registration 파일(`deploy/users/<login>.yaml`)로 분리. ApplicationSet generator: `files: deploy/users/*.yaml`, source repoURL은 `{{ .deployRepo }}` 템플릿. 운영 마이그레이션 완료(2026-05-14): ArgoCD repo-creds Secret(GitHub App), 3명 사용자(hizieun/sungwookoo/sw-koo) JWT impersonation으로 register 재호출, 옛 dir 정리. 모두 Synced/Healthy, HTTP 200 |
| 3.2 | K-PIPA/GDPR 권리 보장 (BIZ §5의 컴플라이언스 항목) | ✅ | `/privacy` `/terms` 베타 스텁 → 출시 톤 production 텍스트로 교체. `DELETE /account` 로 계정 anonymize + deploy repo archive + 환경변수 정리. `GET /account/export` 로 사용자 데이터(profile, deployment, envVars, latestScan, audit) JSON 다운로드. `POST /auth/consent` + `requiresConsent` 플래그 + `/consent` 페이지로 정책 동의 게이트. 백엔드 OAuth URL을 install URL에서 순수 authorize URL로 전환 (재로그인 시 install settings 페이지로 튀던 UX 버그 수정) |
| 3.3 | 운영 자동화 (cleanup cron + image scan + host disk GC) | ✅ | `@nestjs/schedule` 도입. `CleanupService` 매일 03:00 KST: (a) 30일 지난 soft-deleted users + audit 항목 hard delete (b) 30일 지난 archived swkoo-deploy repos 완전 삭제 (c) 활성 사용자 Trivy 이미지 스캔 → `scan_results` 테이블에 severity counts 저장. 스캔은 K8s Job 디스패치 (격리, ephemeral, `trivy-db-cache` PVC 공유), `--platform=linux/arm64` 필수 (OCI A1 arm64). 호스트 측: 주 1회 `crictl-prune.timer` systemd timer로 containerd 이미지 캐시 정리 (k3s 디폴트 GC 임계 85%가 너무 늦음) |
| 4 (Step 1) | 사용자 지정 sub-slug | ✅ | `users.subdomain` partial UNIQUE 컬럼, `validateSubdomainFormat`(예약어 + DNS 라벨 룰), `/api/deploy/subdomain/check` 가용성 endpoint, Deploy 화면 입력 필드. 비우면 `<login>-<repo>` fallback. 친구 1차 인터뷰 "도메인 변경" ask 의 1차 답. |
| 5 (Step 2.1) | 단위 테스트 토대 | 🟡 진행 중 | Jest config + ts-jest preset, `subdomain.spec.ts`(15) + `users.repository.subdomain.spec.ts`(20) — 35 cases. 가장 회귀 위험 큰 영역(슬러그 UNIQUE) 락. 나머지 코드는 *만질 때마다* 동행 룰. |
| 5 (Step 2.2) | SQLite 일일 백업 | ✅ | `BackupService` 매일 04:00 KST(cleanup 이후, K-PIPA 약속 반영), Instance Principal 인증으로 OCI Object Storage(`swkoo-kr-backups`) 업로드. streaming upload + V8 heap 768MB + 컨테이너 limit 1Gi (OCI SDK overhead). `POST /api/admin/backup/trigger` 수동 트리거. PVC 복원 dry-run 으로 runbook 검증 (다운타임 ~1분). |
| 5 (Step 2.3) | Alertmanager → Discord 라우팅 | ✅ | 22일+ 동안 비어있던 통로 구축. Inline Python 변환기(arm64 호환, 40줄 stdlib), `AlertmanagerConfig` CR + Alertmanager CR 수동 패치(selector 활성). `SwkooBackendDown` 표현식 수정(`up == 0 or absent(up)`). `InfoInhibitor` 누수 차단(drop receiver). Watchdog heartbeat 로 파이프라인 자체 헬스체크. |

---

## 7. 알려진 한계

- 단일 노드 — 노드 죽으면 친구 앱도 다운. (다중 노드 / 관리형 k8s는 BIZ_READINESS §5)
- Always Free 천장 (4 OCPU / 24GB / Egress 10TB·월) → 실측 수용 ceiling ~20명 (CPU 병목).
- 운영 부담 24/7 1인 → 친구 수 제한적.
- 보안 격리는 NetworkPolicy + 자원 한도 + Trivy 이미지 스캔(Phase 3.3, severity counts만, admission webhook 차단은 없음).
- 사용자가 push한 이미지 안의 코드는 검증 안 함 — 신뢰 기반. 스캔은 보고형이지 차단형 아님.

---

## 8. Observatory와의 관계

`/deploy`로 등록된 사용자 앱들도 **swkoo k3s 클러스터의 Application**이므로 Observatory의 cross-tool 타임라인에 자동으로 노출된다.

- swkoo-kr Application + swkoo-observability Application + 친구 앱 ApplicationSet → Observatory 한 화면에서 함께 본다.
- 운영자(swkoo) 시점에서 "내가 운영하는 모든 것"이 한 화면.
- 친구 시점에서 `/deploy` 페이지는 자기 앱만 본다. `/observatory`는 Phase 2.11의 per-viewer 가시성으로 비로그인=operator only / 로그인=operator+본인 / admin=전체+토글.

---

## 9. 다음 결정 포인트

Phase 1·2·3.1·3.2·3.3 + Step 1·2 (sub-slug, 테스트 토대, 백업, 알람 라우팅) 모두 ✅. 남은 큰 줄기 (BIZ_READINESS §5 참조):

- 회사 entity 설립 (코드와 병렬 가능)
- 다중 노드 / 관리형 k8s 이전 — CPU 한계(현 ~20명) 해소
- 결제 모듈 (Stripe) — entity 후속
- 다중 region — 단일 노드 전제 깸, 대규모 작업

코드 측 잔여 후보:
- 사용자별 plan tier (admin UI에서 quota 토글) — CPU 수용 인원 확장 + 유료 전환 자리
- 스테이트풀 서비스 호스팅 (DB 등) — 현재 Phase 1 non-goal에서 풀기
- 단위 테스트 확장 — Step 2.1에서 슬러그 영역만 35 케이스 시작. ScanService 알림 dedup, DeployService stage parser, ArgoCD 상태 매핑 등 미커버
- 사용자 본인 도메인 연결 (custom domain) — 친구 1차 인터뷰 "도메인 변경" ask 의 2차 답. 첫 paid feature 후보로 자연스러움

---

## 10. 사업 전환을 고려하는 경우

이 vision은 **friend-only 베타** 가정 위에 작성되었다. 유료 모델로의 전환을 검토할 때는 [`/BIZ_READINESS.md`](../BIZ_READINESS.md)를 참조한다 — 본 문서 §3의 non-goal 중 일부(특히 SLA 보장, 다중 노드, 결제)가 그 시점에 진실이 되어야 한다. **매니페스트 repo 단일성과 데이터 격리는 이미 Phase 3.1·3.2에서 정리됨** — repo는 사용자별 분리, 사용자 데이터 수명주기 자동화 완료. 남은 BIZ 결정의 비용·순서·의존성은 BIZ_READINESS에서 추적한다.

---

## 변경 이력

| 날짜 | 작업 |
|------|------|
| 2026-05-06 | v0 초안 작성 |
| 2026-05-08 | §10 추가 — BIZ_READINESS.md cross-link |
| 2026-05-12 | Phase 2.10 (위생 패스) 추가 — §6 |
| 2026-05-14 | Phase 1 종료 — §4 성공기준 외부 사용자 3명으로 검증. Phase 2.11 (Observatory per-viewer + user menu) 추가. Phase 3.1 (per-tenant repo split) 코드 머지 + 운영 마이그레이션 완료. Phase 3.2 (K-PIPA/GDPR 권리 + production-tone policy text + consent gate + OAuth URL fix). Phase 3.3 (cleanup cron + Trivy 일일 스캔 + crictl-prune 호스트 timer). §7 한계·§8 Observatory·§9 다음 포인트·§10 BIZ 링크 갱신. |
| 2026-05-18 | Phase 3.3 follow-up — Trivy 결과 진행도 페이지 노출(`/account/scan` + `<ScanPanel />`) + critical/high 신규 발견 시 운영자 Discord 알림(`DISCORD_SCAN_WEBHOOK_URL`). repo `swkoo-portfolio` → `swkoo-kr` rename. §9 잔여 후보에서 "스캔 결과 표면화" 제거. |
| 2026-05-20 | Step 1·2 묶음 — §6 Phase 표에 Step 1 (sub-slug), Step 2.1 (테스트), Step 2.2 (백업), Step 2.3 (Alertmanager→Discord) 추가. §9 잔여 후보 갱신 (테스트 항목 축소, custom domain 신규 추가). Step 2.3 audit 으로 깨진 silent failure 3건(SwkooBackendDown 표현식, Alertmanager null receiver, InfoInhibitor 누수) 발견·수정. Step 2.2 백업 E2E 복원 dry-run 으로 runbook 검증. |
