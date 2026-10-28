# 운영 검증 실행 절차

## 범위와 준비

운영자가 OCI 관리 호스트에서 수동 실행한다. 예약 실행·고객 앱 부하·새 인프라·자동 백업 기능은 추가하지 않는다. 기본 동작은 계획 출력이며 `--execute`를 명시해야 자원을 생성한다.

플랫폼의 검토된 코드로 backend를 빌드하고 검증 JSON을 생성한다.

```powershell
npm --prefix apps/backend run build
node scripts/render-storage-validation.cjs storage-fixtures.json
node scripts/render-load-validation.cjs load-fixtures.json
python scripts/test_operational_validation.py
```

JSON과 아래 스크립트를 권한 제한 관리 디렉터리에 전송한다. 자격 증명을 파일에 복사하거나 CI 비밀을 추가하지 않는다.

- `run-operational-validation.py`
- `validate-user-storage.py`
- `validate-runtime-failures.py`
- `validate-app-capacity.py`
- `check-runtime-snapshots.cjs`

실행 전 현재 소유자 관리 이미지 digest를 확인한다. storage/runtime은 `ghcr.io/sungwookoo/sprintflow:latest@sha256:...`, load는 명시적으로 테스트용 사용을 허용한 `ghcr.io/sw-koo/nextjs-sample@sha256:...`만 허용한다. 태그만 전달하거나 다른 사용자 이미지를 지정하면 중단한다. 부하용 이미지의 코드·의존성 기준은 테스트 저장소 PR [#3](https://github.com/sw-koo/nextjs-sample/pull/3)·[#4](https://github.com/sw-koo/nextjs-sample/pull/4)와 연결된 실제 빌드 이력을 참조한다.

## 계획 확인과 실행

아래 `<digest>`는 위에서 확인한 64자리 digest로 바꾼다. `<새 결과 디렉터리>`는 존재하지 않는 경로를 지정하며, 생략하면 안전한 임시 디렉터리를 만든다. 출력에는 인증 정보가 포함되지 않는다.

```sh
python3 run-operational-validation.py storage --fixtures storage-fixtures.json --image ghcr.io/sungwookoo/sprintflow:latest@sha256:<digest>
python3 run-operational-validation.py runtime --image ghcr.io/sungwookoo/sprintflow:latest@sha256:<digest>
python3 run-operational-validation.py load --fixtures load-fixtures.json --image ghcr.io/sw-koo/nextjs-sample@sha256:<digest>
```

계획의 대상·이미지·제한 시간을 확인하고 같은 명령에 `--execute --output-dir <새 결과 디렉터리>`를 붙여 sudo로 실행한다. 현재 단일 OCI 노드 이름·Ready 상태·디스크 여유 5GiB 이상을 확인하며, 검증 namespace가 이미 있으면 인계받아 변경하지 않고 중단한다. 클러스터나 호스트를 교체했다면 코드의 노드 확인 기준부터 별도로 검토한다.

## 작업별 결과

| 작업 | 검증 | 최대 실행 시간 |
|---|---|---|
| storage | 빈 DB migration, Pod 교체·환경변수 변경 후 데이터 유지, 별도 PVC 복원, 격리, 삭제 시 회수 | 10분 |
| runtime | OOM·예약 CPU 부족·DB 연결 실패 관측 후 운영 backend 코드로 원인 분류 | 10분 |
| load | Next.js SSR·API 읽기·DB 쓰기 혼합, 앱 3개 동시 실행, 15분 지속 구간 포함 | 25분 |

runtime은 기존 작업을 선점하지 않는 낮은 우선순위의 임시 PriorityClass를 사용한다. 다른 workload를 중단하거나 GitHub 장애를 실제로 발생시키지 않는다. load는 pod 내부 localhost로만 요청하며 Ingress를 만들지 않는다. 각 앱 1·3·5 요청/초를 15초씩 측정한 뒤 2 요청/초로 15분 유지한다. 동시 요청은 앱당 2개로 제한한다.

표의 제한 시간은 검사 단계이며 중단 시 정리를 위해 최대 4분 추가로 기다릴 수 있다. 실행 시 출력되는 결과 디렉터리의 `execution.log`로 진행 상태를 확인한다. 원격 실행에는 SSH keepalive를 사용하고, 연결이 끊겼다면 반환 코드 대신 서버에 저장된 결과와 실제 자원 상태를 다시 확인한다.

load는 컨테이너 지표 준비를 최대 90초 기다린다. 측정 중 지표가 사라지거나 노드 CPU 80%·메모리 75%, 앱 working set 460MiB에 도달하거나 컨테이너 재시작·요청 실패가 발생하면 실패로 중단한다. 이 수치는 검증 안전선이며 서비스 수용량 보장이 아니다.

## 중단·정리·기록

Ctrl+C 또는 SIGTERM으로 중단한다. 관리 실행기는 자식에게 종료 신호를 전달하고 자식의 `finally` 정리를 기다린다. 정상 종료 후 namespace와 runtime PriorityClass 제거를 확인해야 `passed`가 된다. 실행 시간 초과·오류·중단은 `failed`로 기록한다. SSH 연결이 끊기면 먼저 실행 프로세스와 결과 파일을 확인하고 같은 namespace로 새 검증을 겹쳐 실행하지 않는다.

결과 디렉터리는 권한 700이며 `summary.json`에 시작·종료 시각, 이미지, 대상, 통과·실패와 이유를 기록한다. `execution.log`에 검사 결과를 남기고 runtime은 `snapshots.json`, load는 `load.json`과 클라이언트별 로그를 추가한다. 결과 파일은 덮어쓰지 않는다. SIGKILL·노드 장애처럼 정리 코드를 실행할 수 없는 상황에는 자동 회수를 보장하지 않으므로, 생성 주체를 확인한 전용 검증 자원만 운영자가 정리한다.

실행 실패·중단 시에도 남은 검증 namespace를 조회해 `remainingNamespaces`로 기록한다. API 조회까지 실패하면 `cleanupStatus: unverified`로 남긴다. 잔여 자원을 다른 실행의 자원일 수 있으므로 무조건 삭제하지 않는다.

PR 검사에서는 부작용 없는 안전성 테스트 12개를 실행한다. 실제 클러스터 실행은 자동 CI에서 수행하지 않는다. GitHub OAuth 전체 흐름은 실제 로그인된 브라우저에서 별도로 검사하며 쿠키·비밀번호·토큰을 실행기에 전달하지 않는다.

## 외부 HTTPS 지속 검증

`render-load-validation.cjs`로 만든 JSON과 허용된 fixture digest를 사용한다. Windows 관리 PC에서 기존 `swkoo-oci` SSH 연결로 실행하며, HTTP 요청은 관리 PC에서 공개 HTTPS 주소로 보낸다. `public-capacity-client.cjs`도 같은 scripts 폴더에 있어야 한다.

```powershell
python scripts/validate-public-capacity.py load-fixtures.json ghcr.io/sw-koo/nextjs-sample@sha256:<digest> --seconds 3600 --output-dir <새 결과 폴더>
```

계획의 대상·시간을 확인한 뒤 `--execute`를 붙인다. 고정된 `swkoo-load-a/b/c.apps.swkoo.kr`와 전용 namespace 3개만 사용한다. 빈 DB의 Next.js·SQLite 앱을 배포하고 일반 인증서 발급과 실제 TLS 검증 후 시작한다. Certificate Ready와 Ingress 적용 사이의 전파를 최대 90초 기다리며 인증서 검증을 해제하지 않는다. 신규 인증서 발급을 포함하므로 무분별한 반복 실행으로 발급 제한을 소모하지 않는다.

노드·디스크·기존 namespace를 확인하고 외부 클라이언트는 앱당 동시 요청 최대 2개로 제한한다. 15초씩 1·3·5 요청/초, 이후 2 요청/초를 최대 1시간 유지한다. SSR 40%·API 읽기 50%·쓰기 10% 혼합이다. 오류·요청 누락·재시작·노드 CPU 80%/메모리 75%·앱 working set 460MiB 도달 시 중단한다. 마지막 실제 DB 기록 수를 검사한다.

출력 폴더의 `summary.json`, `samples.json`, `clients.json`, `client.log`를 보관한다. 생성한 namespace UID가 같은지 대조한 뒤 정리하며 실패한 정리는 결과에 남긴다. 기존 namespace·고객 앱·소스 저장소는 재사용하지 않는다. 임시 공개 앱에는 합성 데이터만 넣는다. 사용자 앱 자동 백업이나 장기간 운영 수용량 보장이 아니다.

PR 안전성 검사는 기존 9개에 외부 대상·이미지·자원 종류, 계획의 무부작용, 로그 권한 범위 검사 3개를 추가해 12개다.
