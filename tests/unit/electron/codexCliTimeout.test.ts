import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type * as NodeChildProcess from 'node:child_process';
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
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type * as NodeFsPromises from 'fs/promises';
import { FakeAssistantAppServerProcess } from '@tests/unit/electron/helpers/fakeAssistantAppServerProcess';

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    terminateDetachedChildProcess: vi.fn(),
    existsSync: vi.fn<typeof NodeFs.existsSync>(() => true),
    access: vi.fn<typeof NodeFsPromises.access>(async () => undefined),
    userData: '/tmp/evb-codex-test',
}));

vi.mock('child_process', () => ({spawn: mocks.spawn}));
vi.mock('fs', async importOriginal => ({
    ...(await importOriginal<typeof NodeFs>()),
    existsSync: mocks.existsSync,
}));
vi.mock('fs/promises', async importOriginal => ({
    ...(await importOriginal<typeof NodeFsPromises>()),
    access: mocks.access,
}));
vi.mock('electron', () => ({app: {getPath: () => mocks.userData}}));
vi.mock('@electron/utils/nativeChildProcess', () => ({
    createDetachedChildProcessSpawnOptions: (options: Record<string, unknown>) => ({
        ...options,
        detached: true,
    }),
    terminateDetachedChildProcess: (...args: unknown[]) => mocks.terminateDetachedChildProcess(...args),
}));

describe('Codex CLI timeout cleanup', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.resetModules();
        vi.clearAllMocks();
        mocks.existsSync.mockReturnValue(true);
        mocks.access.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not settle a timeout until the detached process tree is terminated', async () => {
        const process = new FakeAssistantAppServerProcess(() => true);
        let finishTermination!: (terminated: boolean) => void;
        mocks.spawn.mockReturnValue(process);
        mocks.terminateDetachedChildProcess.mockReturnValue(new Promise<boolean>(resolve => {
            finishTermination = resolve;
        }));
        const {runCodexCli} = await import('@electron/features/agent/codexCli');
        let settled = false;
        const resultPromise = runCodexCli('/usr/bin/codex', ['--version']).then((result) => {
            settled = true;
            return result;
        });

        await vi.advanceTimersByTimeAsync(15_000);

        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(process, 1_000);
        expect(settled).toBe(false);

        finishTermination(true);
        await expect(resultPromise).resolves.toMatchObject({
            ok: false,
            stderr: 'Command timed out.',
        });
    });

    it('requests piped output from the spawned process', async () => {
        const process = new FakeAssistantAppServerProcess(() => true);
        mocks.spawn.mockReturnValue(process);
        const {runCodexCli} = await import('@electron/features/agent/codexCli');

        const resultPromise = runCodexCli('/usr/bin/codex', ['--version']);
        process.emit('close', 1);
        await expect(resultPromise).resolves.toMatchObject({
            ok: false,
            exitCode: 1,
        });
        expect(mocks.spawn).toHaveBeenCalledWith(
            '/usr/bin/codex',
            ['--version'],
            expect.objectContaining({stdio: [
                'pipe',
                'pipe',
                'pipe',
            ]}),
        );
    });

    it('reports when timeout cleanup cannot confirm process-tree termination', async () => {
        const process = new FakeAssistantAppServerProcess(() => true);
        mocks.spawn.mockReturnValue(process);
        mocks.terminateDetachedChildProcess.mockResolvedValue(false);
        const {runCodexCli} = await import('@electron/features/agent/codexCli');
        const resultPromise = runCodexCli('/usr/bin/codex', ['--version']);

        await vi.advanceTimersByTimeAsync(15_000);

        await expect(resultPromise).resolves.toMatchObject({
            ok: false,
            stderr: 'Command timed out and its process tree did not terminate.',
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
        const childProcess = await vi.importActual<typeof NodeChildProcess>('node:child_process');
        mocks.existsSync.mockImplementation(path => typeof path === 'string' && path.startsWith(fixtureDir) && fs.existsSync(path));
        mocks.access.mockImplementation(fsPromises.access);
        // Run the version-only Node fixture portably, including on Windows.
        mocks.spawn.mockImplementation((command, args, options) => childProcess.spawn(
            process.execPath,
            /powershell\.exe$/iu.test(command)
                ? [
                    '--eval',
                    fs.readFileSync(args[args.indexOf('-File') + 1]!, 'utf8'),
                ]
                : [
                    command,
                    ...args,
                ],
            options,
        ));
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

    it('observes missing installations, recovery, override changes and managed installation', async () => {
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
        expect(await getCodexCliInfo()).toMatchObject({
            path: managed,
            version: '0.160.1',
        });
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

    it('retries a rejected version launch instead of retaining its rejected promise', async () => {
        const {getCodexCliInfo} = await import('@electron/features/agent/codexCli');
        mocks.spawn.mockImplementationOnce(() => {
            throw new Error('version launch failed');
        });
        await expect(getCodexCliInfo()).rejects.toThrow('version launch failed');
        expect(await getCodexCliInfo()).toMatchObject({version: '0.157.1'});
        expect(await versionInvocations()).toBe(1);
    });
});
