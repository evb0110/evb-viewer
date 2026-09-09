import {
    spawn,
    type ChildProcess,
} from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

interface IModernSession {
    port: number;
    pid: number;
    cdpPort: number;
    electronPid: number | null;
    nuxtPid: number | null;
    nuxtPort: number;
    logs?: {
        manifestFile: string;
        sessionLogFile: string;
        runDir: string;
        relativeRunDir: string;
        runCombinedLogFile: string;
    };
}

interface ITestHarness {
    root: string;
    sessionName: string;
    modernSession: IModernSession | null;
    modernSessionNames: string[];
}

const harness: ITestHarness = {
    root: '',
    sessionName: 'default',
    modernSession: {
        port: 45_001,
        pid: 45_002,
        cdpPort: 45_003,
        electronPid: null,
        nuxtPid: null,
        nuxtPort: 45_004,
        logs: {
            manifestFile: '/tmp/modern-logs.json',
            sessionLogFile: '/tmp/modern-session.log',
            runDir: '/tmp/modern-run',
            relativeRunDir: 'modern-run',
            runCombinedLogFile: '/tmp/modern-combined.log',
        },
    },
    modernSessionNames: ['modern'],
};

const commandMocks = {
    sendCommand: vi.fn(async (command: string) => command === 'ping'
        ? {uptime: 12.4}
        : {ready: true}),
    cleanupStaleSessionArtifacts: vi.fn(async () => ({
        retained: false,
        reason: null,
    })),
    clearSessionStarting: vi.fn(),
    getSessionInfo: vi.fn(() => harness.modernSession),
    getSessionStartingInfo: vi.fn(() => null),
    isSessionRunning: vi.fn(async () => true),
    listAllSessionNames: vi.fn(() => harness.modernSessionNames),
    devSupervisor: vi.fn(async () => undefined),
    startSessionDetached: vi.fn(async () => undefined),
    stopSession: vi.fn(async () => undefined),
    stopSingleSession: vi.fn(async () => undefined),
    runDevLogs: vi.fn(),
    delay: vi.fn(async () => undefined),
};

let runCli: () => Promise<void>;
let originalArgv: string[];
let exitSpy: ReturnType<typeof vi.spyOn> | null = null;
let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null;
let consoleLogSpy: ReturnType<typeof vi.spyOn> | null = null;
let processKillSpy: ReturnType<typeof vi.spyOn> | null = null;

class ICliExit extends Error {
    readonly code: number | string | null | undefined;

    constructor(code: number | string | null | undefined) {
        super(`CLI exited with ${String(code)}`);
        this.code = code;
    }
}

function devkitPath(...parts: string[]) {
    return join(harness.root, '.devkit', ...parts);
}

function legacySessionPath() {
    return devkitPath('electron-session.json');
}

function legacyStartingPath() {
    return devkitPath('electron-session-starting.json');
}

function resetHarness() {
    rmSync(devkitPath(), {
        force: true,
        recursive: true,
    });
    mkdirSync(devkitPath(), {recursive: true});
    harness.sessionName = 'default';
    harness.modernSession = {
        port: 45_001,
        pid: 45_002,
        cdpPort: 45_003,
        electronPid: null,
        nuxtPid: null,
        nuxtPort: 45_004,
    };
    harness.modernSessionNames = ['modern'];
    for (const mock of Object.values(commandMocks)) {
        mock.mockClear();
    }
}

function writeLegacyRecord(path: string, record: unknown) {
    writeFileSync(path, JSON.stringify(record));
}

function writeBothLegacyRecords(pid: number, fields: Record<string, unknown> = {}) {
    writeLegacyRecord(legacySessionPath(), {
        ...fields,
        pid,
    });
    writeLegacyRecord(legacyStartingPath(), {
        ...fields,
        pid,
    });
}

async function invokeCli(args: string[]) {
    process.argv = [
        process.execPath,
        join(harness.root, 'scripts', 'electronRun.ts'),
        ...args,
    ];
    await runCli();
}

function installExitThrower() {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
        throw new ICliExit(code);
    });
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

