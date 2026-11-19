export interface AppResourceLimits {
  cpuMillicores: number;
  memoryMiB: number;
}

export interface DeployPolicy extends AppResourceLimits {
  maxApps: number | null;
}

export const DEFAULT_APP_RESOURCES = { cpuMillicores: 500, memoryMiB: 512 };
export const APP_RESOURCE_BOUNDS = { minCpuMillicores: 100, maxCpuMillicores: 4000, minMemoryMiB: 256, maxMemoryMiB: 8192 };

export function resolveDeployPolicy(policy: DeployPolicy | null | undefined, isAdmin: boolean): DeployPolicy {
  return {
    ...DEFAULT_APP_RESOURCES,
    ...policy,
    maxApps: policy?.maxApps ?? (isAdmin ? null : 1),
  };
}

export function isDeployPolicy(value: unknown): value is DeployPolicy {
  if (!value || typeof value !== 'object') return false;
  const { maxApps, cpuMillicores, memoryMiB } = value as DeployPolicy;
  return (maxApps === null || (Number.isSafeInteger(maxApps) && maxApps >= 0))
    && Number.isInteger(cpuMillicores) && cpuMillicores >= APP_RESOURCE_BOUNDS.minCpuMillicores && cpuMillicores <= APP_RESOURCE_BOUNDS.maxCpuMillicores
    && Number.isInteger(memoryMiB) && memoryMiB >= APP_RESOURCE_BOUNDS.minMemoryMiB && memoryMiB <= APP_RESOURCE_BOUNDS.maxMemoryMiB;
}
