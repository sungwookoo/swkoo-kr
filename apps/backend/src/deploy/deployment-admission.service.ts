import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { APP_RESOURCE_BOUNDS } from '../onboarding/deploy-policy';
import { UsersRepository } from '../onboarding/users.repository';
import { MetricSample, PlatformMetricsService } from './platform-metrics.service';

const Mi = 1024 ** 2;
const Gi = 1024 * Mi;
const MAX_USAGE = 0.70;
const MIN_CPU = 1, MIN_MEMORY = 4 * Gi, MIN_DISK = 5 * Gi;
const APP_CPU = 0.2, APP_MEMORY = 512 * Mi, APP_EPHEMERAL = 2 * Gi;
export const ADMISSION_QUERIES = [
  'kube_node_status_allocatable{resource=~"cpu|memory"}',
  'kube_node_status_condition{condition=~"Ready|MemoryPressure|DiskPressure",status="true"}',
  'kube_pod_container_resource_requests{resource=~"cpu|memory"}',
  'kube_pod_init_container_resource_requests{resource=~"cpu|memory"}',
  '1-avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))',
  'max_over_time((1-node_memory_MemAvailable_bytes/node_memory_MemTotal_bytes)[5m:30s])',
  'node_filesystem_avail_bytes{mountpoint="/",fstype!~"tmpfs|overlay"}',
  'time()-min(timestamp(kube_node_status_allocatable))',
  'time()-min(timestamp(node_cpu_seconds_total{mode="idle"}))',
  'time()-min(timestamp(node_filesystem_avail_bytes{mountpoint="/",fstype!~"tmpfs|overlay"}))',
  'min(count_over_time(node_cpu_seconds_total{mode="idle"}[5m]))',
  'min(count_over_time(node_memory_MemAvailable_bytes[5m]))',
  'sum(kube_persistentvolumeclaim_resource_requests_storage_bytes{namespace=~"user-.*"}) or vector(0)',
  'node_filesystem_avail_bytes{mountpoint="/data",fstype="ext4"}',
  'time()-min(timestamp(node_filesystem_avail_bytes{mountpoint="/data",fstype="ext4"}))',
  'node_filesystem_files_free{mountpoint="/",fstype="ext4"}/node_filesystem_files{mountpoint="/",fstype="ext4"}',
  'node_filesystem_files_free{mountpoint="/data",fstype="ext4"}/node_filesystem_files{mountpoint="/data",fstype="ext4"}',
  'time()-min(timestamp(node_filesystem_files_free{mountpoint=~"/|/data",fstype="ext4"}))',
  'sum(kube_pod_container_resource_limits{resource="ephemeral_storage",namespace=~"user-.*"}) or vector(0)',
];

/** Pending admissions survive restarts until observed in the same request
 * snapshot. Recovery of an existing registered app remains available. */
@Injectable()
export class DeploymentAdmissionService {
  constructor(private readonly metrics: PlatformMetricsService, private readonly users: UsersRepository) {}

