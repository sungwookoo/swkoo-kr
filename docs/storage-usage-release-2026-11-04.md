# 저장공간 표시 운영 배포 및 OCI 확인 — 2026-11-04

사용자가 짧은 API 중단을 허용한 후 [기능 PR #107](https://github.com/sungwookoo/swkoo-kr/pull/107)과
[이미지 PR #109](https://github.com/sungwookoo/swkoo-kr/pull/109)를 반영했다.
서버 재부팅·다른 사용자 저장소 변경·사용자 앱 재배포는 하지 않았다.

## 배포와 기능

- backend·frontend 실행 revision: `6839b68be6d6401a65463775d00c6a623b705500`.
- [빌드·배포 workflow 41761396480](https://github.com/sungwookoo/swkoo-kr/actions/runs/41761396480)
  성공. 필수 검사·이미지 게시·매니페스트 병합·실제 공개 HTTPS 버전 및 접근 거부 검사를 포함한다.
- 본인 관리 화면에 실제 할당 bytes·남은 공간·inode 수·상한을 표시한다.
  80% 및 한도 도달 경고, 오래되거나 누락된 값의 측정 대기, 플랫폼 볼륨 미연결 안내를 구분한다.
- 호스트 측정기는 읽기만 수행하며 앱 파일 내용·로그를 수집하지 않는다.
  실제 SprintFlow는 278,528 bytes·inode 3개, 상한 1GiB·65,536개였다.

## 테스트와 접근 경계

- backend 434개·frontend 103개·Playwright 32개 및 양쪽 빌드, 운영 npm audit 0건 확인.
- 새 backend 이미지를 별도 제한 Pod에 미리 받아 native SQLite의 메모리 DB 무결성 검사를
  통과시켰고, 해당 임시 Pod는 삭제했다. 사용자 PVC는 시험에 사용하지 않았다.
- 운영 공개 HTTPS API를 서버 내부의 60초 검증 토큰·90초 임시 세션으로 검사했다.
  키·토큰은 출력·파일에 저장하지 않았고 검증용 세션 한 건은 finally에서 제거했다.
  실제 GitHub OAuth 로그인 검증으로 확대하지 않는다.
- 본인 `GET /api/deploy/diagnostics/sungwookoo/SprintFlow`는 200·storage ready·no-store,
  다른 계정 경로는 403, 비로그인은 401이었다. logs는 null이었다.
- 반환값: used 278,528 / limit 1,073,741,824 / remaining 1,073,463,296 bytes,
  inode 3 / limit 65,536 / remaining 65,533. 실제 kernel quota와 집계값도 일치했다.
- 기존 Chrome 계정으로 소유자가 다른 관리 화면의 접근 거부를 확인했다.
  해당 브라우저는 소유자 세션이 아니므로 실제 소유자 화면 육안 검증으로 주장하지 않는다.
  화면의 수치·경고·측정 대기는 모의 API Playwright 검사로 확인했다.

## 실제 중단 관측

외부 PC에서 API·메인·SprintFlow에 각각 424회 요청했다. TLS 검증을 유지했다.
시간은 아래 KST이며 약 1초 간격 검사와 네트워크 응답 시간을 포함한 관측값이다.

| 대상 | 결과 |
|---|---|
| 플랫폼 API | 503 39회. 최초 11:40:22.006 → 최초 정상 복구 11:41:14.385, 관측 구간 약 52.38초 |
| 메인 화면 | 3초 요청 제한의 timeout 1회, 다음 요청은 약 4.11초 후 정상. 연속 HTTP 장애 시간으로 해석하지 않는다 |
| SprintFlow | 424회 오류 0 |
| 기존 사용자 Pod·PV | Pod 3개 UID와 PV 6개 UID 모두 유지 |
| Argo Application | 10개 모두 Synced/Healthy |

기존 약 5초 안내는 이번 실제 결과보다 짧았다. Recreate의 종료 대기·새 Pod 준비 확인을
포함한 운영 관측값으로 정정했다. 인스턴스 재부팅은 없었으며 API 무중단 배포를 주장하지 않는다.

## OCI 정기 정리와 용량

- 첫 자연 정기 실행: **11월 4일 05:10:56 KST 시작, 05:11:15 KST 완료**.
  이미지 항목 6개와 오래된 플랫폼 DB 백업 1개를 추가 정리했다.
- 보존 manifest 86개를 재검증했고 플랫폼 DB 백업은 14개·843,886,592 bytes로 유지됐다.
- 상태 파일 `success=true`, `budgetOk=false`. 서비스 종료 상태 1은 정리 실패가 아니라
  OCI 보고량이 8GB 안전 예산을 초과해 발생시킨 경고다. 이 경고는 기존 보고에 유지된다.
- 11월 4일 11:43 KST 조회: backend 4,155,028,851 + frontend 4,975,562,964 +
  backup 843,886,592 = **9,974,478,407 bytes**. 새 배포 이미지도 포함한 보고값이다.
  이전 삭제분의 물리 용량 회수는 아직 반영 대기다. 삭제 후 최대 48시간이라는
  [Oracle 안내](https://docs.oracle.com/en-us/iaas/Content/Registry/Tasks/registrydeletingimages.htm)를 따른다.
- 11월 4일 11:34 KST 비용 API의 11월 누적 집계는 **SGD 0**이었다.
  집계 이후 사용량·최종 월 청구액이 항상 0이라는 보장은 아니다.

실제 재부팅 복구 시험과 추가 일반 계정 검증은 보류 상태다.
