import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {Transport} from '@sentry/core';
import type {DiagnosticEventId} from '@contracts/diagnostics/diagnosticEventId';
import {requireEpochMs} from '@contracts/timestamps';
import {
    decodeStartupCrashMarkerRecord,
    type StartupCrashMarkerRecord,
} from '@contracts/diagnostics/startupCrashMarker';
import {createNoopMainDiagnosticsTransport} from '@electron/features/diagnostics/public';
import {createSentryNodeDiagnosticsTransport} from '@electron/features/diagnostics/sentryNodeAdapter';
import {
    installStartupCrashMarker,
    notifyStartupCrashMarkerAdapterReady,
    resolveDesktopDiagnosticDist,
    type IStartupCrashMarkerFileSystem,
    type IStartupCrashMarkerOptions,
    type IStartupCrashMarkerProcess,
} from '@electron/features/diagnostics/startupCrashMarker';

const MARKER_PATH = '/diagnostics-user-data/startup-crash-marker.json';
const RELEASE = 'evb-viewer-desktop@0.1.449';
const DIST = 'macos-arm64';
const EVENT_ID = '0123456789abcdef0123456789abcdef' as DiagnosticEventId;

function createProcess() {
    let listener: ((error: unknown) => void) | undefined;
    const on = vi.fn((
        _event: 'uncaughtExceptionMonitor',
        next: (error: unknown) => void,
    ) => {
        listener = next;
    });
    const off = vi.fn((
        _event: 'uncaughtExceptionMonitor',
        next: (error: unknown) => void,
    ) => {
        if (listener === next) {
            listener = undefined;
        }
    });
    const processSource: IStartupCrashMarkerProcess = {
        on,
        off,
    };
    return {
        processSource,
        on,
        off,
        emit(error: unknown) {
            listener?.(error);
        },
        hasListener() {
            return listener !== undefined;
        },
    };
}

function createFileSystem(initialContent?: string) {
    let content = initialContent;
    const readFileSync = vi.fn((_path: string, _encoding: 'utf8') => {
        if (content === undefined) {
            throw new Error('ENOENT');
        }
        return content;
    });
    const unlinkSync = vi.fn((_path: string) => {
        content = undefined;
    });
    const writeFileSync = vi.fn((
        _path: string,
        data: string,
        _options: {
            encoding: 'utf8';
            flag: 'w'
        },
    ) => {
        content = data;
    });
    const fileSystem: IStartupCrashMarkerFileSystem = {
        readFileSync,
        unlinkSync,
        writeFileSync,
    };
    return {
        fileSystem,
        readFileSync,
        unlinkSync,
        writeFileSync,
        getContent: () => content,
    };
}

function createMarker(overrides: Partial<StartupCrashMarkerRecord> = {}): StartupCrashMarkerRecord {
    return {
        schemaVersion: 1,
        eventId: EVENT_ID,
        code: 'MAIN_STARTUP_CRASH',
        frames: [],
        timestamp: requireEpochMs(1_735_689_600_000),
        release: RELEASE,
        dist: DIST,
        ...overrides,
    };
}

function install(
    options: Partial<IStartupCrashMarkerOptions> = {},
    initialContent?: string,
    markPrimaryInstanceReady = true,
) {
    const process = createProcess();
    const fileSystem = createFileSystem(initialContent);
    const controller = installStartupCrashMarker({
        markerPath: MARKER_PATH,
        preference: 'granted',
        release: RELEASE,
        dist: DIST,
        createEventId: () => EVENT_ID,
        fileSystem: fileSystem.fileSystem,
        now: () => 1_735_689_600_000,
        process: process.processSource,
        ...options,
    });
    if (markPrimaryInstanceReady) {
        controller.markPrimaryInstanceReady();
    }
    return {
        ...process,
        ...fileSystem,
        controller,
    };
}

