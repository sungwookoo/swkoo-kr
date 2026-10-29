# 앱별 영구 저장공간 제한 운영 절차

## 적용 범위

- 지원되는 Prisma SQLite 앱: 실제 할당 블록 1GiB, inode 65,536개. 초과 쓰기는 `EDQUOT`로 거부한다. 기존 파일을 자동 삭제하지 않는다.
- 신규 앱은 `swkoo-user-quota` StorageClass를 사용한다. 기존 PVC의 불변 StorageClass는 바꾸지 않고 기존 디렉터리에 한도를 적용한다. 기존 프로필을 다시 등록해도 클래스를 보존한다.
- 플랫폼·모니터링 볼륨에는 앱 한도를 적용하지 않는다. 원래 `local-path` 클래스와 경로를 유지한다.
- 고객 소스 저장소와 고객 배포 저장소를 수정하지 않는다. 운영자 소유 앱의 배포 설정만 보강한다.
- 정기 백업 서비스나 유료 인프라를 추가하지 않는다. 이번 전환의 일회성 복구 사본은 운영자 PC에 인증된 암호화로 보관하고 키는 Windows 사용자 DPAPI로 보호한다.

## 필수 사전 시험

1. 온라인 SQLite backup API로 업무 DB를 복제하고 복호화·복원 후 `PRAGMA integrity_check`를 확인한다.
2. `scripts/validate-storage-recovery.py --execute`: 운영 데이터와 분리된 loop 디스크를 partclone으로 복제하고 CRC 검사한다. quota 기능과 데이터를 바꾼 뒤 전체 블록 사본으로 복원해 원본 DB 해시·무결성·파일시스템 기능이 되돌아오는지 확인한다.
3. `scripts/validate-project-quota.py --execute`: 격리 디스크에서 실제 1GiB 쓰기 차단, inode 제한, 재마운트, 기존 데이터, 독립 앱, 삭제를 확인한다.
4. `scripts/validate-quota-provisioner.py --manifests <rendered.json> --execute`: 실제 controller/helper/PVC/비특권 Pod를 생성해 차단·우회 방어·재시작·데이터 유지·회수를 확인한다. 실패 시 시험 리소스를 보존하며 강제 정리하지 않는다.
5. 새 helper/controller 이미지 취약점 검사와 백엔드·프런트엔드·브라우저 회귀 검사를 통과한다. feature branch의 이미지 빌드는 운영 태그·매니페스트를 변경하지 않는다.

## 전환 순서

1. 원래 배포 수, Argo 자동 동기화, CronJob 상태, 노드 스케줄링 상태, fstab과 전체 PVC/PV를 사본에 기록한다. 운영 이미지와 신규 이미지를 미리 준비한다.
2. 관련 자동 동기화·작업 생성기를 잠시 정지한다. Prometheus operator를 먼저 멈추고, `/data`에 쓰는 API·운영자 앱·Portainer·Prometheus·provisioner를 정상 종료한다. 디스크를 사용하지 않는 기존 고객 앱은 유지한다. 노드를 잠시 cordon해 새 디스크 사용자가 생기지 않도록 한다.
3. 남은 파일 사용자와 kubelet 하위 마운트가 없는지 확인한다. bind mount와 `/data`를 정상 해제한다. 강제·lazy unmount는 사용하지 않는다.
4. 오프라인 파일시스템 검사 후 `/dev/sdb`의 **전체 사용 블록**을 partclone으로 복제해 PC에 암호화 전송한다. 복호화 인증과 partclone CRC 검사를 완료하기 전 파일시스템을 변경하지 않는다. 정지 시점 원본 파일 SHA-256 목록도 기록한다.
5. UUID를 다시 확인한 뒤 `tune2fs -O project,quota -Q prjquota`를 적용하고 오프라인 검사를 통과시킨다. fstab에 `prjquota`를 추가하고 원래 경로에 마운트한다. 포맷하지 않는다.
6. 기존 운영자 앱 디렉터리에 `deploy/storage/quota.py`를 적용한다. 초과 데이터·특수 파일·기존 hard link·ID 충돌 발견 시 중단한다. 재개 전에 원본 파일 해시가 일치해야 한다.
7. stateful Pod에는 `Localhost: swkoo-user-storage-v1.json`을 적용한다. 프로젝트 ID/상속 속성 변경 ioctl을 차단한다. 일반 RuntimeDefault만으로는 파일 소유자의 한도 우회를 막을 수 없다.
8. `deploy/host/install-storage-guard.sh`를 실행해 UUID·마운트·project quota·seccomp 해시를 K3s 시작 전에 검사하게 한다. 사용 중 및 다음 부팅 커널의 `quota_v2` 모듈을 미리 확보한다. K3s 재시작은 전환에 필요하지 않다.
9. 기본 provisioner는 `deploy/local-storage`로 동일 경로·클래스를 유지하며 보안 보완한 이미지로 관리한다. K3s `local-storage.yaml.skip`으로 패키지 재적용만 막는다. `--disable=local-storage`는 기존 리소스를 제거하므로 사용하지 않는다. [K3s 공식 문서](https://docs.k3s.io/installation/packaged-components#using-skip-files)
10. 원래 복제 수·동기화·작업 상태·스케줄링을 복구하고 신규 quota provisioner를 가동한다. 앱별 HTTPS·DB 무결성·새 PVC 생성 및 회수·운영 버전을 확인하고 실제 중단 시간을 기록한다.

## 복구와 유지보수

- **쓰기 재개 전** 전환 실패: 정상 unmount 후 검증한 partclone 사본으로 원래 장치를 복원하고 원래 fstab·설정·Pod 보안 설정·배포 수를 복구한다. 복원 명령은 UUID·장치·마운트·사본 인증을 다시 확인한 후에만 실행한다.
- **쓰기 재개 후** 과거 블록 사본을 덮어쓰지 않는다. 새 쓰기를 보존하고 별도 복구 계획을 세운다.
- quota 설정 오류 시 보호 없는 볼륨을 대신 만들지 않는다. PVC는 실패 상태로 남고 운영자가 조사한다.
- 커널 업데이트 시 modules-extra의 quota_v2 제공 여부, K3s/containerd 업데이트 시 seccomp 기준을 재검증한다. 이 프로필은 자동으로 새 RuntimeDefault를 따라가지 않는다. `scripts/build-user-storage-seccomp.py`로 검토한 기준에서 재생성하고 운영 시험을 반복한다.
- 한도는 실제 할당량 기준이며 `df`가 보이는 디스크 전체 크기와 다르다. DB journal/WAL·디렉터리도 한도에 포함되므로 저장 실패를 앱에서 처리하고 여유 공간을 유지해야 한다.
- 기존 이미지 정리는 ConfigMap과 일시적인 helper Pod까지 수집하지 못하므로 `storage-helper-<SHA>`·`storage-provisioner-<SHA>` 이미지는 삭제 대상에서 제외한다. 현재 실행·재시작·복구 참조를 모두 확인하는 별도 정책을 검증하기 전 자동 정리를 확대하지 않는다.

## 현재 기록

소스 변경 시점에는 사전 시험과 이미지 검증을 진행 중이다. 운영 적용 완료 여부·실제 중단 시간·최종 사본 해시는 별도 적용 보고서에 기록한다. 이 문서만으로 운영 적용 완료를 의미하지 않는다.
