import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { UsersRepository } from '../onboarding/users.repository';
import { MetricSample, PlatformMetricsService } from './platform-metrics.service';

const Gi = 1024 ** 3;
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
];

/** Pending admissions survive restarts until observed in the same request
 * snapshot. Recovery of an existing registered app remains available. */
@Injectable()
export class DeploymentAdmissionService {
  constructor(private readonly metrics: PlatformMetricsService, private readonly users: UsersRepository) {}

  async reserve(login: string): Promise<void> {
    const at = Date.now();
    const data = await Promise.all(ADMISSION_QUERIES.map(query => this.metrics.query(query, at / 1000)));
    const invalid = (): never => { throw new ServiceUnavailableException({ reason: 'CAPACITY_UNVERIFIED', message: '서버 여유를 확인하지 못해 신규 배포를 보류했습니다. 잠시 후 다시 시도해 주세요.' }); };
    const one = (rows: MetricSample[]) => rows.length === 1 ? Number(rows[0].value[1]) : invalid();
    const [allocation, conditions, requests, init, cpu, memory, disk, ...checks] = data;
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
    const pending = this.users.listAdmissionReservations();
    const observed = new Set(requests.map(row => row.metric.namespace));
    if (observed.has(`user-${login.toLowerCase()}`)) throw new ConflictException({ reason: 'NAMESPACE_NOT_CLEARED', message: '이전 앱의 자원이 아직 남아 있습니다. 삭제 완료 후 다시 시도하거나 운영자에게 문의해 주세요.' });
    const unobserved = pending.filter(row => !observed.has(`user-${row.login}`) && row.login !== login.toLowerCase());
    const requestedCpu = [...pods.values()].reduce((sum, pod) => sum + Math.max(pod.cpu, pod.initCpu), 0);
    const requestedMemory = [...pods.values()].reduce((sum, pod) => sum + Math.max(pod.memory, pod.initMemory), 0);
    // Two slots for initial + replacement pods, plus a full 1Gi PVC budget.
    if (blocked || cpuUsed >= 0.70 || memoryUsed >= 0.70 ||
        allocated('cpu') - requestedCpu - (unobserved.length + 1) * 0.2 < 1 ||
        allocated('memory') - requestedMemory - (unobserved.length + 1) * 512 * 1024 ** 2 < 4 * Gi ||
        diskFree - (unobserved.length + 1) * Gi < 5 * Gi) {
      throw new ServiceUnavailableException({ reason: 'CAPACITY_UNAVAILABLE', message: '서버의 배포 여유가 부족해 신규 배포를 보류했습니다. 기존 앱은 유지됩니다. 잠시 후 다시 시도하거나 운영자에게 문의해 주세요.' });
    }
    for (const row of pending) if (observed.has(`user-${row.login}`)) this.users.releaseAdmissionReservation(row.login);
    this.users.reserveAdmission(login.toLowerCase(), at);
  }
}
