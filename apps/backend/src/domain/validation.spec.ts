import { validateCustomDomain } from './validation';

describe('validateCustomDomain', () => {
  describe('accepts valid subdomains', () => {
    it.each([
      ['app.example-user.com', 'example-user.com'],
      ['www.mydomain.net', 'mydomain.net'],
      ['demo.mysite.io', 'mysite.io'],
      // co.kr is a multi-label public suffix; tldts handles correctly.
      ['app.mybiz.co.kr', 'mybiz.co.kr'],
      ['portfolio.work.co.uk', 'work.co.uk'],
      // 4+ labels — deeper subdomain.
      ['a.b.c.example-host.com', 'example-host.com'],
      // numeric labels are OK as long as they're not full IP.
      ['v2.app.something.dev', 'something.dev'],
    ])('accepts %s → registrable %s', (input, registrable) => {
      const r = validateCustomDomain(input);
      expect(r.ok).toBe(true);
      expect(r.registrable).toBe(registrable);
      expect(r.normalized).toBe(input.toLowerCase());
    });

    it('lowercases and trims', () => {
      const r = validateCustomDomain('  APP.Example-User.COM  ');
      expect(r.ok).toBe(true);
      expect(r.normalized).toBe('app.example-user.com');
    });
  });

  describe('rejects malformed input', () => {
    it.each([
      ['', 'EMPTY'],
      ['   ', 'EMPTY'],
      ['https://app.example-user.com', 'PROTOCOL_OR_PATH'],
      ['app.example-user.com/path', 'PROTOCOL_OR_PATH'],
      ['*.example-user.com', 'WILDCARD'],
      ['*example-user.com', 'WILDCARD'],
      ['192.168.1.1', 'IP_ADDRESS'],
      ['10.0.0.1', 'IP_ADDRESS'],
      // 250+ chars
      [`a.${'x'.repeat(248)}.com`, 'TOO_LONG'],
      ['app..example-user.com', 'INVALID_LABEL'],     // empty label
      ['-app.example-user.com', 'INVALID_LABEL'],     // leading dash
      ['app-.example-user.com', 'INVALID_LABEL'],     // trailing dash
      ['app_v1.example-user.com', 'INVALID_LABEL'],   // underscore
      ['app.한글.com', 'INVALID_LABEL'],              // unicode (punycode not auto-converted)
    ])('rejects %s with %s', (input, expectedReason) => {
      const r = validateCustomDomain(input);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe(expectedReason);
    });
  });

  describe('rejects swkoo.kr family', () => {
    it.each([
      'swkoo.kr',
      'app.swkoo.kr',
      'apps.swkoo.kr',
      'foo.apps.swkoo.kr',
      'deep.nested.swkoo.kr',
    ])('rejects %s', (input) => {
      const r = validateCustomDomain(input);
      expect(r.ok).toBe(false);
      // swkoo.kr apex hits APEX_NOT_SUPPORTED; subdomains hit SWKOO_DOMAIN.
      // Either is a correct refusal; assert it's one of those two.
      expect(['SWKOO_DOMAIN', 'APEX_NOT_SUPPORTED']).toContain(r.reason);
    });
  });

  describe('rejects apex / registrable domain', () => {
    it.each([
      'example-user.com',        // plain apex
      'mybiz.co.kr',             // co.kr apex (multi-label public suffix)
      'work.co.uk',              // co.uk apex
      'something.dev',           // .dev apex
    ])('rejects apex %s as APEX_NOT_SUPPORTED', (input) => {
      expect(validateCustomDomain(input).reason).toBe('APEX_NOT_SUPPORTED');
    });
  });

  describe('rejects reserved documentation domains', () => {
    it.each([
      ['app.example.com', 'RESERVED_DOMAIN'],
      ['www.example.com', 'RESERVED_DOMAIN'],
      ['demo.example.net', 'RESERVED_DOMAIN'],
      ['x.example.org', 'RESERVED_DOMAIN'],
      ['foo.example.edu', 'RESERVED_DOMAIN'],
      // Apex of a reserved-docs domain: APEX check fires first (both correct rejections).
      ['example.com', 'APEX_NOT_SUPPORTED'],
    ])('rejects %s with %s', (input, expectedReason) => {
      expect(validateCustomDomain(input).reason).toBe(expectedReason);
    });
  });

  describe('rejects reserved special-use TLDs', () => {
    // .test / .invalid / .localhost / .example are not in the ICANN list;
    // tldts marks them isIcann=false, so we reject as INVALID_TLD.
    it.each([
      'foo.test',
      'foo.invalid',
      'foo.localhost',
      'service.local',
      'app.example',
    ])('rejects %s', (input) => {
      const r = validateCustomDomain(input);
      expect(r.ok).toBe(false);
      // INVALID_TLD or APEX (when 2-label) both acceptable refusals.
      expect(['INVALID_TLD', 'APEX_NOT_SUPPORTED']).toContain(r.reason);
    });
  });
});
