# 의존성 및 운영 정책 재점검 — 2026-11-03

이번 변경은 문서와 CI 검사만 반영한다. 앱 이미지·서버 재시작·사용자 저장소 수정은 없다.

## npm 의존성

양쪽 `npm audit --omit=dev`는 0건이며, PR 검증과 이미지 게시 전 단계에
같은 검사를 추가했다. audit 실패 시 이미지 게시로 진행하지 않는다.

전체 개발 도구 포함 조회에서는 backend Low 4·Moderate 27, frontend Moderate 15
영향 패키지가 표시된다. 영향 패키지 수는 개별 취약점 수가 아니다. 직접 공지는:

- [deepmerge GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4):
  Jest 설정 경로의 Low. 공식 공지 patched version None, npm 최신 4.3.1로 재확인했다.
- [minimatch GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249):
  10월 30일 갱신된 Moderate. 수정판은 11.0.1이며, 테스트·lint 도구의 하위 3/9/10 계열에
  영향을 표시한다. 운영 의존성에는 포함되지 않는다. 최신 ESLint도 10 계열을 요구한다.

npm이 권고하는 Jest 25·ESLint 4·Next 설정 12 강제 다운그레이드는 적용하지 않는다.
minimatch 3의 함수형 CommonJS API와 11의 객체 export도 호환되지 않아 전역 override를
하지 않는다. 현재 개발 도구에는 외부 사용자가 제공하는 glob·Jest/lint 설정을 입력하지 않는다.
호환되는 상위 수정판 적용은 남은 작업이며, 이 기록은 취약점 해결 완료를 뜻하지 않는다.

## Node 고정

Node 24.18.1은 [upstream #65446](https://github.com/nodejs/node/issues/65446)의
native ObjectWrap cleanup 문제에 대한 기존 예외다. 재조회 시 open 상태다.
고정 해제에는 별도 native 재현 시험, ARM64 SQLite 복원·종료 검증이 필요하다.
npm audit는 Node 자체·OS·미공개 취약점의 부재를 보장하지 않는다.

## 남은 실제 검증

- OCI 최초 자연 예약 정리는 11월 4일 05:11:55 KST 예정이므로 아직 미검증이다.
  수동 정리 및 재실행은 검증했지만 물리 용량 반영과 예산 경고 해제는 대기한다.
- 저장공간 사용량 표시는 PR #107에서 구현·검증 중이다. 호스트 collector는 앱 중단 없이
  설치했으며 실제 quota bytes·inode와 집계값 일치를 확인했다. backend 운영 활성화는
  기존 Recreate 방식의 짧은 API 중단 허용 여부가 필요하므로 별도로 판단한다.
- 인스턴스 실제 재부팅은 이번 무중단 작업에서 제외한다.
- 서로 다른 신규 일반 계정 2개의 검증은 운영자 요청으로 보류했다.
