# 현재 구현 및 검증 기준선

기준일: 2026-09-15. 코드 기준선과 아래 운영 검증 기록을 구분한다. Observatory의 정체성은 [VISION](../VISION.md), Deploy의 정체성은 [deploy-vision](./deploy-vision.md)을 따른다.

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
- 현재 등록된 활성 앱의 `Synced / Healthy`, 성공한 동기화 작업, 현재 이미지와 비교된 source·이미지 summary의 digest 일치, 앱 URL의 2xx/3xx 응답을 확인한다. 이는 Argo CD의 상태에 근거하며 Pod를 직접 조회하는 검증은 아니다.
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
- PR 단계 검증 확대와 실제 배포 흐름의 통합 테스트. 현재 Playwright는 모의 API를 사용한다.
- 전체 배포 진행 UI의 최신 빌드·이미지 연결 검증은 후속 작업이다. 이번에는 완료 이메일의 판정만 강화했다.

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
