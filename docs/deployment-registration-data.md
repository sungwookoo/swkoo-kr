# 배포 등록 데이터 운영

2026-10-28 실제 GitHub 로그인 후 앱 삭제 검증에서 코드 저장소 `main`의 PR·필수 검사 규칙이 기존 배포 등록/삭제 commit을 차단하는 문제를 확인했다. 코드 보호 규칙을 유지하고, 자동 기록이 필요한 등록 데이터만 같은 저장소의 `deployment-data` 브랜치로 분리한다.

- 코드 및 플랫폼 설정: `main`, 기존 PR·필수 검사 유지.
- 실시간 앱 등록 정보: `deployment-data`의 `deploy/users/<login>.yaml`.
- 사용자별 Kubernetes 매니페스트: 기존 `swkoo-deploy/<login>` 저장소의 `main`.
- 사용자 앱 소스: 기존 사용자 소유 저장소. 이번 실제 검증에서 명시적으로 허용된 `sw-koo/nextjs-sample` 외의 사용자 소스는 변경하지 않는다.

`deployment-data`는 기존 네 등록 파일과 동일한 blob으로 초기화한 독립 브랜치다. 코드·워크플로는 포함하지 않는다. 백엔드의 `MANIFEST_BRANCH=deployment-data`와 ApplicationSet Git generator의 `revision: deployment-data`를 함께 사용한다. 사용자별 deploy 저장소의 `targetRevision: main`은 그대로다.

`main`의 기존 등록 파일은 전환 도중 기존 generator가 빈 목록을 읽어 앱을 제거하지 않도록 마이그레이션 스냅샷으로 남긴다. 앞으로 실제 상태 확인은 반드시 데이터 브랜치에서 한다. 데이터 브랜치를 코드 브랜치에 병합하거나 코드 브랜치를 데이터 브랜치로 덮어쓰지 않는다.

운영 전환 시 기존 모든 Application이 유지되는지 확인한 뒤 테스트 계정으로 삭제·재등록을 수행한다. 롤백 시에는 먼저 데이터 브랜치의 최신 등록 목록을 보존해야 한다. 이전 코드의 `main`을 가리키는 설정으로 단순 복귀하면 이미 삭제된 앱을 되살리거나 신규 앱을 누락할 수 있다.

등록·삭제 회귀 테스트는 운영 데이터 브랜치를 전달하는지 확인한다. GitHub ref 갱신 오류는 안전한 HTTP 오류로 변환하며, Axios 요청의 설치 토큰이 예외 로그로 전파되지 않도록 한다.

ApplicationSet의 즉시 재조회는 `argocd.argoproj.io/application-set-refresh=true`로 요청한다. 기존 `argocd.argoproj.io/refresh=hard`는 Application용이므로 이 리소스에서는 사용하지 않는다. [Argo CD 공식 annotation 문서](https://argo-cd.readthedocs.io/en/stable/user-guide/annotations-and-labels/)를 기준으로 수정하고 API 요청 회귀 테스트를 추가했다.
