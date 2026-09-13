import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IDebugLogEntry} from '@contracts/electronApiCommon';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {requireDiagnosticEventId} from '@contracts/diagnostics/diagnosticEventId';
import {isRecord} from '@contracts/runtimeGuards';
import {
    requireEpochMs,
    requireIsoTimestamp,
} from '@contracts/timestamps';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

const mocks = vi.hoisted(() => ({
    reportRuntimeError: vi.fn(),
    onDebugLog: vi.fn(),
    capture: vi.fn(),
    captureForPresentation: vi.fn(),
    initializeRendererFailureReporter: vi.fn(),
    getValidatedElectronPlatformApi: vi.fn((): unknown => undefined),
    waitForPreferredDesktopPlatformBridge: vi.fn(async () => ({
        bridgeReady: false,
        shouldWait: false,
    })),
    isElectronUserAgent: vi.fn(() => true),
}));

const platformApi = createElectronPlatformApiFixture({diagnostics: {onDebugLog: mocks.onDebugLog}});
vi.mock('@app/utils/platform', () => ({
    getPlatformAPI: () => platformApi,
    isElectronUserAgent: mocks.isElectronUserAgent,
    waitForPreferredDesktopPlatformBridge: mocks.waitForPreferredDesktopPlatformBridge,
}));
vi.mock('@app/utils/electronPlatformBridge', () => ({getValidatedElectronPlatformApi: mocks.getValidatedElectronPlatformApi}));
vi.mock('@app/utils/failureReporter', () => ({initializeRendererFailureReporter: mocks.initializeRendererFailureReporter}));
vi.mock('@app/composables/useRuntimeErrorReports', () => ({useRuntimeErrorReports: () => ({reportRuntimeError: mocks.reportRuntimeError})}));
vi.mock('@app/utils/createPluginTranslate', () => ({createPluginTranslate: () => (key: string) => key}));
vi.mock('@i18n-core', () => ({
    DEFAULT_LOCALE: 'en',
    isLocaleMessageSource: () => false,
}));

const failure: FailureReceipt = {
    eventId: requireDiagnosticEventId('d'.repeat(32)),
    code: 'UNCLASSIFIED_RENDERER_ERROR',
    occurredAt: requireEpochMs(1_757_000_000_000),
    severity: 'error',
};

function isLegacyDebugLogEntry(value: unknown): value is IDebugLogEntry {
    return isRecord(value)
        && typeof value.source === 'string'
        && typeof value.message === 'string'
        && typeof value.timestamp === 'string'
        && (value.level === undefined || value.level === 'DEBUG' || value.level === 'INFO' || value.level === 'WARN' || value.level === 'ERROR');
}

function isDebugLogCallback(value: unknown): value is (entry: IDebugLogEntry) => void {
    return typeof value === 'function';
}

function requireDebugLogCallback(value: unknown) {
    if (!isDebugLogCallback(value)) {
        throw new TypeError('Expected the runtime error log subscription callback');
    }
    return value;
}

function installAutoImportStubs() {
    vi.stubGlobal('defineNuxtPlugin', (plugin: unknown) => plugin);
    vi.stubGlobal('useRuntimeErrorReports', () => ({reportRuntimeError: mocks.reportRuntimeError}));
    vi.stubGlobal('useCookie', () => ({value: 'en'}));
}

function createNuxtApp() {
    const hooks = new Map<string, () => void>();
    const originalUnmount = vi.fn();
    return {
        hooks,
        nuxtApp: {
            hook: vi.fn((name: string, callback: () => void) => {
                hooks.set(name, callback);
            }),
            vueApp: {unmount: originalUnmount},
        },
    };
}

async function flushPluginTasks() {
    await Promise.resolve();
    await Promise.resolve();
}

async function loadPlugin() {
    return (await import('@app/plugins/runtimeErrorLogStream.client')).default as (app: unknown) => void;
}

