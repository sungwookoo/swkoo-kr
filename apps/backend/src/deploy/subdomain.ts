// User-chosen sub-slug validation for `<slug>.apps.swkoo.kr`.
//
// Rules:
//   - DNS label (RFC 1035): lowercase a-z, 0-9, hyphen; start/end alnum;
//     length 3-63 (min 3 keeps single-letter grabs off the table).
//   - Not in the reserved set below (subdomains we may want to use for
//     swkoo.kr operator services or that overlap with common conventions).
// Uniqueness across users is enforced by the partial UNIQUE index on
// users.subdomain — not checked here.

const FORMAT_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

const RESERVED: ReadonlySet<string> = new Set([
  // swkoo.kr operator surfaces we might host on the apps.* zone
  'swkoo', 'swkoo-kr', 'swkoo-deploy', 'swkoo-portfolio',
  // generic web conventions
  'www', 'mail', 'api', 'app', 'admin', 'auth', 'login', 'logout',
  'signup', 'signin', 'oauth', 'sso', 'register', 'account', 'settings',
  'dashboard', 'console', 'control', 'panel', 'home',
  'docs', 'doc', 'help', 'support', 'faq', 'status', 'blog', 'news',
  // platform / infra brand names a user might claim by accident
  'argocd', 'argo', 'grafana', 'prometheus', 'kibana', 'alertmanager',
  'kube', 'k8s', 'kubernetes', 'traefik', 'nginx',
  // observability / ops jargon we use in this project
  'monitor', 'monitoring', 'metrics', 'logs', 'alerts',
  'observability', 'observatory',
  'ci', 'build', 'runner', 'image', 'scan', 'security',
  // environment names
  'staging', 'prod', 'production', 'dev', 'development', 'demo',
  'test', 'beta', 'alpha',
  // ambiguous / dangerous
  'root', 'system', 'sys', 'private', 'public', 'internal', 'new',
  // legal pages we'll never want shadowed
  'privacy', 'terms', 'legal', 'tos',
]);

export type SubdomainCheck =
  | { ok: true }
  | { ok: false; reason: 'FORMAT' | 'RESERVED' };

export function validateSubdomainFormat(slug: string): SubdomainCheck {
  if (!FORMAT_RE.test(slug)) return { ok: false, reason: 'FORMAT' };
  if (RESERVED.has(slug)) return { ok: false, reason: 'RESERVED' };
  return { ok: true };
}

export function subdomainErrorMessage(reason: 'FORMAT' | 'RESERVED' | 'TAKEN'): string {
  switch (reason) {
    case 'FORMAT':
      return '3~63자, 소문자/숫자/하이픈만 사용 가능, 첫 글자와 마지막 글자는 영문/숫자.';
    case 'RESERVED':
      return '예약된 이름입니다. 다른 이름을 골라주세요.';
    case 'TAKEN':
      return '이미 다른 사용자가 쓰고 있는 이름입니다.';
  }
}
