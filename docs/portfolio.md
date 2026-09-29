# 개발자 포트폴리오

- 공개 주소: `https://swkoo.kr/portfolio`
- 일반 사이트 메뉴에 연결하지 않는 직접 접속 페이지다. 인증으로 제한된 비공개 페이지는 아니다.
- `apps/frontend/public/portfolio/index.html`을 Next.js rewrite로 제공한다. 기존 사이트 레이아웃과 분리된 정적 문서이며 API·로그인을 사용하지 않는다.
- 웹 공개본에는 이메일만 포함한다. 휴대폰 번호가 포함된 제출용 HTML·PDF·ZIP과 내부 근거 문서는 웹 디렉터리에 추가하지 않는다.
- HTML의 robots 메타와 `/portfolio` 하위 경로의 `X-Robots-Tag: noindex, nofollow`로 검색 색인 제외를 요청한다. 사이트 메뉴·사이트맵에는 추가하지 않는다.
- Pretendard 글꼴과 라이선스를 `/portfolio/assets/fonts/`에서 함께 제공한다. `/portfolio`와 `/portfolio/index.html` 모두에서 동작하도록 글꼴은 절대 경로를 사용한다.

## 갱신과 배포 확인

2026-09-29 제출 기준본의 웹 공개 버전을 최초 게시한다. 이후 원고 갱신 시 공개용 연락처와 측정 조건·업무 담당 범위를 유지한다.

일반 프런트엔드 PR 검증·이미지 빌드·GitOps 배포 절차를 따른다. 변경 후 아래를 확인한다.

1. `/portfolio`와 글꼴 URL의 HTTPS 200 응답 및 색인 제외 헤더.
2. HTML에 휴대폰 번호가 없고 포트폴리오 목차가 정상 작동하는지.
3. 홈·기존 메뉴에는 포트폴리오 링크가 추가되지 않았는지.
4. 데스크톱·모바일 표시 및 프런트엔드 rollout 상태.
