import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { buildDjvuRuntimeEnv } from '@electron/features/djvu/main/buildDjvuRuntimeEnv';
import {
    getDjvuNativeToolsBase,
    resolveDjvuNativeToolPaths,
} from '@electron/features/djvu/main/nativeToolPaths';

describe('DjVu native tool path boundary', () => {
    it('resolves ddjvu, djvudump, and djvused from the DjVuLibre resource root', () => {
        const djvuBase = path.join('/repo/resources/djvulibre/darwin-arm64');
        const existingPaths = new Set([
            path.join(djvuBase, 'bin', 'ddjvu'),
            path.join(djvuBase, 'bin', 'djvudump'),
            path.join(djvuBase, 'bin', 'djvused'),
        ]);

        expect(resolveDjvuNativeToolPaths({
            exists: candidate => existingPaths.has(candidate),
            isPackaged: false,
            nativeToolsBase: '/repo/resources',
            platform: 'darwin',
            platformArch: 'darwin-arm64',
        })).toEqual({
            ddjvu: path.join(djvuBase, 'bin', 'ddjvu'),
            djvudump: path.join(djvuBase, 'bin', 'djvudump'),
            djvused: path.join(djvuBase, 'bin', 'djvused'),
        });
    });

    it('keeps the existing development fallback to command names when bundled tools are absent', () => {
        expect(resolveDjvuNativeToolPaths({
            exists: () => false,
            isPackaged: false,
            nativeToolsBase: '/repo/resources',
            platform: 'linux',
            platformArch: 'linux-x64',
        })).toEqual({
            ddjvu: 'ddjvu',
            djvudump: 'djvudump',
            djvused: 'djvused',
        });
    });

    it('keeps packaged DjVu binaries on the native-tools root', () => {
        expect(getDjvuNativeToolsBase('/app/Contents/Resources/app.asar/dist-electron/djvu', true, {
            platform: 'darwin',
            resourcesPath: '/app/Contents/Resources',
        })).toBe(path.join('/app/Contents/MacOS/native-tools'));
    });

    it('keeps the previous development DjVuLibre resource lookup order', () => {
        const currentDirectoryResource = path.join('/worktree/resources/djvulibre');
        const repoResource = path.join('/repo/resources/djvulibre');

        expect(getDjvuNativeToolsBase('/repo/electron/features/djvu/main', false, {
            cwd: '/worktree',
            exists: candidate => candidate === repoResource,
        })).toBe(path.join('/repo/resources'));
        expect(getDjvuNativeToolsBase('/repo/electron/features/djvu/main', false, {
            cwd: '/worktree',
            exists: candidate => candidate === currentDirectoryResource,
        })).toBe(path.join('/worktree/resources'));
    });
});

describe('buildDjvuRuntimeEnv', () => {
    it('prepends DjVu bin and lib directories to PATH on Windows', () => {
        const env = buildDjvuRuntimeEnv({
            platform: 'win32',
            baseEnv: { Path: 'C:\\Windows\\System32' },
            binDir: 'C:\\bundle\\djvu\\bin',
            libDir: 'C:\\bundle\\djvu\\lib',
        });

        expect(env.Path).toBe('C:\\bundle\\djvu\\bin;C:\\bundle\\djvu\\lib;C:\\Windows\\System32');
    });

    it('normalizes mixed-case PATH keys on Windows to a single Path key', () => {
        const env = buildDjvuRuntimeEnv({
            platform: 'win32',
            baseEnv: {
                PATH: 'C:\\Windows\\System32',
                Path: 'C:\\Windows',
            },
            binDir: 'C:\\bundle\\djvu\\bin',
            libDir: 'C:\\bundle\\djvu\\lib',
        });

        expect(env.Path).toBe('C:\\bundle\\djvu\\bin;C:\\bundle\\djvu\\lib;C:\\Windows\\System32;C:\\Windows');
        expect(env.PATH).toBeUndefined();
    });

    it('prepends DjVu lib directory to Unix dynamic loader variables', () => {
        const env = buildDjvuRuntimeEnv({
            platform: 'linux',
            baseEnv: {
                LD_LIBRARY_PATH: '/usr/lib',
                DYLD_LIBRARY_PATH: '/opt/lib',
            },
            libDir: '/opt/evb/djvu/lib',
        });

        expect(env.LD_LIBRARY_PATH).toBe('/opt/evb/djvu/lib:/usr/lib');
        expect(env.DYLD_LIBRARY_PATH).toBe('/opt/evb/djvu/lib:/opt/lib');
    });

    it.each([
        [
            'darwin',
            'en_US.UTF-8',
        ],
        [
            'linux',
            'C.UTF-8',
        ],
    ] as const)('adds a supported UTF-8 locale for %s DjVuLibre filename decoding', (platform, locale) => {
        const env = buildDjvuRuntimeEnv({
            platform,
            baseEnv: {},
            libDir: '/opt/evb/djvu/lib',
        });

        expect(env.LC_ALL).toBe(locale);
        expect(env.LC_CTYPE).toBe(locale);
        expect(env.LANG).toBe(locale);
    });

    it.each([
        [
            'darwin',
            'en_US.UTF-8',
        ],
        [
            'linux',
            'C.UTF-8',
        ],
    ] as const)('overrides inherited locale settings for %s DjVuLibre filename decoding', (platform, locale) => {
        const env = buildDjvuRuntimeEnv({
            platform,
            baseEnv: {
                LC_ALL: 'UTF-8',
                LC_CTYPE: 'en_US.UTF-8',
                LANG: 'en_US.UTF-8',
            },
            libDir: '/opt/evb/djvu/lib',
        });

        expect(env.LC_ALL).toBe(locale);
        expect(env.LC_CTYPE).toBe(locale);
        expect(env.LANG).toBe(locale);
    });
});
