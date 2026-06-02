import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { PatternItem } from '@/content/about';
import { PatternList } from './PatternList';

const fixture: PatternItem[] = [
  { id: 'one', label: 'Pattern One', body: 'first pattern body' },
  { id: 'two', label: 'Pattern Two', body: 'second pattern body' },
];

describe('PatternList', () => {
  it('renders all labels collapsed by default', () => {
    render(<PatternList items={fixture} />);
    expect(screen.getByRole('button', { name: /Pattern One/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.queryByText('first pattern body')).not.toBeInTheDocument();
    expect(screen.queryByText('second pattern body')).not.toBeInTheDocument();
  });

  it('clicking a row expands its body and sets aria-expanded=true', async () => {
    const user = userEvent.setup();
    render(<PatternList items={fixture} />);

    await user.click(screen.getByRole('button', { name: /Pattern One/ }));

    expect(screen.getByRole('button', { name: /Pattern One/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByText('first pattern body')).toBeInTheDocument();
  });

  it('multiple rows can be open at once', async () => {
    const user = userEvent.setup();
    render(<PatternList items={fixture} />);

    await user.click(screen.getByRole('button', { name: /Pattern One/ }));
    await user.click(screen.getByRole('button', { name: /Pattern Two/ }));

    expect(screen.getByText('first pattern body')).toBeInTheDocument();
    expect(screen.getByText('second pattern body')).toBeInTheDocument();
  });

  it('clicking an open row collapses it again', async () => {
    const user = userEvent.setup();
    render(<PatternList items={fixture} />);

    const btn = screen.getByRole('button', { name: /Pattern One/ });
    await user.click(btn);
    await user.click(btn);

    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('first pattern body')).not.toBeInTheDocument();
  });
});
