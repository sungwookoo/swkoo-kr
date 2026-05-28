import useSWR from 'swr';

import { API_BASE_URL } from './api-base';

export interface Me {
  id: number;
  githubLogin: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  isAllowed: boolean;
  isAdmin: boolean;
  requiresReauth: boolean;
  requiresConsent: boolean;
  policyVersion: string;
  brandName: string;
}

export async function acceptConsent(version: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/auth/consent`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version }),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
}

async function fetcher(url: string): Promise<Me | null> {
  const response = await fetch(url, { credentials: 'include' });
  if (response.status === 401) return null;
  if (!response.ok) {
    throw new Error(`auth/me failed: ${response.status}`);
  }
  return (await response.json()) as Me;
}

export const ME_SWR_KEY = `${API_BASE_URL}/auth/me`;

export function useMe(): {
  me: Me | null | undefined;
  isLoading: boolean;
  error: Error | undefined;
} {
  const { data, error, isLoading } = useSWR<Me | null>(ME_SWR_KEY, fetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  return { me: data, isLoading, error };
}

/** Pure OAuth login — for users who already installed the swkoo-deploy
 * App on at least one repo. */
export function loginUrl(): string {
  return `${API_BASE_URL}/auth/github/login`;
}

/** GitHub App installation — for new users who need to grant repo access.
 * Lands on GitHub's installation screen, then returns through /callback. */
export function installUrl(): string {
  return `${API_BASE_URL}/auth/github/install`;
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE_URL}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  });
}
