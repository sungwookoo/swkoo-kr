import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: '공지사항 — swkoo.kr',
  description: 'swkoo.kr의 서비스 개선과 운영 소식을 전합니다.',
};

export default function NoticesPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-20 sm:py-24">
      <p className="font-mono text-xs tracking-widest text-zinc-500">UPDATES</p>
      <h1 className="mt-4 text-3xl font-semibold text-zinc-100">공지사항</h1>
      <p className="mt-4 text-sm leading-relaxed text-zinc-400">서비스를 조금씩 더 안전하고 편하게 만드는 소식을 전합니다.</p>
      <ul className="mt-12 border-y border-zinc-800">
        <li className="border-b border-zinc-800">
          <Link href="/notices/2026-10-29-storage-update" className="group block py-7 focus-visible:outline focus-visible:outline-offset-4 focus-visible:outline-zinc-400">
            <time dateTime="2026-10-29" className="font-mono text-xs text-zinc-500">2026.10.29</time>
            <h2 className="mt-3 text-lg font-medium text-zinc-200 group-hover:text-white">영구 저장공간 보호 개선 <span aria-hidden>→</span></h2>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">앱별 저장 한도를 적용하고, 안내와 실제 제공 내용을 맞췄습니다.</p>
          </Link>
        </li>
        <li>
          <Link href="/notices/2026-10-27-security-update" className="group block py-7 focus-visible:outline focus-visible:outline-offset-4 focus-visible:outline-zinc-400">
            <time dateTime="2026-10-27" className="font-mono text-xs text-zinc-500">2026.10.27</time>
            <h2 className="mt-3 text-lg font-medium text-zinc-200 group-hover:text-white">보안 및 안정성 업데이트 <span aria-hidden>→</span></h2>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">로그인 보호와 작업 환경을 보강하고, 보안 점검 결과를 더 정확하게 확인할 수 있도록 개선했습니다.</p>
          </Link>
        </li>
      </ul>
      <Link href="/" className="mt-10 inline-block text-sm text-zinc-400 underline-offset-4 hover:underline">← 홈으로</Link>
    </main>
  );
}
