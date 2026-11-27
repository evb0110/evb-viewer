import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {UPDATES_PLATFORM_FEATURE} from '@contracts/updatesPlatformFeature';

const mocks = vi.hoisted(() => ({
    exposeInMainWorld: vi.fn(),
    ipcRenderer: {
        emit: vi.fn(),
        invoke: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
        send: vi.fn(),
    },
    webUtils: {getPathForFile: vi.fn(() => '')},
    createElectronApi: vi.fn(() => ({})),
}));

vi.mock('electron', () => ({
    contextBridge: {exposeInMainWorld: mocks.exposeInMainWorld},
    ipcRenderer: mocks.ipcRenderer,
    webUtils: mocks.webUtils,
}));
vi.mock('@sentry/electron/preload', () => ({}));
vi.mock('@electron/preload/createElectronApi', () => ({createElectronApi: mocks.createElectronApi}));
vi.mock('@electron/preload/markPreloadInstalled', () => ({markPreloadInstalled: () => false}));
vi.mock('@electron/preload/installDebugLogListener', () => ({installDebugLogListener: vi.fn()}));
vi.mock('@electron/preload/preloadLog', () => ({
    createPreloadMainLogger: () => vi.fn(),
    exposeStartupTraceFlag: vi.fn(),
    tracePreload: vi.fn(),
}));
vi.mock('@electron/preload/installStartupOverlayLifecycle', () => ({installStartupOverlayLifecycle: vi.fn()}));

describe('preload __emitUpdateStatusForAutomation ingress validation', () => {
    const originalArgv = process.argv;

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        process.argv = [...originalArgv, '--evb-renderer-file-open-helper'];
    });

    afterEach(() => {
        process.argv = originalArgv;
    });

    async function loadAutomationEmitter() {
        await import('@electron/preload');
        const exposedCall = mocks.exposeInMainWorld.mock.calls.find(([name]) => name === '__emitUpdateStatusForAutomation');
        expect(exposedCall).toBeDefined();
        return exposedCall![1] as (status: unknown) => void;
    }

    it('forwards valid update status frames after decoding via decodeAppUpdateStatus', async () => {
        const emitUpdateStatus = await loadAutomationEmitter();
        const validStatus = {
            phase: 'available' as const,
            origin: 'manual' as const,
            version: '9.9.9',
            percent: null,
            message: null,
            requestedHere: true,
        };

        emitUpdateStatus({
            ...validStatus,
            unexpectedField: 'should-be-stripped',
        });

        expect(mocks.ipcRenderer.emit).toHaveBeenCalledExactlyOnceWith(UPDATES_PLATFORM_FEATURE.events.onStatus.channel, {}, validStatus);
    });

    it.each([
        null,
        'available',
        {
            phase: 'future-phase',
            origin: 'manual',
            version: null,
            percent: null,
            message: null,
        },
        {
            phase: 'downloading',
            origin: 'auto',
            version: '9.9.9',
            percent: 150,
            message: null,
        },
        {
            phase: 'error',
            origin: 'unknown-origin',
            version: null,
            percent: null,
            message: 'boom',
        },
        {
            phase: 'error',
            reason: 'invalid-reason',
            origin: 'manual',
            version: null,
            percent: null,
            message: 'boom',
        },
    ])('rejects malformed automation update status payload %j without emitting', async (malformed) => {
        const emitUpdateStatus = await loadAutomationEmitter();

        expect(() => emitUpdateStatus(malformed)).toThrow('Invalid automation update status payload');
        expect(mocks.ipcRenderer.emit).not.toHaveBeenCalled();
    });
});
