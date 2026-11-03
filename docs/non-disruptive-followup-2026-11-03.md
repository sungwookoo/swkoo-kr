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

2026-11-03 npm 조회 기준:

- 양쪽 `npm audit --omit=dev`: 0건. PR 검증과 이미지 게시 전 검사에 같은 명령을 추가했다.
- backend 전체: Low 4·Moderate 27 영향 패키지, frontend 전체: Moderate 15 영향 패키지.
  영향 패키지 수는 서로 다른 취약점 수가 아니다. 직접 공지는 아래 두 가지다.
- [deepmerge GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4):
  Jest 설정 경로의 Low. 현재 조회한 공식 공지는 patched version None이며 npm 최신 4.3.1이다.
- [minimatch GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249):
  10월 30일 갱신된 Moderate 공지. 수정판은 11.0.1이고 기존 테스트·lint 도구의
  하위 의존성 3/9/10 계열에 영향을 표시한다. 운영 의존성에는 포함되지 않는다.
  npm의 Jest 25·ESLint 4·Next 설정 12 강제 다운그레이드는 적용하지 않는다.
  minimatch 3의 함수형 CommonJS API와 11의 객체 export는 호환되지 않으므로
  전역 override도 적용하지 않는다. 개발 도구에 외부 이용자의 glob·Jest/lint 설정을
  입력하지 않는 현재 경계를 유지한다. 호환되는 상위 수정판 검토는 남은 작업이다.
- Node 24.18.1 고정은 [upstream #65446](https://github.com/nodejs/node/issues/65446)의
  native ObjectWrap cleanup 문제에 대한 기존 예외다. 재조회 시 이슈는 open이다.
  새 버전 번호만으로 해결됐다고 간주하거나 운영 native addon을 교체하지 않는다.
  해당 고정 해제는 별도 native 재현 시험·ARM64 DB 복원·종료 검사를 거쳐야 한다.

이 검토는 개발 의존성 취약점 해결 완료나 런타임 전체의 취약점 부재를 뜻하지 않는다.
npm 검사는 OS·Node 자체·미공개 취약점을 검사하지 않는다.

## 배포 제약

현재 backend는 단일 프로세스 내 작업 제외와 SQLite에 맞춰 Recreate를 사용한다.
기존 배포 파일에는 약 5초 API 중단이 명시되어 있다. 따라서 backend 변경을
무중단이라고 안내하거나 replica를 임의로 늘리지 않는다. 저장공간 표시의 운영 활성화는
이 영향이 허용된 배포에서 수행한다. 호스트 collector 설치·문서·정책 검사는 앱 중단이 없다.
