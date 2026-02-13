import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
    resolve: {
        alias: {
            '@app': resolve(__dirname, 'app'),
            '@electron': resolve(__dirname, 'electron'),
        },
    },
    test: {
        include: ['tests/**/*.test.ts'],
        globals: false,
    },
});
