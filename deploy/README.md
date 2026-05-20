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

  > **OCI auth token rotation 시 주의**: 같은 token 이 두 곳에 박혀있습니다:
  > 1. GitHub Actions repo secret `OCI_AUTH_TOKEN` — 빌드 시 push 용
  > 2. 클러스터 `swkoo/ocir-credentials` Secret — 런타임 pull 용
  >
  > **두 곳 모두** 갱신해야 합니다. GHA 만 갱신하면 push 는 통과하지만 새 이미지를 cluster 가 pull 못 해 `ImagePullBackOff` 로 backend 다운. 갱신 명령 (token 노출 최소화):
  > ```bash
  > kubectl create secret docker-registry ocir-credentials -n swkoo \
  >   --docker-server=nrt.ocir.io \
  >   --docker-username='<namespace>/<username>' \
  >   --docker-password='<new-auth-token>' \
  >   --dry-run=client -o yaml | kubectl apply -f -
  > # 실패 중인 pod 가 있으면:
  > kubectl -n swkoo delete pod -l app=swkoo-backend
  > kubectl -n swkoo delete pod -l app=swkoo-frontend
  > ```
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
  - `RESEND_API_KEY`, `EMAIL_FROM` — 둘 다 설정 시 사용자 deploy 완료 시 OAuth email 로 자동 알림. `EMAIL_FROM` 은 "swkoo.kr <noreply@swkoo.kr>" 형식. Resend 콘솔에서 도메인 verification 후 키 발급 필요. 미설정 시 알림 OFF
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

## 알람 → Discord 라우팅 (Step 2.3)

Prometheus 알람은 `deploy/observability/*-alerts.yaml` 의 PrometheusRule 들이 정의. Alertmanager → Discord 통로는 다음 3가지로 구성:

1. **Discord 변환 sidecar** (`alertmanager-discord-deployment.yaml`) — Alertmanager 의 webhook 페이로드를 Discord 가 받는 포맷으로 변환. 이 sidecar 가 없으면 Discord 가 400으로 거절
2. **AlertmanagerConfig CR** (`alertmanagerconfig-discord.yaml`) — discord receiver + Watchdog 헬스체크 route
3. **Alertmanager CR 패치** (`alertmanager-cr-patch.yaml`) — helm-managed CR 이라 kustomize 미포함, *수동 1회 적용*

### 1회 설정 (운영자)

**a. Discord webhook URL Secret 생성**

```bash
kubectl create secret generic alertmanager-discord-webhook -n monitoring \
  --from-literal=url='https://discord.com/api/webhooks/<id>/<token>'
```

(URL 은 Discord 서버 → 채널 설정 → 연동 → 웹훅 에서 발급)

**b. Alertmanager CR 패치**

운영자가 1회 수동 적용. Helm 으로 kube-prometheus-stack 업그레이드 시 되돌려질 수 있음 — 그땐 재적용:

```bash
kubectl patch alertmanager kube-prometheus-stack-alertmanager -n monitoring --type=merge -p '{
  "spec": {
    "alertmanagerConfigSelector": { "matchLabels": { "alertmanagerConfig": "swkoo" } },
    "alertmanagerConfigNamespaceSelector": { "matchLabels": { "kubernetes.io/metadata.name": "monitoring" } },
    "alertmanagerConfigMatcherStrategy": { "type": "None" }
  }
}'
```

(`alertmanager-cr-patch.yaml` 에 같은 내용 reference 로 보관)

### 동작 검증

- `Watchdog` 알람은 kube-prometheus-stack 의 내장 룰 — 항상 fire 상태. AlertmanagerConfig 의 `repeatInterval: 6h` 라 *6시간마다 Discord 메시지 1건* 도달해야 정상
- 도착 안 하면 통로가 죽음 — `kubectl logs -n monitoring deploy/alertmanager-discord` 부터 확인
- 즉시 검증하려면 synthetic alert:

```bash
kubectl -n monitoring exec alertmanager-kube-prometheus-stack-alertmanager-0 -c alertmanager -- \
  wget -qO- --post-data='[{"labels":{"alertname":"SwkooSmokeTest","severity":"warning"},"annotations":{"summary":"smoke test from operator"}}]' \
  --header='Content-Type: application/json' \
  'http://localhost:9093/api/v2/alerts'
```

30초~5분 안에 Discord 도달.

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

전체 시퀀스는 2026-05-20 dry-run 으로 검증됨 (총 다운타임 ~1분). 외부 도구 (`oci` CLI, `sqlite3` CLI) 설치 불필요 — backend pod 안에 있는 OCI SDK + better-sqlite3 + Instance Principal 인증을 그대로 활용.

**0. 사전: ArgoCD selfHeal 일시 비활성**

`swkoo-portfolio` Application 이 `selfHeal: true` 상태면 수동 `scale --replicas=0` 을 즉시 되돌리므로 먼저 꺼야 함:

```bash
kubectl patch application swkoo-portfolio -n argocd --type=json \
  -p='[{"op": "replace", "path": "/spec/syncPolicy/automated/selfHeal", "value": false}]'
```

