export interface StorageUsage {
  status: 'ready' | 'unknown' | 'not_configured';
  checkedAt?: string;
  usedBytes?: number;
  limitBytes?: number;
  remainingBytes?: number;
  usedInodes?: number;
  limitInodes?: number;
  remainingInodes?: number;
  warning?: 'near_limit' | 'full' | null;
}

/** Bind host counters to the authenticated namespace and exact running Pod. */
export function storageUsage(raw: string, namespace: string, claim: string, podUid: string, now = Date.now()): StorageUsage {
  try {
    const data = JSON.parse(raw), time = Date.parse(data.checkedAt);
    if (!Number.isFinite(time) || time > now + 5000 || now - time > 90_000 || !Array.isArray(data.volumes)) return { status: 'unknown' };
    const rows = data.volumes.filter((row: any) => row.namespace === namespace && row.claimName === claim &&
      typeof row.claimUid === 'string' && Array.isArray(row.podUids) && row.podUids.includes(podUid));
    if (rows.length !== 1) return { status: 'unknown' };
    const row = rows[0];
    if (['usedBytes','limitBytes','usedInodes','limitInodes'].some(key => !Number.isSafeInteger(row[key]) || row[key] < 0) ||
        row.limitBytes !== 1024 ** 3 || row.limitInodes !== 65536) return { status: 'unknown' };
    const ratio = Math.max(row.usedBytes / row.limitBytes, row.usedInodes / row.limitInodes);
    return { status: 'ready', checkedAt: data.checkedAt, usedBytes: row.usedBytes, limitBytes: row.limitBytes,
      remainingBytes: Math.max(0, row.limitBytes - row.usedBytes), usedInodes: row.usedInodes, limitInodes: row.limitInodes,
      remainingInodes: Math.max(0, row.limitInodes - row.usedInodes), warning: ratio >= 1 ? 'full' : ratio >= .8 ? 'near_limit' : null };
  } catch { return { status: 'unknown' }; }
}
