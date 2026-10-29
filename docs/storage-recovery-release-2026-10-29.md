# 저장공간·복구·운영 확인

기준일: 2026-10-29. 플랫폼 저장소만 변경하며 다른 이용자의 소스·배포 저장소를 수정하지 않는다. 사용자 앱 자동 백업과 유료 인프라는 도입하지 않는다.

## 1. 디스크 보호: 적용 가능한 보완과 남은 강제 제한

실제 파일시스템을 확인한 결과 운영체제 `/`는 45GiB, 데이터 `/data`는 별도 147GiB ext4 볼륨이었다. K3s 저장 경로는 `/data/k3s-storage`의 bind mount다. 조사 시 여유 공간은 각각 약 12GiB·130GiB였다. 기존 수용 검사는 PVC 예산도 운영체제 여유 공간에서 공제했다.

신규 배포 수용 검사에서 데이터 디스크와 루트 디스크를 별도로 검사한다. 데이터 디스크는 기존 PVC 요청량과 미관측 예약·신규 앱당 1GiB를 공제한 후 5GiB 이상, 루트 디스크는 관측된 사용자 컨테이너 임시 저장공간 상한 합과 미관측 예약·신규 앱당 교체 여유 포함 2GiB를 공제한 후 5GiB 이상을 요구한다. 두 디스크의 가용 inode 비율도 10% 이상이어야 한다. 누락·90초 초과 지표·모호한 복수 응답은 신규 등록을 보류한다. 기존 앱 복구 재배포는 유지한다.

새로 렌더링하는 앱·Prisma 초기화 컨테이너는 임시 저장공간 요청 128MiB·상한 1GiB, namespace는 교체용 2GiB 상한을 적용한다. 이는 컨테이너 쓰기 영역·로그의 kubelet 감시 및 축출 기준이다. 영구 PVC에는 적용되지 않으며 즉시 쓰기를 거절하는 파일시스템 quota도 아니다. 기존 타 이용자 배포 manifest는 수정하지 않았으므로 이 임시 제한은 소급 적용했다고 주장하지 않는다. 임시 저장공간을 소모한 앱은 재생성될 수 있으며, 고속 쓰기의 감시 지연 위험도 남는다.

운영체제·데이터 디스크 5GiB 미만, inode 10% 미만 상태를 기존 Prometheus에서 확인하는 경고 규칙을 추가한다. 사용자 파일 자동 삭제나 자동 용량 증설은 없다.

**앱별 영구 저장공간 1GiB 강제 제한은 미완료다.** local-path provisioner는 PVC 용량 상한을 강제하지 않는다. 현재 데이터 파일시스템에는 project/quota 기능이 없다. 운영 데이터와 무관한 임시 64MiB loop 파일시스템으로 시험했으며, 설치된 도구는 마운트 중 quota 기능 활성화를 거부했다: `The quota feature may only be changed when the filesystem is unmounted.` 시험 볼륨·파일은 모두 제거했다.

실제 데이터 디스크에는 플랫폼 DB·모니터링 등도 연결되어 있다. 강제 제한의 다음 단계는 별도 점검 시간에 모든 사용 mount를 해제하고 ext4 project quota 활성화, PV별 project ID 및 프로비저너 생성·삭제 처리를 연동한 뒤 용량·inode 초과·재시작·삭제·타 앱 격리를 검증하는 것이다. 기존 데이터의 전환·복구 절차까지 준비한 후 진행해야 하며 이번 온라인 설정 보완 범위에는 포함하지 않는다. 사용자 화면·시작 안내·약관은 현재 제한의 실제 범위를 명시한다.

## 2. 부분 배포·예약 복구

관리자 화면 하단의 **배포 예약 복구**에서 목록 → 상태 확인 → 미사용 예약 해제 순서로 사용한다. API는 `GET /api/admin/deployment-recovery`, `GET /api/admin/deployment-recovery/:login`, `POST /api/admin/deployment-recovery/:login/release`다. 로그인과 환경 설정의 관리자 계정 검사를 모두 통과해야 하며 응답은 no-store다.

서버는 원본 등록 파일 존재 여부(잘못된 형식도 존재로 처리), 올바른 Argo 프로젝트의 Application, namespace, Released/Failed를 포함한 관련 PV를 직접 검사한다. 네 항목 모두 없고 같은 예약이 남아 있을 때만 해제할 수 있다. 조회 결과 digest를 확인 요청에 보내며 실행 시 다시 검사한다. 등록·앱 삭제·계정 삭제와 같은 공유 잠금을 사용하고 요청 연결이 끊겨도 처리 완료까지 유지한다. DB에서는 예약 생성 시각까지 일치하는 한 건의 삭제와 감사 기록을 한 트랜잭션으로 처리한다.

등록/배포가 남아 있으면 예약을 유지하고 기존 앱 화면의 재시도·제거 절차를 따른다. Git/Argo/Kubernetes 오류와 접근 거부는 부재로 간주하지 않는다. 계정 삭제로 익명화된 예약은 별도 감사 검토 대상으로 남긴다. PV·namespace·저장소·사용자 파일을 이 도구로 삭제하지 않는다. 단일 backend replica + Recreate 전제를 유지한다.

운영 적용에는 `deploy/argocd/swkoo-backend-recovery-rbac.yaml`의 namespace get·PV list 읽기 권한이 필요하다. 쓰기·exec·새 secret 읽기 권한은 추가하지 않는다.

## 3. 배포 후 자동 확인

이미지 빌드 시 소스 commit을 넣고 backend health 및 frontend `/version.json`에서 유효한 commit만 반환한다. 인증 정보나 내부 설정은 반환하지 않는다. 이미지 manifest PR의 검사·병합 뒤 기존 publish workflow에서 `scripts/verify-production-release.py`를 실행한다.

새로 빌드한 서비스의 실제 공개 응답 revision이 해당 commit에 도달해야 성공한다. 양쪽 revision 형식·캐시 방지·backend health, 메인/배포/공지 HTTP 200, 비로그인 배포·관리자 API HTTP 401을 확인한다. TLS 인증 검증을 켜고 redirect는 허용하지 않는다. 15분 동안 기다려도 실패하면 workflow를 실패시키고 JSON 결과를 artifact로 남긴다. 자동 롤백·재로그인·유료 외부 모니터·새 클러스터 자격증명은 추가하지 않는다. 인증된 실제 신규 배포 전체 검증을 매번 자동 실행하는 것은 아니다.

## 검증 및 운영 반영

로컬 backend·frontend 테스트 및 빌드, 브라우저 32개, Python 운영 안전성 12개·배포 후 검증 실패 경로/저장 시험 안전성 7개와 클라이언트 과부하 중단 검사를 통과했다. 운영 노드의 격리된 namespace에서 32MiB 임시 저장 한도에 64MiB를 쓴 Pod가 해당 용량 초과 사유로 Evicted, 1MiB만 쓴 비교 Pod는 Running임을 확인했다. 테스트는 1GiB를 직접 채우는 대신 같은 kubelet 제한 기능을 낮은 상한으로 확인한 것이며, 실제 신규 템플릿의 1GiB 상한은 YAML 구조 검사로 확인한다. 시험 namespace는 UID를 확인한 후 제거했다.

최종 운영 반영 결과는 아래에 추가한다. 영구 저장공간의 강제 상한은 위의 미완료 항목으로 유지한다.

참고: [local-path provisioner의 용량 제한 미지원](https://github.com/rancher/local-path-provisioner#cons), [ext4 quota 기능 설정](https://man7.org/linux/man-pages/man8/tune2fs.8.html).
