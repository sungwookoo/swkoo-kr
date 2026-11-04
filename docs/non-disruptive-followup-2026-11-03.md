# 저장공간 관측 및 무중단 후속 점검 — 2026-11-03

사용자 앱 소스·배포 저장소는 변경하지 않는다. 재부팅 검증은 이번 작업에서 하지 않으며,
일반 계정 추가 검증도 운영자 요청으로 보류한다.

## 저장 용량과 예약 실행 확인

11월 3일 수동 정리·재실행은 검증을 마쳤다. 최초 자연 예약 실행은 11월 4일
05:11:55 KST 예정으로, 이번 점검 시각에는 아직 도래하지 않았다.
OCI layer bytes도 아직 삭제 전 데이터가 포함된 값으로 보고된다.
예약 timer enabled/active와 실패·지연·예산 경고의 표시를 확인했으며,
자연 예약 실행 성공 및 과금 용량 최종 반영은 미완료로 유지한다.
[보관 정책과 실제 삭제 결과](./oci-storage-retention.md)를 따른다.

## 앱별 저장공간 표시

호스트가 강제 quota의 실제 할당 bytes·inode를 읽고 Kubernetes의 고정 ConfigMap에
집계값만 게시한다. backend는 기존 로그인·현재 앱 검사 후 해당 namespace·claim·Pod UID의
측정값만 반환한다. 다른 앱 원본 파일·로그·DB를 조회하지 않는다.
실제 1GiB·65,536 상한과 남은 양, 80% 접근 및 한도 도달 경고를 표시한다.
누락·90초 초과·형식 오류·UID 불일치는 0이 아닌 측정 대기다.
[접근 범위와 운영 절차](./app-diagnostics.md)를 참조한다.

## 의존성 및 버전 예외 재검토

[의존성 검토 기록](./dependency-review-2026-11-03.md)을 따른다. 해당 문서와 운영 의존성
audit gate, 저장 한도 관련 문구 정정은 PR #108로 먼저 병합했다. 앱 파일 변경이 없어
main 파이프라인에서 앱 빌드·이미지 변경·배포는 모두 생략됐고 기존 앱 버전은 유지됐다.

## 구현 및 실제 측정 검증

- backend 434개·frontend 103개·Playwright 32개와 양쪽 빌드 통과.
- 호스트 collector 경계 검사 2개와 Linux quota 회귀 8개 통과.
- 호스트 collector 및 timer는 앱 중단 없이 설치했다. 실제 SprintFlow는
  278,528 bytes·inode 3개이며 kernel quota와 게시된 집계값이 일치했다.
- 실행 중인 backend의 별도 Node 프로세스에서 새 진단 클래스로 실제 Kubernetes API를
  조회해 같은 used/remaining/limit 값을 확인했다. 배포 등록 조회만 본인 앱으로 고정한
  통합 검사이며, 새 HTTP API 또는 실제 GitHub 로그인 검증으로 확대하지 않는다.
- backend ServiceAccount의 집계 ConfigMap get은 허용되고 다른 이름 get·목록 조회는 거부됐다.
- 기존 서버 프로세스·사용자 앱·PVC는 재시작하거나 변경하지 않았다. 운영 HTTP API와
  새 화면 기능의 활성화는 아래 배포 제약에 따라 대기한다.

## 배포 제약

현재 backend는 단일 프로세스 내 작업 제외와 SQLite에 맞춰 Recreate를 사용한다.
기존 배포 파일에는 약 5초 API 중단이 명시되어 있다. 따라서 backend 변경을
무중단이라고 안내하거나 replica를 임의로 늘리지 않는다. 저장공간 표시의 운영 활성화는
이 영향이 허용된 배포에서 수행한다. 호스트 collector 설치·문서·정책 검사는 앱 중단이 없다.
