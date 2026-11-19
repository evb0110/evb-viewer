import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type * as NodeFs from 'fs';
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rename,
    rm,
    stat,
    utimes,
    writeFile,
} from 'node:fs/promises';
import {
    delimiter,
    join,
} from 'node:path';
import {tmpdir} from 'node:os';
import type * as NodeFsPromises from 'fs/promises';
import type * as NativeCommand from '@electron/native-tools/runNativeCommand';
import { markUnprovenNativeTermination } from '@electron/utils/nativeTerminationProof';

const mocks = vi.hoisted(() => ({
    runNativeCommand: vi.fn<typeof NativeCommand.runNativeCommand>(),
    existsSync: vi.fn<typeof NodeFs.existsSync>(() => true),
    access: vi.fn<typeof NodeFsPromises.access>(async () => undefined),
    stat: vi.fn<typeof NodeFsPromises.stat>(),
    userData: '/tmp/evb-codex-test',
}));

vi.mock('@electron/features/agent/assistantShellEnvironment', () => ({
    getAssistantShellEnvironment: async () => ({
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        PATH: process.env.PATH,
        CODEX_CLI_PATH: process.env.CODEX_CLI_PATH,
    }),
}));
vi.mock('@electron/native-tools/runNativeCommand', () => ({runNativeCommand: mocks.runNativeCommand}));
vi.mock('fs', async importOriginal => ({
    ...(await importOriginal<typeof NodeFs>()),
    existsSync: mocks.existsSync,
}));
vi.mock('fs/promises', async importOriginal => ({
    ...(await importOriginal<typeof NodeFsPromises>()),
    access: mocks.access,
    stat: mocks.stat,
}));
vi.mock('electron', () => ({app: {getPath: () => mocks.userData}}));
describe('Codex CLI command results', () => {
    let sandbox: string;
    let runCodexCli: typeof import('@electron/features/agent/codexCli').runCodexCli;

    beforeEach(async () => {
        sandbox = await mkdtemp(join(tmpdir(), 'evb-codex-command-'));
        vi.stubEnv('HOME', sandbox);
        vi.stubEnv('USERPROFILE', sandbox);
        vi.stubEnv('PATH', sandbox);
        const nativeCommand = await vi.importActual<typeof NativeCommand>('@electron/native-tools/runNativeCommand');
        mocks.runNativeCommand.mockReset().mockImplementation(nativeCommand.runNativeCommand);
        ({runCodexCli} = await import('@electron/features/agent/codexCli'));
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(sandbox, {recursive: true, force: true});
    });

    it('returns both streams and exit status for a successful command', async () => {
        await expect(runCodexCli(process.execPath, [
            '--eval',
            'console.log("codex-cli 0.157.1"); console.error("fixture warning");',
        ])).resolves.toEqual({
            ok: true,
            stdout: 'codex-cli 0.157.1\n',
            stderr: 'fixture warning\n',
            exitCode: 0,
        });
    });

    it('returns the failed exit code with everything the command printed', async () => {
        const stdout = 'fixture stdout detail\n';
        const stderr = `${'fixture diagnostic. '.repeat(70)}\nRemediation: run fixture repair.\n`;
        expect(stderr.length).toBeGreaterThan(1_200);
        await expect(runCodexCli(process.execPath, [
            '--eval',
            `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 7;`,
        ])).resolves.toEqual({
            ok: false,
            stdout,
            stderr,
            exitCode: 7,
        });
    });

    it('reports a missing executable as a failed result', async () => {
        await expect(runCodexCli(join(sandbox, 'missing-codex'), [])).resolves.toEqual({
            ok: false,
            stdout: '',
            stderr: expect.stringContaining('ENOENT'),
            exitCode: null,
        });
    });

    it('keeps the tail of each oversized stream within a 256 KiB byte cap', async () => {
        const result = await runCodexCli(process.execPath, [
            '--eval',
            'const text = "head" + "é".repeat(160 * 1024) + "tail"; process.stdout.write(text); process.stderr.write(text);',
        ]);
        expect(result).toMatchObject({
            ok: true,
            exitCode: 0,
        });
        for (const stream of [result.stdout, result.stderr]) {
            expect(Buffer.byteLength(stream)).toBeLessThanOrEqual(256 * 1024);
            expect(stream.startsWith('head')).toBe(false);
            expect(stream.endsWith('étail')).toBe(true);
        }
    });

    it('returns what a hung command printed before its timeout with the timeout text', async () => {
        // The real runner with a shortened deadline, so the hang does not take 15 s.
        const nativeCommand = await vi.importActual<typeof NativeCommand>('@electron/native-tools/runNativeCommand');
        mocks.runNativeCommand.mockImplementationOnce((command, args, options) => (
            nativeCommand.runNativeCommand(command, args, {...options, timeoutMs: 1_000})
        ));
        await expect(runCodexCli(process.execPath, [
            '--eval',
            'process.stdout.write("partial stdout\\n"); process.stderr.write("partial stderr\\n"); setInterval(() => {}, 1_000);',
        ])).resolves.toEqual({
            ok: false,
            stdout: 'partial stdout\n',
            stderr: 'partial stderr\nCodex timed out after 1000ms',
            exitCode: null,
        });
    });

    it.each([false, true])('reports timeout with unproven termination = %s', async (unproven) => {
        const timeout = new Error('Codex timed out after 15000ms');
        const detail = 'process-tree termination could not be proven';
        mocks.runNativeCommand.mockRejectedValueOnce(unproven ? markUnprovenNativeTermination(timeout, detail) : timeout);
        await expect(runCodexCli(process.execPath, ['--version'])).resolves.toEqual({
            ok: false,
            stdout: '',
            stderr: unproven
                ? 'Codex timed out after 15000ms; process-tree termination could not be proven'
                : 'Codex timed out after 15000ms',
            exitCode: null,
        });
    });
});

