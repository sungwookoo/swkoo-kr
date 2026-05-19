import { subdomainErrorMessage, validateSubdomainFormat } from './subdomain';

describe('validateSubdomainFormat', () => {
  it.each([
    ['myapp'],
    ['my-app'],
    ['a1b'],
    ['abc'],
    ['my-cool-app-2026'],
    // exactly 63 chars (DNS label max)
    ['a' + 'b'.repeat(61) + 'c'],
  ])('accepts %s', (slug) => {
    expect(validateSubdomainFormat(slug)).toEqual({ ok: true });
  });

  it.each([
    // too short (<3)
    ['ab'],
    ['a'],
    [''],
    // too long (>63)
    ['a' + 'b'.repeat(62) + 'c'],
    // uppercase
    ['MyApp'],
    // leading hyphen
    ['-abc'],
    // trailing hyphen
    ['abc-'],
    // invalid chars
    ['my_app'],
    ['my.app'],
    ['my app'],
    // unicode
    ['앱'],
  ])('rejects %s as FORMAT', (slug) => {
    expect(validateSubdomainFormat(slug)).toEqual({ ok: false, reason: 'FORMAT' });
  });

  it.each([
    ['www'],
    ['api'],
    ['admin'],
    ['swkoo'],
    ['argocd'],
    ['production'],
    ['privacy'],
  ])('rejects reserved name %s', (slug) => {
    expect(validateSubdomainFormat(slug)).toEqual({ ok: false, reason: 'RESERVED' });
  });
});

describe('subdomainErrorMessage', () => {
  it('returns a non-empty message for each reason', () => {
    expect(subdomainErrorMessage('FORMAT')).toMatch(/3~63/);
    expect(subdomainErrorMessage('RESERVED')).toMatch(/예약/);
    expect(subdomainErrorMessage('TAKEN')).toMatch(/다른 사용자/);
  });
});
