import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface IPnpmInvocation {
    args: string[];
    command: string;
}

interface IBuildStrictModule {
    getPnpmInvocation: (args: string[], platform?: NodeJS.Platform) => IPnpmInvocation;
    getStrictBuildScriptName: (argv?: string[], env?: NodeJS.ProcessEnv) => string;
    getStrictBuildEnv: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
    shouldWriteErrorOutputToBuildLog: (error: unknown) => boolean;
}

const {
    getPnpmInvocation,
    getStrictBuildScriptName,
    getStrictBuildEnv,
    shouldWriteErrorOutputToBuildLog,
} = await import(
    pathToFileURL(path.join(process.cwd(), 'scripts/run-build-strict.mjs')).href
) as IBuildStrictModule;

describe('run-build-strict', () => {
    it('uses cmd.exe for Windows pnpm child processes', () => {
        expect(getPnpmInvocation([
            'run',
            'build:desktop',
        ], 'win32')).toEqual({
            args: [
                '/d',
                '/s',
                '/c',
                'pnpm',
                'run',
                'build:desktop',
            ],
            command: 'cmd.exe',
        });
    });

    it('uses pnpm directly on POSIX platforms', () => {
        const args = [
            'run',
            'build:desktop',
        ];

        expect(getPnpmInvocation(args, 'darwin')).toEqual({
            args,
            command: 'pnpm',
        });
        expect(getPnpmInvocation(args, 'linux')).toEqual({
            args,
            command: 'pnpm',
        });
    });

    it('uses the wasm-checking desktop build by default', () => {
        expect(getStrictBuildScriptName([], {})).toBe('build:desktop');
        expect(getStrictBuildScriptName([], { EVB_STRICT_BUILD_SKIP_WASM_CHECK: '0' }))
            .toBe('build:desktop');
    });

    it('uses the no-wasm-check desktop build when requested', () => {
        expect(getStrictBuildScriptName(['--skip-wasm-check'], {}))
            .toBe('build:desktop:no-wasm-check');
        expect(getStrictBuildScriptName([], { EVB_STRICT_BUILD_SKIP_WASM_CHECK: '1' }))
            .toBe('build:desktop:no-wasm-check');
    });

    it('adds a heap floor for strict build child processes', () => {
        const env = getStrictBuildEnv({});
        expect(env.NODE_OPTIONS).toBe('--max-old-space-size=6144');
        expect(env.EVB_NUXT_BUILD_DIR).toMatch(/\.devkit\/cache\/strict-build\/nuxt-build$/u);
        expect(env.EVB_NUXT_VITE_CACHE_DIR).toMatch(/\.devkit\/cache\/strict-build\/vite-cache$/u);
        expect(getStrictBuildEnv({ NODE_OPTIONS: '--trace-warnings' }).NODE_OPTIONS)
            .toBe('--trace-warnings --max-old-space-size=6144');
    });

    it('preserves explicit Nuxt artifact directories', () => {
        expect(getStrictBuildEnv({
            EVB_NUXT_BUILD_DIR: '/tmp/custom-nuxt-build',
            EVB_NUXT_VITE_CACHE_DIR: '/tmp/custom-vite-cache',
        })).toMatchObject({
            EVB_NUXT_BUILD_DIR: '/tmp/custom-nuxt-build',
            EVB_NUXT_VITE_CACHE_DIR: '/tmp/custom-vite-cache',
        });
    });

    it('preserves an explicit heap setting from the caller', () => {
        expect(getStrictBuildEnv({ NODE_OPTIONS: '--max-old-space-size=8192 --trace-warnings' }).NODE_OPTIONS)
            .toBe('--max-old-space-size=8192 --trace-warnings');
    });

    it('preserves the original build log when the warning checker fails', () => {
        expect(shouldWriteErrorOutputToBuildLog({ output: 'raw build output' })).toBe(true);
        expect(shouldWriteErrorOutputToBuildLog({
            output: 'warning checker diagnostics',
            preserveExistingBuildLog: true,
        })).toBe(false);
    });
});