복구 종료 후 반드시 `true` 로 복원 (마지막 step).

**1. backend pod 안에서 OCI 백업 다운로드 → pod 임시 파일**

```bash
kubectl exec -n swkoo deploy/swkoo-backend -- node -e "
const common = require('oci-common');
const objectstorage = require('oci-objectstorage');
const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
(async () => {
  const provider = await new common.InstancePrincipalsAuthenticationDetailsProviderBuilder().build();
  const client = new objectstorage.ObjectStorageClient({ authenticationDetailsProvider: provider });
  const resp = await client.getObject({
    namespaceName: 'nrznn4yiltsz',
    bucketName: 'swkoo-kr-backups',
    objectName: 'daily/<YYYY-MM-DD>/observatory.sqlite',
  });
  await pipeline(Readable.fromWeb(resp.value), fs.createWriteStream('/tmp/restore.sqlite'));
  console.log('downloaded', fs.statSync('/tmp/restore.sqlite').size, 'bytes');
})().catch(e => { console.error(e); process.exit(1); });
"
```

`<YYYY-MM-DD>` 자리에 복구하려는 백업 날짜.

**2. pod 안에서 sqlite 무결성 검증**

```bash
kubectl exec -n swkoo deploy/swkoo-backend -- node -e "
const D = require('better-sqlite3');
const db = new D('/tmp/restore.sqlite', { readonly: true });
console.log('tables:', db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all().map(t=>t.name));
console.log('users active:', db.prepare('SELECT count(*) AS n FROM users WHERE deleted_at IS NULL').get().n);
console.log('audit by action:'); db.prepare('SELECT action, count(*) AS n FROM audit_log GROUP BY action ORDER BY n DESC').all().forEach(r => console.log(' ', r.action, r.n));
db.close();
"
```

테이블 ≥ 5개 + 사용자 수 합리적이면 OK.

**3. pod 의 파일을 호스트로 빼기**

```bash
POD=$(kubectl -n swkoo get pods -l app=swkoo-backend -o jsonpath='{.items[0].metadata.name}')
kubectl -n swkoo cp swkoo/$POD:/tmp/restore.sqlite /tmp/restore.sqlite
```

**4. 백엔드 정지 (PVC 점유 해제)**

```bash
kubectl scale deployment/swkoo-backend -n swkoo --replicas=0
kubectl -n swkoo wait --for=delete pod -l app=swkoo-backend --timeout=60s
```

**5. 디버그 pod 띄워 PVC 마운트**

```bash
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: pvc-restore
  namespace: swkoo
spec:
  restartPolicy: Never
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: swkoo-backend-data
  containers:
    - name: shell
      image: alpine:3.20
      command: ["sleep", "600"]
      volumeMounts:
        - name: data
          mountPath: /data
EOF
kubectl -n swkoo wait --for=condition=Ready pod/pvc-restore --timeout=60s
```

**6. 파일 교체 + WAL 부산물 제거 + 권한 복원**

WAL 모드의 `-shm` / `-wal` 파일은 옛 트랜잭션을 가지고 있어 새 DB 와 일관성 안 맞음 — 반드시 같이 삭제.

```bash
kubectl -n swkoo cp /tmp/restore.sqlite pvc-restore:/data/observatory.sqlite
kubectl -n swkoo exec pvc-restore -- sh -c '
  rm -f /data/observatory.sqlite-shm /data/observatory.sqlite-wal &&
  chmod 666 /data/observatory.sqlite &&
  chown 100:101 /data/observatory.sqlite &&
  ls -la /data/
'
```

원본 권한: 100:101 (Node alpine 이미지의 `node` 사용자 매핑), 모드 666.

**7. 디버그 pod 삭제 + 백엔드 재기동**

```bash
kubectl -n swkoo delete pod pvc-restore --wait
kubectl -n swkoo scale deployment/swkoo-backend --replicas=1
kubectl -n swkoo wait --for=condition=Ready pod -l app=swkoo-backend --timeout=120s
```

**8. selfHeal 복원**

```bash
kubectl patch application swkoo-portfolio -n argocd --type=json \
  -p='[{"op": "replace", "path": "/spec/syncPolicy/automated/selfHeal", "value": true}]'
```

**9. 스모크 검증**

```bash
curl -fsS https://swkoo.kr/api/health
kubectl exec -n swkoo deploy/swkoo-backend -- node -e "
const D=require('better-sqlite3'); const db=new D('/data/observatory.sqlite',{readonly:true});
console.log('active users:', db.prepare('SELECT count(*) FROM users WHERE deleted_at IS NULL').get());
"
# 호스트 임시 파일 정리
rm -f /tmp/restore.sqlite
```

**10. 운영자 본인 admin 로그인 + 친구 1명에게 "정상 동작 중인가" 확인 요청**

복구 시점 이후 발생했던 *작은* 상태 변경 (audit log 새 행, sign-in lastLoginAt 등) 은 손실. 사용자 환경변수 (k8s Secret) 와 manifest (git) 는 영향 없음.
