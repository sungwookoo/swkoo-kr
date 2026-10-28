# GitHub 토큰 최소 권한 검증 — 2026-10-28

## 변경

저장소 토큰은 대상 저장소 1개와 명시한 권한으로만 발급한다. 권한 누락·빈 객체·잘못된 값은 GitHub 요청 전에 거부한다. 조회는 contents 또는 metadata 읽기, 매니페스트 변경은 contents 쓰기, 보관·삭제는 administration 쓰기로 분리했다. 기존 소스 검토·초안 PR의 명시적 권한 제한은 유지한다.

조직 범위 예외는 설정된 플랫폼 배포 조직으로 제한한다. 신규 저장소 생성에는 administration 쓰기, 보관된 저장소 목록 조회에는 metadata 읽기만 사용한다. 생성 이후 파일 기록·보관·삭제는 대상 저장소 하나로 다시 제한한 토큰을 받는다. 조직 생성 토큰으로 매니페스트를 기록하지 않는다.

[GitHub 공식 문서](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)에 따라 repository·permission 생략 시 설치 전체 권한으로 확대되는 기본 동작을 피한다. 조직 목록·생성은 아직 대상 저장소가 없거나 목록 전체를 읽어야 하므로 저장소 범위를 한 개로 제한할 수 없는 예외다. 이 예외가 사용자 소스 저장소 접근으로 쓰이지 않도록 조직과 목적을 검사한다.

## 검증

- backend 전체 34 suites / 362 tests 및 프로덕션 빌드 통과.
- 권한 생략·잘못된 권한의 사전 거부, 저장소 한 개 지정, 조직·목적 검사, 조직 생성 토큰의 파일 쓰기 재사용 방지, 정리 작업의 저장소별 삭제 권한을 회귀 테스트로 검증했다.
- 새 서비스 코드를 운영 컨테이너의 별도 Node 프로세스에서 로드해 실제 GitHub API를 시험했다. 운영 서버 파일이나 실행 중인 서비스 모듈은 교체하지 않았다.
- 플랫폼 배포 조직에 고유 이름의 임시 private 저장소 하나만 만들었다. 토큰의 `/installation/repositories`가 정확히 이 저장소 한 개를 반환하는지 확인했다.
- contents 쓰기 토큰으로 검증 파일 기록, 읽기 토큰으로 조회 성공. 같은 읽기 토큰의 Git blob 쓰기는 403으로 거부됐다.
- 조직 administration 전용 토큰도 Git blob 쓰기가 403으로 거부됐다. 대상 저장소만 허용한 읽기 토큰으로 다른 private 배포 저장소의 파일 조회는 404로 거부됐다.
- metadata 전용 조직 목록 조회와 소유자 관리 SprintFlow의 GHCR 버전 조회가 성공했다. 앱 이미지·소스·DB는 변경하지 않았다.
- 저장소 전용 administration 토큰으로 임시 저장소 보관·삭제 성공. 새로 만든 ID·이름·설명을 대조한 임시 저장소만 제거했다.

실제 사용자 소스 저장소에는 기록·PR 생성·삭제를 하지 않았다. GitHub token이나 App private key는 출력·전달하지 않았다. 실제 API 시험은 토큰 범위 확인이며 모든 권한 우회 가능성을 인증하는 결과는 아니다.

## 운영 반영

[PR #83](https://github.com/sungwookoo/swkoo-kr/pull/83)과 [이미지 PR #84](https://github.com/sungwookoo/swkoo-kr/pull/84)로 backend 이미지 `4aeb2fdca01d8afaf7a7ee4f2397cfa0de89120b`를 반영했다. 새 Pod Ready·재시작 0, health 200과 기존 앱 정상 상태를 확인했다. 이후 실제 일반 계정의 SQLite 앱 등록·새 이미지 배포·환경변수 변경·삭제도 이 버전에서 수행해, 좁힌 권한으로 서비스 흐름이 유지됨을 확인했다.
