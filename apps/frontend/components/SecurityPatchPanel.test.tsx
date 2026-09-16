import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecurityPatchPanel } from './SecurityPatchPanel';
const state = vi.hoisted(() => ({ data: null as any, mutate: vi.fn() }));
vi.mock('swr', () => ({ default: () => ({ data: state.data, mutate: state.mutate, isLoading: false }) }));
describe('explicit security patch consent', () => {
  beforeEach(() => { state.data = null; state.mutate.mockReset(); vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ state: 'preparing' }) }))); });
  it('does not prepare or write anything on render and requires consent', async () => {
    render(<SecurityPatchPanel repo="alice/app" />);
    expect(fetch).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: '보안 수정안 준비' });
    expect(button).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(button);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/prepare'), expect.objectContaining({ method: 'POST', body: JSON.stringify({ repo: 'alice/app', consent: 'npm-lockfile-v1' }) }));
  });
  it('requires a second consent to create a draft PR and explains deployment impact', async () => {
    state.data = { id: 'id', state: 'ready', repo: 'alice/app', base: 'main', sha: '12345678', before: 2, after: 1, changes: [] };
    render(<SecurityPatchPanel repo="alice/app" />);
    expect(screen.getByText(/앱 테스트·프로덕션 빌드·DB 연결은 미검증/)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: '검토용 초안 PR 만들기' });
    expect(button).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(button);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/pr'), expect.objectContaining({ body: JSON.stringify({ repo: 'alice/app', consent: 'npm-lockfile-v1', id: 'id' }) }));
  });
  it('does not offer publication for blocked proposals', () => {
    state.data = { state: 'blocked', message: '메이저 버전 변경은 수동 검토가 필요합니다.' };
    render(<SecurityPatchPanel repo="alice/app" />);
    expect(screen.queryByRole('button', { name: '검토용 초안 PR 만들기' })).not.toBeInTheDocument();
    expect(screen.getByText(/메이저 버전 변경은 수동/)).toBeInTheDocument();
  });
});
