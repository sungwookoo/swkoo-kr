import type { Metadata } from 'next';
import { IBM_Plex_Sans_KR, JetBrains_Mono } from 'next/font/google';

import './globals.css';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
// A fresh CSP nonce is attached to every rendered document.
export const dynamic = 'force-dynamic';

const sans = IBM_Plex_Sans_KR({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap'
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap'
});

export const metadata: Metadata = {
  title: 'swkoo.kr — GitHub repo가 라이브 앱이 됩니다',
  description:
    'GitHub에 연결하면 Dockerfile부터 Kubernetes 매니페스트까지 자동으로 생성·commit되고, ArgoCD가 배포합니다. 사용한 인프라는 운영 콘솔(Observatory)에서 그대로 공개됩니다.'
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className={`${sans.variable} ${mono.variable}`}>
      <body className="flex min-h-screen flex-col bg-ink text-slate-100 antialiased">
        <Header />
        <div className="flex-1 pt-16">{children}</div>
        <Footer />
      </body>
    </html>
  );
}