describe('startup crash marker', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('writes one strict marker and replaces it instead of creating a queue', () => {
        const setup = install();

        expect(setup.controller.isArmed()).toBe(true);
        setup.emit(new Error(
            'secret-document.pdf\n    at startupMarker (electron/main.ts:12:4)',
        ));
        setup.emit(new Error('second occurrence'));

        expect(setup.writeFileSync).toHaveBeenCalledTimes(1);
        expect(setup.writeFileSync).toHaveBeenCalledWith(
            MARKER_PATH,
            expect.any(String),
            {
                encoding: 'utf8',
                flag: 'w',
            },
        );
        const marker = JSON.parse(setup.getContent()!) as Record<string, unknown>;
        expect(Object.keys(marker).sort()).toEqual([
            'code',
            'dist',
            'eventId',
            'frames',
            'release',
            'schemaVersion',
            'timestamp',
        ]);
        expect(marker).toMatchObject({
            schemaVersion: 1,
            eventId: EVENT_ID,
            code: 'MAIN_STARTUP_CRASH',
            timestamp: 1_735_689_600_000,
            release: RELEASE,
            dist: DIST,
        });
        expect(marker.frames).toEqual([{
            module: 'electron/main.ts',
            function: 'startupMarker',
            line: 12,
            column: 4,
        }]);
        expect(setup.getContent()).not.toContain('secret-document.pdf');
        expect(setup.controller.isArmed()).toBe(false);
        expect(setup.off).toHaveBeenCalledTimes(1);
    });

    it('does not write after denial, a preference read failure, or an unsupported dist', () => {
        const denied = install({preference: 'denied'});
        denied.emit(new Error('denied'));
        expect(denied.writeFileSync).not.toHaveBeenCalled();
        expect(denied.controller.isArmed()).toBe(false);

        const readFailure = install({preference: () => { throw new Error('unreadable'); }});
        readFailure.emit(new Error('unknown preference'));
        expect(readFailure.writeFileSync).not.toHaveBeenCalled();
        expect(readFailure.controller.isArmed()).toBe(false);

        const unsupported = install({dist: null});
        unsupported.emit(new Error('unsupported configuration'));
        expect(unsupported.writeFileSync).not.toHaveBeenCalled();
        expect(unsupported.controller.isArmed()).toBe(false);
    });

    it('leaves a granted marker armed when the reporter is only a no-op or unready', () => {
        let liveDeliveryAvailable = false;
        const setup = install({isLiveDeliveryAvailable: () => liveDeliveryAvailable});
        const noOpTransport = createNoopMainDiagnosticsTransport();

        // A bootstrap reporter may report isReady=true for its no-op transport.
        // It cannot change this controller until the explicit adapter handoff.
        expect(noOpTransport.isReady).toBe(true);
        expect(setup.controller.isArmed()).toBe(true);
        expect(setup.unlinkSync).toHaveBeenCalledOnce();
        expect(setup.hasListener()).toBe(true);

        liveDeliveryAvailable = true;
        setup.emit(new Error('live adapter became available'));
        expect(setup.writeFileSync).not.toHaveBeenCalled();
        expect(setup.controller.isArmed()).toBe(false);
        expect(setup.off).toHaveBeenCalledTimes(1);
    });

    it('does not retry a failed marker write', () => {
        const baseFileSystem = createFileSystem();
        const writeFileSync = vi.fn(() => { throw new Error('EACCES'); });
        const setup = install({fileSystem: {
            ...baseFileSystem.fileSystem,
            writeFileSync,
        }});

        setup.emit(new Error('write failure'));
        setup.emit(new Error('second write failure'));

        expect(writeFileSync).toHaveBeenCalledTimes(1);
        expect(setup.controller.isArmed()).toBe(false);
    });

    it('keeps a valid marker on disk until the process is the primary instance', () => {
        const marker = createMarker();
        const setup = install({}, JSON.stringify(marker), false);
        const send = vi.fn();

        expect(setup.readFileSync).not.toHaveBeenCalled();
        expect(setup.unlinkSync).not.toHaveBeenCalled();
        expect(setup.getContent()).toBe(JSON.stringify(marker));

        expect(notifyStartupCrashMarkerAdapterReady({
            preference: 'granted',
            release: RELEASE,
            dist: DIST,
            send,
        })).toBe(true);
        expect(send).not.toHaveBeenCalled();

        setup.controller.markPrimaryInstanceReady();
        expect(setup.readFileSync).toHaveBeenCalledOnce();
        expect(setup.unlinkSync).toHaveBeenCalledOnce();
        expect(setup.getContent()).toBeUndefined();

        expect(setup.controller.isArmed()).toBe(false);
        expect(setup.off).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith(marker);
        expect(setup.unlinkSync).toHaveBeenCalledOnce();
        expect(setup.getContent()).toBeUndefined();
    });

    it('discards a marker from a different validated build without handing it to transport', () => {
        const setup = install({}, JSON.stringify(createMarker({
            release: 'evb-viewer-desktop@0.1.448',
            dist: 'windows-x64',
        })));
        const send = vi.fn();
        const onDiscard = vi.fn();

        setup.controller.onLiveAdapterReady({
            preference: 'granted',
            release: RELEASE,
            dist: DIST,
            send,
            onDiscard,
        });

        expect(send).not.toHaveBeenCalled();
        expect(onDiscard).toHaveBeenCalledExactlyOnceWith('build-identity-mismatch');
        expect(setup.unlinkSync).toHaveBeenCalledOnce();
        expect(setup.getContent()).toBeUndefined();
    });

    it('reconstructs a matching marker as one closed envelope at the adapter boundary', async () => {
        const marker = createMarker({frames: [{
            module: 'electron/startup.ts',
            function: 'boot',
            line: 17,
            column: 9,
        }]});
        const setup = install({}, JSON.stringify(marker));
        const envelopes: unknown[] = [];
        const adapter = createSentryNodeDiagnosticsTransport({
            dsn: 'https://publickey@o123.ingest.de.sentry.io/456',
            identity: {
                target: 'desktop',
                release: RELEASE,
                dist: DIST,
                environment: 'test',
            },
            appVersion: '0.1.449',
            platform: 'darwin',
            architecture: 'arm64',
            makeTransport: () => ({
                send: vi.fn((envelope: unknown) => {
                    envelopes.push(envelope);
                    return Promise.resolve({statusCode: 200});
                }),
                flush: vi.fn(() => Promise.resolve(true)),
            } as Transport),
        });

        setup.controller.onLiveAdapterReady({
            preference: 'granted',
            release: RELEASE,
            dist: DIST,
            send: savedMarker => adapter.send?.({
                schemaVersion: 1,
                eventId: savedMarker.eventId,
                code: 'MAIN_STARTUP_CRASH',
                severity: 'fatal',
                runtime: 'electron-main',
                operation: 'startup-crash',
                occurredAt: savedMarker.timestamp,
                frames: savedMarker.frames,
                context: {},
            }),
        });

        await new Promise<void>(resolvePromise => setImmediate(resolvePromise));
        expect(envelopes).toHaveLength(1);
        const serialized = JSON.stringify(envelopes[0]);
        expect(serialized).toContain(EVENT_ID);
        expect(serialized).toContain('1735689600');
        expect(serialized).toContain('electron/startup.ts');
        expect(serialized).toContain('evb-viewer-desktop@0.1.449');
        expect(serialized).toContain('macos-arm64');
        expect(serialized).toContain('evb-diagnostic-v1');
        expect(setup.unlinkSync).toHaveBeenCalledOnce();
    });

    it.each([
        [
            'denied',
            'granted',
        ],
        [
            'corrupt',
            '{',
        ],
        [
            'partial',
            JSON.stringify({schemaVersion: 1}),
        ],
        [
            'unknown extra',
            JSON.stringify({
                ...createMarker(),
                message: 'free-form',
            }),
        ],
    ])('deletes a %s marker without sending it', (_name, content) => {
        const setup = install({preference: _name === 'denied' ? 'denied' : 'granted'}, content);
        const send = vi.fn();

        setup.controller.onLiveAdapterReady({
            preference: _name === 'denied' ? 'denied' : 'granted',
            release: RELEASE,
            dist: DIST,
            send,
        });

        expect(send).not.toHaveBeenCalled();
        expect(setup.unlinkSync).toHaveBeenCalledTimes(1);
        expect(setup.getContent()).toBeUndefined();
    });

    it('deletes a marker even when live replay delivery throws', () => {
        const setup = install({}, JSON.stringify(createMarker()));
        const send = vi.fn(() => { throw new Error('transport failed'); });

        expect(() => setup.controller.onLiveAdapterReady({
            preference: 'granted',
            release: RELEASE,
            dist: DIST,
            send,
        })).not.toThrow();
        expect(send).toHaveBeenCalledTimes(1);
        expect(setup.unlinkSync).toHaveBeenCalledTimes(1);
        expect(setup.getContent()).toBeUndefined();
    });

    it('observes rejecting replay and live thenables without an unhandled rejection', async () => {
        const unhandledRejection = vi.fn();
        process.once('unhandledRejection', unhandledRejection);
        try {
            const replay = install({}, JSON.stringify(createMarker()));
            const replaySend = vi.fn(() => Promise.reject(new Error('replay failed')));
            replay.controller.onLiveAdapterReady({
                preference: 'granted',
                release: RELEASE,
                dist: DIST,
                send: replaySend,
            });

            const live = install();
            const liveSend = vi.fn(() => Promise.reject(new Error('live failed')));
            live.controller.onLiveAdapterReady({
                preference: 'granted',
                release: RELEASE,
                dist: DIST,
                send: liveSend,
            });
            expect(live.controller.captureLiveException(new Error('live failure'))).toBeDefined();

            await new Promise<void>(resolvePromise => {
                setImmediate(resolvePromise);
            });
            expect(replaySend).toHaveBeenCalledTimes(1);
            expect(liveSend).toHaveBeenCalledTimes(1);
            expect(replay.getContent()).toBeUndefined();
            expect(live.getContent()).toBeUndefined();
            expect(unhandledRejection).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', unhandledRejection);
        }
    });

    it('sends one live occurrence after adapter handoff and never writes a marker', () => {
        const setup = install();
        const send = vi.fn();

        setup.controller.onLiveAdapterReady({
            preference: 'granted',
            release: RELEASE,
            dist: DIST,
            send,
        });
        const firstReceipt = setup.controller.captureLiveException(
            new Error('live failure\n    at liveFailure (electron/main.ts:20:3)'),
        );
        const secondReceipt = setup.controller.captureLiveException(new Error('duplicate'));

        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0]?.[0]).toMatchObject({
            eventId: firstReceipt?.eventId,
            code: 'MAIN_STARTUP_CRASH',
            frames: [{
                module: 'electron/main.ts',
                function: 'liveFailure',
                line: 20,
                column: 3,
            }],
        });
        expect(secondReceipt).toEqual(firstReceipt);
        expect(setup.writeFileSync).not.toHaveBeenCalled();
        expect(setup.getContent()).toBeUndefined();
    });

    it('does not suppress a new live occurrence after replaying a marker from an earlier launch', () => {
        const setup = install({}, JSON.stringify(createMarker()));
        const send = vi.fn();

        setup.controller.onLiveAdapterReady({
            preference: 'granted',
            release: RELEASE,
            dist: DIST,
            send,
        });
        const receipt = setup.controller.captureLiveException(new Error('current launch'));

        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls[0]?.[0]).toEqual(createMarker());
        expect(send.mock.calls[1]?.[0]).toMatchObject({
            code: 'MAIN_STARTUP_CRASH',
            eventId: receipt?.eventId,
        });
        expect(setup.unlinkSync).toHaveBeenCalledTimes(1);
        expect(setup.getContent()).toBeUndefined();
    });

    it('uses the shared desktop dist identities and fails closed for unsupported platforms', () => {
        expect(resolveDesktopDiagnosticDist('darwin', 'arm64', undefined)).toBe('macos-arm64');
        expect(resolveDesktopDiagnosticDist('win32', 'x64', 'store-appx-x64')).toBe('store-appx-x64');
        expect(resolveDesktopDiagnosticDist('freebsd' as NodeJS.Platform, 'riscv64', undefined)).toBeNull();
        expect(resolveDesktopDiagnosticDist('linux', 'x64', 'not-a-dist')).toBe('linux-x64');
    });

    it('accepts the development release identity used by the main process', () => {
        expect(decodeStartupCrashMarkerRecord(createMarker({release: `${RELEASE}+0123456789abcdef0123456789abcdef01234567`}))).not.toBeNull();
    });

    it('installs the monitor after the synchronous preference read and loads the adapter only after reporter construction', () => {
        const source = readFileSync(resolve(process.cwd(), 'electron/bootstrap/mainProcess.ts'), 'utf8');
        const preferenceIndex = source.indexOf('const diagnosticsPreference = readDiagnosticsPreferenceSync();');
        const markerIndex = source.indexOf('installStartupCrashMarker({', preferenceIndex);
        const reporterIndex = source.indexOf('mainFailureReporterForAdapter = initializeMainFailureReporter({');
        const grantedLoadIndex = source.indexOf('if (diagnosticsPreference === \'granted\')', reporterIndex);
        const bootstrapIndex = source.indexOf('void runInitSequence({');
        const durableSettingsIndex = source.indexOf('const settings = await loadSettings();', bootstrapIndex);
        const mainPreferenceIndex = source.indexOf(
            'setMainDiagnosticsPreference(settings.clientDiagnosticsPreference);',
            durableSettingsIndex,
        );
        const resourceProfileIndex = source.indexOf('initializeHostResourceProfile({', durableSettingsIndex);

        expect(preferenceIndex).toBeGreaterThan(-1);
        expect(markerIndex).toBeGreaterThan(preferenceIndex);
        expect(reporterIndex).toBeGreaterThan(markerIndex);
        expect(grantedLoadIndex).toBeGreaterThan(reporterIndex);
        expect(reporterIndex).toBeLessThan(bootstrapIndex);
        expect(mainPreferenceIndex).toBeGreaterThan(durableSettingsIndex);
        expect(mainPreferenceIndex).toBeLessThan(resourceProfileIndex);
        expect(source.slice(markerIndex, reporterIndex)).not.toContain('isTransportReady');
        expect(source.slice(reporterIndex, grantedLoadIndex)).not.toContain('import(\'@electron/features/diagnostics/sentryNodeAdapter\')');
    });

    it('captures the live exception before the existing coordinated fatal shutdown call', () => {
        const source = readFileSync(resolve(process.cwd(), 'electron/bootstrap/mainProcess.ts'), 'utf8');
        const handlerIndex = source.indexOf('process.on(\'uncaughtException\', (error) => {');
        const handler = source.slice(handlerIndex, source.indexOf('\n});', handlerIndex) + 4);

        expect(handler).toContain('const receipt = startupCrashMarker.captureLiveException(error);');
        expect(handler.indexOf('captureLiveException')).toBeLessThan(handler.indexOf('requestFatalShutdown'));
        expect(handler).toContain('Uncaught exception in main process: ${error.stack ?? error.message}');
        expect(handler).toContain('receipt,');
        expect(source).toContain('logger: shutdownLogger,');
    });
});
