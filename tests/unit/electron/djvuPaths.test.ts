import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {
    mkdtempSync, copyFileSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { buildDjvuRuntimeEnv } from '@electron/features/djvu/main/buildDjvuRuntimeEnv';
import {
    getDjvuNativeToolsBase,
    needsDjvuPathAlias,
    resolveDjvuNativeToolPaths,
    runDjvuSourceCommand,
} from '@electron/features/djvu/main/nativeToolPaths';

const native = vi.hoisted(() => ({
    platform: process.platform,
    scratchRoot: '',
    onPowerShell: null as ((args: string[], options: {
        signal?: AbortSignal;
        onTerminationProof?: (proof: Promise<boolean>) => void;
    }) => Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
    }>) | null,
    spawnedNonPowerShell: [] as string[],
}));
vi.mock('@electron/utils/appTempDir', () => ({getAppTempDir: () => native.scratchRoot}));
// Keep real filesystem and DjVuLibre decoding. Only the process launcher is
// replaced, so the Windows alias branch can run on any host.
vi.mock('@electron/native-tools/runNativeCommand', () => ({runNativeCommand: async (
    command: string,
    args: string[],
    options: {
        cwd?: string;
        signal?: AbortSignal;
        onTerminationProof?: (proof: Promise<boolean>) => void;
    } = {},
) => {
    if (command === 'powershell.exe') {
        if (native.onPowerShell) {
            return native.onPowerShell(args, options);
        }
        return {
            stdout: '',
            stderr: '',
            exitCode: 0,
        };
    }
    native.spawnedNonPowerShell.push(command);
    const toolRoot = path.resolve('resources/djvulibre', `${native.platform}-${process.arch}`);
    const stdout = execFileSync(command, args, {
        ...options,
        encoding: 'utf8',
        windowsHide: true,
        env: {
            ...process.env,
            Path: `${path.join(toolRoot, 'bin')};${path.join(toolRoot, 'lib')};${process.env.Path ?? ''}`,
            LD_LIBRARY_PATH: path.join(toolRoot, 'lib'),
            DYLD_LIBRARY_PATH: path.join(toolRoot, 'lib'),
        },
    });
    return {
        stdout,
        stderr: '',
        exitCode: 0,
    };
}}));

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

    it.each([
        'bundled',
        'indirect',
    ])('renders a renamed café-index.djvu with its %s components', async (kind) => {
        const root = mkdtempSync(path.join(tmpdir(), 'djvu-paths-'));
        native.scratchRoot = path.join(root, 'scratch');
        const toolRoot = path.resolve('resources/djvulibre', `${native.platform}-${process.arch}`, 'bin');
        const tool = (name: string) => path.join(toolRoot, `${name}${native.platform === 'win32' ? '.exe' : ''}`);
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');
        const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
        try {
            const source = path.join(root, 'café-index.djvu');
            const original = path.resolve('tests/fixtures/djvu/sources/mixed-dpi.djvu');
            if (kind === 'indirect') {
                const index = path.join(root, 'index.djvu');
                await runNativeCommand(tool('djvused'), [
                    original,
                    '-e',
                    `save-indirect "${index.replaceAll('\\', '/')}"`,
                ]);
                copyFileSync(index, source);
            } else copyFileSync(original, source);
            const sourceBytes = new Map(readdirSync(root).map(name => [
                name,
                readFileSync(path.join(root, name)),
            ]));
            Object.defineProperty(process, 'platform', {
                ...platformDescriptor,
                value: 'win32',
            });
            const count = await runDjvuSourceCommand(tool('djvused'), [
                source,
                '-e',
                'n',
            ], 0);
            expect(count.stdout.trim()).toBe('2');
            for (const page of [
                1,
                2,
            ]) {
                const output = path.join(root, `page-${page}.ppm`);
                await runDjvuSourceCommand(tool('ddjvu'), [
                    '-format=ppm',
                    `-page=${page}`,
                    '-size=100x100',
                    source,
                    output,
                ], 3);
                expect(readFileSync(output).subarray(0, 2).toString()).toBe('P6');
            }
            for (const [
                name,
                bytes,
            ] of sourceBytes) expect(readFileSync(path.join(root, name))).toEqual(bytes);
            expect(readdirSync(native.scratchRoot).filter(name => name.startsWith('djvu-export-'))).toEqual([]);
        } finally {
            Object.defineProperty(process, 'platform', platformDescriptor);
            rmSync(root, {
                recursive: true,
                force: true,
            });
        }
    });

    it.each([
        'scratch-root',
        'indirect-source',
    ] as const)('holds the broker lease across canceled Windows short-path %s lookup until delayed proof resolves true', async (lookupKind) => {
        const {JobBroker} = await import('@electron/resources/jobBroker');
        const {markUnprovenNativeTermination} = await import('@electron/utils/nativeTerminationProof');
        const aliasSuffix = path.join('djvu-export-XXXXXX', 'source', `input-${'x'.repeat(36)}.djvu`);
        const aliasProbe = path.join('djvu-s8-XXXXXX', 'scratch', aliasSuffix);
        const tempBase = needsDjvuPathAlias(path.join(tmpdir(), aliasProbe), 'win32')
            ? (native.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Temp') : '/tmp')
            : tmpdir();
        const root = mkdtempSync(path.join(tempBase, 'djvu-s8-'));
        const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const delayedProof = Promise.withResolvers<boolean>();
        try {
            const capacity = {
                cpuTokens: 1,
                estimatedResidentBytes: 64 * 1024 * 1024,
                nativeProcesses: 1,
                ioWeight: 1,
            };
            const broker = new JobBroker(capacity);
            const controller = new AbortController();
            const unprovenError = markUnprovenNativeTermination(
                new Error('powershell short-path lookup watchdog expired'),
                'powershell short-path child not proven dead yet',
            );
            native.spawnedNonPowerShell.length = 0;
            native.scratchRoot = lookupKind === 'scratch-root'
                ? path.join(root, 'Евгений')
                : path.join(root, 'scratch');
            if (lookupKind === 'indirect-source') {
                expect(needsDjvuPathAlias(path.join(native.scratchRoot, aliasSuffix), 'win32')).toBe(false);
            }

            const source = path.join(root, 'café-index.djvu');
            // Minimal 25-byte indirect FORM:DJVM + DJVMDIRM header (bit 7 clear).
            const indirectHeader = Buffer.alloc(25);
            indirectHeader.write('AT&TFORM\0\0\0\0DJVMDIRM', 0, 'latin1');
            indirectHeader[24] = 0x00;
            writeFileSync(source, indirectHeader);

            const expectedMethod = lookupKind === 'scratch-root' ? '.GetFolder(' : '.GetFile(';
            const observedPowerShellCommands: string[] = [];
            native.onPowerShell = async (args, options) => {
                const commandText = args.join(' ');
                observedPowerShellCommands.push(commandText);
                expect(commandText).toContain(expectedMethod);
                expect(options.signal).toBe(controller.signal);
                expect(options.onTerminationProof).toEqual(expect.any(Function));
                controller.abort(new Error('DjVu operation canceled'));
                options.onTerminationProof?.(delayedProof.promise);
                throw unprovenError;
            };

            Object.defineProperty(process, 'platform', {
                ...platformDescriptor,
                value: 'win32',
            });

            await expect(broker.run({
                ownerId: `win-short-${lookupKind}`,
                kind: 'djvu-metadata',
                priority: 'user',
                resources: capacity,
            }, ({onTerminationProof}) => runDjvuSourceCommand('/tools/djvused', [
                source,
                '-e',
                'n',
            ], 0, {
                signal: controller.signal,
                onTerminationProof,
            }))).rejects.toBe(unprovenError);

            expect(observedPowerShellCommands).toHaveLength(1);
            expect(native.spawnedNonPowerShell).toEqual([]);
            let competitorGranted = false;
            const competitor = broker.acquire({
                ownerId: 'competitor',
                kind: 'djvu-metadata',
                priority: 'user',
                resources: capacity,
            }).then((lease) => {
                competitorGranted = true;
                return lease;
            });

            await Promise.resolve();
            expect(competitorGranted).toBe(false);
            expect(broker.getSnapshot()).toMatchObject({
                active: 1,
                queued: 1,
                used: capacity,
            });

            delayedProof.resolve(true);
            const competitorLease = await competitor;
            expect(competitorGranted).toBe(true);
            expect(competitorLease.release()).toBe(true);
            expect(broker.getSnapshot()).toMatchObject({
                active: 0,
                queued: 0,
            });
        } finally {
            delayedProof.resolve(true);
            native.onPowerShell = null;
            Object.defineProperty(process, 'platform', platformDescriptor);
            rmSync(root, {
                recursive: true,
                force: true,
            });
        }
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
