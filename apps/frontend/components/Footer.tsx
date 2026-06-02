import Link from 'next/link';

const socialLinks = [
  {
    href: 'https://github.com/sungwookoo',
    label: 'GitHub',
  },
  {
    href: 'https://www.linkedin.com/in/sungwookoo/',
    label: 'LinkedIn',
  },
  {
    href: 'mailto:sungwookoo.dev@gmail.com',
    label: 'Email',
  },
];

const internalLinks = [
  { href: '/' as const, label: 'Home' },
  { href: '/deploy' as const, label: 'Deploy' },
  { href: '/observatory' as const, label: 'Observatory' },
  { href: '/about' as const, label: 'About' },
];

const externalSiteLinks = [
  { href: 'https://argocd.swkoo.kr', label: 'Argo CD' },
];

export function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="border-t border-slate-800 bg-slate-950">
      <div className="mx-auto max-w-5xl px-6 py-12">
        <div className="grid gap-8 md:grid-cols-3">
          {/* Brand */}
          <div className="space-y-4">
            <Link
              href="/"
              className="flex items-center gap-2 text-lg font-bold text-slate-100"
            >
              <span className="text-xl">🐟</span>
              <span>swkoo.kr</span>
            </Link>
            <p className="text-sm text-slate-400">
              GitHub repo 하나로 앱을 라이브로.
              <br />
              그 인프라는 운영 콘솔에서 그대로 공개됩니다.
            </p>
          </div>

          {/* Site Links */}
          <div>
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-300">
              Navigation
            </h3>
            <ul className="space-y-2">
              {internalLinks.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-sm text-slate-400 transition-colors hover:text-zinc-100"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
              {externalSiteLinks.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-slate-400 transition-colors hover:text-zinc-100"
                  >
                    {link.label} ↗
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Contact */}
          <div>
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-300">
              Contact
            </h3>
            <ul className="space-y-2">
              {socialLinks.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    target={link.href.startsWith('mailto:') ? undefined : '_blank'}
                    rel={link.href.startsWith('mailto:') ? undefined : 'noopener noreferrer'}
                    className="text-sm text-slate-400 transition-colors hover:text-zinc-100"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Bottom */}
        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-slate-800 pt-8 md:flex-row">
          <p className="text-sm text-slate-500">
            © {currentYear} Sungwoo Koo. All rights reserved.
          </p>
          <p className="text-sm text-slate-600">
            Built with Next.js · Deployed on K3s
          </p>
        </div>
      </div>
    </footer>
  );
}

