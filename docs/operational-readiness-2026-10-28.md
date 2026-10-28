# 운영 준비도 후속 개선 보고서 — 2026-10-28

요청한 여섯 과제를 순서대로 진행했다. 범위는 플랫폼과 운영 인프라, 별도 검증용 자원이다. 다른 사용자 소스 저장소 변경·PR 생성, 신규 유료 인프라, 사용자 앱 자동 백업 도입은 하지 않았다. 날짜가 붙은 이전 보고서는 당시 결과로 보존한다.

## 1. Terraform 운영 상태 복구

- 운영 서버에서 실제 state와 기존 자격 증명을 확인해 기준 경로를 확정했다. 로컬에 있던 오래된 state로 운영 상태를 덮어쓰지 않았다. state·인증 파일은 Git에서 제외하고 운영 파일 권한을 제한했다.
- bootstrap이 기존 Argo CD·인증서·레지스트리·모니터링 자원을 삭제하거나 재설치하지 않도록 수정했다. 조회 권한 오류도 기존 자원이 없는 것으로 간주하지 않는다. kubeconfig 경로와 제한된 대기 시간을 명시했다.
- 실제 VNIC→subnet→보안 목록 연결을 대조하니 state가 동명의 다른 목록을 관리하고 있었다. 실제 연결 자원을 import해 관리 대상을 바로잡았고, 기존 목록이나 인스턴스를 삭제하지 않았다.
- [인프라 PR #4](https://github.com/sungwookoo/terraform-k3s/pull/4), [PR #5](https://github.com/sungwookoo/terraform-k3s/pull/5) 반영. fmt·validate, 기존 자원 보존/읽기 실패 중단 bootstrap 시험, 운영 plan exit 0을 확인했다. SSH 호스트 공개키 검증도 실제 연결에서 통과했다.
- 현재 K3s v1.35.9+k3s1, cert-manager v1.21.3. 노드 Ready·기존 앱 Synced/Healthy·인증서 Ready를 확인했다. [state 복구 절차](https://github.com/sungwookoo/terraform-k3s/blob/main/STATE-RECOVERY-2026-10-28.md)를 이후 변경의 기준으로 사용한다.

## 2. 상태 저장 앱의 수명주기

현재 소유자 관리 SprintFlow 이미지 `sha256:061144baaa34bfc39b749ea6a7520d6dab2fa61f36696ca5af92d6d98c5bc3a0`를 전용 namespace에서 사용했다. 소스를 변경하거나 기존 앱 DB에 테스트 데이터를 넣지 않았다.

`render-storage-validation.cjs`와 `validate-user-storage.py`로 다음을 검증했다.

1. 빈 SQLite PVC에 Prisma migration을 적용하고 restricted 환경에서 기동.
2. 검증 데이터를 넣은 뒤 Pod 교체와 환경변수 변경 rollout 후 동일 데이터 조회.
3. 임시 SQLite 사본을 다른 namespace/PVC로 복원하고 Prisma 조회 성공.
4. 통신 허용 양성 대조 후 NetworkPolicy로 namespace 간 연결 차단. DNS는 허용하고 서비스계정 token은 마운트하지 않음.
5. A namespace 삭제 후 A의 PV·디렉터리 회수, B 데이터 보존 확인.

검증 namespace·PVC·임시 DB 사본은 정리했다. 이 복구 실험은 사용자 앱 자동 백업 기능을 추가한 것이 아니다. 일반 PostgreSQL 호스팅 지원이나 상태 저장 앱의 신규 GitHub OAuth 전체 흐름까지 검증한 것으로 확대하지 않는다.

## 3. 제한된 자원 측정과 운영 기준

`validate-capacity.py`는 생성 템플릿의 SQLite PVC에서 Project 100개를 준비하고, 요청마다 50개를 조회하는 작은 Node/Prisma API만 측정한다. 앱 상한 500m/512Mi, 예약 100m/256Mi이며 검증 클라이언트는 별도 제한된 컨테이너다. 공개 URL이나 기존 사용자 앱에 부하를 주지 않았다.

| 목표 요청/초 | 요청 수 | 오류·건너뜀 | 응답 p95 | 평균 CPU 코어 | 종료 시 메모리 |
|---|---:|---|---:|---:|---:|
| 5 | 75 | 0·0 | 6.70ms | 0.0246 | 18.95MiB |
| 10 | 150 | 0·0 | 5.95ms | 0.0342 | 22.83MiB |
| 20 | 300 | 0·0 | 5.90ms | 0.0701 | 26.80MiB |

각 구간 15초, 최대 동시 요청 8개, 총 525회다. cgroup 메모리 peak 35.54MiB, CPU throttle 및 OOM 이벤트 0이었다. 측정 중 노드 사용량은 대략 CPU 11%·메모리 30%였고 검증 자원은 삭제했다.

이 결과는 로컬 통신·소규모 읽기 API에 한정된다. Next.js SSR, 외부 TLS·네트워크, 파일 업로드, 쓰기 경합, 장시간 누수나 여러 앱 동시 부하를 대표하지 않는다. 이를 근거로 사용자 수를 확정하지 않는다.

운영 기준은 계정당 앱 1개·allowlist, 앱당 공유 CPU 최대 0.5코어·메모리 최대 512MiB다. 자동 증설은 없으며 namespace quota의 교체 배포 여유를 앱 전용 제공량으로 안내하지 않는다. 사용자 추가 전 노드 예약량과 앱 실제 사용량을 확인하고 여유가 부족하면 등록 확대를 보류한다. 단일 노드이므로 고가용성·특정 동시 사용자 수·SLA를 약속하지 않는다.

## 4. 남은 보안 점검

### 인프라와 이력

OCI SDK 2.189.0으로 접근 가능한 compartment 1개, 정책 2개·문장 3개를 점검했다. 사용자 1명의 MFA 활성, backend dynamic group의 특정 인스턴스 한정 조건, 조건 없는 any-user 권한 부재를 확인했다. 버킷 메타데이터 권한도 기존 플랫폼 버킷으로 좁혔고 Instance Principal로 임시 객체 쓰기·읽기·삭제를 검증했다.

실제 연결 방화벽의 불필요한 공개 NodePort 범위를 제거하고 관리 API를 내부로 제한했다. 외부 관리 포트 차단과 SSH·HTTPS 유지, Terraform의 관리 대상 연결 일치 및 plan 변경 없음을 확인했다. 상세 감사 결과와 변경 전 정책·state는 권한 제한 운영 파일에 보관하며 공개 공지에 복사하지 않는다.

Gitleaks 8.30.1 공식 배포 파일 checksum을 검증하고 원격 refs 갱신 후 `git --all` 이력을 검사했다. 플랫폼 399개·인프라 80개 commit에서 탐지 0건이다. 삭제된 원격 브랜치나 접근할 수 없는 저장소까지 포함하지 않으며, 지원 규칙으로 잡히지 않는 비밀까지 없다는 인증은 아니다.

### 의존성과 엑셀 데모

- frontend 전체 및 backend 운영 의존성 npm audit 0건.
- backend 개발 의존성은 deepmerge 4.3.1의 [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) Low 공지 1개가 Jest/ts-jest 경로의 7개 영향 패키지로 집계된다. 2026-10-28 조회에서 수정 버전은 없다. 운영 이미지에는 포함되지 않는다. 신뢰할 수 없는 Jest 설정을 실행하지 않으며, 자동 권고되는 구버전 Jest 강제 다운그레이드는 적용하지 않았다. 수정판이 나오면 별도 재검증한다.
- 별도 번들 SheetJS는 [공식 standalone 문서](https://docs.sheetjs.com/docs/getting-started/installation/standalone/)의 0.20.3과 줄바꿈을 정규화한 내용이 일치한다. npm audit에는 이 번들이 포함되지 않는다.
- 작은 압축 파일도 과도한 해제량·파싱 시간을 유발할 수 있어 ZIP 구조·최대 512항목·선언된 해제 크기 합계 16MiB·압축률 200배를 검사한다. 별도 Web Worker에서 처리하고 8초 후 중단한다. 기존 파일당 2MB·최대 5개·전체 5,000행 제한을 유지하며 안내 문구에도 반영했다.
- 정상 샘플 업로드, 2MB 미만/해제 20MiB fixture 거부, 응답 없는 worker 종료 후 UI 복구를 브라우저에서 확인했다. ZIP 메타데이터 검사와 worker 시간 제한이 모든 악성 파일의 메모리 안전성을 보장하는 것은 아니다.

## 5. 문서와 공개 안내

`STATUS.md`의 현재 기준일·운영 요약을 갱신하고 `BIZ_READINESS.md`의 등록 브랜치·ApplicationSet refresh·격리 검증·자원 안내를 바로잡았다. 날짜가 붙은 과거 기록은 현재 상태와 구분했다. `/notices`의 기존 공지에 파일 처리·장애 안내 후속 개선만 추가했으며 내부 접근 정보나 상세 공격 재현은 공개하지 않는다.

## 6. 실패 원인과 재시도

- 최신 이미지 Pod의 OOMKilled는 메모리 한도 초과로 안내한다. 재시작 후 정상 준비된 Pod의 과거 OOM만으로 실패 판정하지 않는다.
- CPU·메모리 예약 부족에 따른 Unschedulable은 서버 자원 대기로 안내한다. Argo의 일반 상태 문구가 구체적인 원인과 조치를 덮어쓰지 않도록 수정했다. PVC 대기 등 다른 스케줄링 원인은 자원 부족으로 단정하지 않는다.
- 일반 시작 실패에는 앱 로그·필수 환경변수·DB 설정 점검을 안내한다. 로그를 분석해 DB 오류라고 자동 확정하는 기능은 아니다.
- 환경변수 저장 503 후 입력 유지·재저장, GitHub 연결 실패에 따른 제거 503 후 앱 화면 유지·다시 확인 후 제거를 브라우저 대역 시험으로 확인했다. 기존 소스 등록 부분 실패 안내도 전체 회귀 시험에 포함한다.
- 정기 정리·스캔이 호스트 UTC를 따라 실행되는 시간대 오류를 발견해 `Asia/Seoul` 03:00으로 명시했고 실제 스케줄 등록 시각을 테스트했다. 기존 플랫폼 백업 일정이나 보존 정책은 변경하지 않았다.

실제 OCI 장애 fixture는 별도 namespace에서만 실행한다. 64Mi 컨테이너 OOM, 기존 작업을 선점하지 않는 낮은 우선순위의 4 CPU 예약 대기, 존재하지 않는 SQLite 경로의 연결 실패를 관측하고 저장된 Kubernetes 응답을 실제 backend 판정 함수로 검사한다. 전체 노드를 메모리 부족으로 만들거나 GitHub 장애를 실제로 유발하지 않는다. 검증 자원과 임시 PriorityClass는 정리한다.

## 검증과 재실행

- backend: 34 suites / 349 tests, TypeScript 프로덕션 빌드 통과.
- frontend: 12 files / 100 tests, 프로덕션 빌드 통과.
- 브라우저: 28개 시나리오 통과. API 대역 시험이며, 앞선 [일반 계정 실제 배포 검증](./user-flow-verification-2026-10-28.md)과 구분한다.
- 인프라 운영 적용은 완료했다. 이번 플랫폼 UI·판정 코드의 배포 근거는 이 문서의 후속 운영 확인 기록과 해당 PR의 이미지 반영 이력을 따른다.

검증 스크립트는 먼저 backend 빌드 후 실행한다. 저장소의 `render-storage-validation.cjs`로 JSON을 만들고 `validate-user-storage.py`·`validate-capacity.py`는 운영자 관리 호스트에서 현재 소유자 이미지 digest를 인자로 실행한다. 전용 namespace가 이미 있으면 중단한다. `validate-runtime-failures.py`의 응답 JSON은 `check-runtime-snapshots.cjs`로 검사한다. 일반 사용자에게 이 관리 실행 경로를 노출하지 않는다.

남는 범위는 수정판 없는 개발 도구 Low 공지, 두 신규 GitHub 계정 각각의 전체 OAuth 흐름, 장시간·여러 SSR 앱의 부하 측정, 외부 인증된 침투 테스트다. 일반 DB 호스팅·고가용성·사용자 앱 자동 백업은 별도 제품 결정이 필요한 범위다.
