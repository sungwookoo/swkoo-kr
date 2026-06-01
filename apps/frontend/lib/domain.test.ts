import { describe, expect, it } from 'vitest';

import {
  buildZoneFile,
  panelErrorText,
  zoneFileName,
  type DomainDnsRecords,
  type ReasonedError,
} from './domain';

// ---------------- panelErrorText ----------------

function makeErr(overrides: Partial<ReasonedError> = {}): ReasonedError {
  const err = new Error(overrides.message ?? 'failure') as ReasonedError;
  err.reason = overrides.reason;
  err.status = overrides.status;
  err.registrableDomain = overrides.registrableDomain;
  err.suggestedSubdomain = overrides.suggestedSubdomain;
  return err;
}

describe('panelErrorText — reason → 한국어 메시지 매핑', () => {
  it.each([
    ['NOT_OWNER', /본인 앱의 도메인/],
    ['NOT_ALLOWED', /도메인 관리 권한이 없습니다/],
    ['NO_DEPLOYMENT', /활성 배포가 없습니다/],
    ['REPO_NOT_CURRENT', /현재 활성 배포된 앱이 아닙니다/],
    ['DOMAIN_ALREADY_REGISTERED', /이미 도메인이 등록/],
    ['DOMAIN_TAKEN', /이미 다른 사용자가 등록한 도메인/],
    ['APEX_NOT_SUPPORTED', /서브도메인만 지원/],
    ['SWKOO_DOMAIN', /swkoo\.kr 도메인은 사용할 수 없습니다/],
    ['RESERVED_DOMAIN', /예시\/테스트용 도메인/],
    ['WILDCARD', /와일드카드/],
    ['IP_ADDRESS', /IP 주소는 사용할 수 없습니다/],
    ['PROTOCOL_OR_PATH', /도메인만 입력/],
  ])('%s reason → 한국어 메시지', (reason, pattern) => {
    expect(panelErrorText(makeErr({ reason }))).toMatch(pattern);
  });

  it('401 status with no reason → 로그인 필요 메시지', () => {
    expect(panelErrorText(makeErr({ status: 401 }))).toMatch(/로그인이 필요합니다/);
  });

  it('DOMAIN_VERIFY_COOLDOWN passes backend message verbatim (preserves N초 남았습니다)', () => {
    const err = makeErr({
      reason: 'DOMAIN_VERIFY_COOLDOWN',
      message: '재시도까지 17초 남았습니다. 잠시 후 다시 시도해 주세요.',
    });
    expect(panelErrorText(err)).toBe(err.message);
  });

  it('DNS_CNAME_CONFLICTS_WITH_A passes the backend conflict copy verbatim', () => {
    // Backend writes the full diagnostic — frontend shouldn't replace it.
    const err = makeErr({
      reason: 'DNS_CNAME_CONFLICTS_WITH_A',
      message: 'www.zieun.dev은 현재 다른 서비스(Vercel 등)로 …',
    });
    expect(panelErrorText(err)).toBe(err.message);
  });

  it('unknown reason → err.message fallback', () => {
    expect(
      panelErrorText(makeErr({ reason: 'UNRECOGNIZED_REASON_XYZ', message: 'raw' }))
    ).toBe('raw');
  });

  it('undefined err → null', () => {
    expect(panelErrorText(undefined)).toBeNull();
  });
});

// ---------------- zoneFileName ----------------

describe('zoneFileName — slug derivation', () => {
  it.each([
    ['portfolio.zieun.dev', 'swkoo-dns-records-portfolio-zieun-dev.txt'],
    ['App.Example.COM', 'swkoo-dns-records-app-example-com.txt'],
    ['service.api.mybiz.co.kr', 'swkoo-dns-records-service-api-mybiz-co-kr.txt'],
    // Mixed special chars + leading/trailing dashes get squashed.
    ['..foo--bar.baz.', 'swkoo-dns-records-foo-bar-baz.txt'],
  ])('%s → %s', (input, expected) => {
    expect(zoneFileName(input)).toBe(expected);
  });
});

// ---------------- buildZoneFile ----------------

const cnameTokenRecords: DomainDnsRecords = {
  txt: null,
  cname: {
    host: 'portfolio.zieun.dev',
    target: 'cd-sk-fec0757b3fde4cf5be766e2007b876cd.domains.swkoo.kr',
  },
};

const txtCnameRecords: DomainDnsRecords = {
  txt: {
    host: '_swkoo-challenge.www.zieun.dev',
    value: 'swkoo-domain-verification=sk-deadbeef',
  },
  cname: {
    host: 'www.zieun.dev',
    target: 'zieun-ai-portfolio.apps.swkoo.kr',
  },
};

describe('buildZoneFile — cname_token (v0.2, CNAME only)', () => {
  const out = buildZoneFile(cnameTokenRecords);

  it('contains TTL directive and FQDN-form CNAME (trailing dot)', () => {
    expect(out).toContain('$TTL 300');
    expect(out).toContain(
      'portfolio.zieun.dev. 300 IN CNAME cd-sk-fec0757b3fde4cf5be766e2007b876cd.domains.swkoo.kr.'
    );
  });

  it('emits exactly ONE record line (no TXT for cname_token)', () => {
    const recordLines = out
      .split('\n')
      .filter((l) => /^\S+ 300 IN /.test(l));
    expect(recordLines).toHaveLength(1);
    expect(recordLines[0]).toMatch(/CNAME/);
    expect(out).not.toMatch(/ IN TXT /);
  });
});

describe('buildZoneFile — txt_cname (legacy, TXT + CNAME)', () => {
  const out = buildZoneFile(txtCnameRecords);

  it('contains BOTH TXT and CNAME lines with FQDN trailing dots', () => {
    expect(out).toContain(
      '_swkoo-challenge.www.zieun.dev. 300 IN TXT "swkoo-domain-verification=sk-deadbeef"'
    );
    expect(out).toContain(
      'www.zieun.dev. 300 IN CNAME zieun-ai-portfolio.apps.swkoo.kr.'
    );
  });

  it('emits exactly TWO record lines', () => {
    const recordLines = out
      .split('\n')
      .filter((l) => /^\S+ 300 IN /.test(l));
    expect(recordLines).toHaveLength(2);
  });

  it('escapes backslash and double-quote in TXT value', () => {
    const tricky: DomainDnsRecords = {
      txt: { host: 'x.example.com', value: 'has"quote\\and-backslash' },
      cname: { host: 'x.example.com', target: 't.apps.swkoo.kr' },
    };
    const o = buildZoneFile(tricky);
    expect(o).toContain('"has\\"quote\\\\and-backslash"');
  });
});
