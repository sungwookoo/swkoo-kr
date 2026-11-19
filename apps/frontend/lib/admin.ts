import useSWR from 'swr';

import { API_BASE_URL } from './api-base';
import type { DeployPolicy } from './auth';

export interface AdminUser {
  githubLogin: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  createdAt: string;
  lastLoginAt: string;
  isAllowed: boolean;
  deployPolicy?: DeployPolicy;
}

interface AdminUsersResponse {
  users: AdminUser[];
}

async function fetcher<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export const ADMIN_USERS_SWR_KEY = `${API_BASE_URL}/admin/users`;

export async function setUserDeployPolicy(login: string, policy: DeployPolicy): Promise<DeployPolicy> {
  const response = await fetch(`${ADMIN_USERS_SWR_KEY}/${encodeURIComponent(login)}/deploy-policy`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(policy),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof body?.message === 'string' ? body.message : '배포 한도를 저장하지 못했습니다.');
  return body.deployPolicy;
}

export function useAdminUsers(enabled: boolean): {
  users: AdminUser[] | undefined;
  isLoading: boolean;
  error: Error | undefined;
} {
  const { data, error, isLoading } = useSWR<AdminUsersResponse>(
    enabled ? ADMIN_USERS_SWR_KEY : null,
    fetcher,
    { revalidateOnFocus: false }
  );
  return { users: data?.users, isLoading, error };
}

export async function setUserAllowed(
  login: string,
  isAllowed: boolean
): Promise<{ ok: true; login: string; isAllowed: boolean }> {
  const response = await fetch(
    `${API_BASE_URL}/admin/users/${encodeURIComponent(login)}`,
    {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAllowed }),
    }
  );
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as { ok: true; login: string; isAllowed: boolean };
}
