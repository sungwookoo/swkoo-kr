# OCI 플랫폼 저장공간 보관 정책

2026-11-03. 사용자 소스·배포 저장소, 사용자 앱 이미지·PVC는 이 작업 대상이 아니다.

## 비용 원인

OCI 비용 API에서 2026년 10월 이미지 저장 SGD 0.023421623328,
플랫폼 DB 백업 저장 SGD 0.013335234514, 합계 SGD 0.036756857842를 확인했다.
서버 A1 CPU·메모리·Block Volume·외부 전송은 해당 기간 비용 0이다.
동일 SKU B91628의 합산 사용량 약 11.04 GB·월이 유료 계정의 월 무료
Standard 저장량 10 GB·월을 초과했다. 카드 청구서 원본 대조는 별도다.

기존 이미지 정리는 예약 실행도 dry-run이었다. 백업은 만료 정책 없이
2026-05-20부터 167개, 5,416,882,176 bytes까지 누적됐다.

## 적용 규칙

- `swkoo/backend`, `swkoo/frontend` 두 OCIR 저장소만 정리한다.
- Kubernetes 전체 namespace에서 Deployment·Pod·ReplicaSet의 현재·init·이전 배포 참조를 수집한다.
  따라서 현재 Pod와 배포 희망 버전이 다르거나 롤백 이미지가 오래돼도 보존한다.
- `latest`, 임의 이름의 버전, 모든 `storage-helper-*`·`storage-provisioner-*`,
  최근 SHA 버전 3개, 생성 48시간 이내 이미지를 추가 보존한다.
  저장공간 helper는 ConfigMap 및 짧은 작업에서도 사용하므로 전체 버전을 보호한다.
- 보존할 OCI index의 자식·하위 index·subject를 재귀적으로 보존한다.
  해당 집합에서 도달할 수 없는 오래된 이미지와 태그 없는 잔여물만 삭제한다.
- 참조·하위 manifest 누락, OCI/Registry 목록 불일치, 계획 도중 배포·버전 변경은 차단한다.
  삭제 직전 버전을 재확인하고 ETag 조건을 사용한다. 모르는 버전을 추정 삭제하지 않는다.
- 플랫폼 백업은 `swkoo-kr-backups`의 정확한 `daily/YYYY-MM-DD/observatory.sqlite`만 대상으로 한다.
  최근 14일 및 최소 최신 2개를 보존한다. 최신 백업이 48시간보다 오래되면 정리를 중지한다.
  삭제는 ETag 조건을 사용하며 다른 키·사용자 백업·일회성 복구 사본은 건드리지 않는다.
- 사용자 앱 정기 백업은 도입하지 않는다. 기존 플랫폼 DB 정기 백업만 관리한다.

## 실행과 감시

`deploy/host/storage-maintenance-install.sh`로 검토된 소스를 설치한다.
기존 호스트의 OCI CLI Python SDK·`~ubuntu/.oci/config` 및 기존 Kubernetes 이미지
인증을 사용한다. API 키 복제, 새 IAM 권한, 추가 유료 자원은 만들지 않는다.

```bash
# 삭제 없는 사전 점검
/home/ubuntu/lib/oracle-cli/bin/python3 /usr/local/lib/swkoo-storage-maintenance/oci-storage-maintenance.py
# 검증된 정책 적용 및 로그
sudo systemctl start swkoo-storage-maintenance.service
sudo journalctl -u swkoo-storage-maintenance.service --no-pager
sudo systemctl start swkoo-storage-maintenance.timer
systemctl list-timers swkoo-storage-maintenance.timer
```

`swkoo-storage-maintenance.timer`가 매일 05:10 KST부터 최대 5분 분산 실행한다.
백업 생성 04:00 KST 이후이며 앱 중단은 필요 없다. 재부팅으로 놓친 실행은 보충한다.
동일 파일 잠금으로 수동 실행과 중복 정리를 차단한다. 기존 GitHub OCIR Retention은
예약 삭제 주체에서 제외하고 수동 조회 전용으로 유지한다.

정리 후 OCI가 보고한 이미지 layer bytes와 백업 bytes 합계가 **8 GB** 이상이면
실패로 기록한다. 무료 10 GB에 대해 약 2 GB 여유를 둔다.
`/var/lib/swkoo-storage-maintenance/status.json`에는 비밀 없는 합계·검사 시각·성공 여부만
저장하고 기존 일일 resource report가 실패 또는 36시간 초과 지연을 WARN으로 표시한다.
OCI 이미지 삭제의 물리 용량 반영은 최대 48시간 걸릴 수 있다.

이 예산은 매일 정리·검사하는 안전 기준이며 Oracle의 과금 차단 한도가 아니다.
대량 이미지 게시·백업 급증·정리 실패·요금 정책 변경 시 0원은 보장할 수 없다.
필수 복구 이미지를 지우거나 백업을 무조건 중지해서 예산을 맞추지 않는다.

## 검증 및 운영 결과

보존 그래프·롤백·누락 시 중지·중복 버전·게시 유예·백업 기한·최소 복구 사본·
ETag 경합·목록 페이지 처리에 대한 자동 검사를 CI에서 실행한다.
실제 운영 적용 결과와 복원 시험은 작업 완료 시 이 절에 기록한다.

참고: [요금표](https://www.oracle.com/cloud/price-list/),
[이미지 삭제의 반영 시간](https://docs.oracle.com/en-us/iaas/Content/Registry/Tasks/registrydeletingimages.htm).
