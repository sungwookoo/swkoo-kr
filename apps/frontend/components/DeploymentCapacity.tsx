'use client';

import { useDeploymentCapacity } from '@/lib/admin';

const REASONS = {
  node: '서버 상태를 확인해야 합니다.',
  usage: 'CPU나 메모리 사용량이 배포 기준을 넘었습니다.',
  compute: '새 앱에 필요한 CPU·메모리 예약 여유가 부족합니다.',
  storage: '저장공간이나 파일 수 여유가 부족합니다.',
};

const cpu = (millicores: number) => `${millicores / 1000}코어`;
const memory = (miB: number) => miB >= 1024 ? `${(Math.floor(miB / 102.4) / 10).toFixed(1)}GiB` : `${miB}MiB`;

export function DeploymentCapacity() {
  const { data, error, isValidating, mutate } = useDeploymentCapacity();
  return (
    <section aria-label="서버 가용 자원" className="space-y-4 rounded border border-zinc-800 bg-zinc-950/40 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-zinc-100">서버 가용 자원</h2>
        <div className="flex items-center gap-3 text-xs">
          {data && !error && <time dateTime={data.checkedAt} className="text-zinc-400">
            {new Date(data.checkedAt).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false })}
            {' KST 기준'}
          </time>}
          <button type="button" onClick={() => void mutate()} disabled={isValidating}
            className="rounded border border-zinc-700 px-2 py-1 text-zinc-200 disabled:opacity-50">
            {isValidating ? '확인 중…' : '새로 확인'}
          </button>
        </div>
      </div>
      {error ? <p role="alert" className="text-sm text-amber-300">서버 자원을 확인하지 못했습니다. 잠시 후 새로 확인해 주세요.</p>
        : !data ? <p role="status" className="text-sm text-zinc-400">서버 사용량을 가져오는 중…</p>
        : <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Resource label="CPU 실제 여유" free={data.cpu.idleMillicores} total={data.cpu.totalMillicores}
              format={cpu} source="최근 5분 평균" />
            <Resource label="메모리 실제 여유" free={data.memory.availableMiB} total={data.memory.totalMiB}
              format={memory} source="최근 수집값" />
          </div>
          <div className="space-y-2 border-t border-zinc-800 pt-3 text-sm">
            <p className={data.deployment.reason ? 'text-amber-300' : 'text-emerald-300'}>
              {data.deployment.reason ? `신규 배포 보류 · ${REASONS[data.deployment.reason]}` : '현재 서버 기준으로 신규 앱 1개 배포 가능'}
            </p>
            <p className="text-zinc-300">
              예약에 쓸 수 있는 여유 · CPU {cpu(data.deployment.availableMillicores)} · 메모리 {memory(data.deployment.availableMemoryMiB)}
            </p>
            <p className="text-xs text-zinc-400">
              기존 앱 예약, 대기 중인 배포 {data.deployment.pending}건, 운영 여유(CPU {cpu(data.deployment.safetyMillicores)}·메모리 {memory(data.deployment.safetyMemoryMiB)})를 제외한 값입니다.
              신규 앱 1개는 교체분까지 CPU {cpu(data.deployment.requiredMillicores)}와 메모리 {memory(data.deployment.requiredMemoryMiB)}를 기준으로 확인합니다.
            </p>
            {data.deployment.suggestedLimits ? <p className="text-zinc-200">
              새 앱 1개의 상한 설정 참고 · CPU {cpu(data.deployment.suggestedLimits.cpuMillicores)} · 메모리 {memory(data.deployment.suggestedLimits.memoryMiB)}
            </p> : !data.deployment.reason && <p className="text-zinc-400">현재 부하에서는 앱의 최소 입력값을 충족하는 상한 참고값이 없습니다.</p>}
            <p className="text-xs text-zinc-400">
              상한 참고값은 현재 부하가 유지될 때 서버 사용률 {data.deployment.usageCeilingPercent}% 기준을 넘지 않도록 추정한 값입니다.
              자원은 공유되며 앱 등록 시 서버 상태와 계정 한도를 다시 확인합니다.
            </p>
          </div>
        </>}
    </section>
  );
}

function Resource({ label, free, total, format, source }: {
  label: string; free: number; total: number; format: (value: number) => string; source: string;
}) {
  return <div className="space-y-2 rounded border border-zinc-800 p-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-sm text-zinc-300">{label}</h3>
      <span className="text-xs text-zinc-400">{source}</span>
    </div>
    <p className="text-xl tabular-nums text-zinc-100">{format(free)} <span className="text-sm text-zinc-400">/ {format(total)}</span></p>
    <meter className="block h-2 w-full accent-emerald-400" aria-label={label} value={free} max={total} />
  </div>;
}
