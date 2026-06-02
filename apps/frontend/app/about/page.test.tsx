import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

// ArchitectureDiagram pulls in mermaid which is heavy / jsdom-unfriendly.
// The page-level test only needs to assert structure, so stub it out.
vi.mock('@/components/ArchitectureDiagram', () => ({
  ArchitectureDiagram: () => <div data-testid="architecture-diagram-mock" />,
}));

import { hero, claims, techMatrix } from '@/content/about';
import AboutPage from './page';

describe('AboutPage', () => {
  it('renders the hero headline + eyebrow + subtitle from content/about.ts', () => {
    render(<AboutPage />);
    expect(
      screen.getByRole('heading', { level: 1, name: hero.title })
    ).toBeInTheDocument();
    expect(screen.getByText(hero.eyebrow)).toBeInTheDocument();
    expect(screen.getByText(hero.subtitle)).toBeInTheDocument();
  });

  it('lists all four core claim labels', () => {
    render(<AboutPage />);
    for (const c of claims) {
      expect(screen.getByText(c.label)).toBeInTheDocument();
    }
  });

  it('renders every tech-matrix keyword as a clickable button', () => {
    render(<AboutPage />);
    for (const item of techMatrix) {
      expect(screen.getByRole('button', { name: item.label })).toBeInTheDocument();
    }
  });

  it('clicking a tech keyword reveals What/Used for/Why detail', async () => {
    const user = userEvent.setup();
    render(<AboutPage />);

    // Pick one we know is present.
    const argo = screen.getByRole('button', { name: 'ArgoCD' });
    await user.click(argo);

    // Detail panel includes the "Used for" sub-label and the body string.
    expect(screen.getByText('Used for')).toBeInTheDocument();
    expect(
      screen.getByText(/Application = git path → cluster namespace/)
    ).toBeInTheDocument();
  });

  it('renders the architecture section with the (mocked) diagram + flow lists', () => {
    render(<AboutPage />);
    expect(
      screen.getByRole('heading', { level: 2, name: 'Architecture' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('architecture-diagram-mock')).toBeInTheDocument();
    expect(screen.getByText('데이터/이벤트 흐름')).toBeInTheDocument();
    expect(screen.getByText('실패/알림 흐름')).toBeInTheDocument();
  });

  it('renders the trade-offs section (moved from Observatory)', () => {
    render(<AboutPage />);
    expect(screen.getByRole('heading', { level: 2, name: 'Trade-offs' })).toBeInTheDocument();
    expect(screen.getByText('고가용성 미구현')).toBeInTheDocument();
  });
});
