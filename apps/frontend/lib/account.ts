import useSWR from 'swr';

import { API_BASE_URL } from './api-base';

export interface ScanFinding {
  id: string;
  pkg: string;
  installed: string;
  fixed: string | null;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  title: string;
  url: string;
}

export interface LatestScan {
  id: number;
  userId: number;
  image: string;
  critical: number;
  high: number;
  medium: number;
  scannedAt: string;
  trivyVersion: string | null;
  findings: ScanFinding[];
}

async function fetcher<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export function useLatestScan(enabled: boolean): {
  scan: LatestScan | null | undefined;
  isLoading: boolean;
  error: Error | undefined;
} {
  const { data, error, isLoading } = useSWR<LatestScan | null>(
    enabled ? `${API_BASE_URL}/account/scan` : null,
    fetcher
  );
  return { scan: data, isLoading, error };
}

/** Triggers a JSON download with everything the service knows about the
 * signed-in user. Browser does the actual file save. */
export async function exportMyData(login: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/account/export`, {
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `swkoo-${login}-data-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function deleteMyAccount(): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/account`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
}
