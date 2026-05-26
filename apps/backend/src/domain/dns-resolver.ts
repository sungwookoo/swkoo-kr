import { Injectable, Logger } from '@nestjs/common';
import { Resolver } from 'node:dns/promises';

const DEFAULT_RESOLVERS = ['1.1.1.1'];
const TIMEOUT_MS = 5_000;
const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 1_000;

/** External DNS lookups for custom domain verification. We deliberately
 * bypass the cluster's CoreDNS — it caches NXDOMAIN aggressively and we
 * want propagation to be reflected within a few seconds of the user
 * adding a record. Configurable via DNS_RESOLVERS env (comma-separated)
 * for tests / disaster-mitigation. */
@Injectable()
export class DnsResolver {
  private readonly logger = new Logger(DnsResolver.name);
  private readonly resolvers: string[];

  constructor() {
    const raw = process.env.DNS_RESOLVERS;
    this.resolvers = raw
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : DEFAULT_RESOLVERS;
    if (this.resolvers.length === 0) {
      this.resolvers.push(...DEFAULT_RESOLVERS);
    }
    this.logger.log(`DNS resolvers: ${this.resolvers.join(',')}`);
  }

  private makeResolver(): Resolver {
    const r = new Resolver({ timeout: TIMEOUT_MS, tries: 1 });
    r.setServers(this.resolvers);
    return r;
  }

  /** Returns concatenated TXT chunks (Node returns string[][]; each inner
   * array is the chunks of a single record, multiple records are
   * concatenated with newline). Empty array when the name has no TXT or
   * doesn't resolve. */
  async resolveTxt(name: string): Promise<string[]> {
    return this.withRetry('TXT', name, async () => {
      const r = this.makeResolver();
      const records = await r.resolveTxt(name);
      return records.map((chunks) => chunks.join(''));
    });
  }

  /** Returns the CNAME targets (Node may return multiple for unusual
   * setups; we typically use the first). Empty array on NXDOMAIN or no
   * CNAME (note: NXDOMAIN throws; we map to empty for the verify caller). */
  async resolveCname(name: string): Promise<string[]> {
    return this.withRetry('CNAME', name, async () => {
      const r = this.makeResolver();
      return r.resolveCname(name);
    });
  }

  private async withRetry<T>(
    kind: string,
    name: string,
    fn: () => Promise<T>
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException).code;
        // NXDOMAIN / NODATA are deterministic — no point retrying.
        if (code === 'ENOTFOUND' || code === 'ENODATA') {
          throw err;
        }
        if (attempt < RETRY_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * attempt));
        }
      }
    }
    this.logger.warn(
      `DNS ${kind} ${name} failed after ${RETRY_ATTEMPTS} attempts: ${(lastErr as Error).message}`
    );
    throw lastErr;
  }
}
