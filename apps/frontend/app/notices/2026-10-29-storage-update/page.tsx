import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: '영구 저장공간 보호 개선 — swkoo.kr',
  description: '앱별 영구 저장 한도와 이용 안내를 개선했습니다.',
};

export default function StorageUpdatePage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-20 sm:py-24">
      <time dateTime="2026-10-29" className="font-mono text-xs text-zinc-500">2026.10.29</time>
      <h1 className="mt-4 text-3xl font-semibold text-zinc-100">영구 저장공간 보호 개선</h1>
      <div className="mt-8 space-y-5 text-sm leading-relaxed text-zinc-400">
        <p>지원되는 Prisma SQLite 앱의 영구 저장공간에 앱별 최대 1GiB 한도를 적용했습니다. 한 앱의 저장공간 사용이 다른 앱에 영향을 주는 상황을 줄이기 위한 개선입니다.</p>
        <p>실제 할당량 1GiB 또는 파일·폴더 65,536개에 도달하면 추가 저장이 거부됩니다. 앱에서 저장 오류가 발생할 수 있으므로 데이터 정리 등으로 여유 공간을 유지해 주세요. 한도 도달을 이유로 기존 파일을 자동 삭제하지 않습니다.</p>
        <p>적용 전 복구 사본과 복원 시험을 준비하고, 저장 한도·앱 재시작·기존 데이터 무결성을 확인했습니다. 이용자 앱의 소스 저장소는 변경하지 않았습니다.</p>
        <p>이번 작업의 일회성 복구 사본과 별개로, 이용자 데이터의 정기 백업 서비스는 제공하지 않습니다. 앱 삭제 시 영구 데이터도 함께 삭제되므로 필요한 자료는 미리 보관해 주세요.</p>
      </div>
      <Link href="/notices" className="mt-10 inline-block text-sm text-zinc-400 underline-offset-4 hover:underline">← 공지사항</Link>
    </main>
  );
}
