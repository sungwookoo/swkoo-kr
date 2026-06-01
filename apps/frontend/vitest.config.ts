import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

// Frontend test runner. Vitest (not Jest) — picks up the existing
// tsconfig path aliases via vite-tsconfig-paths, and runs in jsdom for
// React Testing Library. Configured so component test files can live
// next to their source (DomainPanel.tsx ↔ DomainPanel.test.tsx).
export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['**/*.test.{ts,tsx}'],
    // Next's own folders contain runtime code that mustn't be scanned.
    // `e2e/` holds Playwright specs — those use a different runner
    // (`@playwright/test`) and crash Vitest if loaded here.
    exclude: ['node_modules', '.next', 'dist', 'e2e', 'test-results', 'playwright-report'],
    css: false,
  },
});
