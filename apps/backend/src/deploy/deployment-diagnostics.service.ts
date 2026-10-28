import { ConflictException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { KubeClient } from '../kube/kube.client';
import { UsersRepository, UserRow } from '../onboarding/users.repository';
import { DeployService } from './deploy.service';
import { EnvService } from './env.service';
import { PlatformMetricsService } from './platform-metrics.service';

export function redactAppLogs(raw: string, values: string[]): string {
  let result = raw;
  for (const value of [...new Set(values)].filter(value => value.length >= 4).sort((a,b) => b.length-a.length)) result = result.split(value).join('[숨김]');
  return result
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[비공개 키 숨김]')
    .replace(/((?:authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/gi, '$1[숨김]')
    .replace(/((?:password|passwd|token|api[_-]?key|secret|database_url)\s*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[숨김]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[인증 정보 숨김]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[숨김]@')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

@Injectable()
export class DeploymentDiagnosticsService {
  constructor(private readonly deploy: DeployService, private readonly kube: KubeClient,
    private readonly metrics: PlatformMetricsService, private readonly env: EnvService, private readonly users: UsersRepository) {}

  async get(user: UserRow, login: string, repo: string, includeLogs: boolean) {
    if (login.toLowerCase() !== user.githubLogin.toLowerCase() || !user.isAllowed) throw new ForbiddenException('본인 앱만 확인할 수 있습니다.');
    const current = await this.deploy.getCurrentDeployment(user.githubLogin, true);
    if (!current || current.state !== 'active' || current.repo.toLowerCase() !== repo.toLowerCase()) throw new ConflictException('현재 배포된 앱이 아닙니다. 배포 목록에서 다시 확인해 주세요.');
    if (!this.kube.available()) throw new ServiceUnavailableException('앱 실행 상태를 확인하지 못했습니다.');
    const namespace = `user-${user.githubLogin.toLowerCase()}`, appName = current.appName;
    const response = await this.kube.core!.listNamespacedPod({ namespace, labelSelector: `app=${appName}` });
    const pod = response.items.filter(p => p.metadata?.namespace === namespace && p.metadata.labels?.app === appName && !p.metadata.deletionTimestamp)
      .sort((a,b) => Date.parse(String(b.metadata?.creationTimestamp)) - Date.parse(String(a.metadata?.creationTimestamp)))[0];
    const result = { checkedAt: new Date().toISOString(), state: pod?.status?.phase ?? 'Pending', restarts: 0,
      usage: null as null | { cpuMillicores: number | null; memoryMiB: number | null; cpuLimit: string | null; memoryLimit: string | null },
      logs: null as string | null, logSource: null as 'app' | 'initialization' | null, logError: null as string | null };
    if (!pod?.metadata?.name) { if (includeLogs) result.logError = '앱 실행 기록을 준비 중입니다.'; return result; }
    const container = pod.spec?.containers.find(c => c.name === appName);
    if (!container) throw new ServiceUnavailableException('앱 실행 대상을 확인하지 못했습니다.');
    const status = pod.status?.containerStatuses?.find(c => c.name === appName);
    const initialization = pod.status?.initContainerStatuses?.find(c => (c.state?.terminated?.exitCode ?? 0) !== 0 || c.state?.waiting?.reason === 'CrashLoopBackOff');
    const failed = !!initialization || (status?.state?.terminated?.exitCode ?? 0) !== 0 ||
      ['CrashLoopBackOff','ImagePullBackOff','ErrImagePull'].includes(status?.state?.waiting?.reason ?? '');
    result.state = failed ? 'Failed' : status?.ready && status.state?.running ? 'Running' : 'Pending';
    result.restarts = [...(pod.status?.containerStatuses ?? []), ...(pod.status?.initContainerStatuses ?? [])].reduce((sum,c) => sum+c.restartCount, 0);
    const labels = `namespace=${JSON.stringify(namespace)},pod=${JSON.stringify(pod.metadata.name)},container=${JSON.stringify(appName)}`;
    try {
      const [cpu, memory] = await Promise.all([
        this.metrics.query(`sum(rate(container_cpu_usage_seconds_total{${labels}}[5m]) and (time()-timestamp(container_cpu_usage_seconds_total{${labels}})<90))`),
        this.metrics.query(`sum(container_memory_working_set_bytes{${labels}} and (time()-timestamp(container_memory_working_set_bytes{${labels}})<90))`),
      ]);
      const value = (rows: typeof cpu, scale: number) => rows.length === 1 && Number(rows[0].value[1]) >= 0 ? Math.round(Number(rows[0].value[1]) / scale) : null;
      result.usage = { cpuMillicores: value(cpu,.001), memoryMiB: value(memory,1024**2), cpuLimit: container.resources?.limits?.cpu ?? null, memoryLimit: container.resources?.limits?.memory ?? null };
    } catch { /* Telemetry unavailable is shown as unknown, never as zero. */ }
    if (includeLogs) {
      try {
        const vars = await this.env.getEnv(user.githubLogin, appName);
        const raw = await this.kube.core!.readNamespacedPodLog({ namespace, name: pod.metadata.name, container: initialization?.name ?? appName,
          tailLines: 100, limitBytes: 16_384, sinceSeconds: 3600, timestamps: true, follow: false });
        const values = [...Object.values(vars), ...(container.env ?? []).flatMap(v => v.value ? [v.value] : [])];
        this.users.audit({ actor: user.githubLogin, action: 'APP_LOG_VIEW', target: current.fullName, reason: null, metaJson: null });
        result.logs = redactAppLogs(raw, values); result.logSource = initialization ? 'initialization' : 'app';
      } catch { result.logError = '실행 로그를 불러오지 못했습니다. 잠시 후 다시 시도하거나 운영자에게 문의해 주세요.'; }
    }
    return result;
  }
}
