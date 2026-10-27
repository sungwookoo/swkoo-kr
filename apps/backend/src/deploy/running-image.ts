import type { V1Pod } from '@kubernetes/client-node';

// A rollout with two distinct images has no single authoritative scan target.
export function runningImage(pods: V1Pod[], containerName: string): string | null {
  const images = new Set<string>();
  for (const pod of pods) {
    if (pod.metadata?.deletionTimestamp || pod.status?.phase !== 'Running') continue;
    const status = pod.status.containerStatuses?.find(c => c.name === containerName);
    if (!status?.ready) continue;
    const spec = pod.spec?.containers.find(c => c.name === containerName);
    const digest = status.imageID?.match(/sha256:[a-f0-9]{64}$/)?.[0];
    if (!digest || !spec?.image) return null;
    const repository = spec.image.split('@')[0].replace(/:[^/:]+$/, '');
    images.add(`${repository}@${digest}`);
  }
  return images.size === 1 ? [...images][0] : null;
}
