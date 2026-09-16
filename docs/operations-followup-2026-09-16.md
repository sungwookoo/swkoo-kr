# 운영 후속 점검 — 2026-09-16

## 사용자 앱 보안

현재 실행 digest를 Trivy 0.74.0으로 검사했다. OS와 언어 패키지의 합계이며, 같은 CVE가 여러 패키지에 포함되면 여러 건으로 집계된다.

| 앱 | Critical | High | Medium | 조치 |
|---|---:|---:|---:|---|
| SprintFlow | 0 | 0 | 0 | 소스 56e07fc 빌드·배포 및 재검사 완료 |
| PocketPlan | 3 | 67 | 91 | 소스 쓰기 권한 없음. 수정 패치 준비 |
| hizieun/portfolio | 2 | 31 | 22 | 소스 쓰기 권한 없음. 수정 패치 준비 |
| sw-koo/nextjs-sample | 5 | 37 | 50 | 소스 쓰기 권한 없음. 수정 패치 준비 |

세 앱의 수정안은 로컬 `C:/sungwoo/resource-rollout/security-patches-20260916/`에 보관한다. 각 수정안의 npm audit 0건과 프로덕션 빌드를 확인했다. PocketPlan은 Prisma 생성기와 Client 버전을 7.10.0으로 맞추고 테스트도 통과했다. PostgreSQL 서비스 연결·실제 사용자 데이터 동작은 검증하지 않았다. 소유자 적용·ARM64 이미지 빌드·운영 재검사는 남아 있다.

SprintFlow는 Next.js 16.3.5, Prisma 6 유지, deepmerge-ts 8 override, npm 11.19.1로 변경했다. SQLite 보존 회귀 테스트 2개와 빌드를 통과했다. 자동 DB 백업 도입은 보류 상태다.

## 플랫폼 이미지와 스캐너

업데이트 전 플랫폼 이미지에서 OpenSSL 및 기본 npm 도구의 취약점을 확인했다. 실행에 불필요한 npm/Yarn은 플랫폼 최종 이미지에서 제거하고 Alpine 패키지를 갱신했다. 사용자 앱 생성 Dockerfile에는 npm 수정 버전과 OS 갱신을 반영한다.

스캔 결과를 읽기 전에 Job을 삭제하던 순서를 바로잡았다. OCIR 검사에만 기존 ocir-credentials를 읽기 전용으로 연결하며, 사용자 GHCR 검사에는 연결하지 않는다. 스캐너의 서비스계정 토큰 자동 마운트를 끄고 메모리 제한을 유지한다.

## 로그인

사용자 확인: 피드백 당사자는 비로그인 상태였으며 로그인 후 정상 동작했다. 세션 소실 장애로 판정하지 않는다. 기존 401 로그인 안내·원래 관리 화면 복귀 수정으로 해결됐다.

## 성능 검증 범위

동시 부하 테스트는 자동 승인 검토에서 정책 차단되어 실행하지 않았다. 최대 사용자 수 검증은 미완료다.

낮은 빈도로 URL당 1회 순차 조회한 결과: 홈 359ms, SprintFlow 188ms, PocketPlan 140ms, portfolio 250ms, hello 1282ms, 모두 HTTP 200. 이는 동시 접속 성능·p95·SLA의 근거가 아니다.

관측된 서버 사용량: CPU 약 4%, 메모리 42~43%; 사용자 앱 메모리 약 69~83MiB. 사용자 6명 수용을 보장하지 않는다.

## PR 병합 보호

규칙 ID 23527021: main에 PR 필수, check (backend)·check (frontend)·smoke 성공 및 최신 base 필요. 강제 푸시·삭제 차단, bypass 없음. 1인 운영이므로 별도 승인 인원은 0명이다.

PR #28에서 의도적으로 실패시킨 backend 검사로 실제 merge 거부를 확인했고, 실패 코드를 제거한 뒤 모든 검사가 성공하자 정상 병합했다.

이미지 태그 갱신도 자동 PR로 전환했다. GITHUB_TOKEN의 PR workflow 실행 제약을 피하기 위해 검증 workflow를 명시적으로 dispatch하고, 성공 후 일반 merge를 요청한다. 관리자 우회는 사용하지 않는다. update-manifests 작업에 한해 contents/pull-requests/actions 쓰기 권한이 필요하다.

## Terraform

terraform-k3s 2fdd77c: cert-manager v1.12.17 정렬, kubeconfig 경로 입력 추가, 기존 Argo CD·Portainer 보존 및 cert-manager 삭제형 자동 정리 제거.

운영 kubeconfig의 만료된 클라이언트 인증을 현재 k3s 설정으로 갱신했다. 계획을 검토한 후 bootstrap null_resource 4개만 갱신했으며 실제 서비스 재설치는 건너뛰었다. 적용 후 terraform plan -detailed-exitcode 0(변경 없음), Argo CD 기존 Pod 유지, 모든 Certificate Ready=True 확인.
