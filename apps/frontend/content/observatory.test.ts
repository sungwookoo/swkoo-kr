import { describe, expect, it } from 'vitest';

import * as observatory from './observatory';
import * as about from './about';

/** Guard-rail tests for the About/Observatory split. The narrative
 *  copy (problem definition, design principles, architecture,
 *  CI/CD scenarios, observability rationale, trade-offs) MUST live
 *  in content/about.ts after the split, and MUST NOT live in
 *  content/observatory.ts. A future contributor who restores any
 *  of those exports to observatory.ts is probably re-introducing
 *  the marketing copy we deliberately moved out. */
describe('Observatory ↔ About content split', () => {
  const movedKeys = [
    'problemDefinition',
    'designPrinciples',
    'architecture',
    'cicdScenarios',
    'observability',
    'tradeOffs',
  ] as const;

  for (const key of movedKeys) {
    it(`observatory.ts no longer exports "${key}"`, () => {
      expect(observatory).not.toHaveProperty(key);
    });
  }

  it('about.ts owns architecture + tradeOffs', () => {
    expect(about).toHaveProperty('architecture');
    expect(about).toHaveProperty('tradeOffs');
  });

  it('Observatory keeps its data-only labels (hero, statsLabels, legend, etc.)', () => {
    // Smoke — these are still used by the trimmed page.tsx.
    expect(observatory.hero).toBeDefined();
    expect(observatory.statsLabels).toBeDefined();
    expect(observatory.legend).toBeDefined();
    expect(observatory.alerts).toBeDefined();
    expect(observatory.deployments).toBeDefined();
    expect(observatory.emptyStates).toBeDefined();
  });
});
