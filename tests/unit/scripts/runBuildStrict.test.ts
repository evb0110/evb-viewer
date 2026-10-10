import {execFileSync} from 'node:child_process';
import {
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path, {join} from 'node:path';
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
    getStrictBuildEnv: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
    isStrictBuildStampFresh: (root?: string) => boolean;
    shouldWriteErrorOutputToBuildLog: (error: unknown) => boolean;
    writeStrictBuildStamp: (root?: string) => void;
}

const {
    getPnpmInvocation,
    getStrictBuildEnv,
    isStrictBuildStampFresh,
    shouldWriteErrorOutputToBuildLog,
    writeStrictBuildStamp,
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

    it('adds a heap floor for strict build child processes', () => {
        const env = getStrictBuildEnv({});
        expect(env.NODE_OPTIONS).toBe('--max-old-space-size=6144');
        expect(env.EVB_NUXT_BUILD_DIR).toBe(path.resolve('.devkit', 'cache', 'strict-build', 'nuxt-build'));
        expect(env.EVB_NUXT_VITE_CACHE_DIR).toBe(path.resolve('.devkit', 'cache', 'strict-build', 'vite-cache'));
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

    it('invalidates the strict build stamp when an already-dirty tracked file changes again', () => {
        const root = mkdtempSync(join(tmpdir(), 'evb-strict-build-stamp-'));
        const sourcePath = path.join(root, 'source.ts');
        try {
            execFileSync('git', [
                'init',
                '--quiet',
            ], {cwd: root});
            execFileSync('git', [
                'config',
                'user.email',
                'build-stamp@example.test',
            ], {cwd: root});
            execFileSync('git', [
                'config',
                'user.name',
                'Build Stamp Test',
            ], {cwd: root});
            writeFileSync(path.join(root, '.gitignore'), '.devkit/\n', 'utf8');
            writeFileSync(sourcePath, 'export const source = "committed";\n', 'utf8');
            execFileSync('git', [
                'add',
                '--all',
            ], {cwd: root});
            execFileSync('git', [
                'commit',
                '--quiet',
                '-m',
                'baseline',
            ], {cwd: root});

            writeFileSync(sourcePath, 'export const source = "first edit";\n', 'utf8');
            writeStrictBuildStamp(root);
            expect(isStrictBuildStampFresh(root)).toBe(true);

            writeFileSync(sourcePath, 'export const source = "second edit";\n', 'utf8');
            expect(isStrictBuildStampFresh(root)).toBe(false);
        } finally {
            rmSync(root, {
                force: true,
                recursive: true,
            });
        }
    });
});