  private async snapshot(at: number) {
    const data = await Promise.all(ADMISSION_QUERIES.map(query => this.metrics.query(query, at / 1000)));
    const invalid = (): never => { throw new ServiceUnavailableException({ reason: 'CAPACITY_UNVERIFIED', message: '서버 여유를 확인하지 못해 신규 배포를 보류했습니다. 잠시 후 다시 시도해 주세요.' }); };
    const one = (rows: MetricSample[]) => rows.length === 1 ? Number(rows[0].value[1]) : invalid();
    const [allocation, conditions, requests, init, cpu, memory, disk, ...checks] = data.slice(0, 12);
    const existingStorage = one(data[12]);
    const dataFree = one(data[13]), dataAge = one(data[14]);
    const rootInodes = one(data[15]), dataInodes = one(data[16]), inodeAge = one(data[17]);
    const existingEphemeral = one(data[18]);
    if (existingStorage < 0 || dataFree < 0 || existingEphemeral < 0 || dataAge < 0 || dataAge > 90 ||
        inodeAge < 0 || inodeAge > 90 || rootInodes < 0 || rootInodes > 1 || dataInodes < 0 || dataInodes > 1) invalid();
    const node = allocation[0]?.metric.node;
    if (allocation.length !== 2 || !node || allocation.some(row => row.metric.node !== node) ||
        conditions.length !== 3 || conditions.some(row => row.metric.node !== node) ||
        !requests.length || checks.slice(0, 3).some(rows => one(rows) < 0 || one(rows) > 90) ||
        checks.slice(3).some(rows => one(rows) < 8)) invalid();
    const allocated = (resource: string) => one(allocation.filter(row => row.metric.resource === resource));
    const blocked = conditions.some(row => Number(row.value[1]) !== (row.metric.condition === 'Ready' ? 1 : 0));
    const cpuUsed = one(cpu), memoryUsed = one(memory), diskFree = one(disk);
    if (cpuUsed < 0 || cpuUsed > 1 || memoryUsed < 0 || memoryUsed > 1 || diskFree < 0) invalid();
    const pods = new Map<string, { cpu: number; memory: number; initCpu: number; initMemory: number }>();
    for (const [rows, isInit] of [[requests, false], [init, true]] as const) {
      for (const row of rows) {
        const { namespace, pod, resource } = row.metric;
        if (!namespace || !pod || !['cpu','memory'].includes(resource) || Number(row.value[1]) < 0) invalid();
        const key = `${namespace}/${pod}`, usage = pods.get(key) ?? { cpu: 0, memory: 0, initCpu: 0, initMemory: 0 };
        const value = Number(row.value[1]);
        if (isInit) {
          if (resource === 'cpu') usage.initCpu = Math.max(usage.initCpu, value);
          else usage.initMemory = Math.max(usage.initMemory, value);
        } else if (resource === 'cpu') usage.cpu += value;
        else usage.memory += value;
        pods.set(key, usage);
      }
    }
    const observed = new Set(requests.map(row => row.metric.namespace));
    const requestedCpu = [...pods.values()].reduce((sum, pod) => sum + Math.max(pod.cpu, pod.initCpu), 0);
    const requestedMemory = [...pods.values()].reduce((sum, pod) => sum + Math.max(pod.memory, pod.initMemory), 0);
    const cpuRemaining = allocated('cpu') - requestedCpu;
    const memoryRemaining = allocated('memory') - requestedMemory;
    return {
      observed, cpuUsed, memoryUsed, cpuRemaining, memoryRemaining,
      reason: (slots: number, storageSlots = slots) => {
        if (blocked) return 'node' as const;
        if (cpuUsed >= MAX_USAGE || memoryUsed >= MAX_USAGE) return 'usage' as const;
        if (cpuRemaining - slots * APP_CPU < MIN_CPU || memoryRemaining - slots * APP_MEMORY < MIN_MEMORY) return 'compute' as const;
        // Existing PVC requests and intermittent disk use are both deducted to keep a safety margin.
        if (diskFree - existingEphemeral - slots * APP_EPHEMERAL < MIN_DISK ||
            dataFree - existingStorage - storageSlots * Gi < MIN_DISK || rootInodes < .10 || dataInodes < .10) return 'storage' as const;
        return null;
      },
    };
  }