function installOutputCapture() {
    const lines: string[] = [];
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
    });
    return lines;
}

function terminationSignals(killSpy: ReturnType<typeof vi.spyOn>) {
    return killSpy.mock.calls.filter(([
        , signal,
    ]: [
        unknown,
        NodeJS.Signals | number | undefined,
    ]) => signal === 'SIGTERM' || signal === 'SIGKILL');
}

function installProcessKillSpy() {
    processKillSpy = vi.spyOn(process, 'kill');
    return processKillSpy;
}

function spawnHarmlessFixture() {
    const child = spawn(process.execPath, [
        '-e',
        'setInterval(() => {}, 1000);',
    ], {stdio: 'ignore'});
    return new Promise<ChildProcess>((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', () => resolve(child));
    });
}

async function stopHarmlessFixture(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGKILL');
    });
}

describe('TH-12 CLI legacy session migration', () => {
    beforeAll(async () => {
        originalArgv = [...process.argv];
        harness.root = mkdtempSync(join(tmpdir(), 'evb-viewer-th12-cli-'));

        vi.doMock('@scripts/electron-run/projectRoot', () => ({projectRoot: harness.root}));
        vi.doMock('@scripts/electron-run/electronRunSessionPaths', () => ({
            getCurrentSessionName: () => harness.sessionName,
            sessionFilePath: (name = harness.sessionName) => devkitPath('sessions', name, 'session.json'),
            setCurrentSessionName: (name: string) => {
                harness.sessionName = name;
            },
        }));
        vi.doMock('@scripts/electron-run/electronRunSessionArtifacts', () => ({
            cleanupStaleSessionArtifacts: commandMocks.cleanupStaleSessionArtifacts,
            clearSessionStarting: commandMocks.clearSessionStarting,
            getSessionInfo: commandMocks.getSessionInfo,
            getSessionStartingInfo: commandMocks.getSessionStartingInfo,
            isSessionRunning: commandMocks.isSessionRunning,
            listAllSessionNames: commandMocks.listAllSessionNames,
        }));
        vi.doMock('@scripts/electron-run/electronRunProcessTree', async importOriginal => await importOriginal());
        vi.doMock('@scripts/electron-run/sendCommand', () => ({sendCommand: commandMocks.sendCommand}));
        vi.doMock('@scripts/electron-run/devSupervisor', () => ({devSupervisor: commandMocks.devSupervisor}));
        vi.doMock('@scripts/electron-run/startSessionDetached', () => ({startSessionDetached: commandMocks.startSessionDetached}));
        vi.doMock('@scripts/electron-run/stopSession', () => ({
            stopSession: commandMocks.stopSession,
            stopSingleSession: commandMocks.stopSingleSession,
        }));
        vi.doMock('@scripts/devLogs', () => ({runDevLogs: commandMocks.runDevLogs}));
        vi.doMock('es-toolkit/promise', () => ({delay: commandMocks.delay}));

        ({runCli} = await import('@scripts/electron-run/runCli'));
    });

    beforeEach(() => {
        resetHarness();
    });

    afterEach(() => {
        exitSpy?.mockRestore();
        consoleErrorSpy?.mockRestore();
        consoleLogSpy?.mockRestore();
        processKillSpy?.mockRestore();
        exitSpy = null;
        consoleErrorSpy = null;
        consoleLogSpy = null;
        processKillSpy = null;
        process.argv = [...originalArgv];
    });

    afterAll(() => {
        vi.resetModules();
        rmSync(harness.root, {
            force: true,
            recursive: true,
        });
        process.argv = [...originalArgv];
    });

    it.each([
        'status',
        'list',
        'health',
        'logs',
    ] as const)(
        '%s inspects both legacy records without signaling or rewriting them',
        async command => {
            const fixture = await spawnHarmlessFixture();
            const pid = fixture.pid!;
            writeBothLegacyRecords(pid, {
                executable: '/stale/project/node_modules/.bin/electron',
                projectRoot: '/stale/project',
                sessionName: 'stale-session',
                startTime: 'stale-start-time',
                bootId: 'stale-boot-id',
            });
            const sessionBytes = readFileSync(legacySessionPath(), 'utf8');
            const startingBytes = readFileSync(legacyStartingPath(), 'utf8');
            const output = installOutputCapture();
            const killSpy = installProcessKillSpy();

            try {
                await invokeCli([command]);

                expect(output.join('\n')).toContain('Legacy Electron session metadata');
                expect(output.join('\n')).toContain('ambiguous');
                expect(output.join('\n')).toContain('Preserved; no process signal was sent');
                expect(readFileSync(legacySessionPath(), 'utf8')).toBe(sessionBytes);
                expect(readFileSync(legacyStartingPath(), 'utf8')).toBe(startingBytes);
                expect(terminationSignals(killSpy)).toHaveLength(0);
                expect(fixture.exitCode).toBeNull();
            } finally {
                await stopHarmlessFixture(fixture);
            }
        },
    );

    it('lists modern session state beside dead legacy records and preserves both files', async () => {
        const legacyFixture = await spawnHarmlessFixture();
        const modernFixture = await spawnHarmlessFixture();
        const legacyPid = legacyFixture.pid!;
        const modernPid = modernFixture.pid!;
        await stopHarmlessFixture(legacyFixture);
        harness.modernSession = {
            ...harness.modernSession!,
            pid: modernPid,
        };
        writeBothLegacyRecords(legacyPid);
        const sessionBytes = readFileSync(legacySessionPath(), 'utf8');
        const startingBytes = readFileSync(legacyStartingPath(), 'utf8');
        const output = installOutputCapture();
        const killSpy = installProcessKillSpy();

        try {
            await invokeCli(['list']);

            expect(output.join('\n')).toContain('Status: dead');
            expect(output.join('\n')).toContain('modern');
            expect(output.join('\n')).toContain(`PID:     ${String(modernPid)}`);
            expect(readFileSync(legacySessionPath(), 'utf8')).toBe(sessionBytes);
            expect(readFileSync(legacyStartingPath(), 'utf8')).toBe(startingBytes);
            expect(terminationSignals(killSpy)).toHaveLength(0);
        } finally {
            await stopHarmlessFixture(modernFixture);
        }
    });

    it.each([
        'start',
        'cleanstart',
        'startd',
        'stop',
        'restart',
        'restartd',
    ] as const)(
        '%s refuses live legacy PIDs without inferring ownership or invoking the handler',
        async command => {
            const fixture = await spawnHarmlessFixture();
            const pid = fixture.pid!;
            writeBothLegacyRecords(pid);
            const sessionBytes = readFileSync(legacySessionPath(), 'utf8');
            const startingBytes = readFileSync(legacyStartingPath(), 'utf8');
            const killSpy = installProcessKillSpy();
            installExitThrower();

            try {
                await expect(invokeCli([command])).rejects.toMatchObject({code: 1});

                expect(commandMocks.devSupervisor).not.toHaveBeenCalled();
                expect(commandMocks.startSessionDetached).not.toHaveBeenCalled();
                expect(commandMocks.stopSession).not.toHaveBeenCalled();
                expect(commandMocks.stopSingleSession).not.toHaveBeenCalled();
                expect(readFileSync(legacySessionPath(), 'utf8')).toBe(sessionBytes);
                expect(readFileSync(legacyStartingPath(), 'utf8')).toBe(startingBytes);
                expect(terminationSignals(killSpy)).toHaveLength(0);
                expect(fixture.exitCode).toBeNull();
            } finally {
                await stopHarmlessFixture(fixture);
            }
        },
    );

    it('archives only dead legacy owners atomically and leaves their bytes recoverable', async () => {
        const fixture = await spawnHarmlessFixture();
        const pid = fixture.pid!;
        await stopHarmlessFixture(fixture);
        const sessionRecord = JSON.stringify({
            pid,
            form: 'session',
        });
        const startingRecord = JSON.stringify({
            pid,
            form: 'starting',
        });
        writeFileSync(legacySessionPath(), sessionRecord);
        writeFileSync(legacyStartingPath(), startingRecord);

        await invokeCli(['start']);

        expect(existsSync(legacySessionPath())).toBe(false);
        expect(existsSync(legacyStartingPath())).toBe(false);
        expect(readFileSync(`${legacySessionPath()}.migrated`, 'utf8')).toBe(sessionRecord);
        expect(readFileSync(`${legacyStartingPath()}.migrated`, 'utf8')).toBe(startingRecord);
        expect(commandMocks.devSupervisor).toHaveBeenCalledOnce();
    });

    it('keeps malformed legacy bytes and resolves unknown intent before inspecting them', async () => {
        const malformedSession = '{"pid":';
        const malformedStarting = 'not-json';
        writeFileSync(legacySessionPath(), malformedSession);
        writeFileSync(legacyStartingPath(), malformedStarting);
        const output = installOutputCapture();
        await invokeCli(['list']);

        expect(output.join('\n')).toContain('Status: malformed');
        expect(readFileSync(legacySessionPath(), 'utf8')).toBe(malformedSession);
        expect(readFileSync(legacyStartingPath(), 'utf8')).toBe(malformedStarting);

        installExitThrower();
        await expect(invokeCli(['start'])).rejects.toMatchObject({code: 1});
        expect(commandMocks.devSupervisor).not.toHaveBeenCalled();
        expect(readFileSync(legacySessionPath(), 'utf8')).toBe(malformedSession);
        expect(readFileSync(legacyStartingPath(), 'utf8')).toBe(malformedStarting);

        const fixture = await spawnHarmlessFixture();
        const pid = fixture.pid!;
        writeBothLegacyRecords(pid);
        const liveSessionBytes = readFileSync(legacySessionPath(), 'utf8');
        const liveStartingBytes = readFileSync(legacyStartingPath(), 'utf8');
        const killSpy = installProcessKillSpy();
        killSpy.mockClear();

        try {
            await expect(invokeCli(['unknown-command'])).rejects.toMatchObject({code: 1});
            expect(readFileSync(legacySessionPath(), 'utf8')).toBe(liveSessionBytes);
            expect(readFileSync(legacyStartingPath(), 'utf8')).toBe(liveStartingBytes);
            expect(killSpy).not.toHaveBeenCalled();
            expect(commandMocks.devSupervisor).not.toHaveBeenCalled();
        } finally {
            await stopHarmlessFixture(fixture);
        }
    });

    it('retains recoverable evidence when a multi-file migration is interrupted', async () => {
        const firstFixture = await spawnHarmlessFixture();
        const secondFixture = await spawnHarmlessFixture();
        const firstPid = firstFixture.pid!;
        const secondPid = secondFixture.pid!;
        await Promise.all([
            stopHarmlessFixture(firstFixture),
            stopHarmlessFixture(secondFixture),
        ]);
        const sessionRecord = JSON.stringify({
            pid: firstPid,
            form: 'session',
        });
        const startingRecord = JSON.stringify({
            pid: secondPid,
            form: 'starting',
        });
        writeFileSync(legacySessionPath(), sessionRecord);
        writeFileSync(legacyStartingPath(), startingRecord);
        const existingArchive = 'prior recovery evidence';
        writeFileSync(`${legacyStartingPath()}.migrated`, existingArchive);
        const killSpy = installProcessKillSpy();
        installExitThrower();

        await expect(invokeCli(['start'])).rejects.toMatchObject({code: 1});

        expect(existsSync(legacySessionPath())).toBe(false);
        expect(readFileSync(`${legacySessionPath()}.migrated`, 'utf8')).toBe(sessionRecord);
        expect(readFileSync(legacyStartingPath(), 'utf8')).toBe(startingRecord);
        expect(readFileSync(`${legacyStartingPath()}.migrated`, 'utf8')).toBe(existingArchive);
        expect(commandMocks.devSupervisor).not.toHaveBeenCalled();
        expect(terminationSignals(killSpy)).toHaveLength(0);
    });
});
