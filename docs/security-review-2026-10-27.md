# swkoo.kr 보안 점검 — 2026-10-27

## 범위와 판정 기준

- 기준 코드: `171446e9473023cf55c2e21fe4f0ec8ce0fabb24` (점검 시 GitHub main과 일치).
- 운영 백엔드: `3e1123a01cd8ed9b21b2f2f94e3347cfccd66a11`, 프런트엔드: `baa1ef6dd612446dfda9fa5bd6c301bf71d2dbf6`.
- 소스 검토, 최신 npm audit(개발 의존성 포함/제외), 운영 패키지 버전·Kubernetes 설정 조회, 기존 이미지 스캔 기록 확인, 비인증 HTTP 검사, 보안 관련 회귀 테스트를 수행했다.
- 운영 서버에 공격 페이로드·부하를 보내거나 사용자 저장소를 변경하지 않았다. 운영 설정·데이터도 변경하지 않았다.
- P1은 우선 수정, P2는 후속 보강이다. 패키지 공지의 Critical 등급과 실제 서비스에서 입증된 공격 가능성을 구분한다. 침해 발생 여부에 대한 포렌식 판정은 아니다.

## 요약

| 범위 | Critical | High | Moderate | Low | 합계 |
|---|---:|---:|---:|---:|---:|
| 백엔드 npm 전체 | 2 | 3 | 2 | 0 | 7 |
| 백엔드 npm 운영 의존성 | 1 | 3 | 2 | 0 | 6 |
| 프런트엔드 npm 전체 | 2 | 5 | 3 | 2 | 12 |
| 프런트엔드 npm 운영 의존성 | 2 | 2 | 0 | 2 | 6 |

숫자는 npm이 보고한 취약 **패키지 항목 수**이며, 고유 CVE 수나 재현된 공격 수가 아니다. 운영 의존성 집합도 standalone 이미지에 모두 포함된다는 뜻은 아니다.

### 운영에 설치된 버전 직접 확인

- backend: body-parser 2.3.0, proxy-addr 2.0.7, follow-redirects 1.16.0, multer 2.3.0, ip-address 10.7.2, Node 24.18.1.
- frontend: Next.js 16.3.5, Node 24.22.0. Docker 기반은 Alpine이다.

## 우선 수정 사항

### P1-1. 인증 전에 실행되는 body-parser의 서비스 중단 취약점

- 근거: `apps/backend/src/main.ts:80`의 JSON parser와 81행의 URL-encoded parser. 기본 압축 해제를 사용하며 인증 guard보다 먼저 동작한다.
- 운영 버전 2.3.0은 [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828)의 영향 범위다. 공지는 조작된 압축 본문으로 인증 없이 프로세스를 종료시킬 수 있다고 설명한다.
- 판정: 영향 버전과 적용 조건 확인. 운영 장애를 유발하는 재현 요청은 보내지 않았다. 단일 백엔드 replica이므로 API 가용성에 직접 영향이 있다.
- 조치: body-parser 2.4.0 이상을 실제 설치하도록 lockfile 갱신하고 parser 회귀 테스트 수행. 압축 본문이 필요 없다면 `inflate: false`도 검토한다. Nest 기본 parser까지 포함해 실제 실행 설정을 검증해야 한다.

### P1-2. Next.js 및 운영 의존성의 보안 업데이트 누락

