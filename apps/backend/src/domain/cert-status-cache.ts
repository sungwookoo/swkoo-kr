import { Injectable, Logger } from '@nestjs/common';

import { KubeClient } from '../kube/kube.client';

const TTL_MS = 20_000;

export interface CertStatus {
  ready: boolean;
  reason?: string;
  message?: string;
  /** When the cert was last marked Ready=True. Useful for UI display. */
  notAfter?: string;
  /** When the cache observation was taken (epoch ms). */
  observedAt: number;
  /** Truthy when the live read failed (cluster unreachable, 404 etc.). */
  fetchError?: string;
}

/** Per-process LRU-ish cache for cert-manager Certificate status, used by
 *  GET /api/deploy/domain/:login/:repo to surface Ready state without
 *  hammering the kube API. 20s TTL — short enough that the panel feels
 *  live (cert issuance takes ~30-90s), long enough that opening a panel
 *  twice in a row is one read. */
@Injectable()
export class CertStatusCache {
  private readonly logger = new Logger(CertStatusCache.name);
  private cache = new Map<string, CertStatus>();

  constructor(private readonly kube: KubeClient) {}

  /** Returns the cached status if fresh; otherwise reads from k8s and
   * caches the result. Read failures are also cached so a thundering
   * herd from the frontend doesn't fan-out to N kube reads. */
  async get(namespace: string, name: string): Promise<CertStatus> {
    const key = `${namespace}/${name}`;
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && now - cached.observedAt < TTL_MS) return cached;
    const fresh = await this.read(namespace, name);
    this.cache.set(key, fresh);
    return fresh;
  }

  /** Force-invalidate a single entry, e.g. immediately after a DELETE
   * so a follow-up GET reflects the absence. */
  invalidate(namespace: string, name: string): void {
    this.cache.delete(`${namespace}/${name}`);
  }

  private async read(namespace: string, name: string): Promise<CertStatus> {
    const observedAt = Date.now();
    try {
      const cert = await this.kube.getCertificate(namespace, name);
      if (!cert) {
        return { ready: false, observedAt, fetchError: 'cert not found' };
      }
      const ready = cert.status?.conditions?.find((c) => c.type === 'Ready');
      return {
        ready: ready?.status === 'True',
        reason: ready?.reason,
        message: ready?.message,
        notAfter: cert.status?.notAfter,
        observedAt,
      };
    } catch (err) {
      const e = err as { code?: number; statusCode?: number; message?: string; body?: { code?: number } };
      const code = e.code ?? e.statusCode ?? e.body?.code;
      // 404 is normal when Cert hasn't been provisioned yet (verify ran
      // but ArgoCD hasn't synced, or cert-manager hasn't picked it up).
      // Log only the unexpected failures.
      if (code !== 404) {
        this.logger.warn(
          `getCertificate ${namespace}/${name} failed: ${e.message ?? String(err)}`
        );
      }
      return {
        ready: false,
        observedAt,
        fetchError: code === 404 ? 'cert not provisioned yet' : (e.message ?? 'kube read failed'),
      };
    }
  }
}
