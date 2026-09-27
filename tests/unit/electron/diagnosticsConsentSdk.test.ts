import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
const sdk = vi.hoisted(() => ({
    captureException: vi.fn(),
    client: null as {getOptions: () => {enabled?: boolean}} | null,
    init: vi.fn(),
    options: null as null | {
        enabled?: boolean;
        transport?: (options: Record<string, unknown>) => {
            send: (envelope: unknown) => Promise<unknown>;
            flush: (timeout?: number) => Promise<boolean>;
        }
    },
    send: vi.fn(),
}));

vi.mock('electron', () => ({app: {
    getPath: () => '/tmp/evb-diagnostics-consent-test',
    getVersion: () => '0.0.0',
    isPackaged: true,
}}));
vi.mock('@sentry/core', () => ({
    captureException: sdk.captureException,
    getClient: () => sdk.client,
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
        sdk.init.mockClear();
        sdk.captureException.mockClear();
        sdk.options = null;
        sdk.send.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it.each([
        'unknown',
        'denied',
    ] as const)('never loads the SDK while consent is %s', async (preference) => {
        const diagnostics = await importWithDsn();

        diagnostics.setMainDiagnosticsPreference(preference);
        await vi.dynamicImportSettled();

        expect(sdk.init).not.toHaveBeenCalled();
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
        const {
            captureMainFailure, setMainFailureCaptureState,
        } = await import('@electron/utils/captureMainFailure');
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
        await Promise.resolve();

        expect(sdk.captureException).toHaveBeenCalledOnce();
        expect(sdk.captureException.mock.calls[0]?.[1]).toMatchObject({event_id: receipt.eventId});
    });

    it('discards main-process failures queued during SDK loading when consent is withdrawn', async () => {
        const {
            captureMainFailure, setMainFailureCaptureState,
        } = await import('@electron/utils/captureMainFailure');
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
