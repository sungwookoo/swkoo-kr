import type { ArgoCdApplication } from '../pipelines/types/argo-cd.types';

/** Require the compared source and resource summary to agree with the desired
 * image. An old Healthy status alone does not establish a new deployment. */
export function readyImageDigest(app: ArgoCdApplication | null, login: string, repo: string): string | null {
  const status = app?.status;
  if (status?.sync?.status !== 'Synced' || status.health?.status !== 'Healthy') return null;
  if (status.operationState?.phase !== 'Succeeded') return null;
  const imageRepo = `ghcr.io/${login}/${repo}`.toLowerCase();
  const matches = (image: string) => image.toLowerCase().startsWith(`${imageRepo}:`)
    || image.toLowerCase().startsWith(`${imageRepo}@`);
  const desired = app?.spec.source?.kustomize?.images?.find(matches);
  const digest = desired?.match(/@(sha256:[a-f0-9]{64})$/)?.[1];
  if (!digest || !desired) return null;
  if (!status.sync.comparedTo?.source?.kustomize?.images?.includes(desired)) return null;
  if (!status.summary?.images?.some((image) => matches(image) && image.endsWith(`@${digest}`))) return null;
  return digest;
}

