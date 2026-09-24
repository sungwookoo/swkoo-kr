# 현재 구현 및 검증 기준선

기준일: 2026-09-15. 코드 기준선과 아래 운영 검증 기록을 구분한다. Observatory의 정체성은 [VISION](../VISION.md), Deploy의 정체성은 [deploy-vision](./deploy-vision.md)을 따른다.

## 배포 등록의 사용자 소스 보호 (2026-09-24)

- [정책과 검증 범위](./source-setup-design.md): 파일별 현재/제안 내용과 대상 브랜치를 먼저 안내하고 사용자 동의를 서버에서도 검사한다.
- 없는 Dockerfile/build.yml만 직접 생성하며, 템플릿과 동일한 파일은 유지한다. 다른 기존 파일은 사용자 요청으로 초안 PR에 제안한다. PR 생성 자체는 신규 배포를 등록하지 않는다.
- 소스/템플릿 변경 후 오래된 동의, 기존 파일 직접 덮어쓰기, 검토 후 브랜치 전진을 차단한다. 부분 실패의 완료 단계·소스 링크와 재확인 방법을 안내한다.
- 기존 파일과 템플릿의 차이를 호환성 실패로 단정하지 않는다. 커스텀 설정 자동 호환성 검증과 자동 병합은 제공하지 않는다.
- 검증: 소스 검토·커밋 경합·별도 PR·부분 실패 경계 17개, 프런트엔드 95개, Playwright 17개 및 양쪽 빌드 통과. 사용자 앱 저장소의 쓰기/PR 생성은 모의 API로 검사했다.

## 선택형 보안 수정 PR (2026-09-16)

### 범위 명확화와 취약점 근거 보강 (2026-09-24)

- 화면·가이드·초안 PR 명칭을 ‘npm 의존성 취약점 수정 PR’로 구체화했다. AI 분석·정기 npm 재검사·알림으로 확대하지 않는다.
- 개별 취약점의 식별자·심각도·영향 범위·검사된 버전·근거 링크와 검사 시각을 보관하고, 해결/잔존 항목을 화면과 PR에 표시한다.
- 취약 패키지 총수와 개별 공지 수를 구분한다. 개별 해결 근거 없는 총수 감소, 새 취약점, 심각도 상승, 근거 없는 이전 수정안의 PR 생성을 차단한다.
- 사용자 요청·초안 PR·사용자 병합 원칙을 유지한다. 운영 앱에 적용된 결과로 표시하지 않으며 앱 테스트·빌드·DB 연결 미검증을 안내한다.
- 검증: 백엔드 전체 281개 통과 후 PR 본문 크기 차단 검사를 추가해 관련 34개를 재검증했다. 프런트엔드 95개·Playwright 15개·양쪽 빌드 통과. 실제 격리 Job에서 lodash 4.17.19→4.18.1, 취약 패키지 1→0, 개별 공지 5개 해소와 근거 링크 수집을 확인했다. 테스트 Job은 삭제했다.

### 최초 도입 기록 (2026-09-16)

- [설계·권한·사용자 동의 기준](./security-patch-design.md): 수정안 준비와 초안 PR 생성을 각각 사용자가 요청한다. 자동 병합하지 않는다.
- 공개 npm 단일 프로젝트의 기존 버전 범위 안에서 lockfile만 제안한다. 메이저·0.x minor 변경, 앱 코드·DB·Dockerfile·workflow 변경은 제외한다. 앱 테스트·빌드는 미검증으로 표시한다.
- 로컬 백엔드 270개, 프런트엔드 93개, Playwright 15개 테스트 및 양쪽 빌드를 확인했다. 실제 제한된 Kubernetes 작업에서 lodash fixture의 npm 취약점 1→0 및 설치 스크립트 미실행을 확인하고 Job을 정리했다.
- 사용자 저장소는 시험 대상으로 수정하지 않았다. 실제 GitHub PR 쓰기는 모의 API로 검증했다.

## 후속 운영 점검 (2026-09-16)

[상세 결과 및 미완료 범위](./operations-followup-2026-09-16.md)를 참조한다. PocketPlan PostgreSQL 연결 설정 미확인과 운영 부하 테스트 정책 차단으로 인해 모든 항목의 완료를 주장하지 않는다.

## 의존성 취약점 정리 (2026-09-16)

