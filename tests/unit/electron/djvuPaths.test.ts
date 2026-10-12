import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { buildDjvuRuntimeEnv } from '@electron/features/djvu/main/buildDjvuRuntimeEnv';
import {
    getDjvuNativeToolsBase,
    needsDjvuPathAlias,
    resolveDjvuNativeToolPaths,
} from '@electron/features/djvu/main/nativeToolPaths';

describe('DjVu native tool path boundary', () => {
    it.each([
        'Гиргас Словарь',
        'ספר שלום',
        'ܟܬܒܐ ܫܠܡܐ',
        'كتاب عربي',
        'a\u0301 combining',
        'cafe\u0301 NFD',
        'café NFC',
    ])('aliases non-ASCII Windows paths independently of the ANSI code page: %s', (name) => {
        const filePath = `C:\\Users\\evb\\${name}.djvu`;
        expect(needsDjvuPathAlias(filePath, 'win32')).toBe(true);
        expect(needsDjvuPathAlias(filePath, 'linux')).toBe(false);
        expect(needsDjvuPathAlias(filePath, 'darwin')).toBe(false);
    });

    it('aliases Unicode roots and long Windows paths, while preserving ASCII controls', () => {
        expect(needsDjvuPathAlias('C:\\Users\\Евгений\\input.djvu', 'win32')).toBe(true);
        expect(needsDjvuPathAlias(`C:\\${'x'.repeat(260)}.djvu`, 'win32')).toBe(true);
        expect(needsDjvuPathAlias('C:\\scratch\\space name 100%20 literal.djvu', 'win32')).toBe(false);
        expect(needsDjvuPathAlias('C:\\scratch\\ascii.djvu', 'win32')).toBe(false);
    });

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

    it('adds a deterministic UTF-8 locale for Unix DjVuLibre filename decoding', () => {
        const env = buildDjvuRuntimeEnv({
            platform: 'darwin',
            baseEnv: {},
            libDir: '/opt/evb/djvu/lib',
        });

        expect(env.LC_ALL).toBe('C.UTF-8');
        expect(env.LC_CTYPE).toBe('C.UTF-8');
        expect(env.LANG).toBe('C.UTF-8');
    });

    it('overrides inherited Unix locale settings for DjVuLibre filename decoding', () => {
        const env = buildDjvuRuntimeEnv({
            platform: 'darwin',
            baseEnv: {
                LC_ALL: 'UTF-8',
                LC_CTYPE: 'en_US.UTF-8',
                LANG: 'en_US.UTF-8',
            },
            libDir: '/opt/evb/djvu/lib',
        });

        expect(env.LC_ALL).toBe('C.UTF-8');
        expect(env.LC_CTYPE).toBe('C.UTF-8');
        expect(env.LANG).toBe('C.UTF-8');
    });
});
