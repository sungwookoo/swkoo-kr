# 개인 비공개 저장소와 조직 저장소 배포

배포 목록에는 기본적으로 공개 저장소만 표시한다. 배포 화면에서 **비공개 저장소 포함**을 선택한 경우에만 해당 화면에서 비공개 저장소를 조회한다. 개인 저장소는 로그인한 계정이 소유해야 한다. 조직 저장소는 로그인한 계정에 GitHub 저장소 관리 권한이 있고, 해당 저장소에 swkoo-deploy GitHub App이 설치되어 있어야 한다.

개인 비공개 저장소와 조직 저장소의 이미지는 전용 GitHub Container Registry 패키지에 비공개로 게시한다. 첫 빌드가 끝나면 진행 화면에서 GitHub 클래식 토큰을 등록한다. 토큰은 로그인한 GitHub 계정으로 발급하고 `read:packages` 권한만 부여한다. 조직에서 SSO 승인이 필요한 경우 토큰을 해당 조직에 승인한다. 조직 정책이 클래식 토큰을 금지하면 연결할 수 없다. 토큰은 해당 앱 네임스페이스의 Kubernetes Secret에 저장하며 Git이나 앱 환경변수에 포함하지 않는다. 앱을 제거하면 네임스페이스와 함께 삭제된다. 토큰 철회는 GitHub에서 할 수 있다.

앱 주소는 기존 배포와 같이 공개된다. 방문자 접근 제한이 필요한 앱은 자체 로그인이나 접근 제어를 사용한다. 비공개 이미지 배포에는 기존 공개 이미지 스캔과 npm 수정 PR을 표시하지 않는다.

운영에서는 `swkoo-deploy/private-registrations`의 저장소 공개 범위가 Private이고 GitHub App이 접근할 수 있는지 먼저 검증한다. `deploy/argocd/private-users-applicationset.yaml`을 적용하고 ApplicationSet이 비공개 저장소를 읽을 수 있는지 확인한다. 이 검증을 마친 후 `swkoo`의 `swkoo-private-deploy` ConfigMap에 `manifestRepo: swkoo-deploy/private-registrations`를 지정하고 플랫폼 백엔드를 배포한다. 기존 공개 앱은 기존 ApplicationSet에서 계속 관리한다.
