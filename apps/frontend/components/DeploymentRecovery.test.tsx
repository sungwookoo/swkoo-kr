import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeploymentRecovery } from './DeploymentRecovery';

const row = { login: 'alice', createdAt: 123 };
const plan = { login: 'alice', digest: 'reviewed', canRelease: true, registration: false, application: false, namespace: false, persistentVolumes: 0 };
const respond = (data: unknown, status = 200) => ({ ok: status === 200, status, text: async () => JSON.stringify(data) });

describe('reviewed administrator recovery', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => respond({ reservations: [row] }))));
  it('requires inspection before offering an explicit release and sends only the reviewed digest', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond({ reservations: [row] }) as any)
      .mockResolvedValueOnce(respond(plan) as any).mockResolvedValueOnce(respond({ ok: true }) as any)
      .mockResolvedValueOnce(respond({ reservations: [] }) as any);
    render(<DeploymentRecovery />);
    await userEvent.click(await screen.findByRole('button', { name: '상태 확인' }));
    expect(vi.mocked(fetch).mock.calls.every(call => call[1]?.method !== 'POST')).toBe(true);
    await userEvent.click(await screen.findByRole('button', { name: '미사용 예약 해제' }));
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/alice/release'), expect.objectContaining({ method: 'POST', body: JSON.stringify({ digest: 'reviewed' }) }));
    expect(await screen.findByText('남은 배포 예약이 없습니다.')).toBeInTheDocument();
  });
  it('never offers release when storage survives and keeps error responses readable', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond({ reservations: [row] }) as any)
      .mockResolvedValueOnce(respond({ ...plan, canRelease: false, persistentVolumes: 1 }) as any)
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => '' } as any);
    render(<DeploymentRecovery />);
    await userEvent.click(await screen.findByRole('button', { name: '상태 확인' }));
    expect(await screen.findByText(/저장 볼륨 1개/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '미사용 예약 해제' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '예약 목록 새로고침' }));
    expect(await screen.findByRole('status')).toHaveTextContent('503');
  });
  it('shows anonymized reservations for manual review without a release action', async () => {
    vi.mocked(fetch).mockResolvedValue(respond({ reservations: [{ login: 'deleted_1', createdAt: 123 }] }) as any);
    render(<DeploymentRecovery />);
    expect(await screen.findByText('익명화된 예약 · 운영자 별도 확인')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '상태 확인' })).not.toBeInTheDocument();
  });
});