describe('runtime error log stream', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        installAutoImportStubs();
        vi.stubGlobal('window', new EventTarget());
        Object.defineProperty(window, 'location', {
            configurable: true,
            value: {pathname: '/electron'},
        });
        Object.defineProperty(window, 'electronAPI', {
            configurable: true,
            value: platformApi,
        });
        mocks.getValidatedElectronPlatformApi.mockReturnValue(platformApi);
        mocks.initializeRendererFailureReporter.mockReturnValue({
            capture: mocks.capture,
            captureForPresentation: mocks.captureForPresentation,
        });
        mocks.capture.mockReturnValue(failure);
        mocks.captureForPresentation.mockReturnValue({failure});
    });

    it('presents a main-owned failure receipt without recapturing it', async () => {
        const unsubscribe = vi.fn();
        mocks.onDebugLog.mockReturnValue(unsubscribe);
        const plugin = await loadPlugin();
        const harness = createNuxtApp();

        plugin(harness.nuxtApp);
        harness.hooks.get('app:mounted')?.();
        await flushPluginTasks();

        const callback = requireDebugLogCallback(mocks.onDebugLog.mock.calls[0]?.[0]);
        callback({
            source: 'main',
            message: '[ERROR] main failure',
            timestamp: requireIsoTimestamp('2026-09-03T00:00:00.000Z'),
            level: 'ERROR',
            failureRef: {
                eventId: requireDiagnosticEventId('a'.repeat(32)),
                code: 'UNCLASSIFIED_MAIN_ERROR',
                severity: 'fatal',
            },
        });

        expect(mocks.capture).not.toHaveBeenCalled();
        expect(mocks.reportRuntimeError).toHaveBeenCalledWith(expect.objectContaining({
            failure: {
                eventId: 'a'.repeat(32),
                code: 'UNCLASSIFIED_MAIN_ERROR',
                occurredAt: Date.parse('2026-09-03T00:00:00.000Z'),
                severity: 'fatal',
            },
            description: expect.stringContaining(`Error ID: ${'a'.repeat(32)}`),
        }));

        harness.nuxtApp.vueApp.unmount();
        expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it('owns a receipt-free main error projection with a bounded renderer code', async () => {
        mocks.onDebugLog.mockReturnValue(vi.fn());
        const plugin = await loadPlugin();
        const harness = createNuxtApp();

        plugin(harness.nuxtApp);
        harness.hooks.get('app:mounted')?.();
        await flushPluginTasks();

        const callback = requireDebugLogCallback(mocks.onDebugLog.mock.calls[0]?.[0]);
        const legacyEntry = {
            source: 'main',
            message: '[ERROR] legacy main failure',
            timestamp: requireIsoTimestamp('2026-09-03T00:00:00.000Z'),
            level: 'ERROR',
        };
        if (!isLegacyDebugLogEntry(legacyEntry)) {
            throw new TypeError('Invalid legacy debug log fixture');
        }
        callback(legacyEntry);

        expect(mocks.captureForPresentation).toHaveBeenCalledOnce();
        expect(mocks.captureForPresentation).toHaveBeenCalledWith({
            code: 'RENDERER_RUNTIME_ERROR_LOG_STREAM_FAILED',
            context: {phase: 'legacy-error-projection'},
            local: {
                source: 'runtime-error-log-stream',
                message: 'Main runtime error log entry has no failure receipt',
                data: {
                    source: 'main',
                    timestamp: '2026-09-03T00:00:00.000Z',
                    message: '[ERROR] legacy main failure',
                },
            },
        }, {localAlreadyRecorded: true});
        expect(mocks.reportRuntimeError).toHaveBeenCalledWith({
            failure,
            title: 'errors.runtime.streamError',
            description: '2026-09-03T00:00:00.000Z\n[ERROR] legacy main failure',
        });
    });

    it('owns one renderer occurrence for a bridge-init defect and keeps arbitrary error text out of capture input', async () => {
        mocks.onDebugLog.mockImplementation(() => {
            throw new Error('private bridge failure details');
        });
        const plugin = await loadPlugin();
        const harness = createNuxtApp();

        plugin(harness.nuxtApp);
        harness.hooks.get('app:mounted')?.();
        await flushPluginTasks();

        expect(mocks.initializeRendererFailureReporter).toHaveBeenCalledWith({host: 'electron'});
        expect(mocks.captureForPresentation).toHaveBeenCalledOnce();
        const [captureInput] = mocks.captureForPresentation.mock.calls[0] as [{
            code: string;
            context: unknown;
            local: {message: string};
        }];
        expect(captureInput.code).toBe('RENDERER_RUNTIME_ERROR_LOG_STREAM_FAILED');
        expect(captureInput.context).toEqual({phase: 'subscription-initialization'});
        expect(captureInput.local.message).toBe('Electron diagnostics log stream initialization failed');
        expect(JSON.stringify(captureInput)).not.toContain('private bridge failure details');
        expect(mocks.reportRuntimeError).toHaveBeenCalledWith({
            failure,
            title: 'errors.runtime.streamError',
        });
    });
});
