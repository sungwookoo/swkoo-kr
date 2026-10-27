# 2026-10-27 보안 개선 및 운영 절차

범위는 swkoo.kr 플랫폼 소스와 운영 인프라다. 다른 사용자 앱 저장소를 수정하거나 PR을 만들지 않는다. 신규 백업 서비스는 도입하지 않는다. 기존 점검 결과는 `security-review-2026-10-27.md`에 보존한다.

## 변경

- 의존성을 패치하고 압축 요청 본문을 415로 거부한다. 일반 JSON과 webhook 서명 검증에 필요한 원문은 유지한다.
- 패치·스캔 Job은 `swkoo-workers`에서 실행한다. restricted Pod 정책, 전용 무권한 서비스 계정, 허용 이미지/볼륨/실행시간 admission 정책, 공용 HTTPS·DNS만 허용하는 통신 정책을 적용한다. 플랫폼 namespace의 Job 생성 권한은 제거한다.
- 플랫폼 컨테이너는 기존 UID/GID를 유지하면서 non-root, 기본 seccomp, 전체 capability 제거, 권한 상승 금지를 명시한다.
- `__Host-` 세션/OAuth cookie와 서버 세션 목록을 사용한다. 로그아웃 및 계정 삭제 시 세션을 폐기한다. 기존 세션은 배포 후 재로그인이 필요하다.
- GitHub access/refresh token은 AES-256-GCM으로 암호화한다. 사용자 ID와 토큰 종류도 인증하므로 다른 필드에 복사한 암호문은 거부한다. 기존 값은 시작 시 트랜잭션으로 변환하고 WAL을 비운다. 잘못된 키는 시작 실패로 처리한다.
- 동적 페이지에 매 요청 nonce CSP, 정적 페이지에 외부 스크립트 또는 hash CSP를 적용한다. 보안 헤더와 API no-store를 적용한다.
- 신뢰하는 내부 프록시만 전달 IP를 사용하고 backend ingress를 제한한다. 요청 제한이 모든 사용자를 하나의 프록시 IP로 묶지 않게 한다.
- 실행 중인 준비 완료 컨테이너의 digest를 스캔한다. 서로 다른 digest가 함께 실행 중이면 확정될 때까지 건너뛴다. 화면에는 스캔 이미지와 현재 이미지의 일치 여부, 48시간 경과 여부를 표시한다. 운영 이미지 검사도 상세 finding을 감사 기록에 보관한다.

## 암호화 키 운영

`TOKEN_ENCRYPTION_KEY`는 별도 Kubernetes Secret `swkoo-token-encryption`에 보관하는 무작위 32바이트 base64 값이다. 저장소/로그에 기록하지 않는다. 로컬 개발도 지속 DB를 사용한다면 고정된 개발 전용 키가 필요하다. 테스트만 임시 키를 허용한다.

현재 구현은 두 키의 동시 사용을 지원하지 않는다. 키 교체는 유지보수 시간에 backend를 중지하고, DB의 `access_token`, `refresh_token`, `token_expires_at`을 NULL로 만들고 `sessions`를 비운 후 WAL checkpoint를 수행한다. 이후 Secret을 새 키로 교체하고 backend를 다시 시작한다. 사용자 재로그인으로 새 토큰을 저장한다. 사용자/배포/환경변수 기록은 삭제하지 않는다. 재로그인 없이 보존하려면 별도로 검증된 재암호화 절차가 먼저 필요하다. 키를 잃은 경우에도 같은 토큰 초기화 절차를 따른다.

암호화는 DB 파일만 유출되는 상황의 보호다. backend 실행 권한 또는 DB와 Secret 모두를 가진 관리자를 막지는 않는다. 배포 이전에 만들어진 사본의 평문까지 소급해 제거하지 않는다.

## 배포 순서와 복구

1. worker namespace·정책·캐시와 registry Secret을 준비하고 정상/거부 Job을 검증한다.
2. 토큰 Secret을 준비한 뒤 새 backend/frontend 이미지를 배포한다.
3. worker Argo Application을 등록하고 기존 플랫폼 namespace의 Job 생성 권한을 제거한다.
4. 실제 HTTPS, 인증 차단, cookie/header, DB 암호화 상태, worker 실행과 권한을 확인한다.

암호화 이후에는 평문을 기대하는 예전 backend로 단순 롤백하지 않는다. 암호화 호환 코드를 유지한 수정 이미지를 배포한다. 장애 시 키를 재생성하지 말고 Secret 참조·파일 권한·시작 로그를 먼저 확인한다. 인프라 업그레이드는 minor 버전별로 readiness와 인증서를 확인한다.

## 검증 기록

- 1차 의존성 수정 PR #62 및 이미지 반영 PR #63 운영 적용 완료.
- backend 전체 321개 테스트 및 추가 마이그레이션/계정 삭제 테스트 통과.
- frontend 단위 테스트 95개, 브라우저 테스트 19개 통과. 운영 빌드 CSP 테스트도 별도 통과.
- 격리된 실제 패치 fixture: 취약 패키지 1→0, 설치 스크립트 실행 없이 lockfile 변경 검증 통과. 비허용 서비스 계정 Job은 admission에서 거부.
- 1차 운영 이미지의 실제 digest 검사: backend/frontend 각각 Critical·High·Medium 0건. npm audit도 양쪽 0건. 공지 DB 시점과 검사 범위에 한정된 결과다.
- K3s v1.35.9+k3s1, cert-manager v1.21.3 전환 완료. 중간 minor별 준비 상태와 인증서를 확인했다. 기존 인증서 10개 Ready 및 별도 테스트 도메인의 Let's Encrypt staging 인증서 신규 발급 성공. 테스트 namespace는 제거했다.
- kubeconfig의 전체 사용자 읽기 권한을 600으로 제한하고 K3s 서비스의 생성 옵션에도 반영했다. Terraform의 기존 클러스터 삭제 bootstrap을 제거했다. 현재 checkout에 유효한 운영 state가 없어 전체 apply는 수행하지 않았으며, 기존 서비스에 직접 업그레이드를 적용했다. 인프라 저장소 PR #1에 절차와 설정을 기록했다.
- 허용하지 않은 이미지·Secret 환경변수 참조·서비스 계정을 가진 Job은 admission에서 거부했다.
- 스캔 기록이 없을 때 JSON null을 반환하고, 로그인 사용자별 조회 및 비로그인 차단을 HTTP 테스트로 확인했다. 쿠키 안내도 세션/OAuth 실제 이름과 수명에 맞췄다.

## 남는 범위

실제 별도 사용자 두 명의 GitHub 로그인까지 포함한 교차 계정 시험은 수행하지 않았다. 자동화 테스트는 별도 사용자 세션으로 계정별 조회를 검증한다. OCI IAM 전체 감사, 전체 Git 이력 secret 검사, 사용자 앱 소스 수정은 이번 배포에 포함하지 않는다. 토큰 암호화 키는 DB와 분리했지만 노드 관리자에 대한 격리는 아니다.