- 백엔드·프런트엔드 전체 의존성 `npm audit` 0건 및 GitHub Dependabot 열린 경고 0건 확인. 운영 이미지 OS 취약점 또는 사용자 앱 저장소까지 해결했다는 의미는 아니다.
- Next.js 16.3.5, sharp 0.35.4, Mermaid 11.17.2, DOMPurify 3.4.15, Axios 1.20.0, js-yaml 4.3.2 등 수정 버전으로 갱신했다.
- NestJS 11 계열을 유지하며 Multer 2.3.0 override를 적용했다. 상위 플랫폼 패키지가 수정 버전을 채택하면 override 제거를 검토한다. [Multer 보안 공지](https://github.com/advisories/GHSA-wc9g-mqfw-jrwm).
- Next.js 갱신 후 TypeScript 6에서 더 이상 허용되지 않는 ES5 target과 baseUrl을 ES2017 및 상대 paths로 수정했다.
- 백엔드 244개·프런트엔드 90개·Playwright 14개 테스트, 양쪽 프로덕션 빌드 통과. 프런트엔드 npm ci 설치 재현 확인.

- [CI 35051607683](https://github.com/sungwookoo/swkoo-kr/actions/runs/35051607683) 성공. 양쪽 운영 이미지 `a36953036b75257dbfd9f8f98595d9e5845bfb5c` rollout 완료, Argo Synced/Healthy. 홈·About·Deploy·가이드·관리 페이지·health API HTTP 200 확인.

## 배포 관리 로그인 복구 (2026-09-16)

- 비로그인·세션 만료 시 숫자 401 대신 로그인 안내와 GitHub 로그인 버튼을 표시한다. 인증 실패 후 이전 상태의 환경변수·관리 패널을 숨긴다.
- OAuth 시작 시 원래 관리 경로를 state에 연결된 임시 쿠키로 보관하고 성공 후 복귀한다. 외부 URL·상위 경로·다른 state는 허용하지 않는다.
- 다른 계정의 403은 관리 권한 안내로 구분한다. API의 인증·소유권 검사는 유지한다.
- OAuth 회귀 테스트 13개 및 배포 화면 Playwright 4개 통과. 사용자 브라우저의 세션이 사라진 원인 자체는 첨부 화면만으로 확정할 수 없다.

## 기존 개선 계획 후속 구현 (2026-09-15)

- 배포 상태 책임을 `DeployStatusService`로 분리하고, 공통 Argo 이미지 판정을 `deployment-readiness.ts`로 추출했다.
- 저장소 기본 브랜치의 현재 SHA에 대한 `build.yml` 실행만 조회한다. 해당 SHA 태그의 GHCR digest와 원하는 이미지가 같아야 다음 단계로 진행한다.
- Argo 비교 source·summary 일치, 성공한 동기화, Deployment observedGeneration·updated/available replicas 및 해당 이미지 Pod Ready를 확인한다. 오래된 정상 앱으로 새 배포를 완료 처리하지 않는다.
- ImagePullBackOff/CrashLoopBackOff 등은 컨테이너 실패로, 정상 rollout 뒤 HTTP 오류는 앱 응답 실패로 표시한다. 알림도 동일한 최신 빌드·이미지·컨테이너 판정을 사용하며, 조회 중 이미지가 바뀌면 발송하지 않는다.
- 화면의 라이브 표시는 모든 단계가 성공해야 표시한다. 제거 확인 화면에 PVC·DB 삭제 범위와 사전 백업 필요성을 명시했다.
- PR 단위 테스트·프로덕션 빌드 workflow 추가, 기존 Playwright smoke를 PR에서도 실행한다. 이 workflow 추가는 GitHub branch protection 설정 변경을 의미하지 않는다.
- 최종 CI: 백엔드 238개(17 suites), 프런트엔드 90개, Playwright 12개 통과. 실제 Nest HTTP 경계에서 무인증·다른 사용자 상태/환경변수 읽기/쓰기 거부를 검증했다.
- 운영 분리 검증: 실제 Prisma migration + 동일 PVC로 Pod 교체 후 데이터 유지, 다른 namespace/PVC로 백업 복구, 양성 대조 후 cross-namespace TCP 차단, DNS 허용·서비스계정 token 없음 확인. namespace 삭제 시 해당 PV 및 디렉터리 회수 확인. 테스트 자원 정리 완료.
- OCI Object Storage `daily/2026-09-14/observatory.sqlite` (36,544,512 bytes)를 임시 경로로 다운로드·복원해 integrity/foreign_key 검사 통과, users 4 / audit_log 332 / custom_domains 1 확인. 임시 복원 파일 삭제, 운영 DB 미변경.

- 임시 Prometheus 경고를 실제 알림 경로로 발송하여 Discord relay의 `posted alert=SwkooValidationDrill status=204` 확인. 테스트 규칙 삭제 완료. 이는 제공자의 요청 수락 확인이며 사람이 메시지를 읽었다는 의미는 아니다.
- [최종 백엔드 CI](https://github.com/sungwookoo/swkoo-kr/actions/runs/34960855162), [PR 검증 수동 실행](https://github.com/sungwookoo/swkoo-kr/actions/runs/34960595475), [Playwright CI](https://github.com/sungwookoo/swkoo-kr/actions/runs/34960599631) 성공.
- 운영 이미지: 백엔드 `19df55d92d66aa47483edff54b75cd7415bf68d4`, 프런트엔드 `590aadd87ce8e48d489bb7ddc7a3096ca1f53581`. 두 Pod Ready/restart 0, 모든 Argo Application Synced/Healthy.
- 로그인한 SprintFlow 배포 화면에서 최신 빌드 `6279406`, 이미지 `sha256:77c71e44b890…`, 컨테이너 준비 및 라이브 응답의 전체 성공 확인. `/api/health`와 사용자 앱 4개 HTTPS 200 확인.

## SprintFlow 빈 DB 오류 복구 (2026-09-15)

- SprintFlow 커밋 `62794065767d9d04115db28803db3af49fcd8f74`: 첫 접속 시 프로젝트가 없으면 프로젝트와 상태 4개를 원자적으로 생성. 기존 데이터는 유지하고 동시 요청의 중복 생성은 고유 키로 방지한다.
- 초기화 전 SQLite 백업 `app.db.before-workspace-fix-20260915`을 기존 PV에 보관했고 무결성 검사 통과. `db:reset`/`db:seed`는 실행하지 않았다.
- 실제 SQLite 회귀 테스트 2개(동시 초기화·사용자 수정/작업 보존·기존 다른 프로젝트 보존), 타입 검사, 프로덕션 빌드 통과.
- [이미지 빌드](https://github.com/sungwookoo/SprintFlow/actions/runs/34958756419) 성공. 운영 digest `sha256:77c71e44b89075dae79232951f65e9b56854fbe85976b3f9996437f24415e582`로 전환 완료.
- HTTPS 200 반복 확인, 브라우저 보드·일정 화면 정상. Project 1 / Status 4 / Issue 0 / Member 0 / Sprint 0, DB integrity ok. Pod Ready, restart 0, Argo Synced/Healthy. 아래 과거 검증 기록의 HTTP 500은 이 변경으로 해결됨.

## 사용자 앱 자원 기본값 변경 (2026-09-15)

- 앱 및 Prisma 초기화 컨테이너: CPU requests 100m / limits 500m, 메모리 requests 256Mi / limits 512Mi.
- 신규 사용자 LimitRange와 생성 Deployment에 동일한 값을 적용한다. 네임스페이스 총 quota는 재배포 여유를 위해 유지한다(requests 500m/512Mi, limits 1 CPU/1Gi).
- 기존 4개 GitOps 저장소의 활성 앱과 LimitRange를 수정했다: hatbann `6951f25`, hizieun `af56a78`, sungwookoo `c6ccc2a`, sw-koo `d30a111`.
- 4개 앱 모두 새 자원으로 Running/Ready, 재시작 0회 확인. SprintFlow 초기화 컨테이너도 같은 자원이며, 기존 PVC Bound 및 미적용 migration 없음 확인.
- hello / planner-h / zieun-ai-portfolio HTTPS 200. SprintFlow는 기존의 프로젝트 데이터 없음 오류로 HTTP 500을 유지한다. DB 초기화는 실행하지 않았다.
- `/deploy`, 시작 가이드, 이용약관에 공유 CPU 최대 0.5코어·메모리 최대 512MiB 및 예약량을 안내한다. 영구 저장공간 1GiB는 지원되는 Prisma SQLite 앱에 제공된다.
- 총 6명은 운영 시작 시 검증할 계획 규모이며 부하 테스트로 보장된 수용량이나 가입 제한이 아니다.
- 로컬 템플릿 테스트 22개, 프런트엔드 테스트 90개, 백엔드 빌드 및 기존 앱 설정의 서버 dry-run 통과.
- CI [34957796342](https://github.com/sungwookoo/swkoo-kr/actions/runs/34957796342) 성공: 백엔드 217개·프런트엔드 90개 테스트, 프로덕션 빌드 통과.
- 백엔드·프런트엔드 이미지 `758317bc896abf2a0a7f23a2ac2b47fc7968ffe7` 운영 rollout 완료. 모든 Argo 앱 Synced/Healthy. `/api/health` 200, 공개 배포 화면 및 약관·시작 가이드의 새 사양 확인.

## 구현된 기능

| 영역 | 코드에서 확인한 범위 |
|---|---|
| Observatory | 배포 타임라인, 이미지 출처·신뢰도 추적, 활성 알람, Webhook 이벤트 이력, 사용자별 조회 범위 |
| Deploy | GitHub App 로그인, 허용 사용자 등록, Next.js 분석 및 빌드 파일 생성, 상태·환경변수 관리 |
| 사용자 매니페스트 | 사용자별 private 배포 저장소 + 공통 등록 파일 + ApplicationSet |
| 도메인 | 서브도메인 선택, 커스텀 도메인 검증·등록·삭제 및 인증서 상태 조회 |
| 저장소 | Prisma SQLite 프로필 자동 감지, 1Gi PVC·`/data` 마운트·초기화 템플릿, 재등록 시 기존 프로필 보존 |
| 운영 | 감사 로그, Trivy 보고형 스캔, SQLite 백업, 계정 삭제·내보내기 |
| 격리 | NetworkPolicy·자원 제한·PSA restricted 생성 템플릿 |

## 이번 변경: 배포 완료 이메일

- 화면 상태 조회에서 발송 부수 효과를 제거하고 1분 주기 작업으로 분리했다.
- 현재 등록된 활성 앱의 `Synced / Healthy`, 성공한 동기화 작업, 현재 이미지와 비교된 source·이미지 summary의 digest 일치, 앱 URL의 2xx/3xx 응답을 확인한다. 2026-09-15 후속 구현으로 최신 소스 빌드 및 실제 Pod 준비 상태 검증도 추가했다(위 기록 참조).
- SQLite `deploy_notifications`에 수신자·메일 내용 데이터·중복 방지 키·시도를 저장한다. 실패 시 5분 간격으로 재시도하고, 성공해야 발송 완료로 기록한다.
- 최초 시도 후 23시간이 지나면 `expired`로 전환하고 `DEPLOY_NOTIFY_EXPIRED` 감사 로그를 남긴다. Resend의 [중복 방지 키 유효기간은 24시간](https://resend.com/docs/dashboard/emails/idempotency-keys)이므로 무기한 자동 재시도하지 않는다.
- 같은 사용자·저장소·digest는 한 번만 발송한다. 기존 `last_notified_image_sha`는 이전 버전에서 보낸 이미지의 재발송을 막기 위해 유지한다. 이전 버전이 발송 전에 기록한 실패 여부는 복구할 수 없다.
- 재시도는 해당 이미지가 현재 활성·정상 배포로 확인될 때만 진행한다. 빠르게 교체되거나 삭제된 배포, 1분 사이 완료·교체된 배포의 알림은 보장하지 않는다.
- 대기 기록은 재시작 후 유지된다. 계정 내보내기에 포함하며 계정 삭제 시 제거한다. 백업은 기존 SQLite 백업·보존 정책을 따른다.
- 현재 단일 백엔드 인스턴스용이다. 다중 인스턴스 전환 시 DB 작업 선점 방식이 필요하다. 이메일 제공자가 요청을 수락한 사실과 수신함 도착은 다르다.

## 로컬 검증

- Backend: Jest 15개 스위트, 215개 테스트 통과.
- Backend: TypeScript 프로덕션 빌드 통과.
- 임시 SQLite DB와 외부 연동을 끈 환경에서 Nest 앱 기동·스케줄 작업 3개 등록·`/api/health` HTTP 200 확인.
- 새 테스트: 화면 없는 발송, 실패·재시작·재시도, 키 재사용, 중복 주기 실행, 시간 만료, 계정 삭제, 이전 이미지 상태 오인 방지.
- 외부 API와 이메일은 테스트 대역을 사용했다. 실제 메일은 발송하지 않았다.

## 운영 검증 범위

- 운영 Argo CD의 `sync.comparedTo.source.kustomize.images`·`summary.images` 형태 확인 완료.
- 화면 조회 없는 발송·성공 기록 확인 완료. 수신함 도착 여부는 발송 전용 Resend 키로 조회할 수 없어 미확인.
- Prisma SQLite 앱 재시작·재배포 후 데이터 보존, 별도 공간의 백업 복구.
- 기존 namespace의 격리 정책 적용 및 장애 알림 수신 경로 확인.

## 미완료·후속 범위

- 일반적인 DB 호스팅, 다중 노드·고가용성, 결제·일반 공개 가입.
- Playwright는 UI API 대역을 사용한다. 실제 Nest HTTP 인가 통합 테스트 및 별도 OCI 공간의 저장소·격리 검증을 함께 수행한다.
- 배포 판정은 아래 2026-09-15 개선 검증 기록을 따른다.

## OCI 배포 및 테스트 결과

2026-09-15 KST. SSH 별칭 `swkoo-oci`, 호스트 `instance-20250321-1004`, ARM64 k3s `v1.32.3+k3s1`에서 확인했다.

- 기능 커밋: `36d9175`. 배포 이미지 태그: `94c5292ab0f0566e9af24e73b8d8709405fb70da`.
- [GitHub Actions 실행](https://github.com/sungwookoo/swkoo-kr/actions/runs/34953317115): 백엔드 테스트·이미지 빌드·OCIR push·매니페스트 갱신 성공. Argo CD `swkoo-portfolio`는 Synced / Healthy.
- 첫 CI에서 Node 24.20.0 + SQLite 네이티브 모듈의 cleanup assertion으로 프로세스가 중단됐다. [Node 이슈 #65446](https://github.com/nodejs/node/issues/65446)을 확인하고 백엔드 CI·Docker 빌드/런타임을 24.18.1로 고정했다. 향후 해당 upstream 수정 확인 후 버전 정책을 재검토한다.
- 배포 전 SQLite 스냅샷 생성·무결성 검사, 배포 후 실제 DB 무결성 검사 모두 `ok`. 새 알림 테이블 자동 생성 확인.
- 검증 완료 후 임시 사전 스냅샷은 제거했다. 기존 예약 백업·보존 정책은 유지한다.
- `/api/health`, `/deploy`, 인증된 본인 `/api/deploy/current`·`/api/deploy/status` 요청 정상 응답.
- 운영 TLS 검사 중 사용자 앱 인증서 만료 발견. Cloudflare 토큰 권한은 정상이며 cert-manager 1.12.0의 [Cloudflare DNS cleanup 버그 #7540](https://github.com/cert-manager/cert-manager/issues/7540)가 원인이었다. Helm 사전 검증 후 같은 minor 수정판 1.12.17을 적용하고 만료된 발급 요청을 `cmctl renew`로 갱신했다.
- 사용자 인증서 4개 + 공통 wildcard 인증서의 만료일이 2026-12-14로 갱신되었다. `swkoo-argocd-config`도 Synced / Healthy로 회복했다.
- `hello.apps.swkoo.kr`, `planner-h.apps.swkoo.kr`, `zieun-ai-portfolio.apps.swkoo.kr`: TLS 검증을 포함한 HTTPS 200.
- `sw-koo/nextjs-sample`, `hizieun/portfolio`에 대해 화면 조회 없이 주기 작업에서 메일 발송 성공 및 `sent`·`DEPLOY_NOTIFY` 기록 확인. 기존 기록은 과거 다른 이미지 또는 미발송 상태였다.
- 18:47 KST 재확인에서도 발송·감사 기록이 2건으로 유지되어 여러 주기 동안 중복 발송이 없었다. 백엔드 Pod는 Ready, 재시작 0회.
- **별도 앱 오류:** `sprintflow.apps.swkoo.kr`은 TLS 복구 후 HTTP 500. 앱 로그에 "프로젝트 데이터가 없습니다"가 기록된다. 해당 앱 데이터 초기화는 수행하지 않았고, 완료 알림도 발송되지 않았다.

이번 인증서 복구는 기존 Helm release에 직접 적용한 운영 수정이다. Terraform의 현재 버전 기본값은 별도 저장소에 남아 있으므로 다음 Terraform 적용 시 아래 runbook의 버전 주의사항을 확인한다. 장기적인 cert-manager 지원 버전 업그레이드는 후속 과제다.
