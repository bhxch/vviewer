import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['packages/*/test/**/*.test.ts', 'packages/*/src/**/*.test.ts', 'tools/*/test/**/*.test.ts', 'apps/web/src/**/*.test.ts'], environment: 'jsdom' } });
