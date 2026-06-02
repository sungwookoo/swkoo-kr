import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { TechItem } from '@/content/about';
import { TechMatrix } from './TechMatrix';

const fixture: TechItem[] = [
  {
    id: 'alpha',
    label: 'Alpha',
    what: 'alpha-what description',
    usedFor: 'alpha-used-for description',
    whyItMatters: 'alpha-why description',
  },
  {
    id: 'beta',
    label: 'Beta',
    what: 'beta-what description',
    usedFor: 'beta-used-for description',
    whyItMatters: 'beta-why description',
  },
];

describe('TechMatrix', () => {
  it('renders every label as a button with aria-pressed=false initially', () => {
    render(<TechMatrix items={fixture} />);
    const alpha = screen.getByRole('button', { name: 'Alpha' });
    const beta = screen.getByRole('button', { name: 'Beta' });
    expect(alpha).toHaveAttribute('aria-pressed', 'false');
    expect(beta).toHaveAttribute('aria-pressed', 'false');
    // No detail panel until something is clicked.
    expect(screen.queryByText(/alpha-what description/)).not.toBeInTheDocument();
  });

  it('clicking a chip reveals the What / Used for / Why panel', async () => {
    const user = userEvent.setup();
    render(<TechMatrix items={fixture} />);

    await user.click(screen.getByRole('button', { name: 'Alpha' }));

    expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByText('alpha-what description')).toBeInTheDocument();
    expect(screen.getByText('alpha-used-for description')).toBeInTheDocument();
    expect(screen.getByText('alpha-why description')).toBeInTheDocument();
  });

  it('clicking the same chip again closes the panel (toggle)', async () => {
    const user = userEvent.setup();
    render(<TechMatrix items={fixture} />);

    const alpha = screen.getByRole('button', { name: 'Alpha' });
    await user.click(alpha);
    await user.click(alpha);

    expect(alpha).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText(/alpha-what description/)).not.toBeInTheDocument();
  });

  it('clicking a different chip swaps the visible detail (single-open)', async () => {
    const user = userEvent.setup();
    render(<TechMatrix items={fixture} />);

    await user.click(screen.getByRole('button', { name: 'Alpha' }));
    await user.click(screen.getByRole('button', { name: 'Beta' }));

    // Beta's detail is visible…
    expect(screen.getByText('beta-what description')).toBeInTheDocument();
    // …and Alpha's is not.
    expect(screen.queryByText('alpha-what description')).not.toBeInTheDocument();
  });
});
