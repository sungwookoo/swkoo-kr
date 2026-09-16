# 운영 후속 점검 — 2026-09-16

## 사용자 앱 보안

현재 실행 digest를 Trivy 0.74.0으로 검사했다. OS와 언어 패키지의 합계이며, 같은 CVE가 여러 패키지에 포함되면 여러 건으로 집계된다.

| 앱 | Critical | High | Medium | 조치 |
|---|---:|---:|---:|---|
| SprintFlow | 0 | 0 | 0 | 소스 56e07fc 빌드·배포 및 재검사 완료 |
| PocketPlan | 3 | 67 | 91 | PostgreSQL 연결 설정 확인 필요. 보안 PR #1 초안 유지 |
| hizieun/portfolio | 0 | 0 | 0 | PR #1 병합, ARM64 빌드·배포·재검사 완료 |
| sw-koo/nextjs-sample | 0 | 0 | 0 | PR #1 병합, ARM64 빌드·배포·재검사 완료 |

세 앱의 수정안은 로컬 `C:/sungwoo/resource-rollout/security-patches-20260916/`에 보관한다. 각 수정안의 npm audit 0건과 프로덕션 빌드를 확인했다. PocketPlan은 Prisma 생성기와 Client 버전을 7.10.0으로 맞추고 테스트도 통과했다. PostgreSQL 서비스 연결·실제 사용자 데이터 동작은 검증하지 않았다. 기존 GitHub App의 저장소별 쓰기 권한으로 [portfolio PR](https://github.com/hizieun/portfolio/pull/1)과 [sample PR](https://github.com/sw-koo/nextjs-sample/pull/1)을 적용했다. [PocketPlan PR](https://github.com/hatbann/PocketPlan/pull/1)은 초안이다. 최신 소스는 PostgreSQL을 요구하지만 운영 DB 환경변수 Secret이 없고 외부 DB 연결 지원은 보류되어 있으므로 병합하지 않았다.

SprintFlow는 Next.js 16.3.5, Prisma 6 유지, deepmerge-ts 8 override, npm 11.19.1로 변경했다. SQLite 보존 회귀 테스트 2개와 빌드를 통과했다. 자동 DB 백업 도입은 보류 상태다.

## 플랫폼 이미지와 스캐너

업데이트 전 플랫폼 이미지에서 OpenSSL 및 기본 npm 도구의 취약점을 확인했다. 실행에 불필요한 npm/Yarn은 플랫폼 최종 이미지에서 제거하고 Alpine 패키지를 갱신했다. 사용자 앱 생성 Dockerfile에는 npm 수정 버전과 OS 갱신을 반영한다.

스캔 결과를 읽기 전에 Job을 삭제하던 순서를 바로잡았다. OCIR 검사에만 기존 ocir-credentials를 읽기 전용으로 연결하며, 사용자 GHCR 검사에는 연결하지 않는다. 스캐너의 서비스계정 토큰 자동 마운트를 끄고 메모리 제한을 유지한다.

플랫폼 이미지 `35cd5bdcc73936aaf3a8c0a627184ac60124d634` 두 개를 실제 제한된 Kubernetes 스캔 작업으로 검사해 모든 등급 0건을 확인했다. 기존 OCIR 인증으로 비공개 이미지 조회가 성공했고, 스캐너 자원 상한 500m/512Mi 안에서 작업이 완료됐다. 한 차례 레지스트리 연결 실패는 결과에서 제외하고 재시도 성공을 확인했다.

## 로그인

사용자 확인: 피드백 당사자는 비로그인 상태였으며 로그인 후 정상 동작했다. 세션 소실 장애로 판정하지 않는다. 기존 401 로그인 안내·원래 관리 화면 복귀 수정으로 해결됐다.

## 성능 검증 범위

동시 부하 테스트는 자동 승인 검토에서 정책 차단되어 실행하지 않았다. 최대 사용자 수 검증은 미완료다.

낮은 빈도로 URL당 1회 순차 조회한 결과: 홈 359ms, SprintFlow 188ms, PocketPlan 140ms, portfolio 250ms, hello 1282ms, 모두 HTTP 200. 이는 동시 접속 성능·p95·SLA의 근거가 아니다.

관측된 서버 사용량: CPU 약 4%, 메모리 42~43%; 사용자 앱 메모리 약 69~83MiB. 사용자 6명 수용을 보장하지 않는다.

## PR 병합 보호

규칙 ID 23527021: main에 PR 필수, check (backend)·check (frontend)·smoke 성공 및 최신 base 필요. 강제 푸시·삭제 차단, bypass 없음. 1인 운영이므로 별도 승인 인원은 0명이다.

PR #28에서 의도적으로 실패시킨 backend 검사로 실제 merge 거부를 확인했고, 실패 코드를 제거한 뒤 모든 검사가 성공하자 정상 병합했다.

이미지 태그 갱신도 자동 PR로 전환했다. GITHUB_TOKEN의 PR workflow 실행 제약을 피하기 위해 검증 workflow를 명시적으로 dispatch하고, 성공 후 일반 merge를 요청한다. PR merge commit 검사가 필요하므로 매니페스트 전용 PR에도 pull_request 검사를 실행한다. 자동화는 자신이 생성한 브랜치와 동일한 SHA의 두 검증 workflow에 한해서 실행 대기 승인을 요청한다. 관리자 우회는 사용하지 않는다. update-manifests 작업에 한해 contents/pull-requests/actions 쓰기 권한이 필요하다.

자동 배포 PR #29의 필수 검사 성공 및 자동 병합을 확인했다. 첫 실행에서는 GitHub 봇 PR 실행 승인을 운영자가 수행했으며, dispatch 검사만으로 병합 정책이 충족되지 않는 것을 확인해 PR merge commit 검사도 유지했다.

## Terraform

terraform-k3s 2fdd77c: cert-manager v1.12.17 정렬, kubeconfig 경로 입력 추가, 기존 Argo CD·Portainer 보존 및 cert-manager 삭제형 자동 정리 제거.

운영 kubeconfig의 만료된 클라이언트 인증을 현재 k3s 설정으로 갱신했다. 계획을 검토한 후 bootstrap null_resource 4개만 갱신했으며 실제 서비스 재설치는 건너뛰었다. 적용 후 terraform plan -detailed-exitcode 0(변경 없음), Argo CD 기존 Pod 유지, 모든 Certificate Ready=True 확인.
