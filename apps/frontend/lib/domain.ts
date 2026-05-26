import useSWR from 'swr';

import { API_BASE_URL } from './api-base';

export type CustomDomainStatus = 'pending' | 'verified' | 'applying' | 'active' | 'error';

export interface DomainDnsRecords {
  txt: { host: string; value: string };
  cname: { host: string; target: string };
}

export interface DomainInfo {
  domain: string | null;
  status: CustomDomainStatus | null;
  verificationToken: string | null;
  dnsRecords: DomainDnsRecords | null;
  verifiedAt: string | null;
  lastError: string | null;
  certificateReady: boolean;
  certificateError: string | null;
  url: string | null;
}

export function domainSwrKey(login: string, repo: string): string {
  return `${API_BASE_URL}/deploy/domain/${encodeURIComponent(login)}/${encodeURIComponent(repo)}`;
}

async function fetcher<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    throw await toReasonedError(response, '도메인 조회 실패');
  }
  return (await response.json()) as T;
}

/** Backend errors arrive as `{ statusCode, message: { reason, message } }`
 * or as plain strings. We collapse both shapes into an Error carrying the
 * machine `reason` so the panel can branch on it. */
async function toReasonedError(response: Response, fallback: string): Promise<Error> {
  let payload: { message?: string | { reason?: string; message?: string } } = {};
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    // body wasn't JSON (e.g. ingress 502); fall through to fallback.
  }
  const detail = payload.message;
  if (detail && typeof detail === 'object' && 'reason' in detail) {
    const err = new Error(detail.message ?? detail.reason ?? fallback) as Error & {
      reason?: string;
      status?: number;
    };
    err.reason = detail.reason;
    err.status = response.status;
    return err;
  }
  const err = new Error(
    typeof detail === 'string' ? detail : `${fallback} (${response.status})`
  ) as Error & { status?: number };
  err.status = response.status;
  return err;
}

/** Panel reads. Polls when status is `applying` (cert issuance ~30-90s) so
 *  the user sees the green flip without manual refresh; idle otherwise. */
export function useDomain(login: string | null, repo: string | null): {
  domain: DomainInfo | undefined;
  isLoading: boolean;
  error: (Error & { reason?: string; status?: number }) | undefined;
  refresh: () => Promise<DomainInfo | undefined>;
} {
  const key = login && repo ? domainSwrKey(login, repo) : null;
  const { data, error, isLoading, mutate } = useSWR<DomainInfo>(key, fetcher, {
    revalidateOnFocus: true,
    refreshInterval: (latest) => (latest?.status === 'applying' ? 5_000 : 0),
  });
  return {
    domain: data,
    isLoading,
    error: error as (Error & { reason?: string; status?: number }) | undefined,
    refresh: () => mutate(),
  };
}

export async function registerDomain(
  login: string,
  repo: string,
  domain: string
): Promise<DomainInfo> {
  const response = await fetch(domainSwrKey(login, repo), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain }),
  });
  if (!response.ok) {
    throw await toReasonedError(response, '도메인 등록 실패');
  }
  return (await response.json()) as DomainInfo;
}

export async function verifyDomain(login: string, repo: string): Promise<DomainInfo> {
  const response = await fetch(`${domainSwrKey(login, repo)}/verify`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!response.ok) {
    throw await toReasonedError(response, 'DNS 확인 실패');
  }
  return (await response.json()) as DomainInfo;
}

export async function deleteDomain(login: string, repo: string): Promise<void> {
  const response = await fetch(domainSwrKey(login, repo), {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!response.ok && response.status !== 204) {
    throw await toReasonedError(response, '도메인 삭제 실패');
  }
}

/** Translate machine reasons → Korean panel copy. Backend already returns
 *  Korean `message` text; this is a fallback / annotation layer that
 *  picks a panel-specific phrasing for known reasons (e.g. NOT_OWNER ≠
 *  "도메인 관리 권한이 없습니다" — frontend says "이 페이지의 도메인은
 *  본인이 아닙니다"). Unknown reasons fall back to the raw `err.message`. */
export function panelErrorText(
  err: (Error & { reason?: string; status?: number }) | undefined
): string | null {
  if (!err) return null;
  switch (err.reason) {
    case 'NOT_OWNER':
      return '본인 앱의 도메인만 관리할 수 있습니다.';
    case 'NOT_ALLOWED':
      return '도메인 관리 권한이 없습니다. 운영자에게 문의하세요.';
    case 'NO_DEPLOYMENT':
      return '활성 배포가 없습니다. 먼저 앱을 배포하세요.';
    case 'REPO_NOT_CURRENT':
      return '현재 활성 배포된 앱이 아닙니다. URL의 repo 부분을 확인하세요.';
    case 'DOMAIN_ALREADY_REGISTERED':
      return '이 앱에 이미 도메인이 등록되어 있습니다.';
    case 'DOMAIN_TAKEN':
      return '이미 다른 사용자가 등록한 도메인입니다.';
    case 'APEX_NOT_SUPPORTED':
      return 'v0는 서브도메인만 지원합니다 (예: app.example.com).';
    case 'SWKOO_DOMAIN':
      return 'swkoo.kr 도메인은 사용할 수 없습니다.';
    case 'RESERVED_DOMAIN':
      return '예시/테스트용 도메인은 등록할 수 없습니다.';
    case 'WILDCARD':
      return '와일드카드(*) 도메인은 지원하지 않습니다.';
    case 'IP_ADDRESS':
      return 'IP 주소는 사용할 수 없습니다.';
    case 'PROTOCOL_OR_PATH':
      return '도메인만 입력해 주세요. (https://, 슬래시 제외)';
    case 'INVALID_LABEL':
    case 'INVALID_TLD':
    case 'TOO_LONG':
    case 'EMPTY':
      return '도메인 형식이 올바르지 않습니다.';
    case 'DNS_TXT_NOT_FOUND':
    case 'DNS_TXT_MISMATCH':
    case 'DNS_TXT_ERROR':
    case 'DNS_CNAME_NOT_FOUND':
    case 'DNS_CNAME_MISMATCH':
    case 'DNS_CNAME_ERROR':
      return err.message ?? 'DNS 확인 실패';
    default:
      // Auth gate at /api boundary returns plain 401 (no reason).
      if (err.status === 401) return '로그인이 필요합니다.';
      return err.message ?? null;
  }
}
