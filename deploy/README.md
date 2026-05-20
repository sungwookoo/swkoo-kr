# swkoo-kr 배포 가이드

## 구성
- `base/`: Kustomize 기본 리소스
  - `backend/`: NestJS API Deployment/Service/Ingress (`swkoo-backend`)
  - `frontend/`: Next.js UI Deployment/Service/Ingress (`swkoo-frontend`)
  - `common/namespace.yaml`: `swkoo` 네임스페이스 생성
- `argocd/application.yaml`: Argo CD `Application` 매니페스트

## 선행 조건
- OCI Container Registry 이미지
  - `nrt.ocir.io/<namespace>/swkoo/backend:latest`
  - `nrt.ocir.io/<namespace>/swkoo/frontend:latest`
- 이미지 풀 시크릿: `ocir-credentials`
  ```bash
  kubectl create secret docker-registry ocir-credentials \
    --namespace swkoo \
    --docker-server=nrt.ocir.io \
    --docker-username='<namespace>/<username>' \
    --docker-password='<auth-token>'
  ```
- 백엔드 환경 변수 시크릿: `swkoo-backend-env` — 백엔드가 `envFrom: secretRef:`로 흡수하는 단일 Secret. 모든 토큰·비밀키·환경 의존 값이 여기에 모임.

  ```bash
  kubectl create secret generic swkoo-backend-env \
    --namespace swkoo \
    --from-literal=ARGOCD_BASE_URL=https://argocd.swkoo.kr \
    --from-literal=ARGOCD_AUTH_TOKEN=<jwt-token> \
    --from-literal=JWT_SECRET=<random-32+-bytes> \
    --from-literal=GITHUB_APP_ID=<app-id> \
    --from-literal=GITHUB_APP_SLUG=<app-slug> \
    --from-literal=GITHUB_APP_CLIENT_ID=<client-id> \
    --from-literal=GITHUB_APP_CLIENT_SECRET=<client-secret> \
    --from-literal=GITHUB_APP_PRIVATE_KEY="$(cat private-key.pem)" \
    --from-literal=DEPLOY_ALLOWLIST=sungwookoo \
    --from-literal=ADMIN_LOGINS=sungwookoo
  ```

  `GITHUB_APP_SLUG`은 App의 URL-safe 이름 (예: `swkoo-deploy`). https://github.com/apps/&lt;slug&gt;/installations/new 형태의 install URL 만들 때 사용.

  필요 시 키:
  - `ARGOCD_USERNAME` / `ARGOCD_PASSWORD` — `ARGOCD_AUTH_TOKEN` 대체
  - `ARGOCD_WEBHOOK_SECRET`, `GITHUB_WEBHOOK_SECRET` — 웹훅 HMAC 검증
  - `ALERTMANAGER_AUTH_TOKEN` — Alertmanager가 인증 요구 시
  - `DISCORD_WEBHOOK_URL` — 신규 사용자 가입 시 Discord 알림 (없으면 알림 OFF)
  - `DISCORD_BUILD_FAILURE_WEBHOOK_URL` — 사용자 repo GHA 빌드 실패 시 운영자 알림 (없으면 알림 OFF)
  - `DISCORD_SCAN_WEBHOOK_URL` — 일일 Trivy 스캔에서 critical/high 신규 발견 시 운영자 알림 (없으면 알림 OFF)
  - `OCI_REGION`, `OCI_OBJECT_STORAGE_NAMESPACE`, `OCI_BACKUP_BUCKET` — 셋 다 설정 시 매일 04:00 KST SQLite 백업이 OCI Object Storage 로 업로드. 하나라도 비면 백업 OFF. 인증은 Instance Principal (메타데이터 서비스, 정적 키 없음) — Dynamic Group + Policy 사전 설정 필요 (아래 *백업 / 복구* 섹션)
  - `BRAND_NAME`, `APPS_DOMAIN`, `MANIFEST_REPO`, `MANIFEST_BRANCH`, `APP_BASE_URL`, `PIPELINES_CACHE_TTL`, `ALERTS_CACHE_TTL` — 기본값 덮어쓸 때만

  키 추가/수정 (기존 키 보존하며 merge):
  ```bash
  kubectl patch secret swkoo-backend-env -n swkoo --type=merge \
    -p '{"stringData":{"ADMIN_LOGINS":"sungwookoo,co-admin"}}'

  # Secret 변경은 Pod 자동 재시작 안 함 — 명시적으로 rollout
  kubectl rollout restart deployment/swkoo-backend -n swkoo
  ```

  `kubectl create secret ... --dry-run=client -o yaml | kubectl apply -f -` 패턴은 *전체 교체*라 누락된 키가 삭제됨 — 매번 모든 키를 명시할 자신이 없으면 위의 `patch --type=merge`만 사용.

> **운영 메모**: `DEPLOY_ALLOWLIST`는 Phase 2.7 (관리자 페이지) 이후 *초기 시드 전용*으로 남고, 실제 권한 체크는 `users.is_allowed` DB 컬럼에서 함. 친구 추가·제거는 `/admin`에서 토글. `ADMIN_LOGINS`는 그대로 env 단일 source.

> **k8s API 권한 (Phase 2.8 — 사용자 env 패널)**: 백엔드는 `swkoo` namespace의 `swkoo-backend` ServiceAccount로 동작하며, 각 사용자 namespace에는 `templates.ts`가 register 시 자동 commit하는 Role + RoleBinding으로 Secret CRUD + Deployment patch 권한이 부여됩니다. 기존 사용자가 이 기능 이전에 등록했다면 한 번 재배포해야 본인 namespace에 RBAC이 생성됩니다 — 그 전엔 `/deploy/<login>/<repo>` 환경변수 패널이 "권한 없음" 표시.

