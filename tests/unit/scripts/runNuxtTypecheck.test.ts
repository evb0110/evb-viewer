import {describe, expect, it} from 'vitest';
import path from 'node:path';
import {resolveNuxtTypecheckRun} from '@scripts/run-nuxt-typecheck.mjs';

describe('resolveNuxtTypecheckRun', () => {
    it('defaults to the current workspace with a warm cache', () => {
        const run = resolveNuxtTypecheckRun({
            argv: [],
            cwd: '/repo',
            env: {PATH: '/bin'},
        });

        expect(run).toMatchObject({
            cacheDir: path.resolve('/repo', '.devkit', 'cache', 'typecheck'),
            cold: false,
            workspaceDir: '/repo',
        });
        expect(run.env.NODE_OPTIONS).toContain('--max-old-space-size');
    });

    it('resolves a workspace argument and honours every cold switch', () => {
        expect(
            resolveNuxtTypecheckRun({
                argv: ['--cold', 'landing'],
                cwd: '/repo',
                env: {},
            }),
        ).toMatchObject({
            cacheDir: path.resolve('/repo', 'landing', '.devkit', 'cache', 'typecheck'),
            cold: true,
            workspaceDir: path.resolve('/repo', 'landing'),
        });
        expect(
            resolveNuxtTypecheckRun({
                argv: [],
                cwd: '/repo',
                env: {EVB_GATE_NO_CACHE: '1'},
            }).cold,
        ).toBe(true);
        expect(
            resolveNuxtTypecheckRun({
                argv: [],
                cwd: '/repo',
                env: {EVB_TYPECHECK_COLD: '1'},
            }).cold,
        ).toBe(true);
    });

    it('strips pnpm npm_config variables except the user agent', () => {
        const {env} = resolveNuxtTypecheckRun({
            argv: [],
            cwd: '/repo',
            env: {
                PATH: '/bin',
                npm_config_registry: 'https://registry.example',
                npm_config_user_agent: 'pnpm/10',
            },
        });

        expect(env).not.toHaveProperty('npm_config_registry');
        expect(env).toMatchObject({
            PATH: '/bin',
            npm_config_user_agent: 'pnpm/10',
        });
    });
});
