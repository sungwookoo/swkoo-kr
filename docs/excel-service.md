# 엑셀 취합·검증 서비스 소개 및 데모

- 소개서: https://swkoo.kr/excel-service
- 데모: https://swkoo.kr/excel-service/demo
- 기존 메뉴와 사이트맵에는 연결하지 않는 공개 직접 접속 페이지. 접근 인증은 없다.
- HTML robots 메타와 X-Robots-Tag 헤더로 검색 색인 제외를 요청한다.
- 정적 파일은 apps/frontend/public/excel-service에서 제공한다. CSS/JS는 절대 경로를 사용한다.
- SheetJS CE 0.20.3을 라이선스와 함께 자체 제공한다. 고객 파일은 브라우저 메모리에서만 읽으며 서버에 업로드·저장하지 않는다.
- 가상 자료 12행 중 확인 필요 6행, 통과 6행. 실제 파일 입력과 결과 XLSX 다운로드를 지원한다.
- 지원 범위: 동일 헤더 6개, 첫 시트, 최대 5개 파일/각 2MB/전체 5000행. 날짜는 YYYY-MM-DD 텍스트, 금액은 원 단위 정수. 수식 셀은 미지원.
- 오류 행을 임의로 수정·삭제하지 않는다. 중복된 모든 주문번호 행을 표시한다.

## 배포 확인

기존 PR 검증 → 이미지 빌드 → 이미지 manifest PR → Argo CD 자동 동기화 절차를 따른다.
소개서·데모·CSS·JS의 HTTPS 응답, noindex 헤더, 샘플 결과 및 XLSX 내보내기를 확인한다.