- Next.js 16.3.5가 설치되어 있다. [GHSA-673q-mjm6-r5xr](https://github.com/advisories/GHSA-673q-mjm6-r5xr)의 수정 버전은 16.4.1이다. 공지의 typed-array `use cache` 조건은 현재 앱 소스에서 발견하지 못했다.
- [GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw)는 glibc Linux의 이미지 처리 조건을 명시한다. 현재 Alpine 환경에 이 RCE가 그대로 성립한다고 판정하지 않는다. `next/og`, Server Actions 등 개별 공지 조건도 구분해야 한다.
- backend 추가 항목: follow-redirects, multer, ip-address, proxy-addr. proxy-addr는 Critical로 집계되지만 현재 앱에 IP 기반 인증이나 `trust proxy` 설정은 확인되지 않았다. Multer 업로드 인터셉터 사용도 확인되지 않았다.
- frontend 추가 운영 항목: DOMPurify, sharp, source-map-js, KaTeX/Mermaid. Mermaid는 현재 정적 차트에 쓰이며, 공격자 입력 경로가 확인된 XSS로 단정하지 않는다.
- 조치: 호환 범위 패치를 먼저 적용하고 운영 이미지에서 재검사한다. `npm audit fix --force` 일괄 적용은 피한다. Mermaid/KaTeX는 메이저 변경 여부를 별도 검토한다. 개발 전용 Handlebars·Vite·Vitest 등의 공지는 CI/개발 환경 문제로 분리한다.

### P1-3. 백엔드 침해 시 Job 생성 권한이 노드로 확대될 위험

- 근거: `deploy/argocd/swkoo-backend-scan-rbac.yaml`이 backend SA에 `swkoo` namespace의 Job 생성 권한을 부여한다. 실제 `kubectl auth can-i create jobs`도 yes였다.
- 사용자 namespace는 Pod Security restricted지만 `swkoo`에는 enforce label이 없다. 조회한 validating admission 설정에도 해당 Job의 이미지·serviceAccount·hostPath 등을 제한하는 별도 정책이 없었다.
- 판정: 선행 조건은 backend 코드 실행 또는 SA 자격 증명 탈취이다. 공개 API에서 임의 Job을 바로 만들 수 있다는 뜻은 아니다. 그 조건에서는 임의 Pod 사양이 담긴 Job으로 권한이 확대될 수 있는 구조다. 악성 Job은 만들지 않았다.
- 조치: 스캔 worker를 별도 namespace로 분리하고 restricted 정책 적용, 사용할 SA·볼륨·이미지 제한. backend/frontend에도 non-root, privilege escalation 차단, capabilities drop, seccomp 등을 명시한다. 기존 Trivy worker 사양을 먼저 호환되게 고쳐야 한다.

### P1-4. 지원 종료된 인증서 관리 구성

- 운영 cert-manager는 1.12.17이다. [공식 지원 표](https://cert-manager.io/docs/releases/)에서 1.12 LTS 지원 종료는 2025-05-19다.
- K3s 1.32.3+k3s1, Argo CD 3.1.8, Traefik 3.3.2 등도 운영 중이다. 이번 점검에서 각 이미지 전체 CVE와 공급자 지원 계약까지 확정하지 않았다.
- 조치: K3s와 호환되는 지원 버전으로 cert-manager 업그레이드 계획 수립. CRD·DNS issuer·인증서 발급/갱신·복구 검증을 포함한다. 단순 이미지 태그 변경으로 처리하지 않는다.

## 후속 보강 사항

### P2-1. 세션 및 OAuth cookie를 사용자 서브도메인에서 더 강하게 격리

- `auth.service.ts:21`의 cookie 이름은 `swkoo_session`, OAuth state도 일반 이름이다. Secure/HttpOnly/SameSite=Lax와 host-only 설정은 적용되어 있다.
- 사용자 앱도 `*.apps.swkoo.kr`에 있어 상위 도메인 cookie를 설정할 수 있는 동일 등록 도메인에 속한다. 일반 이름은 sibling-domain cookie tossing에 대한 브라우저의 `__Host-` 보호를 받지 않는다.
- 판정: 설계상 위험. 실제 사용자 브라우저에서 로그인 혼동 공격을 재현하지 않았다.
- 조치: session/state/return cookie를 `__Host-` 이름으로 이행하고 기존 cookie 정리. 별도 등록 도메인으로 사용자 앱을 분리하는 방안도 장기 검토.
- 추가로 JWT는 30일 유효하고 logout은 cookie 삭제만 수행한다(`auth.controller.ts:219`, `auth.service.ts:275`). 이미 복사된 토큰은 로그아웃으로 폐기되지 않는다. 서버측 session ID 또는 session version으로 폐기 기능을 마련한다. 탈퇴 계정은 DB 조회에서 제외되어 별도로 차단된다.

### P2-2. 프런트엔드 문서의 보안 헤더 누락

- 실제 `GET/HEAD https://swkoo.kr/`에서 CSP, frame-ancestors/X-Frame-Options, nosniff, HSTS가 확인되지 않았다. API에는 HSTS와 CSP Report-Only가 있다. API 헤더가 HTML 문서를 보호하지는 않는다.
- 근거: `apps/frontend/next.config.mjs:15`에는 특정 경로의 robots 헤더만 설정되어 있다.
- 조치: 전체 HTML에 frame-ancestors와 nosniff 등 적용. CSP는 Next.js hydration/인라인 스크립트와 Mermaid를 고려해 nonce 또는 hash 방식으로 검증한다. 민감 API 응답에도 명시적인 Cache-Control: no-store를 적용한다.

### P2-3. 프록시 뒤에서 IP별 요청 제한이 공유될 가능성

- `app.module.ts`는 기본 ThrottlerGuard 60회/분을 사용한다. 설치된 guard는 `req.ip`를 기준으로 한다. Express `trust proxy` 설정은 소스에 없다.
- Traefik 뒤에서는 클라이언트 IP 대신 프록시 주소를 기준으로 집계할 수 있어 한 사용자의 요청이 다른 사용자까지 제한할 수 있다.
- 판정: 코드·토폴로지 기반 위험. 운영에 60회 이상 요청을 보내 차단을 유도하지 않았다.
- 조치: 신뢰할 ingress 홉/네트워크를 명시하고 서로 다른 클라이언트 IP 분리와 위조 X-Forwarded-For 거부를 함께 테스트한다. 무조건 `trust proxy=true`로 바꾸지 않는다.

### P2-4. 사용자 앱 검사 대상이 운영 digest와 연결되지 않음

- `apps/backend/src/deploy/scan.service.ts:144`는 `ghcr.io/...:latest`를 검사한다. 운영 Deployment는 digest로 고정되어 있다.
- 따라서 배포 실패·지연·tag 이동 시 스캔 결과와 실제 실행 중인 앱이 달라질 수 있다. 현재 두 digest가 불일치한다고 확정한 것은 아니다.
- 조치: Deployment/Pod에서 실제 digest를 읽어 검사하고 digest·검사 DB 시각을 저장한다. 화면에 현재 배포와 일치 여부·오래된 결과를 표시한다.
- 운영 플랫폼 스캔은 배포 이미지 태그를 조회하지만 결과를 합계만 audit_log에 저장한다. 원인 추적을 위해 공지별 상세 근거와 digest도 보존하는 편이 좋다.

### P2-5. 사용자 GitHub 토큰의 애플리케이션 수준 평문 보관

- `users.repository.ts:511`은 access/refresh token을 SQLite TEXT 열에 그대로 저장한다. 이번 점검에서는 실제 토큰 값을 읽지 않았다.
- DB 파일/백업 읽기 권한이 노출될 경우 토큰이 함께 노출될 수 있다. OCI 디스크 암호화와 별개인 애플리케이션 수준 보호 문제다.
- 조치: 데이터와 분리된 키로 인증된 암호화 적용, 키 교체와 토큰 폐기 경로 설계. backend는 사용자 namespace Secret 관리 권한도 가지므로 침해 영향 범위를 줄이는 작업과 함께 처리한다.

## 기존 운영 이미지 스캔 기록

2026-10-26 12:00~12:01 KST의 기존 Trivy 기록이다. 이번 턴의 새 전체 이미지 스캔으로 오인하면 안 된다. 건수는 npm 패키지 항목 수와 단위가 다르다.

| 대상 | Critical | High | Medium |
|---|---:|---:|---:|
| swkoo-backend | 1 | 4 | 3 |
| swkoo-frontend | 3 | 3 | 5 |
| SprintFlow | 3 | 10 | 16 |
| PocketPlan | 5 | 81 | 106 |
| hizieun/portfolio | 3 | 10 | 14 |
| sw-koo/nextjs-sample | 6 | 13 | 20 |

사용자 앱은 현황만 읽었다. 소스 수정·버전 강제 변경·PR 생성은 하지 않았다. 9월의 npm 취약점 0건은 당시의 입력과 공지 DB에 대한 결과이며 10월 상태를 보증하지 않는다.

## 통과한 검사와 확인된 방어

- 비로그인 요청: `/api/auth/me`, `/api/deploy/current`, 환경변수 조회, 계정 export, 스캔 조회, 관리자 사용자 조회 모두 401.
- 타 서브도메인의 변경 요청: 403. 서명 없는 GitHub webhook: 401.
- OAuth state, controller 권한, source setup, security patch 등 회귀 테스트 10 suites / 90 tests 통과.
- 현재 Git 추적 파일 274개의 고신뢰 패턴 검사에서 실제 형태의 GitHub token/private key/AWS access-key 후보 0개. 전체 Git 이력·고엔트로피·모든 공급자 secret scanner를 대체하지 않는다.
- 사용자 namespace restricted 정책, 서비스 계정 자동 마운트 차단, 사설망·metadata egress 차단 정책 확인. 이번에 새 네트워크 침투 재현은 하지 않았다.
- source setup/security patch는 범위가 제한된 GitHub 토큰, 변경안 동의, 기준 commit 재검사, 초안 PR 흐름을 사용한다. 모든 GitHub helper가 기본적으로 repo-scoped인 것은 아니므로 추가 최소권한화 여지가 있다.
- 엑셀 데모는 브라우저에서 파일을 처리하고 결과를 textContent로 출력한다. 별도 포함된 SheetJS 0.20.3은 npm audit 대상 밖이다. 해당 번들의 전체 최신 공지 검증과 압축폭탄 시험은 미실시다.

## 한계 및 권장 순서

실제 로그인 계정 2개를 사용하는 교차 사용자 침투 테스트, 전체 Git 이력 secret 검사, 모든 인프라 이미지의 새 CVE 스캔, OCI IAM/방화벽 전수 감사, 외부 인증된 침투 테스트는 포함하지 않았다. 발견 사항이 없다고 인증하는 보고서가 아니다.

1. body-parser 및 Next.js/운영 의존성 패치 → 테스트 → 새 운영 이미지 검사.
2. 스캔 Job 권한 격리 및 플랫폼 Pod 보안 설정.
3. cert-manager/K3s 등 지원 버전으로 단계적 전환 계획.
4. cookie/session, 보안 헤더, 요청 제한, digest 기반 스캔, 토큰 보관 개선.
5. 전용 테스트 계정으로 교차 사용자·로그아웃 후 토큰·cookie 격리 검증.

이 문서는 점검 결과만 기록한다. 코드 수정, 배포, 신규 백업 도입은 수행하지 않았다.
