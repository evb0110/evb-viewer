import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type * as Fs from 'node:fs';
const sdk = vi.hoisted(() => ({
    captureException: vi.fn(),
    client: null as {getOptions: () => {enabled?: boolean}} | null,
    getClient: vi.fn(),
    init: vi.fn(),
    options: null as null | {
        enabled?: boolean;
        transport?: (options: Record<string, unknown>) => {
            send: (envelope: unknown) => Promise<unknown>;
            flush: (timeout?: number) => Promise<boolean>;
        };
    },
    readFileSync: vi.fn(),
    rmSync: vi.fn(),
    send: vi.fn(),
    useMockFs: false,
}));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof Fs>();
    return {
        ...actual,
        readFileSync: (...args: Parameters<typeof actual.readFileSync>) =>
            sdk.useMockFs ? sdk.readFileSync(...args) : actual.readFileSync(...args),
        rmSync: (...args: Parameters<typeof actual.rmSync>) => (sdk.useMockFs ? sdk.rmSync(...args) : actual.rmSync(...args)),
    };
});

vi.mock('electron', () => ({
    app: {
        getPath: () => '/tmp/evb-diagnostics-consent-test',
        getVersion: () => '0.0.0',
        isPackaged: true,
    },
}));
vi.mock('@sentry/core', () => ({
    captureException: sdk.captureException,
    getClient: () => {
        sdk.getClient();
        return sdk.client;
    },
}));
vi.mock('@sentry/electron/main', () => ({
    IPCMode: {Classic: 1},
    makeElectronTransport: () => ({
        send: sdk.send,
        flush: vi.fn(async () => true),
    }),
    init: (options: {enabled?: boolean}) => {
        sdk.options = options as typeof sdk.options;
        sdk.init(options);
        sdk.client = {getOptions: () => options};
    },
}));

async function importWithDsn() {
    vi.stubGlobal('__EVB_SENTRY_DSN__', 'https://public@sentry.invalid/1');
    return import('@electron/features/diagnostics/sentry');
}