  async capacity() {
    const at = Date.now();
    const [snapshot, ...host] = await Promise.all([
      this.snapshot(at),
      ...[
        'count(node_cpu_seconds_total{mode="idle"})',
        'node_memory_MemAvailable_bytes',
        'node_memory_MemTotal_bytes',
        'time()-min(timestamp(node_memory_MemAvailable_bytes))',
      ].map(query => this.metrics.query(query, at / 1000)),
    ]);
    const [cpuCores, availableMemory, totalMemory, memoryAge] = host.map(rows => rows.length === 1 ? Number(rows[0].value[1]) : NaN);
    if (![cpuCores, availableMemory, totalMemory, memoryAge].every(Number.isFinite) || cpuCores <= 0 ||
        totalMemory <= 0 || availableMemory < 0 || availableMemory > totalMemory || memoryAge < 0 || memoryAge > 90) {
      throw new ServiceUnavailableException('최신 서버 사용량을 확인하지 못했습니다.');
    }
    const pending = this.users.listAdmissionReservations().filter(row => !snapshot.observed.has(`user-${row.login}`)).length;
    const reason = snapshot.reason(pending + 1);
    const cpuBudget = Math.max(0, Math.round((snapshot.cpuRemaining - pending * APP_CPU - MIN_CPU) * 1000));
    const memoryBudget = Math.max(0, snapshot.memoryRemaining - pending * APP_MEMORY - MIN_MEMORY);
    const cpuMillicores = Math.floor(Math.min(cpuBudget, (MAX_USAGE - snapshot.cpuUsed) * cpuCores * 1000,
      APP_RESOURCE_BOUNDS.maxCpuMillicores) / 10) * 10;
    const memoryMiB = Math.floor(Math.min(memoryBudget, (MAX_USAGE - snapshot.memoryUsed) * totalMemory,
      availableMemory - (1 - MAX_USAGE) * totalMemory, APP_RESOURCE_BOUNDS.maxMemoryMiB * Mi) / (64 * Mi)) * 64;
    const suggestedLimits = !reason && cpuMillicores >= APP_RESOURCE_BOUNDS.minCpuMillicores && memoryMiB >= APP_RESOURCE_BOUNDS.minMemoryMiB
      ? { cpuMillicores, memoryMiB } : null;
    return {
      checkedAt: new Date(at).toISOString(),
      cpu: { totalMillicores: cpuCores * 1000, idleMillicores: Math.round((1 - snapshot.cpuUsed) * cpuCores * 1000) },
      memory: { totalMiB: Math.floor(totalMemory / Mi), availableMiB: Math.floor(availableMemory / Mi) },
      deployment: {
        reason, pending,
        availableMillicores: cpuBudget,
        availableMemoryMiB: Math.floor(memoryBudget / Mi),
        requiredMillicores: APP_CPU * 1000, requiredMemoryMiB: APP_MEMORY / Mi,
        safetyMillicores: MIN_CPU * 1000, safetyMemoryMiB: MIN_MEMORY / Mi,
        usageCeilingPercent: MAX_USAGE * 100,
        suggestedLimits,
      },
    };
  }

  async reserve(login: string, mode: 'register' | 'resume' = 'register'): Promise<void> {
    const at = Date.now();
    const snapshot = await this.snapshot(at);
    const loginLc = login.toLowerCase();
    if (snapshot.observed.has(`user-${loginLc}`)) throw new ConflictException({ reason: 'NAMESPACE_NOT_CLEARED', message: mode === 'resume'
      ? '서버 지표에 이전 파드의 자원이 남아 있습니다. 잠시 후 다시 시도해 주세요.'
      : '이전 앱의 자원이 아직 남아 있습니다. 삭제 완료 후 다시 시도하거나 운영자에게 문의해 주세요.' });
    const pending = this.users.listAdmissionReservations();
    const unobserved = pending.filter(row => !snapshot.observed.has(`user-${row.login}`) && row.login !== loginLc);
    if (snapshot.reason(unobserved.length + 1, unobserved.length + Number(mode === 'register'))) {
      throw new ServiceUnavailableException({ reason: 'CAPACITY_UNAVAILABLE', message: mode === 'resume'
        ? '서버에 여유 자원이 부족해 앱을 다시 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.'
        : '서버의 배포 여유가 부족해 신규 배포를 보류했습니다. 기존 앱은 유지됩니다. 잠시 후 다시 시도하거나 운영자에게 문의해 주세요.' });
    }
    for (const row of pending) if (snapshot.observed.has(`user-${row.login}`)) this.users.releaseAdmissionReservation(row.login);
    this.users.reserveAdmission(loginLc, at);
  }
}