> **ApplicationSet refresh 권한 (Phase 2.9)**: register/delete 직후 백엔드가 `swkoo-users` ApplicationSet에 `argocd.argoproj.io/refresh=hard` 어노테이션을 패치해 ArgoCD가 즉시 sync하도록 합니다. 권한은 `deploy/argocd/swkoo-backend-applicationset-rbac.yaml`의 Role + RoleBinding으로 부여 — operator가 한 번만 적용하면 됨:
> ```bash
> kubectl apply -f deploy/argocd/swkoo-backend-applicationset-rbac.yaml
> ```
> 미적용 상태에서도 register/delete 자체는 동작하며, 기본 git poll(~3분)으로 sync는 결국 일어남.

> **GitHub App 설정 — Connect 통합 플로우 동작을 위해 필수**:
> - **Request user authorization (OAuth) during installation**: ✅ ON. 이 토글이 켜져 있으면 install URL 한 번으로 install + OAuth가 한 흐름으로 묶이고, GitHub이 *OAuth callback URL* 쪽으로 `code`+`state`+`installation_id`+`setup_action`을 함께 보냅니다. 이 모드에서는 Setup URL 필드가 GitHub UI에서 비활성화되므로 별도 입력 불필요.
> - **User authorization callback URL**: `https://swkoo.kr/api/auth/github/callback`
> - **Webhook URL** (선택): 사용 안 함
> - **Permissions**: Repository → Contents (write), Metadata (read), Actions (read). Account → Email (read)
>
> 위 토글이 OFF면 사용자가 install URL 클릭 시 App만 설치되고 OAuth code 없이 Setup URL로 빠져서 사인인이 안 됩니다.

> **주의:** OAuth 토큰/비밀번호 등 민감 정보는 Git에 커밋하지 말고 Kubernetes Secret 또는 외부 시크릿 매니저를 사용하세요.

## Kustomize로 직접 배포
```bash
kubectl apply -k deploy/base
```

## Argo CD에 등록
```bash
kubectl apply -f deploy/argocd/application.yaml
```

Argo CD UI에서 `swkoo-kr` 애플리케이션을 Sync하면 K3s 클러스터에 프론트/백엔드가 배포됩니다.

## 커스터마이즈 포인트
- 도메인/TLS Secret 이름은 `deploy/base/backend/ingress.yaml`, `deploy/base/frontend/ingress.yaml`에서 변경
- 리플리카 수와 리소스 요청/제한은 각 Deployment에서 조정
- 추가 환경 변수는 Secret/ConfigMap을 만들어 `envFrom` 또는 `env`로 주입

## 백업 / 복구

### 일일 자동 백업 (Step 2.2)

`BackupService`가 매일 04:00 KST 에 SQLite 전체 스냅샷을 OCI Object Storage 로 업로드.
키 패턴: `daily/<YYYY-MM-DD>/observatory.sqlite`. 같은 날짜 키는 덮어씌워짐.

**OCI 사전 설정 (1회)**:
1. Bucket 생성 (Standard tier, private). 이름은 `OCI_BACKUP_BUCKET` 과 일치
2. Dynamic Group 생성 — matching rule: `instance.id = 'ocid1.instance.oc1.<region>.<vm-ocid>'`
3. IAM Policy:
   ```
   Allow dynamic-group <dynamic-group-name> to manage objects in compartment <compartment-name> where target.bucket.name='<bucket-name>'
   Allow dynamic-group <dynamic-group-name> to read buckets in compartment <compartment-name>
   ```
4. 권장: bucket Lifecycle Policy — 90일 지난 객체 자동 삭제

backend Secret 에 `OCI_REGION` / `OCI_OBJECT_STORAGE_NAMESPACE` / `OCI_BACKUP_BUCKET` 추가 + rollout.

### 수동 트리거 (smoke test, pre-migration)

```bash
# 관리자 JWT 쿠키 있는 상태에서
curl -X POST https://swkoo.kr/api/admin/backup/trigger \
  -H 'Cookie: <admin-session-cookie>'
# → { "bucket": "...", "key": "daily/2026-05-20/observatory.sqlite", "sizeBytes": N }
```

### 복구 절차 (사고 시)

1. OCI 콘솔 → Object Storage → `swkoo-kr-backups` 버킷 → 원하는 날짜의 객체 다운로드
2. 다운로드한 `observatory.sqlite` 파일을 sqlite3 로 sanity-check:
   ```bash
   sqlite3 observatory.sqlite ".tables"   # users, audit_log, scan_results 등 보이면 OK
   sqlite3 observatory.sqlite "SELECT count(*) FROM users WHERE deleted_at IS NULL;"
   ```
3. 백엔드 정지 (PVC 점유 해제):
   ```bash
   kubectl scale deployment/swkoo-backend -n swkoo --replicas=0
   ```
4. 한 번 디버그 pod 를 띄워 PVC 마운트 + 파일 교체:
   ```bash
   kubectl run pvc-restore -n swkoo --rm -it --restart=Never \
     --image=alpine --overrides='{"spec":{"volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"swkoo-backend-data"}}],"containers":[{"name":"pvc-restore","image":"alpine","stdin":true,"tty":true,"volumeMounts":[{"name":"data","mountPath":"/data"}]}]}}' \
     -- sh
   # 다른 터미널에서: kubectl cp ./observatory.sqlite swkoo/pvc-restore:/data/observatory.sqlite
   # 컨테이너 안: ls -la /data/ 확인 후 exit
   ```
5. 백엔드 재시작:
   ```bash
   kubectl scale deployment/swkoo-backend -n swkoo --replicas=1
   kubectl rollout status deployment/swkoo-backend -n swkoo
   ```
6. 스모크: `/api/health` 200 응답 + `/admin/users` 목록 확인