describe('Codex installation metadata freshness', () => {
    let fixtureDir: string;
    let executable: string;
    let counter: string;

    async function writeVersion(path: string, version: string, exitCode = 0) {
        await mkdir(join(path, '..'), {recursive: true});
        await writeFile(path, `#!${process.execPath}\nimport('node:fs').then(({appendFileSync}) => {appendFileSync(${JSON.stringify(counter)}, 'version\\n'); console.log('codex-cli ${version}'); process.exitCode = ${exitCode};});`);
        await chmod(path, 0o700);
    }

    async function versionInvocations() {
        return (await readFile(counter, 'utf8')).trim().split('\n').length;
    }

    beforeEach(async () => {
        vi.useRealTimers();
        vi.resetModules();
        vi.clearAllMocks();
        fixtureDir = await mkdtemp(join(tmpdir(), 'ap07-codex-'));
        executable = join(fixtureDir, 'codex.cjs');
        counter = join(fixtureDir, 'versions.txt');
        await writeFile(counter, '');
        mocks.userData = fixtureDir;
        const fs = await vi.importActual<typeof NodeFs>('fs');
        const fsPromises = await vi.importActual<typeof NodeFsPromises>('fs/promises');
        mocks.existsSync.mockImplementation(path => typeof path === 'string' && path.startsWith(fixtureDir) && fs.existsSync(path));
        mocks.access.mockImplementation(fsPromises.access);
        mocks.stat.mockImplementation(fsPromises.stat);
        // Run the version-only Node fixture portably, including on Windows.
        const nativeCommand = await vi.importActual<typeof NativeCommand>('@electron/native-tools/runNativeCommand');
        mocks.runNativeCommand.mockReset().mockImplementation(async (command, args, options) => {
            const script = /powershell\.exe$/iu.test(command) ? args[args.indexOf('-File') + 1]! : command;
            return nativeCommand.runNativeCommand(process.execPath, [
                '--eval',
                await fsPromises.readFile(script, 'utf8'),
                '--',
            ], options);
        });
        vi.stubEnv('HOME', fixtureDir);
        vi.stubEnv('USERPROFILE', fixtureDir);
        vi.stubEnv('PATH', fixtureDir);
        vi.stubEnv('CODEX_CLI_PATH', executable);
        await writeVersion(executable, '0.157.1');
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        mocks.userData = '/tmp/evb-codex-test';
        await rm(fixtureDir, {
            recursive: true,
            force: true,
        });
    });

    it('shares successful version metadata and observes executable replacement', async () => {
        const {getCodexCliInfo} = await import('@electron/features/agent/codexCli');
        const initial = await getCodexCliInfo();
        const simultaneous = await Promise.all(Array.from({length: 10}, () => getCodexCliInfo()));
        expect(simultaneous).toEqual(Array.from({length: 10}, () => initial));
        expect(initial).toMatchObject({
            installed: true,
            version: '0.157.1',
            path: executable,
        });
        expect(await versionInvocations()).toBe(1);

        const replacement = join(fixtureDir, 'replacement.cjs');
        await writeVersion(replacement, '0.158.1');
        await rename(replacement, executable);
        expect(await getCodexCliInfo()).toMatchObject({
            installed: true,
            version: '0.158.1',
        });
        expect(await versionInvocations()).toBe(2);
        const previousStats = await stat(executable);
        await writeVersion(executable, '0.159.1');
        await utimes(executable, previousStats.atime, previousStats.mtime);
        expect(await getCodexCliInfo()).toMatchObject({version: '0.159.1'});
        expect(await versionInvocations()).toBe(3);
    });

    it('observes replacement and removal of the Windows launch script', async () => {
        const launchOwner = await import('@electron/features/agent/codexProcessLaunch');
        const resolveLaunch = launchOwner.resolveCodexProcessLaunch;
        vi.spyOn(launchOwner, 'resolveCodexProcessLaunch').mockImplementation((path, args) => resolveLaunch(path, args, 'win32'));
        executable = join(fixtureDir, 'codex.cmd');
        const script = join(fixtureDir, 'codex.ps1');
        await writeVersion(executable, 'unchanged');
        await writeVersion(script, '0.157.1');
        vi.stubEnv('CODEX_CLI_PATH', executable);
        const {getCodexCliInfo} = await import('@electron/features/agent/codexCli');
        expect(await getCodexCliInfo()).toMatchObject({version: '0.157.1'});
        await writeVersion(script, '0.158.1');
        expect(await getCodexCliInfo()).toMatchObject({version: '0.158.1'});
        await rm(script);
        expect(await getCodexCliInfo()).toMatchObject({
            version: null,
            isVersionSupported: false,
        });
        await writeVersion(script, '0.159.1');
        expect(await getCodexCliInfo()).toMatchObject({version: '0.159.1'});
    });

    it('observes missing installations, recovery and override changes while ignoring retired managed binaries', async () => {
        const {getCodexCliInfo} = await import('@electron/features/agent/codexCli');
        expect(await getCodexCliInfo()).toMatchObject({
            installed: true,
            version: '0.157.1',
        });
        await rm(executable);
        expect(await getCodexCliInfo()).toMatchObject({
            installed: false,
            version: null,
            path: null,
        });
        await writeVersion(executable, '0.158.1');
        expect(await getCodexCliInfo()).toMatchObject({
            installed: true,
            version: '0.158.1',
        });

        const override = join(fixtureDir, 'override.cjs');
        await writeVersion(override, '0.159.1');
        vi.stubEnv('CODEX_CLI_PATH', override);
        expect(await getCodexCliInfo()).toMatchObject({
            path: override,
            version: '0.159.1',
        });
        const pathExecutable = join(fixtureDir, 'path-bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
        await writeVersion(pathExecutable, '0.159.2');
        vi.stubEnv('CODEX_CLI_PATH', '');
        vi.stubEnv('PATH', join(fixtureDir, 'path-bin'));
        expect(await getCodexCliInfo()).toMatchObject({
            path: pathExecutable,
            version: '0.159.2',
        });
        const managed = join(fixtureDir, 'codex', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
        await writeVersion(managed, '0.160.1');
        vi.stubEnv('CODEX_CLI_PATH', '');
        expect(await getCodexCliInfo()).toMatchObject({path: pathExecutable, version: '0.159.2'});
    });

    it('does not reuse in-flight path discovery after an override changes', async () => {
        const {getCodexCliInfo} = await import('@electron/features/agent/codexCli');
        const override = join(fixtureDir, 'override.cjs');
        await writeVersion(override, '0.158.1');
        const originalRequest = getCodexCliInfo();
        vi.stubEnv('CODEX_CLI_PATH', override);
        const overrideRequest = getCodexCliInfo();
        expect(await originalRequest).toMatchObject({
            path: executable,
            version: '0.157.1',
        });
        expect(await overrideRequest).toMatchObject({
            path: override,
            version: '0.158.1',
        });
    });

    it('coalesces cold simultaneous metadata and retries failed version probes', async () => {
        const {getCodexCliInfo} = await import('@electron/features/agent/codexCli');
        const results = await Promise.all(Array.from({length: 10}, () => getCodexCliInfo()));
        expect(results.every(info => info.version === '0.157.1')).toBe(true);
        expect(await versionInvocations()).toBe(1);
        await writeVersion(executable, '0.158.1', 1);
        expect(await getCodexCliInfo()).toMatchObject({
            installed: true,
            version: null,
        });
        expect(await getCodexCliInfo()).toMatchObject({
            installed: true,
            version: null,
        });
        expect(await versionInvocations()).toBe(3);
        await writeVersion(executable, 'unknown');
        expect(await getCodexCliInfo()).toMatchObject({
            installed: true,
            version: null,
        });
        expect(await getCodexCliInfo()).toMatchObject({
            installed: true,
            version: null,
        });
        expect(await versionInvocations()).toBe(5);
        await writeVersion(executable, '0.158.1');
        expect(await getCodexCliInfo()).toMatchObject({
            installed: true,
            version: '0.158.1',
        });
    });

    it('retries a failed version launch instead of retaining its unavailable result', async () => {
        const {getCodexCliInfo} = await import('@electron/features/agent/codexCli');
        mocks.runNativeCommand.mockImplementationOnce(() => {
            throw new Error('version launch failed');
        });
        await expect(getCodexCliInfo()).resolves.toMatchObject({
            installed: true,
            version: null,
            isVersionSupported: false,
        });
        expect(await getCodexCliInfo()).toMatchObject({version: '0.157.1'});
        expect(await versionInvocations()).toBe(1);
    });
});

describe('Codex CLI discovery', () => {
    const sandbox = join(tmpdir(), 'evb-codex-discovery');
    const codexName = process.platform === 'win32' ? 'codex.cmd' : 'codex';
    const homeDirectory = join(sandbox, 'home');
    const installedFiles = new Set<string>();

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        installedFiles.clear();
        mocks.userData = join(sandbox, 'user-data');
        mocks.existsSync.mockImplementation(path => typeof path === 'string' && installedFiles.has(path));
        mocks.stat.mockImplementation(async () => ({isFile: () => true}) as Awaited<ReturnType<typeof NodeFsPromises.stat>>);
        mocks.access.mockImplementation(async path => {
            if (!installedFiles.has(String(path))) {
                throw Object.assign(new Error(`ENOENT: ${String(path)}`), {code: 'ENOENT'});
            }
        });
        vi.stubEnv('CODEX_CLI_PATH', join(sandbox, 'no-codex'));
        vi.stubEnv('PATH', join(sandbox, 'empty-bin'));
        vi.stubEnv('HOME', homeDirectory);
        vi.stubEnv('USERPROFILE', homeDirectory);
        vi.stubEnv('SHELL', join(sandbox, 'no-shell'));
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        mocks.userData = '/tmp/evb-codex-test';
    });

    it('finds the Codex.app bundled CLI on macOS', async () => {
        const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', {value: 'darwin'});
        try {
            const bundled = '/Applications/Codex.app/Contents/Resources/codex';
            installedFiles.add(bundled);
            const {resolveCodexCliPath} = await import('@electron/features/agent/codexCli');
            await expect(resolveCodexCliPath()).resolves.toBe(bundled);
        } finally {
            Object.defineProperty(process, 'platform', originalPlatform!);
        }
    });

    it('finds the CLI on a PATH entry, where Homebrew and npm global installs appear', async () => {
        const homebrewBin = join('/opt/homebrew', 'bin');
        const npmGlobalBin = join(sandbox, 'npm-global', 'bin');
        vi.stubEnv('PATH', [
            homebrewBin,
            npmGlobalBin,
        ].join(delimiter));
        installedFiles.add(join(npmGlobalBin, codexName));
        const {resolveCodexCliPath} = await import('@electron/features/agent/codexCli');
        await expect(resolveCodexCliPath()).resolves.toBe(join(npmGlobalBin, codexName));
    });

    it('finds the CLI in HOME/.local/bin', async () => {
        const localBin = join(homeDirectory, '.local', 'bin', codexName);
        installedFiles.add(localBin);
        const {resolveCodexCliPath} = await import('@electron/features/agent/codexCli');
        await expect(resolveCodexCliPath()).resolves.toBe(localBin);
    });

    it('resolves with a supplied login-shell PATH instead of opening another shell', async () => {
        const shellBin = join(sandbox, 'shell-bin');
        const shellCli = join(shellBin, codexName);
        installedFiles.add(shellCli);
        const {resolveCodexCliPath} = await import('@electron/features/agent/codexCli');
        await expect(resolveCodexCliPath({...process.env, PATH: shellBin})).resolves.toBe(shellCli);
    });

    it('does not reach a Codex installed in fixed system directories outside PATH, HOME and SHELL', async () => {
        installedFiles.add('/usr/local/bin/codex');
        installedFiles.add('/opt/homebrew/bin/codex');
        installedFiles.add('/usr/bin/codex');
        const {resolveCodexCliPath} = await import('@electron/features/agent/codexCli');
        await expect(resolveCodexCliPath()).resolves.toBeNull();
    });
});
