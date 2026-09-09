import { defineConfig } from 'vitest/config';
import {
    electronE2ETeardownTimeoutMs,
    unitSlowTestThresholdMs,
    vitestProjects,
} from './vitest.shared.config';

export default defineConfig({ test: {
    projects: vitestProjects,
    slowTestThreshold: unitSlowTestThresholdMs,
    teardownTimeout: electronE2ETeardownTimeoutMs,
    coverage: {
        provider: 'v8',
        include: [
            'app/**/*.{ts,vue}',
            'electron/**/*.ts',
            'packages/**/*.ts',
            'packages/scan-cleanup/**/*.ts',
            'scripts/**/*.{ts,mjs,cjs}',
            'server/**/*.ts',
        ],
        exclude: [
            '**/*.d.ts',
            'app/.nuxt/**',
            'coverage/**',
            'node_modules/**',
            'tests/**',
        ],
        reporter: [
            'text',
            'json-summary',
            'lcov',
        ],
    },
} });