describe('main diagnostics consent', () => {
    beforeEach(() => {
        vi.resetModules();
        sdk.client = null;
        sdk.getClient.mockClear();
        sdk.init.mockClear();
        sdk.captureException.mockClear();
        sdk.options = null;
        sdk.send.mockReset();
        sdk.readFileSync.mockReset();
        sdk.rmSync.mockReset();
        sdk.useMockFs = false;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it.each(['unknown', 'denied'] as const)('never loads the SDK while consent is %s', async (preference) => {
        const diagnostics = await importWithDsn();

        diagnostics.setMainDiagnosticsPreference(preference);
        await vi.dynamicImportSettled();

        expect(sdk.init).not.toHaveBeenCalled();
        expect(sdk.getClient).not.toHaveBeenCalled();
        expect(sdk.captureException).not.toHaveBeenCalled();
    });

    it('loads the SDK once consent is granted and stops sending when it is revoked', async () => {
        const diagnostics = await importWithDsn();

        diagnostics.setMainDiagnosticsPreference('granted');
        await vi.dynamicImportSettled();
        expect(sdk.init).toHaveBeenCalledOnce();
        expect(sdk.client?.getOptions().enabled).toBe(true);

        diagnostics.setMainDiagnosticsPreference('denied');
        expect(sdk.client?.getOptions().enabled).toBe(false);
        expect(sdk.init).toHaveBeenCalledOnce();
    });

    it('does not retain or retry a failed envelope after consent is revoked', async () => {
        const diagnostics = await importWithDsn();
        diagnostics.setMainDiagnosticsPreference('granted');
        await vi.dynamicImportSettled();
        expect(sdk.options?.transport).toBeTypeOf('function');

        sdk.send.mockRejectedValueOnce(new Error('offline'));
        const transport = sdk.options!.transport!({url: 'https://sentry.invalid'});
        const envelope = {event_id: '0'.repeat(32)};
        await expect(transport.send(envelope)).rejects.toThrow('offline');
        expect(sdk.send).toHaveBeenCalledOnce();

        diagnostics.setMainDiagnosticsPreference('denied');
        await transport.send(envelope);
        expect(sdk.send).toHaveBeenCalledOnce();
    });

    it('sends main-process failures captured during an authorized SDK load once ready', async () => {
        const {captureMainFailure, setMainFailureCaptureState} = await import('@electron/utils/captureMainFailure');
        let resolveLoad!: () => void;
        const load = new Promise<void>((resolve) => {
            resolveLoad = resolve;
        });
        setMainFailureCaptureState('granted', load);

        const receipt = captureMainFailure({
            code: 'MAIN_TEST_FAILURE',
            message: 'A safe test error',
        });
        expect(sdk.captureException).not.toHaveBeenCalled();

        resolveLoad();
        await load;
        await vi.dynamicImportSettled();

        expect(sdk.captureException).toHaveBeenCalledOnce();
        expect(sdk.captureException.mock.calls[0]?.[1]).toMatchObject({event_id: receipt.eventId});
    });

    it('discards main-process failures queued during SDK loading when consent is withdrawn', async () => {
        const {captureMainFailure, setMainFailureCaptureState} = await import('@electron/utils/captureMainFailure');
        let resolveLoad!: () => void;
        const load = new Promise<void>((resolve) => {
            resolveLoad = resolve;
        });
        setMainFailureCaptureState('granted', load);
        captureMainFailure({
            code: 'MAIN_TEST_FAILURE',
            message: 'A safe test error',
        });
        setMainFailureCaptureState('denied', null);
        resolveLoad();
        await load;
        await Promise.resolve();

        expect(sdk.captureException).not.toHaveBeenCalled();
    });

    it('flushes queued main failures when granted state settles with load=null and skips @sentry/core with empty DSN', async () => {
        vi.stubGlobal('__EVB_SENTRY_DSN__', '');
        const diagnosticsNoDsn = await import('@electron/features/diagnostics/sentry');
        const {captureMainFailure, registerMainFailureCaptureSender, setMainFailureCaptureState} =
            await import('@electron/utils/captureMainFailure');

        diagnosticsNoDsn.setMainDiagnosticsPreference('granted');
        captureMainFailure({
            code: 'MAIN_EMPTY_DSN',
            message: 'Should not load @sentry/core when DSN is empty',
        });
        await vi.dynamicImportSettled();
        expect(sdk.init).not.toHaveBeenCalled();
        expect(sdk.captureException).not.toHaveBeenCalled();

        let resolveLoad!: () => void;
        const load = new Promise<void>((resolve) => {
            resolveLoad = resolve;
        });
        const sender = vi.fn();
        setMainFailureCaptureState('granted', load, {managedBySdk: true});
        captureMainFailure({
            code: 'MAIN_QUEUED_FLUSH',
            message: 'Queued before second grant call',
        });
        registerMainFailureCaptureSender(sender);
        setMainFailureCaptureState('granted', null, {managedBySdk: true});
        expect(sender).toHaveBeenCalledOnce();

        resolveLoad();
        await load;
        await Promise.resolve();
        expect(sender).toHaveBeenCalledOnce();
    });

    it('skips rmSync when the startup crash marker does not exist, and removes corrupt or valid markers', async () => {
        sdk.useMockFs = true;
        const diagnostics = await importWithDsn();

        sdk.readFileSync.mockImplementationOnce(() => {
            throw Object.assign(new Error('missing'), {code: 'ENOENT'});
        });
        diagnostics.consumeStartupCrashMarker();
        expect(sdk.rmSync).not.toHaveBeenCalled();

        sdk.readFileSync.mockReturnValueOnce('{corrupt');
        diagnostics.consumeStartupCrashMarker();
        expect(sdk.rmSync).toHaveBeenCalledOnce();

        sdk.rmSync.mockClear();
        diagnostics.setMainDiagnosticsPreference('granted');
        sdk.readFileSync.mockReturnValueOnce(JSON.stringify({name: 'TypeError', message: 'boot boom', stack: 'TypeError: boot boom'}));
        diagnostics.consumeStartupCrashMarker();
        await vi.dynamicImportSettled();
        expect(sdk.rmSync).toHaveBeenCalledOnce();
        expect(sdk.captureException).toHaveBeenCalledOnce();
    });

    it('waits for an in-flight main SDK startup when consenting and resolves immediately otherwise', async () => {
        const nonConsenting = await importWithDsn();
        nonConsenting.setMainDiagnosticsPreference('denied');
        await nonConsenting.waitForMainDiagnosticsReady();
        expect(sdk.init).not.toHaveBeenCalled();

        vi.resetModules();
        const gate = deferred();
        vi.doMock('@sentry/electron/main', async () => {
            await gate.promise;
            return {
                IPCMode: {Classic: 1},
                makeElectronTransport: () => ({
                    send: sdk.send,
                    flush: vi.fn(() => Promise.resolve(true)),
                }),
                init: (options: {enabled?: boolean}) => {
                    sdk.options = options as typeof sdk.options;
                    sdk.init(options);
                    sdk.client = {getOptions: () => options};
                },
            };
        });
        try {
            const consenting = await importWithDsn();
            consenting.setMainDiagnosticsPreference('granted');

            let ready = false;
            const waiting = consenting.waitForMainDiagnosticsReady().then(() => {
                ready = true;
            });
            await Promise.resolve();
            await Promise.resolve();
            expect(ready).toBe(false);
            expect(sdk.init).not.toHaveBeenCalled();

            gate.resolve();
            await waiting;
            expect(ready).toBe(true);
            expect(sdk.init).toHaveBeenCalledOnce();
        } finally {
            vi.doUnmock('@sentry/electron/main');
        }
    });

    it('keeps waitForMainDiagnosticsReady nonfatal when SDK startup fails', async () => {
        vi.resetModules();
        vi.doMock('@sentry/electron/main', () => {
            throw new Error('simulated sentry import failure');
        });
        try {
            const diagnostics = await importWithDsn();
            diagnostics.setMainDiagnosticsPreference('granted');
            await expect(diagnostics.waitForMainDiagnosticsReady()).resolves.toBeUndefined();
        } finally {
            vi.doUnmock('@sentry/electron/main');
        }
    });
});

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return {
        promise,
        resolve,
    };
}

describe('renderer diagnostics SDK loading', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.doUnmock('@sentry/browser');
        vi.resetModules();
    });

    it('sends failures captured during an authorized SDK load after initialization', async () => {
        const gate = deferred();
        const rendererSdk = {
            captureException: vi.fn(),
            getClient: vi.fn(() => ({getOptions: () => ({enabled: true})})),
            init: vi.fn(),
            makeFetchTransport: vi.fn(),
        };
        vi.doMock('@sentry/browser', async () => {
            await gate.promise;
            return rendererSdk;
        });
        const reporter = await import('@app/utils/failureReporter');
        reporter.initializeRendererDiagnostics({
            dsn: 'https://public@sentry.invalid/1',
            release: 'test',
            environment: 'test',
        });
        reporter.setRendererDiagnosticsPreference('granted');
        reporter.captureRendererFailure({
            code: 'RENDERER_TEST_FAILURE',
            local: {
                source: 'test',
                message: 'Safe local message',
            },
        });
        expect(rendererSdk.captureException).not.toHaveBeenCalled();

        gate.resolve();
        await vi.dynamicImportSettled();

        expect(rendererSdk.captureException).toHaveBeenCalledOnce();
    });

    it('discards failures queued during SDK loading when consent is withdrawn', async () => {
        const gate = deferred();
        const rendererSdk = {
            captureException: vi.fn(),
            getClient: vi.fn(() => ({getOptions: () => ({enabled: true})})),
            init: vi.fn(),
            makeFetchTransport: vi.fn(),
        };
        vi.doMock('@sentry/browser', async () => {
            await gate.promise;
            return rendererSdk;
        });
        const reporter = await import('@app/utils/failureReporter');
        reporter.initializeRendererDiagnostics({
            dsn: 'https://public@sentry.invalid/1',
            release: 'test',
            environment: 'test',
        });
        reporter.setRendererDiagnosticsPreference('granted');
        reporter.captureRendererFailure({
            code: 'RENDERER_TEST_FAILURE',
            local: {
                source: 'test',
                message: 'Safe local message',
            },
        });
        reporter.setRendererDiagnosticsPreference('denied');

        gate.resolve();
        await vi.dynamicImportSettled();

        expect(rendererSdk.captureException).not.toHaveBeenCalled();
    });
});
