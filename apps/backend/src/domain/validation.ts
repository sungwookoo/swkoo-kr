import { parse } from 'tldts';

export type RejectReason =
  | 'EMPTY'
  | 'PROTOCOL_OR_PATH'
  | 'WILDCARD'
  | 'IP_ADDRESS'
  | 'TOO_LONG'
  | 'INVALID_LABEL'
  | 'INVALID_TLD'
  | 'SWKOO_DOMAIN'
  | 'APEX_NOT_SUPPORTED'
  | 'RESERVED_DOMAIN';

export const REJECT_MESSAGES: Record<RejectReason, string> = {
  EMPTY: '도메인을 입력해 주세요.',
  PROTOCOL_OR_PATH: '도메인만 입력해 주세요. (https://, 슬래시 제외)',
  WILDCARD: '와일드카드(*) 도메인은 지원하지 않습니다.',
  IP_ADDRESS: 'IP 주소는 사용할 수 없습니다.',
  TOO_LONG: '도메인이 너무 깁니다. (최대 253자)',
  INVALID_LABEL: '도메인 형식이 올바르지 않습니다.',
  INVALID_TLD: '유효한 TLD가 아닙니다.',
  SWKOO_DOMAIN: 'swkoo.kr 도메인은 사용할 수 없습니다.',
  APEX_NOT_SUPPORTED:
    'v0은 서브도메인만 지원합니다. (app.example.com 형식, example.com 같은 apex는 지원 예정)',
  RESERVED_DOMAIN:
    '예시/테스트용 도메인(example.com 등)은 등록할 수 없습니다.',
};

/** Documentation/test reserved 2nd-level domains (RFC 2606 / 6761).
 * Apex itself is rejected by APEX_NOT_SUPPORTED; this catches the
 * `app.example.com` style where someone literally types the docs example. */
const RESERVED_REGISTRABLE_DOMAINS = new Set([
  'example.com',
  'example.net',
  'example.org',
  'example.edu',
]);

export interface ValidationResult {
  ok: boolean;
  reason?: RejectReason;
  /** Normalized lower-cased domain when ok=true. */
  normalized?: string;
  /** Registrable domain (e.g. `app.example.co.kr` → `example.co.kr`) when ok=true. */
  registrable?: string;
}

/** Per the v0 scope: subdomain custom domains only. swkoo.kr / wildcard /
 *  IP / protocol prefix / apex / reserved docs domains all rejected.
 *  Uses tldts (public suffix list) for apex detection so co.kr / co.uk and
 *  other multi-label TLDs are handled correctly. */
export function validateCustomDomain(input: string): ValidationResult {
  if (!input) return { ok: false, reason: 'EMPTY' };
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'EMPTY' };
  if (trimmed.includes('://') || trimmed.includes('/')) {
    return { ok: false, reason: 'PROTOCOL_OR_PATH' };
  }
  if (trimmed.includes('*')) return { ok: false, reason: 'WILDCARD' };
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(trimmed)) {
    return { ok: false, reason: 'IP_ADDRESS' };
  }
  if (trimmed.length > 253) return { ok: false, reason: 'TOO_LONG' };

  const normalized = trimmed.toLowerCase();

  // Label syntax — before tldts, because tldts rejects malformed labels
  // (leading/trailing dash, underscore, unicode) as no-domain which would
  // otherwise surface as INVALID_TLD and obscure the real cause.
  const labels = normalized.split('.');
  for (const l of labels) {
    if (l.length === 0 || l.length > 63) return { ok: false, reason: 'INVALID_LABEL' };
    if (!/^[a-z0-9-]+$/.test(l)) return { ok: false, reason: 'INVALID_LABEL' };
    if (l.startsWith('-') || l.endsWith('-')) return { ok: false, reason: 'INVALID_LABEL' };
  }

  const parsed = parse(normalized);

  // tldts.parse marks isIp / isIcann / isPrivate. Require an ICANN/private
  // entry so .test / .invalid / .localhost / .example reserved by the
  // public suffix list are caught here (they're isIcann=false).
  if (!parsed.domain || (!parsed.isIcann && !parsed.isPrivate)) {
    return { ok: false, reason: 'INVALID_TLD' };
  }

  // swkoo.kr is ours — any subdomain (including apps.swkoo.kr) is internal,
  // not a customer-controlled domain. Reject so users can't shadow internal
  // hostnames.
  if (parsed.domain === 'swkoo.kr') {
    return { ok: false, reason: 'SWKOO_DOMAIN' };
  }

  // Apex: the entered hostname IS the registrable domain. v1 territory.
  if (normalized === parsed.domain) {
    return { ok: false, reason: 'APEX_NOT_SUPPORTED' };
  }

  // RFC 2606 docs domains — user literally typed our placeholder.
  if (RESERVED_REGISTRABLE_DOMAINS.has(parsed.domain)) {
    return { ok: false, reason: 'RESERVED_DOMAIN' };
  }

  return { ok: true, normalized, registrable: parsed.domain };
}
