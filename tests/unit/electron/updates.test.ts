// @vitest-environment happy-dom
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
import {
    ref, computed, watch, onScopeDispose, effectScope, nextTick,
} from 'vue';
import type * as UpdatesOwner from '@electron/updates';
import type {useAppUpdates} from '@app/composables/useAppUpdates';
import type { IAppUpdateStatus } from '@contracts/updatesPlatformFeature';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import type { IPlatformApi } from '@contracts/platformApi';
import { createShutdownCoordinator } from '@electron/bootstrap/shutdown';

type TMockSettings = Record<string, unknown>;
type TMockSettingsUpdater = (
    settings: TMockSettings,
) => Partial<TMockSettings> | undefined | Promise<Partial<TMockSettings> | undefined>;
interface IMockPendingUpdateStartup {
    installationApplied: boolean;
    installRequestedAt: number;
    pendingVersion: string;
    startupAttempts: number;
    version: 1;
}

// The window that asks for manual checks; the tests read the status pushed to it.
const requester = {senderId: 1};

const mocks = vi.hoisted(() => {
    class TestCancellationToken {
        cancelled = false;

        cancel() {
            this.cancelled = true;
        }

        dispose() {}
    }

    class TestEmitter {
        private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

        on(event: string, handler: (...args: unknown[]) => void) {
            const handlers = this.listeners.get(event) ?? new Set<(...args: unknown[]) => void>();
            handlers.add(handler);
            this.listeners.set(event, handlers);
            return this;
        }

        emit(event: string, ...args: unknown[]) {
            for (const handler of this.listeners.get(event) ?? []) {
                handler(...args);
            }
            return this;
        }

        removeListener(event: string, handler: (...args: unknown[]) => void) {
            this.listeners.get(event)?.delete(handler);
            return this;
        }

        removeAllListeners() {
            this.listeners.clear();
            return this;
        }
    }

    const autoUpdater = new TestEmitter() as TestEmitter & {
        autoDownload: boolean;
        autoInstallOnAppQuit: boolean;
        checkForUpdates: ReturnType<typeof vi.fn>;
        downloadUpdate: ReturnType<typeof vi.fn>;
        quitAndInstall: ReturnType<typeof vi.fn>;
        setFeedURL: ReturnType<typeof vi.fn>;
    };

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.checkForUpdates = vi.fn();
    autoUpdater.downloadUpdate = vi.fn();
    autoUpdater.quitAndInstall = vi.fn();
    autoUpdater.setFeedURL = vi.fn();
    const checkMacCodeSignature = vi.fn(async () => true as boolean | null);
    const sessionCookies = {
        get: vi.fn(async (): Promise<Array<{value: string}>> => []),
        set: vi.fn(async () => undefined),
    };

    return {
        app: {
            getVersion: vi.fn(() => '1.0.0'),
            isPackaged: true,
        },
        CancellationToken: TestCancellationToken,
        autoUpdater,
        checkMacCodeSignature,
        fetch: vi.fn(),
        session: {defaultSession: {cookies: sessionCookies}},
        loadSettings: vi.fn(async () => ({})),
        markUpdateInstallPending: vi.fn(async () => {}),
        recordPendingUpdateStartup: vi.fn<() => Promise<IMockPendingUpdateStartup | null>>(async () => null),
        logger: {
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
        },
        updateSettings: vi.fn(async (updater: TMockSettingsUpdater) => {
            const settings: TMockSettings = {};
            const patch = await updater(settings);
            return patch && typeof patch === 'object'
                ? {
                    ...settings,
                    ...patch,
                }
                : settings;
        }),
    };
});

vi.mock('electron', () => ({
    app: mocks.app,
    session: mocks.session,
}));

vi.mock('electron-updater', () => ({
    CancellationToken: mocks.CancellationToken,
    default: {autoUpdater: mocks.autoUpdater},
}));

vi.mock('@electron/config', () => ({config: {updates: {
    initialDelayMs: 1_000,
    metadataUrl: 'https://updates.example.test/latest',
    mirrorMetadataUrl: 'https://mirror.example.test/channels/stable.json',
    mirrorReleaseBaseUrl: 'https://mirror.example.test/releases',
    pollIntervalMs: 60_000,
}}}));

vi.mock('@electron/settings', () => ({
    loadSettings: mocks.loadSettings,
    updateSettings: mocks.updateSettings,
}));
vi.mock('@electron/updateHealthMarker', () => ({
    getSuppressedUpdateVersion: vi.fn().mockResolvedValue(null),
    markUpdateInstallPending: mocks.markUpdateInstallPending,
    recordPendingUpdateStartup: mocks.recordPendingUpdateStartup,
    UPDATE_STARTUP_FAILURE_THRESHOLD: 3,
}));
vi.mock('@electron/updates/checkMacCodeSignature', () => ({checkMacCodeSignature: mocks.checkMacCodeSignature}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));

let rendererPlatform: IPlatformApi = createElectronPlatformApiFixture();
vi.mock('@app/utils/platform', () => ({getPlatformAPI: () => rendererPlatform}));
vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    error: vi.fn(),
    diagnostic: vi.fn(),
}}));
vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));

const originalPlatform = process.platform;
const originalArch = process.arch;
const originalWindowsStore = process.windowsStore;

function createMetadataResponse(version: string, setCookie?: string) {
    const headers = new Headers();
    if (setCookie) {
        headers.set('set-cookie', setCookie);
    }
    const body = JSON.stringify({release: {tag: version}});
    return {
        headers,
        ok: true,
        status: 200,
        body: {getReader: () => new Response(body).body!.getReader()},
        json: async () => ({release: {tag: version}}),
    };
}

function createEmptyResponse(status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => ({}),
    };
}

async function flushPromises() {
    await Promise.resolve();
    await Promise.resolve();
}

let testedOwner: typeof UpdatesOwner | undefined;
async function loadUpdatesModule() {
    vi.resetModules();
    testedOwner = await import('@electron/updates');
    return testedOwner;
}

beforeAll(() => {
    Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'darwin',
    });
    Object.defineProperty(process, 'arch', {
        configurable: true,
        value: 'arm64',
    });
    Object.defineProperty(process, 'windowsStore', {
        configurable: true,
        value: false,
    });
});

describe('updates robustness', () => {
    beforeEach(() => {
        Object.defineProperty(process, 'platform', {
            configurable: true,
            value: 'darwin',
        });
        Object.defineProperty(process, 'arch', {
            configurable: true,
            value: 'arm64',
        });
        Object.defineProperty(process, 'windowsStore', {
            configurable: true,
            value: false,
        });
        vi.useFakeTimers();
        vi.clearAllMocks();
        mocks.autoUpdater.removeAllListeners();
        mocks.autoUpdater.checkForUpdates.mockReset();
        mocks.autoUpdater.downloadUpdate.mockReset();
        mocks.autoUpdater.downloadUpdate.mockResolvedValue([]);
        mocks.autoUpdater.quitAndInstall.mockReset();
        mocks.autoUpdater.setFeedURL.mockReset();
        mocks.checkMacCodeSignature.mockReset();
        mocks.checkMacCodeSignature.mockResolvedValue(true);
        mocks.fetch.mockReset();
        mocks.session.defaultSession.cookies.get.mockReset();
        mocks.session.defaultSession.cookies.set.mockReset();
        mocks.session.defaultSession.cookies.get.mockResolvedValue([]);
        mocks.session.defaultSession.cookies.set.mockResolvedValue(undefined);
        mocks.loadSettings.mockReset();
        mocks.markUpdateInstallPending.mockClear();
        mocks.recordPendingUpdateStartup.mockReset();
        mocks.recordPendingUpdateStartup.mockResolvedValue(null);
        mocks.updateSettings.mockReset();
        mocks.app.getVersion.mockReturnValue('1.0.0');
        mocks.loadSettings.mockResolvedValue({});
        mocks.updateSettings.mockImplementation(async (updater: TMockSettingsUpdater) => {
            const settings: TMockSettings = {};
            const patch = await updater(settings);
            return patch && typeof patch === 'object'
                ? {
                    ...settings,
                    ...patch,
                }
                : settings;
        });
        vi.stubGlobal('fetch', mocks.fetch);
    });

    afterEach(async () => {
        try {
            await testedOwner?.shutdownUpdates();
        } catch {
            // Ignore reset/import failures during teardown.
        }
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('reports the canonical runtime version before updater initialization completes', async () => {
        const updates = await loadUpdatesModule();

        expect(updates.getUpdateStatus()).toMatchObject({
            phase: 'idle',
            version: '1.0.0',
        });
    });

    it('retries updater support after a transient macOS signature-check result', async () => {
        mocks.checkMacCodeSignature
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(true);
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.0.0'));

        const updates = await loadUpdatesModule();

        updates.initializeUpdates(() => {});
        await flushPromises();
        expect(mocks.checkMacCodeSignature).toHaveBeenCalledOnce();
        expect(mocks.fetch).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1_000);
        await flushPromises();
        expect(mocks.checkMacCodeSignature).toHaveBeenCalledTimes(2);
        expect(mocks.fetch).toHaveBeenCalledOnce();
    });

    it('redacts endpoint credentials and URL values from updater status messages', async () => {
        const endpointError = new Error(
            'GET https://user:pass@updates.example.test:8443/latest?channel=stable&token=secret#private failed',
        );
        mocks.fetch.mockRejectedValue(endpointError);
        mocks.autoUpdater.checkForUpdates.mockRejectedValue(endpointError);

        const updates = await loadUpdatesModule();
        const statuses: Array<Record<string, unknown>> = [];
        updates.initializeUpdates(statusFor => statuses.push({...updates.projectUpdateStatusForWindow(statusFor, requester.senderId)}));

        await updates.triggerManualUpdateCheck(requester);

        expect(statuses.at(-1)).toMatchObject({
            phase: 'error',
            message: 'Update check failed: Release rollout metadata failed (https://updates.example.test/latest: GET https://[redacted]@updates.example.test:8443/latest?channel=[redacted]&token=[redacted]#[redacted] failed)',
        });
    });

    it('classifies a manual updater failure with its bounded check context', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockRejectedValue(new Error('updater rejected the feed'));

        const updates = await loadUpdatesModule();
        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        expect(mocks.logger.error).toHaveBeenCalledWith(
            'Update check failed: updater rejected the feed',
            {
                code: 'MAIN_UPDATE_CHECK_FAILED',
                cause: expect.any(Error),
            },
        );
    });

    it.each([
        {
            error: Object.assign(new Error('network is offline'), {code: 'ENETUNREACH'}),
            reason: 'network-unavailable',
        },
        {
            error: Object.assign(new Error('DNS unavailable'), {code: 'ENOTFOUND'}),
            reason: 'network-unavailable',
        },
        {
            error: new DOMException('Metadata deadline elapsed', 'TimeoutError'),
            reason: 'check-timed-out',
        },
    ])('keeps metadata $reason localized and at warning level without an occurrence', async ({
        error, reason,
    }) => {
        mocks.fetch.mockRejectedValue(error);

        const updates = await loadUpdatesModule();
        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        expect(updates.getUpdateStatus()).toMatchObject({
            phase: 'error',
            reason,
        });
        expect(mocks.logger.error).not.toHaveBeenCalled();
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining(error.message),
        );
    });

    it('surfaces a failed install when the old application version is relaunched', async () => {
        mocks.recordPendingUpdateStartup.mockResolvedValue({
            installationApplied: false,
            installRequestedAt: Date.now(),
            pendingVersion: '1.1.0',
            startupAttempts: 1,
            version: 1,
        });

        const updates = await loadUpdatesModule();
        const statuses: Array<Record<string, unknown>> = [];
        updates.initializeUpdates(statusFor => statuses.push({ ...updates.projectUpdateStatusForWindow(statusFor, requester.senderId) }));
        await flushPromises();

        expect(statuses.at(-1)).toMatchObject({
            message: 'Update installation failed: 1.1.0 could not be installed; version 1.0.0 was relaunched',
            origin: 'manual',
            phase: 'error',
            version: '1.1.0',
        });
        expect(mocks.logger.error).toHaveBeenCalledWith(
            expect.stringContaining('Update installation failed: 1.1.0 could not be installed'),
            {
                code: 'MAIN_UPDATE_STARTUP_FAILED',
                cause: expect.objectContaining({pendingVersion: '1.1.0'}),
            },
        );
    });

    it('returns automatic no-update checks to idle state', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-not-available', { version: '1.0.0' });
        });

        const updates = await loadUpdatesModule();
        const statuses: Array<Record<string, unknown>> = [];

        updates.initializeUpdates((statusFor) => {
            statuses.push({ ...updates.projectUpdateStatusForWindow(statusFor, requester.senderId) });
        });

        await vi.advanceTimersByTimeAsync(1_000);
        await flushPromises();

        expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
        expect(statuses.at(-1)).toMatchObject({
            origin: 'auto',
            phase: 'idle',
            version: '1.0.0',
        });
    });

    it('retries a transient release cohort cookie read after its backoff expires', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.0.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-not-available', {version: '1.0.0'});
        });
        mocks.session.defaultSession.cookies.get
            .mockRejectedValueOnce(new Error('session is not ready'))
            .mockResolvedValueOnce([{value: 'cohort-b'}]);

        const updates = await loadUpdatesModule();
        updates.initializeUpdates(() => undefined);

        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();
        expect(mocks.session.defaultSession.cookies.get).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(29_999);
        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();
        expect(mocks.session.defaultSession.cookies.get).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(1);
        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        expect(mocks.session.defaultSession.cookies.get).toHaveBeenCalledTimes(2);
        const recoveredRequestInit = mocks.fetch.mock.calls.at(-1)?.[1] as RequestInit | undefined;
        expect(recoveredRequestInit?.headers).toBeInstanceOf(Headers);
        expect((recoveredRequestInit?.headers as Headers).get('cookie')).toBe('evb_release_cohort=cohort-b');
    });

    it('waits for explicit approval before downloading an available update', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-available', { version: '1.1.0' });
        });

        const updates = await loadUpdatesModule();
        const statuses: Array<Record<string, unknown>> = [];
        updates.initializeUpdates(statusFor => statuses.push({ ...updates.projectUpdateStatusForWindow(statusFor, requester.senderId) }));

        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        expect(mocks.autoUpdater.autoDownload).toBe(false);
        expect(mocks.autoUpdater.downloadUpdate).not.toHaveBeenCalled();
        expect(statuses.at(-1)).toMatchObject({
            origin: 'manual',
            phase: 'available',
            version: '1.1.0',
        });

        expect(updates.downloadAvailableUpdate(requester)).toEqual({started: true});
        await flushPromises();
        expect(mocks.autoUpdater.downloadUpdate).toHaveBeenCalledOnce();
        expect(statuses.at(-1)).toMatchObject({
            origin: 'manual',
            phase: 'downloading',
            percent: 0,
            version: '1.1.0',
        });
    });

    it('defers update handling to Microsoft Store in an AppX runtime', async () => {
        Object.defineProperty(process, 'windowsStore', {
            configurable: true,
            value: true,
        });
        const updates = await loadUpdatesModule();
        const statuses: Array<Record<string, unknown>> = [];
        updates.initializeUpdates(statusFor => statuses.push({...updates.projectUpdateStatusForWindow(statusFor, requester.senderId)}));

        await updates.triggerManualUpdateCheck(requester);

        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
        expect(statuses.at(-1)).toMatchObject({
            phase: 'unsupported',
            message: null,
            reason: 'store-updates',
        });
    });

    it.each([
        'x64',
        'arm64',
    ])('checks the matching Windows %s feed', async (arch) => {
        Object.defineProperty(process, 'platform', {
            configurable: true,
            value: 'win32',
        });
        Object.defineProperty(process, 'arch', {
            configurable: true,
            value: arch,
        });
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('update-available', {version: '1.1.0'});
        });
        const updates = await loadUpdatesModule();
        const statuses: Array<Record<string, unknown>> = [];
        updates.initializeUpdates(statusFor => statuses.push({...updates.projectUpdateStatusForWindow(statusFor, requester.senderId)}));
        await updates.triggerManualUpdateCheck(requester);
        expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
        expect(mocks.checkMacCodeSignature).not.toHaveBeenCalled();
        expect(mocks.fetch).toHaveBeenCalledWith(
            expect.stringContaining(`/latest-win-${arch}.yml`), expect.anything(),
        );
        expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledWith({
            provider: 'generic',
            url: 'https://github.com/evb0110/evb-viewer/releases/download/v1.1.0',
            channel: `latest-win-${arch}`,
            useMultipleRangeRequest: false,
        });
        expect(statuses.at(-1)).toMatchObject({
            phase: 'available',
            version: '1.1.0',
        });
        expect(updates.downloadAvailableUpdate(requester)).toEqual({started: true});
        await flushPromises();
        expect(mocks.autoUpdater.downloadUpdate).toHaveBeenCalledOnce();
    });

    it('cancels and drains an active updater download during shutdown', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        let finishDownload: (() => void) | null = null;
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('update-available', {version: '1.1.0'});
        });
        mocks.autoUpdater.downloadUpdate.mockImplementation(() => new Promise<void>((resolve) => {
            finishDownload = resolve;
        }));
        const updates = await loadUpdatesModule();
        updates.initializeUpdates(() => undefined);
        await updates.triggerManualUpdateCheck(requester);
        expect(updates.downloadAvailableUpdate(requester)).toEqual({started: true});
        await flushPromises();
        const cancellationToken = mocks.autoUpdater.downloadUpdate.mock.calls[0]?.[0] as {cancelled: boolean};

        const shutdownPromise = updates.shutdownUpdates();

        expect(cancellationToken.cancelled).toBe(true);
        const resolveDownload = finishDownload as (() => void) | null;
        resolveDownload?.();
        await expect(shutdownPromise).resolves.toBeUndefined();
    });

    it('does not start a queued updater download after shutdown begins', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('update-available', {version: '1.1.0'});
        });
        const updates = await loadUpdatesModule();
        updates.initializeUpdates(() => undefined);
        await updates.triggerManualUpdateCheck(requester);

        expect(updates.downloadAvailableUpdate(requester)).toEqual({started: true});
        await expect(updates.shutdownUpdates()).resolves.toBeUndefined();

        expect(mocks.autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    });

    it('lets a manual check complete after waiting for an automatic check already in flight', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));

        let resolveAutoCheck: (() => void) | null = null;
        mocks.autoUpdater.checkForUpdates.mockImplementation(() => {
            const callNumber = mocks.autoUpdater.checkForUpdates.mock.calls.length;
            mocks.autoUpdater.emit('checking-for-update');

            if (callNumber === 1) {
                return new Promise<void>((resolve) => {
                    resolveAutoCheck = () => {
                        mocks.autoUpdater.emit('update-not-available', { version: '1.0.0' });
                        resolve();
                    };
                });
            }

            mocks.autoUpdater.emit('update-not-available', { version: '1.0.0' });
            return Promise.resolve();
        });

        const updates = await loadUpdatesModule();
        const statuses: Array<Record<string, unknown>> = [];

        updates.initializeUpdates((statusFor) => {
            statuses.push({ ...updates.projectUpdateStatusForWindow(statusFor, requester.senderId) });
        });

        await vi.advanceTimersByTimeAsync(1_000);
        await flushPromises();

        const manualCheckPromise = updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        expect(statuses.at(-1)).toMatchObject({
            origin: 'manual',
            phase: 'checking',
        });

        const completeAutoCheck = resolveAutoCheck as (() => void) | null;
        if (completeAutoCheck) {
            completeAutoCheck();
        }
        await manualCheckPromise;
        await flushPromises();

        expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
        expect(statuses.at(-1)).toMatchObject({
            origin: 'manual',
            phase: 'no-update',
            version: '1.0.0',
        });
    });

    it('marks a manual result for the window that asked and for no other window', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.0.0'));

        const updates = await loadUpdatesModule();
        const pushedTo = new Map<number, Array<Record<string, unknown>>>();
        updates.initializeUpdates((statusFor) => {
            for (const senderId of [
                requester.senderId,
                2,
            ]) {
                pushedTo.set(senderId, [
                    ...(pushedTo.get(senderId) ?? []),
                    {...updates.projectUpdateStatusForWindow(statusFor, senderId)},
                ]);
            }
        });

        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        expect(pushedTo.get(requester.senderId)?.at(-1)).toMatchObject({
            origin: 'manual',
            phase: 'no-update',
            requestedHere: true,
        });
        expect(pushedTo.get(2)?.at(-1)).toMatchObject({
            origin: 'manual',
            phase: 'no-update',
            requestedHere: false,
        });
    });

    it('marks a result for every window that asked while its check was in flight', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        let resolveCheck: (() => void) | null = null;
        mocks.autoUpdater.checkForUpdates.mockImplementation(() => {
            mocks.autoUpdater.emit('checking-for-update');
            return new Promise<void>((resolve) => {
                resolveCheck = () => {
                    mocks.autoUpdater.emit('update-not-available', { version: '1.0.0' });
                    resolve();
                };
            });
        });

        const updates = await loadUpdatesModule();
        const pushedTo = new Map<number, Array<Record<string, unknown>>>();
        updates.initializeUpdates((statusFor) => {
            for (const senderId of [
                requester.senderId,
                2,
                3,
            ]) {
                pushedTo.set(senderId, [
                    ...(pushedTo.get(senderId) ?? []),
                    {...updates.projectUpdateStatusForWindow(statusFor, senderId)},
                ]);
            }
        });

        // The first request must reach the updater before the second one joins it.
        const firstRequest = updates.triggerManualUpdateCheck(requester);
        await vi.advanceTimersByTimeAsync(0);
        const secondRequest = updates.triggerManualUpdateCheck({senderId: 2});
        await vi.advanceTimersByTimeAsync(0);
        expect(pushedTo.get(2)?.at(-1)).toMatchObject({
            phase: 'checking',
            requestedHere: true,
        });
        expect(pushedTo.get(3)?.at(-1)).toMatchObject({
            phase: 'checking',
            requestedHere: false,
        });

        const completeCheck = resolveCheck as (() => void) | null;
        completeCheck?.();
        await Promise.all([
            firstRequest,
            secondRequest,
        ]);
        await vi.advanceTimersByTimeAsync(0);

        expect(pushedTo.get(requester.senderId)?.at(-1)).toMatchObject({
            phase: 'no-update',
            requestedHere: true,
        });
        expect(pushedTo.get(2)?.at(-1)).toMatchObject({
            phase: 'no-update',
            requestedHere: true,
        });
        expect(pushedTo.get(3)?.at(-1)).toMatchObject({
            phase: 'no-update',
            requestedHere: false,
        });
    });

    it('does not block shutdown indefinitely on an in-flight updater check', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        let resolveCheck: (() => void) | null = null;
        mocks.autoUpdater.checkForUpdates.mockImplementation(() => {
            mocks.autoUpdater.emit('checking-for-update');
            return new Promise<void>((resolve) => {
                resolveCheck = resolve;
            });
        });

        const updates = await loadUpdatesModule();
        updates.initializeUpdates(() => undefined);

        await vi.advanceTimersByTimeAsync(1_000);
        await flushPromises();
        expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

        const shutdownPromise = updates.shutdownUpdates();
        let settled = false;
        void shutdownPromise.then(() => {
            settled = true;
        });

        await vi.advanceTimersByTimeAsync(2_999);
        await flushPromises();
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await expect(shutdownPromise).resolves.toBeUndefined();

        const completeCheck = resolveCheck as (() => void) | null;
        if (completeCheck) {
            completeCheck();
        }
        await flushPromises();
    });

    it('downloads the rollout release directly instead of an older GitHub latest release', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.2.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-available', { version: '1.2.0' });
            mocks.autoUpdater.emit('update-downloaded', { version: '1.2.0' });
        });

        const updates = await loadUpdatesModule();
        const statuses: Array<Record<string, unknown>> = [];

        updates.initializeUpdates((statusFor) => {
            statuses.push({ ...updates.projectUpdateStatusForWindow(statusFor, requester.senderId) });
        });

        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledWith({
            provider: 'generic',
            url: 'https://github.com/evb0110/evb-viewer/releases/download/v1.2.0',
            useMultipleRangeRequest: false,
        });
        expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
        expect(statuses.at(-1)).toMatchObject({
            origin: 'manual',
            phase: 'downloaded',
            version: '1.2.0',
        });
    });

    it('fails closed when the rollout endpoint becomes unavailable', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-not-available', { version: '1.0.0' });
        });

        const updates = await loadUpdatesModule();
        updates.initializeUpdates(() => undefined);

        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        mocks.fetch.mockRejectedValue(new Error('rollout endpoint unavailable'));
        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        expect(mocks.autoUpdater.setFeedURL).toHaveBeenNthCalledWith(1, {
            provider: 'generic',
            url: 'https://github.com/evb0110/evb-viewer/releases/download/v1.1.0',
            useMultipleRangeRequest: false,
        });
        expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledTimes(1);
        expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it('does not use the mirror as an alternate release authority', async () => {
        mocks.fetch.mockImplementation(async (url: string, init?: { method?: string }) => {
            if (url === 'https://updates.example.test/latest') {
                throw new Error('landing blocked');
            }
            if (url === 'https://mirror.example.test/channels/stable.json') {
                return createMetadataResponse('1.1.0');
            }
            if (init?.method === 'HEAD' && url.startsWith('https://github.com/')) {
                throw new Error('github blocked');
            }
            if (init?.method === 'HEAD' && url === 'https://mirror.example.test/releases/v1.1.0/latest-mac.yml') {
                return createEmptyResponse(200);
            }
            throw new Error(`Unexpected request: ${url}`);
        });
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-available', { version: '1.1.0' });
        });

        const updates = await loadUpdatesModule();
        updates.initializeUpdates(() => undefined);
        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        expect(mocks.autoUpdater.setFeedURL).not.toHaveBeenCalled();
        expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    });

    it('keeps a cached downloaded update when a newer release has no updater metadata', async () => {
        mocks.fetch.mockImplementation(async (_url: string, init?: { method?: string }) => {
            if (init?.method === 'HEAD') {
                return createEmptyResponse(200);
            }
            return createMetadataResponse('1.1.0');
        });
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-available', { version: '1.1.0' });
            mocks.autoUpdater.emit('update-downloaded', { version: '1.1.0' });
        });

        const updates = await loadUpdatesModule();
        const statuses: Array<Record<string, unknown>> = [];

        updates.initializeUpdates((statusFor) => {
            statuses.push({ ...updates.projectUpdateStatusForWindow(statusFor, requester.senderId) });
        });

        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        expect(statuses.at(-1)).toMatchObject({
            phase: 'downloaded',
            version: '1.1.0',
        });

        mocks.fetch.mockImplementation(async (_url: string, init?: { method?: string }) => {
            if (init?.method === 'HEAD') {
                return createEmptyResponse(404);
            }
            return createMetadataResponse('1.2.0');
        });

        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
        expect(mocks.logger.info).toHaveBeenCalledWith(
            'Keeping cached downloaded update 1.1.0; newer release 1.2.0 has no latest-mac.yml updater feed',
        );
        expect(statuses.at(-1)).toMatchObject({
            origin: 'manual',
            phase: 'downloaded',
            version: '1.1.0',
        });
    });

    it('skips the updater feed when the latest macOS release has no latest-mac.yml', async () => {
        mocks.app.getVersion.mockReturnValue('1.0.0');
        mocks.fetch.mockImplementation(async (_url: string, init?: { method?: string }) => {
            if (init?.method === 'HEAD') {
                return createEmptyResponse(404);
            }
            return createMetadataResponse('1.1.0');
        });

        const updates = await loadUpdatesModule();
        const statuses: Array<Record<string, unknown>> = [];

        updates.initializeUpdates((statusFor) => {
            statuses.push({ ...updates.projectUpdateStatusForWindow(statusFor, requester.senderId) });
        });

        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
        expect(mocks.logger.info).toHaveBeenCalledWith(
            'Release 1.1.0 has no latest-mac.yml updater feed; skipping in-app updater check',
        );
        expect(statuses.at(-1)).toMatchObject({
            origin: 'manual',
            phase: 'error',
            version: '1.1.0',
            message: 'Update 1.1.0 is available, but its latest-mac.yml feed is not published. Download the release manually.',
            reason: 'feed-unavailable',
        });
    });

    it.each([
        {
            name: 'GitHub 404 followed by mirror rejection',
            github: 404,
            mirror: 'rejected',
        },
        {
            name: 'GitHub rejection followed by mirror 404',
            github: 'rejected',
            mirror: 404,
        },
    ])('keeps one feed error inconclusive when the other feed is $name', async ({
        github,
        mirror,
    }) => {
        mocks.fetch.mockImplementation(async (url: string, init?: {method?: string}) => {
            if (url === 'https://updates.example.test/latest') {
                return createMetadataResponse('1.1.0');
            }
            if (init?.method !== 'HEAD') {
                throw new Error(`Unexpected request: ${url}`);
            }
            const isGithub = url.startsWith('https://github.com/');
            const outcome = isGithub ? github : mirror;
            if (outcome === 404) {
                return createEmptyResponse(404);
            }
            throw new Error(`${isGithub ? 'github' : 'mirror'} unavailable`);
        });

        const updates = await loadUpdatesModule();
        const statuses: Array<Record<string, unknown>> = [];
        updates.initializeUpdates(statusFor => statuses.push({...updates.projectUpdateStatusForWindow(statusFor, requester.senderId)}));

        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
        expect(statuses.at(-1)).toMatchObject({
            origin: 'manual',
            phase: 'error',
            message: expect.stringContaining('Update feed verification failed:'),
        });
    });

    it('does not let a timed-out feed probe or its late response replace a later check result', async () => {
        const lateProbe = Promise.withResolvers<ReturnType<typeof createEmptyResponse>>();
        let feedProbeCalls = 0;
        let firstFeedSignal = null as AbortSignal | null;
        let firstFeedAborted = false;
        const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((delayMs: number) => {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), delayMs);
            return controller.signal;
        });
        mocks.fetch.mockImplementation((url: string, init?: {
            method?: string;
            signal?: AbortSignal;
        }) => {
            if (url === 'https://updates.example.test/latest') {
                return Promise.resolve(createMetadataResponse('1.1.0'));
            }
            if (init?.method !== 'HEAD') {
                return Promise.reject(new Error(`Unexpected request: ${url}`));
            }
            feedProbeCalls += 1;
            if (feedProbeCalls === 1) {
                return new Promise((resolve, reject) => {
                    const signal = init.signal;
                    firstFeedSignal = signal ?? null;
                    const abort = () => {
                        firstFeedAborted = true;
                        reject(new DOMException('The operation was aborted.', 'AbortError'));
                    };
                    if (signal?.aborted) {
                        abort();
                    } else {
                        signal?.addEventListener('abort', abort, {once: true});
                    }
                    lateProbe.promise.then(resolve);
                });
            }
            return Promise.resolve(createEmptyResponse(404));
        });

        const updates = await loadUpdatesModule();
        const statuses: Array<Record<string, unknown>> = [];
        updates.initializeUpdates(statusFor => statuses.push({...updates.projectUpdateStatusForWindow(statusFor, requester.senderId)}));

        const firstCheck = updates.triggerManualUpdateCheck(requester);
        await flushPromises();
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(firstCheck).resolves.toMatchObject({started: true});
        expect(timeoutSpy).toHaveBeenCalledWith(10_000);
        expect(firstFeedSignal).not.toBeNull();
        expect(firstFeedAborted).toBe(true);
        expect(updates.getUpdateStatus().reason).toBe('check-timed-out');
        expect(firstFeedSignal?.aborted).toBe(true);
        expect(statuses.at(-1)).toMatchObject({
            origin: 'manual',
            phase: 'error',
        });

        mocks.fetch.mockImplementation(async (url: string, init?: {method?: string}) => {
            if (url === 'https://updates.example.test/latest') {
                return createMetadataResponse('1.1.0');
            }
            if (init?.method === 'HEAD') {
                return createEmptyResponse(200);
            }
            throw new Error(`Unexpected request: ${url}`);
        });
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-not-available', {version: '1.0.0'});
        });

        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();
        lateProbe.resolve(createEmptyResponse(200));
        await flushPromises();

        expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
        expect(statuses.at(-1)).toMatchObject({
            origin: 'manual',
            phase: 'no-update',
            version: '1.0.0',
        });
    });

    it.each([
        '1.0.0',
        '0.9.9',
    ])('discards a stale downloaded %s event and performs the next check normally', async (staleVersion) => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-available', { version: '1.1.0' });
            mocks.autoUpdater.emit('update-downloaded', { version: staleVersion });
        });

        const updates = await loadUpdatesModule();
        const statuses: Array<Record<string, unknown>> = [];
        updates.initializeUpdates(statusFor => statuses.push({ ...updates.projectUpdateStatusForWindow(statusFor, requester.senderId) }));

        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        expect(statuses.at(-1)).toMatchObject({
            origin: 'manual',
            phase: 'no-update',
            version: '1.0.0',
        });
        await expect(updates.installDownloadedUpdate(requester)).resolves.toEqual({started: false});
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            `Discarding downloaded update ${staleVersion} during download event; running version is 1.0.0`,
        );

        mocks.autoUpdater.checkForUpdates.mockImplementationOnce(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-not-available', { version: '1.0.0' });
        });
        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    });

    it('clears a downloaded candidate that became current before the next check', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementationOnce(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-available', { version: '1.1.0' });
            mocks.autoUpdater.emit('update-downloaded', { version: '1.1.0' });
        });

        const updates = await loadUpdatesModule();
        updates.initializeUpdates(() => undefined);
        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        mocks.app.getVersion.mockReturnValue('1.1.0');
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.2.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementationOnce(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-not-available', { version: '1.1.0' });
        });
        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            'Discarding downloaded update 1.1.0 during update check; running version is 1.1.0',
        );
    });

    it('clears a downloaded candidate that became current before installation', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementationOnce(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-available', { version: '1.1.0' });
            mocks.autoUpdater.emit('update-downloaded', { version: '1.1.0' });
        });

        const updates = await loadUpdatesModule();
        updates.initializeUpdates(() => undefined);
        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        mocks.app.getVersion.mockReturnValue('1.1.0');
        await expect(updates.installDownloadedUpdate(requester)).resolves.toEqual({started: false});
        await expect(updates.installDownloadedUpdate(requester)).resolves.toEqual({started: false});
        expect(mocks.markUpdateInstallPending).not.toHaveBeenCalled();
        expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            'Update installation failed: Downloaded update 1.1.0 is not newer than the running version 1.1.0',
        );
    });

    it('reports a download reason and clears it on the next completed check', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('update-available', {version: '1.1.0'});
        });
        mocks.autoUpdater.downloadUpdate.mockRejectedValueOnce(new Error('damaged download'));
        const updates = await loadUpdatesModule();
        const terminal = Promise.withResolvers<undefined>();
        updates.initializeUpdates(statusFor => {
            if (updates.projectUpdateStatusForWindow(statusFor, requester.senderId).phase === 'error') {
                terminal.resolve(undefined);
            }
        });
        await updates.triggerManualUpdateCheck(requester);
        updates.downloadAvailableUpdate(requester);
        await terminal.promise;
        expect(updates.getUpdateStatus()).toMatchObject({
            phase: 'error',
            reason: 'download-failed',
            message: 'Update download failed: damaged download',
            version: '1.1.0',
        });
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.0.0'));
        await updates.triggerManualUpdateCheck(requester);
        expect(updates.getUpdateStatus()).toMatchObject({
            phase: 'no-update',
            message: null,
        });
        expect(updates.getUpdateStatus().reason).toBeUndefined();
    });

    it('routes downloaded update installation through the configured shutdown hook', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-available', { version: '1.1.0' });
            mocks.autoUpdater.emit('update-downloaded', { version: '1.1.0' });
        });

        const updates = await loadUpdatesModule();
        const installOrder: string[] = [];
        mocks.markUpdateInstallPending.mockImplementationOnce(async () => {
            installOrder.push('marker');
        });
        mocks.autoUpdater.quitAndInstall.mockImplementationOnce(() => {
            installOrder.push('quit');
        });
        const installAfterCleanup: Array<() => void | Promise<void>> = [];
        updates.configureUpdateInstallShutdown((install) => {
            installAfterCleanup.push(install);
        });

        updates.initializeUpdates(() => undefined);
        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        await expect(updates.installDownloadedUpdate(requester)).resolves.toEqual({started: true});
        expect(mocks.updateSettings).toHaveBeenCalled();
        expect(mocks.markUpdateInstallPending).not.toHaveBeenCalled();
        expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();

        const [install] = installAfterCleanup;
        expect(install).toBeTypeOf('function');
        if (typeof install !== 'function') {
            throw new Error('Expected shutdown hook to receive the update installer');
        }
        await install();
        expect(mocks.markUpdateInstallPending).toHaveBeenCalledWith('1.1.0');
        expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
        expect(installOrder).toEqual([
            'marker',
            'quit',
        ]);
    });

    it('does not install an update whose settings write finishes after system shutdown starts', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-available', {version: '1.1.0'});
            mocks.autoUpdater.emit('update-downloaded', {version: '1.1.0'});
        });
        const updates = await loadUpdatesModule();
        const preservation = Promise.withResolvers<undefined>();
        const app = {
            exit: vi.fn(),
            quit: vi.fn(),
        };
        const coordinator = createShutdownCoordinator({
            app,
            logger: {
                ...mocks.logger,
                debug: vi.fn(),
            },
            runPreservationSteps: () => preservation.promise,
            runBestEffortCleanupSteps: async () => {},
        });
        updates.configureUpdateInstallShutdown(install => coordinator.requestGracefulQuit({afterCleanup: install}));
        updates.initializeUpdates(() => undefined);
        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        const settingsWrite = Promise.withResolvers<undefined>();
        mocks.updateSettings.mockImplementationOnce(async () => {
            await settingsWrite.promise;
            return {};
        });
        const installation = updates.installDownloadedUpdate(requester);
        coordinator.requestSystemShutdown();
        settingsWrite.resolve(undefined);
        await installation;
        preservation.resolve(undefined);
        await vi.advanceTimersByTimeAsync(0);

        expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
        expect(mocks.markUpdateInstallPending).not.toHaveBeenCalled();
        expect(app.quit).toHaveBeenCalledOnce();
    });

    it('installs downloaded updates immediately when no shutdown hook is configured', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-available', { version: '1.1.0' });
            mocks.autoUpdater.emit('update-downloaded', { version: '1.1.0' });
        });

        const updates = await loadUpdatesModule();

        updates.initializeUpdates(() => undefined);
        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        await expect(updates.installDownloadedUpdate(requester)).resolves.toEqual({started: true});
        expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
    });

    it('refuses to install a cached update after an online check locally proves it is superseded', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-available', { version: '1.1.0' });
            mocks.autoUpdater.emit('update-downloaded', { version: '1.1.0' });
        });

        const updates = await loadUpdatesModule();
        updates.initializeUpdates(() => undefined);
        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        mocks.fetch.mockResolvedValue(createMetadataResponse('1.2.0'));
        mocks.autoUpdater.checkForUpdates.mockResolvedValue(undefined);
        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        await expect(updates.installDownloadedUpdate(requester)).resolves.toEqual({started: false});
        expect(mocks.markUpdateInstallPending).not.toHaveBeenCalled();
        expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
        expect(mocks.logger.info).toHaveBeenCalledWith(
            'Discarding cached downloaded update 1.1.0 in favor of newer metadata release 1.2.0',
        );
    });

    it('installs an already-downloaded update offline without performing live validation requests', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-available', { version: '1.1.0' });
            mocks.autoUpdater.emit('update-downloaded', { version: '1.1.0' });
        });

        const updates = await loadUpdatesModule();
        updates.initializeUpdates(() => undefined);
        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        const fetchCallsBeforeInstall = mocks.fetch.mock.calls.length;
        mocks.fetch.mockRejectedValue(new Error('getaddrinfo ENOTFOUND updates.example.test'));

        await expect(updates.installDownloadedUpdate(requester)).resolves.toEqual({started: true});
        expect(mocks.fetch).toHaveBeenCalledTimes(fetchCallsBeforeInstall);
        expect(mocks.markUpdateInstallPending).toHaveBeenCalledWith('1.1.0');
        expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
    });

    it('refuses a cached update after an online check locally proves its updater feed was yanked', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-available', { version: '1.1.0' });
            mocks.autoUpdater.emit('update-downloaded', { version: '1.1.0' });
        });

        const updates = await loadUpdatesModule();
        updates.initializeUpdates(() => undefined);
        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        mocks.fetch.mockImplementation(async (_url: string, init?: {method?: string}) => {
            if (init?.method === 'HEAD') {
                return createEmptyResponse(404);
            }
            return createMetadataResponse('1.1.0');
        });
        mocks.autoUpdater.checkForUpdates.mockResolvedValue(undefined);
        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        await expect(updates.installDownloadedUpdate(requester)).resolves.toEqual({started: false});
        expect(mocks.markUpdateInstallPending).not.toHaveBeenCalled();
        expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            'Discarding cached downloaded update 1.1.0; its updater feed is no longer published',
        );
    });

    it('aborts installation when the diagnostic health marker cannot be written', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.markUpdateInstallPending.mockRejectedValueOnce(new Error('disk is read-only'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-available', { version: '1.1.0' });
            mocks.autoUpdater.emit('update-downloaded', { version: '1.1.0' });
        });

        const updates = await loadUpdatesModule();

        updates.initializeUpdates(() => undefined);
        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        await expect(updates.installDownloadedUpdate(requester)).resolves.toEqual({started: true});
        expect(updates.getUpdateStatus().reason).toBe('install-preparation-failed');
        expect(mocks.logger.error).toHaveBeenCalledWith(
            'Update installation aborted: failed to write update health marker: disk is read-only',
            {
                code: 'MAIN_UPDATE_INSTALL_PREPARATION_FAILED',
                cause: expect.any(Error),
            },
        );
        expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    });

    it('rejects oversized release metadata before reading its body', async () => {
        vi.resetModules();
        const metadata = await import('@electron/updates/fetchLatestReleaseMetadataVersion');
        const response = new Response('{"release":{"tag":"1.1.0"}}', {headers: {'content-length': String(16 * 1024 + 1)}});
        mocks.fetch.mockResolvedValue(response);

        await expect(metadata.fetchLatestReleaseMetadataVersion(
            'https://updates.example.test/latest',
            mocks.logger,
        )).rejects.toThrow('maximum allowed response size');

        mocks.fetch.mockResolvedValue(new Response(new Uint8Array(16 * 1024 + 1)));
        await expect(metadata.fetchLatestReleaseMetadataVersion(
            'https://updates.example.test/latest',
            mocks.logger,
        )).rejects.toThrow('maximum allowed response size');
    });

    it('throttles download progress and installs after the approved download completes', async () => {
        mocks.fetch.mockImplementation(async (_url: string, init?: { method?: string }) => {
            if (init?.method === 'HEAD') {
                return createEmptyResponse(200);
            }
            return createMetadataResponse('1.1.0');
        });
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-available', { version: '1.1.0' });
        });

        const downloaded = Promise.withResolvers<string[]>();
        mocks.autoUpdater.downloadUpdate.mockImplementation(() => downloaded.promise);
        const updates = await loadUpdatesModule();
        const statuses: Array<Record<string, unknown>> = [];
        const installAfterCleanup: Array<() => void | Promise<void>> = [];
        updates.configureUpdateInstallShutdown((install) => {
            installAfterCleanup.push(install);
        });

        updates.initializeUpdates((statusFor) => {
            statuses.push({ ...updates.projectUpdateStatusForWindow(statusFor, requester.senderId) });
        });

        await updates.triggerManualUpdateCheck(requester);
        await flushPromises();

        expect(updates.downloadAvailableUpdate(requester)).toEqual({started: true});

        mocks.autoUpdater.emit('download-progress', { percent: 10 });
        mocks.autoUpdater.emit('download-progress', { percent: 25 });
        mocks.autoUpdater.emit('download-progress', { percent: 50 });
        await flushPromises();

        expect(statuses).toHaveLength(4);
        expect(statuses.at(-1)).toMatchObject({
            phase: 'downloading',
            percent: 0,
        });

        await vi.advanceTimersByTimeAsync(249);
        await flushPromises();
        expect(statuses).toHaveLength(4);

        await vi.advanceTimersByTimeAsync(1);
        await flushPromises();
        expect(statuses).toHaveLength(5);
        expect(statuses.at(-1)).toMatchObject({
            phase: 'downloading',
            percent: 50,
        });

        mocks.autoUpdater.emit('update-downloaded', { version: '1.1.0' });
        downloaded.resolve([]);
        await vi.advanceTimersByTimeAsync(0);

        expect(mocks.markUpdateInstallPending).not.toHaveBeenCalled();
        expect(installAfterCleanup).toHaveLength(1);
        expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();

        await installAfterCleanup[0]?.();
        expect(mocks.markUpdateInstallPending).toHaveBeenCalledWith('1.1.0');
        expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
    });
    function fanout(updates: Awaited<ReturnType<typeof loadUpdatesModule>>) {
        const events: IAppUpdateStatus[][] = [];
        updates.initializeUpdates(statusFor => events.push([
            1,
            2,
            3,
        ].map(id => ({...updates.projectUpdateStatusForWindow(statusFor, id)}))));
        return events;
    }
    it('publishes one failure restricted to the asker when check rejects', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        const failure = new Error('feed transport failed');
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('error', failure);
            throw failure;
        });
        const updates = await loadUpdatesModule(); const events = fanout(updates);
        await updates.triggerManualUpdateCheck({senderId: 1});
        const errors = events.filter(e => e[0]!.phase === 'error');
        console.info('UPDATE_CHECK_REJECTION', JSON.stringify(errors));

        expect(errors.length).toBe(1);
        expect(errors.every(e => e[0]!.requestedHere === true && e[1]!.requestedHere === false && e[2]!.requestedHere === false)).toBe(true);
    });
    it('publishes one failure restricted to the asker when download rejects', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {mocks.autoUpdater.emit('update-available',{version:'1.1.0'});});
        const updates = await loadUpdatesModule(); const events = fanout(updates);
        await updates.triggerManualUpdateCheck({senderId:1});
        const failure = new Error('download transport failed');
        mocks.autoUpdater.downloadUpdate.mockImplementation(async () => {mocks.autoUpdater.emit('error',failure);throw failure;});
        updates.downloadAvailableUpdate({senderId:1});
        await vi.advanceTimersByTimeAsync(0);
        const errors=events.filter(e=>e[0]!.phase==='error');
        expect(errors.length).toBe(1);
        expect(errors.every(e=>e[1]!.requestedHere===false && e[2]!.requestedHere===false)).toBe(true);
    });
    it('registers a second window asking during an in-flight download', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {mocks.autoUpdater.emit('update-available',{version:'1.1.0'});});
        const updates=await loadUpdatesModule();const events=fanout(updates);
        await updates.triggerManualUpdateCheck({senderId:1});
        const {
            promise: gate, resolve: release,
        } = Promise.withResolvers<undefined>();
        mocks.autoUpdater.downloadUpdate.mockImplementation(async () => {await gate; const failure = new Error('download failed'); mocks.autoUpdater.emit('error', failure); throw failure;});
        updates.downloadAvailableUpdate({senderId:1});await flushPromises();
        const initialProgress = events.at(-1)!;
        const joined=updates.downloadAvailableUpdate({senderId:2});
        const progress = events.at(-1)!;
        release(undefined);await vi.advanceTimersByTimeAsync(0);
        const result=events.find(event => event[0]!.phase === 'error')!;
        console.info('UPDATE_JOINED_DOWNLOAD', JSON.stringify({
            initialProgress,
            progress,
            result,
        }));
        expect(progress.map(s => s.requestedHere)).toEqual([
            true,
            true,
            false,
        ]);
        expect(joined).toEqual({started: true});
        expect(result.map(s=>s.requestedHere)).toEqual([
            true,
            true,
            false,
        ]);
    });
    it('publishes one result when two windows start the same check together', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('update-available', {version: '1.1.0'});
        });
        const owner = await loadUpdatesModule();
        const events = fanout(owner);
        await Promise.all([
            owner.triggerManualUpdateCheck({senderId: 1}),
            owner.triggerManualUpdateCheck({senderId: 2}),
        ]);
        const results = events.filter(event => event[0]!.phase === 'available');
        expect(results).toHaveLength(1);
        expect(results[0]!.map(status => status.requestedHere)).toEqual([
            true,
            true,
            false,
        ]);
    });

    it('registers every window joining the same in-flight manual check', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        const {
            promise: gate, resolve: release,
        } = Promise.withResolvers<undefined>();
        mocks.autoUpdater.checkForUpdates.mockImplementation(async()=>{mocks.autoUpdater.emit('checking-for-update');await gate;mocks.autoUpdater.emit('update-not-available',{version:'1.0.0'});});
        const updates=await loadUpdatesModule();const events=fanout(updates);
        const a=updates.triggerManualUpdateCheck({senderId:1});
        await vi.advanceTimersByTimeAsync(0);
        const b=updates.triggerManualUpdateCheck({senderId:2});await flushPromises();
        release(undefined);await Promise.all([
            a,
            b,
        ]);

        expect(events.at(-1)!.map(s=>s.requestedHere)).toEqual([
            true,
            true,
            false,
        ]);
    });
    it('keeps a closed asker from retargeting its result to surviving windows',async()=>{
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        const {
            promise: gate, resolve: release,
        } = Promise.withResolvers<undefined>();
        mocks.autoUpdater.checkForUpdates.mockImplementation(async()=>{await gate;mocks.autoUpdater.emit('update-not-available',{version:'1.0.0'});});
        const updates=await loadUpdatesModule();const events=fanout(updates);
        const check=updates.triggerManualUpdateCheck({senderId:99});await vi.advanceTimersByTimeAsync(0);
        release(undefined);await check;
        expect(events.at(-1)!.map(s=>s.requestedHere)).toEqual([
            false,
            false,
            false,
        ]);
    });
    it('keeps startup presentation pending until a subscribed window claims it',async()=>{
        mocks.recordPendingUpdateStartup.mockResolvedValue({
            installationApplied:false,
            installRequestedAt:Date.now(),
            pendingVersion:'1.1.0',
            startupAttempts:1,
            version:1,
        });
        const updates=await loadUpdatesModule();const events=fanout(updates);await vi.advanceTimersByTimeAsync(0);
        const report=events.find(e=>e[0]!.reason==='install-failed')!;
        expect(report.map(s=>s.requestedHere)).toEqual([
            false,
            false,
            false,
        ]);
        expect([
            1,
            2,
            3,
        ].map(senderId => updates.getUpdateStatus({senderId}).requestedHere === true)).toEqual([
            true,
            false,
            false,
        ]);
    });
    it('does not consume an in-flight requester when an unrelated startup report arrives',async()=>{
        const {
            promise: reportGate, resolve: report,
        } = Promise.withResolvers<IMockPendingUpdateStartup | null>();mocks.recordPendingUpdateStartup.mockImplementation(()=>reportGate);
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        const {
            promise: gate, resolve: release,
        } = Promise.withResolvers<undefined>();
        mocks.autoUpdater.checkForUpdates.mockImplementation(async()=>{mocks.autoUpdater.emit('checking-for-update');await gate;mocks.autoUpdater.emit('update-not-available',{version:'1.0.0'});});
        const updates=await loadUpdatesModule();const events=fanout(updates);const check=updates.triggerManualUpdateCheck({senderId:1});
        await vi.advanceTimersByTimeAsync(0);
        report({
            installationApplied:false,
            installRequestedAt:Date.now(),
            pendingVersion:'1.1.0',
            startupAttempts:1,
            version:1,
        });await vi.advanceTimersByTimeAsync(0);
        const startup=events.find(e=>e[0]!.reason==='install-failed')!;release(undefined);await check;

        expect({
            report:startup.map(s=>s.requestedHere),
            check:events.at(-1)!.map(s=>s.requestedHere),
        }).toEqual({
            report:[
                false,
                false,
                false,
            ],
            check:[
                true,
                false,
                false,
            ],
        });
    });

    async function renderers(owner: Awaited<ReturnType<typeof loadUpdatesModule>>, ids = [
        1,
        2,
        3,
    ]) {
        vi.stubGlobal('ref', ref);
        vi.stubGlobal('computed', computed);
        vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
        const listeners = new Map<number, (status: IAppUpdateStatus) => void>();
        const result: Array<ReturnType<typeof useAppUpdates>> = [];
        owner.initializeUpdates(statusFor => {
            for (const id of [
                1,
                2,
                3,
            ]) {
                const projected = owner.projectUpdateStatusForWindow(statusFor, id);
                listeners.get(id)?.(projected);
            }
        });
        for (const id of ids) {
            vi.resetModules();
            rendererPlatform = createElectronPlatformApiFixture({updates: {
                getState: async () => owner.getUpdateStatus({senderId: id}),
                onStatus: listener => {listeners.set(id, listener); return () => {listeners.delete(id);};},
                check: () => owner.triggerManualUpdateCheck({senderId: id}),
                download: async () => owner.downloadAvailableUpdate({senderId: id}),
            }});
            const {useAppUpdates} = await import('@app/composables/useAppUpdates');
            const ui = useAppUpdates();
            await ui.ensureInitialized();
            result.push(ui);
        }
        return result;
    }

    it('keeps a rejected check out of uninvolved renderers', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            const failure = new Error('check network failed');
            mocks.autoUpdater.emit('error', failure);
            throw failure;
        });
        const owner = await loadUpdatesModule();
        const ui = await renderers(owner);
        await owner.triggerManualUpdateCheck({senderId: 1});
        expect(ui.map(window => window.dialog.value.open)).toEqual([
            true,
            false,
            false,
        ]);
    });

    it('keeps joined renderers on download progress and its failure', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('update-available', {version: '1.1.0'});
        });
        const owner = await loadUpdatesModule();
        const ui = await renderers(owner);
        await owner.triggerManualUpdateCheck({senderId: 1});
        await owner.triggerManualUpdateCheck({senderId: 2});
        const gate = Promise.withResolvers<undefined>();
        mocks.autoUpdater.downloadUpdate.mockImplementation(async () => {
            await gate.promise;
            const failure = new Error('download failed');
            mocks.autoUpdater.emit('error', failure);
            throw failure;
        });
        owner.downloadAvailableUpdate({senderId: 1});
        await flushPromises();
        owner.downloadAvailableUpdate({senderId: 2});
        const progress = {...ui[1]!.dialog.value};
        gate.resolve(undefined);
        await vi.advanceTimersByTimeAsync(0);
        expect(progress).toMatchObject({
            open: true,
            phase: 'downloading',
            kind: 'status',
        });
        expect(ui[1]!.dialog.value).toMatchObject({
            open: true,
            phase: 'error',
            kind: 'status',
        });
        expect(ui[2]!.dialog.value.open).toBe(false);
    });

    it('presents an unreceived startup failure once after a late first subscription', async () => {
        mocks.recordPendingUpdateStartup.mockResolvedValue({
            installationApplied: false,
            installRequestedAt: Date.now(),
            pendingVersion: '1.1.0',
            startupAttempts: 1,
            version: 1,
        });
        const owner = await loadUpdatesModule();
        owner.initializeUpdates(() => {});
        await vi.advanceTimersByTimeAsync(0);
        const [first] = await renderers(owner, [1]);
        expect(first!.dialog.value).toMatchObject({
            open: true,
            phase: 'error',
        });
        expect(first!.dialog.value.failure).not.toBeNull();
        first!.closeDialog();
        const [reloaded] = await renderers(owner, [1]);
        expect(reloaded!.dialog.value.open).toBe(false);
        const [newWindow] = await renderers(owner, [2]);
        expect(newWindow!.dialog.value.open).toBe(false);
    });

    it('consumes a startup failure received live before a renderer reload', async () => {
        const marker = Promise.withResolvers<IMockPendingUpdateStartup | null>();
        mocks.recordPendingUpdateStartup.mockImplementation(() => marker.promise);
        const owner = await loadUpdatesModule();
        const [first] = await renderers(owner, [1]);
        marker.resolve({
            installationApplied: false,
            installRequestedAt: Date.now(),
            pendingVersion: '1.1.0',
            startupAttempts: 1,
            version: 1,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(first!.dialog.value).toMatchObject({
            open: true,
            phase: 'error',
        });
        first!.closeDialog();
        const [reloaded] = await renderers(owner, [1]);
        expect(reloaded!.dialog.value.open).toBe(false);
    });

    it('review: repeated error events during download and a check join produce one requested failure', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => mocks.autoUpdater.emit('update-available', {version: '1.1.0'}));
        const owner = await loadUpdatesModule();
        const events: IAppUpdateStatus[][] = [];
        owner.initializeUpdates(s => events.push([
            1,
            2,
            3,
        ].map(id => owner.projectUpdateStatusForWindow(s, id))));
        await owner.triggerManualUpdateCheck({senderId: 1});
        const gate = Promise.withResolvers<undefined>();
        mocks.autoUpdater.downloadUpdate.mockImplementation(async () => {
            await gate.promise;
            const e = new Error('download failed');
            for (let i = 0; i < 3; i++) mocks.autoUpdater.emit('error', e);
            throw e;
        });
        owner.downloadAvailableUpdate({senderId: 1});
        await flushPromises();
        const checking = owner.triggerManualUpdateCheck({senderId: 2});
        await flushPromises();
        gate.resolve(undefined);
        await checking;
        await vi.advanceTimersByTimeAsync(0);
        const errors = events.filter(e => e[0]!.phase === 'error');
        console.log('review repeated-download/check-join', JSON.stringify(errors));
        expect(errors).toHaveLength(1);
        expect(errors[0]!.map(s => s.requestedHere)).toEqual([
            true,
            true,
            false,
        ]);
    });

    it('review: closing the only download requester never retargets its failure', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => mocks.autoUpdater.emit('update-available', {version:'1.1.0'}));
        const owner = await loadUpdatesModule();
        const events: IAppUpdateStatus[][] = [];
        owner.initializeUpdates(s => events.push([
            2,
            3,
        ].map(id => owner.projectUpdateStatusForWindow(s, id))));
        await owner.triggerManualUpdateCheck({senderId:1});
        const gate = Promise.withResolvers<undefined>();
        mocks.autoUpdater.downloadUpdate.mockImplementation(async () => { await gate.promise; throw new Error('download failed'); });
        owner.downloadAvailableUpdate({senderId:1});
        await flushPromises();
        gate.resolve(undefined);
        await vi.advanceTimersByTimeAsync(0);
        const errors = events.filter(e => e[0]!.phase === 'error');
        console.log('review closed-download-requester', JSON.stringify(errors));
        expect(errors).toHaveLength(1);
        expect(errors[0]!.map(s => s.requestedHere)).toEqual([
            false,
            false,
        ]);
    });

    it('review: a window opened during a download hydrates silently and may join', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => mocks.autoUpdater.emit('update-available', {version:'1.1.0'}));
        const owner = await loadUpdatesModule();
        owner.initializeUpdates(() => {});
        await owner.triggerManualUpdateCheck({senderId:1});
        const gate = Promise.withResolvers<undefined>();
        mocks.autoUpdater.downloadUpdate.mockImplementation(async () => { await gate.promise; throw new Error('download failed'); });
        owner.downloadAvailableUpdate({senderId:1});
        await flushPromises();
        const [fresh] = await renderers(owner,[2]);
        expect(fresh!.dialog.value.open).toBe(false);
        await fresh!.downloadUpdate();
        gate.resolve(undefined);
        await vi.advanceTimersByTimeAsync(0);
        console.log('review fresh download window', JSON.stringify({...fresh!.dialog.value}));
        expect(fresh!.dialog.value).toMatchObject({
            open:true,
            phase:'error',
        });
    });

    it('review: app quit cancels a download without emitting its failure', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => mocks.autoUpdater.emit('update-available', {version:'1.1.0'}));
        const owner = await loadUpdatesModule();
        const events: IAppUpdateStatus[] = [];
        owner.initializeUpdates(s => events.push(owner.projectUpdateStatusForWindow(s, 1)));
        await owner.triggerManualUpdateCheck({senderId:1});
        const gate = Promise.withResolvers<undefined>();
        mocks.autoUpdater.downloadUpdate.mockImplementation(async token => {
            await gate.promise;
            expect(token.cancelled).toBe(true);
            const error = new Error('cancelled download');
            mocks.autoUpdater.emit('error',error);
            throw error;
        });
        owner.downloadAvailableUpdate({senderId:1});
        await flushPromises();
        const quit = owner.shutdownUpdates();
        gate.resolve(undefined);
        await quit;
        console.log('review app-quit statuses', JSON.stringify(events));
        expect(events.filter(s => s.phase === 'error')).toHaveLength(0);
    });

    it('review: a live startup failure is presented once across three subscribed windows', async () => {
        const marker = Promise.withResolvers<IMockPendingUpdateStartup | null>();
        mocks.recordPendingUpdateStartup.mockImplementation(() => marker.promise);
        const owner = await loadUpdatesModule();
        const ui = await renderers(owner);
        marker.resolve({
            installationApplied:false,
            installRequestedAt:Date.now(),
            pendingVersion:'1.1.0',
            startupAttempts:1,
            version:1,
        });
        await vi.advanceTimersByTimeAsync(0);
        console.log('review live startup dialogs', JSON.stringify(ui.map(w => ({...w.dialog.value}))));
        expect(ui.filter(w => w.dialog.value.open && w.dialog.value.phase === 'error')).toHaveLength(1);
    });

    it('review: a delayed install error remains attributed to the approving window', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => mocks.autoUpdater.emit('update-available', {version:'1.1.0'}));
        const owner = await loadUpdatesModule();
        const ui = await renderers(owner);
        let install: (() => Promise<void>) | undefined;
        owner.configureUpdateInstallShutdown(callback => { install = callback; });
        await owner.triggerManualUpdateCheck({senderId:1});
        mocks.autoUpdater.downloadUpdate.mockImplementation(async () => {mocks.autoUpdater.emit('update-downloaded',{version:'1.1.0'}); return [];});
        owner.downloadAvailableUpdate({senderId:1});
        await vi.advanceTimersByTimeAsync(0);
        expect(install).toBeDefined();
        await install!();
        mocks.autoUpdater.emit('error',new Error('Squirrel rejected the downloaded ZIP'));
        console.log('review late native error dialogs', JSON.stringify(ui.map(w => ({...w.dialog.value}))));
        expect(ui.map(w => w.dialog.value.open)).toEqual([
            true,
            false,
            false,
        ]);
    });

    it('review: repeated native install errors have one terminal presentation', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => mocks.autoUpdater.emit('update-available', {version:'1.1.0'}));
        const owner = await loadUpdatesModule();
        const events: IAppUpdateStatus[][] = [];
        owner.initializeUpdates(s => events.push([
            1,
            2,
            3,
        ].map(id => owner.projectUpdateStatusForWindow(s, id))));
        owner.configureUpdateInstallShutdown(() => {});
        await owner.triggerManualUpdateCheck({senderId:1});
        mocks.autoUpdater.downloadUpdate.mockImplementation(async () => {mocks.autoUpdater.emit('update-downloaded',{version:'1.1.0'}); return [];});
        owner.downloadAvailableUpdate({senderId:1});
        await vi.advanceTimersByTimeAsync(0);
        const error = new Error('native install failed');
        mocks.autoUpdater.emit('error',error);
        mocks.autoUpdater.emit('error',error);
        const failures = events.filter(e => e[0]!.phase === 'error');
        console.log('review repeated native terminal results', JSON.stringify(failures));
        expect(failures).toHaveLength(1);
        expect(failures[0]!.map(s => s.requestedHere)).toEqual([
            true,
            false,
            false,
        ]);
    });
    it('review-final: a rejected download does not later reopen a ready result', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => mocks.autoUpdater.emit('update-available', {version:'1.1.0'}));
        const owner = await loadUpdatesModule();
        const ui = await renderers(owner);
        const events: IAppUpdateStatus[] = [];
        let requestedInstall = false;
        owner.configureUpdateInstallShutdown(() => {requestedInstall = true;});
        await owner.triggerManualUpdateCheck({senderId:1});
        const skipped = Promise.withResolvers<Record<string, unknown>>();
        mocks.loadSettings.mockImplementationOnce(() => skipped.promise);
        mocks.autoUpdater.downloadUpdate.mockImplementation(async () => {
            // AppUpdater.done dispatches update-downloaded before its final
            // cached-blockmap copy; that subsequent filesystem await can reject.
            mocks.autoUpdater.emit('update-downloaded',{version:'1.1.0'});
            throw new Error('EACCES copying current.blockmap after update-downloaded');
        });
        owner.downloadAvailableUpdate({senderId:1});
        await vi.advanceTimersByTimeAsync(0);
        const failed = {...ui[0]!.dialog.value};
        events.push({...ui[0]!.status.value});
        skipped.resolve({});
        await vi.advanceTimersByTimeAsync(0);
        events.push({...ui[0]!.status.value});
        console.log('review-final download completion ordering', JSON.stringify({
            failed,
            after:{...ui[0]!.dialog.value},
            events,
            requestedInstall,
        }));
        expect(failed.phase).toBe('error');
        expect(ui[0]!.dialog.value).toMatchObject({
            phase:'error',
            kind:'status',
        });
        expect(requestedInstall).toBe(false);
    });

    it('review-final: the actual shell presents one live startup toast across three windows', async () => {
        const marker = Promise.withResolvers<IMockPendingUpdateStartup | null>();
        mocks.recordPendingUpdateStartup.mockImplementation(() => marker.promise);
        const owner = await loadUpdatesModule();
        const ui = await renderers(owner);
        vi.stubGlobal('watch', watch);
        vi.stubGlobal('onScopeDispose', onScopeDispose);
        const {useAppShellUpdatesDialog} = await import('@app/modules/workspace-shell/composables/useAppShellUpdatesDialog');
        const toasts: Array<Array<{
            title:string;
            description:unknown
        }>> = [];
        const scopes = ui.map(w => {
            const sink: Array<{
                title:string;
                description:unknown
            }> = [];
            toasts.push(sink);
            vi.stubGlobal('useToast',()=>({
                add: (t: {
                    title: string;
                    description: unknown
                }) => {sink.push(t); return {id:sink.length};},
                remove:()=>{},
            }));
            const scope = effectScope();
            scope.run(()=>useAppShellUpdatesDialog({
                ...w,
                updatesStatus:w.status,
                updatesDialog:w.dialog,
                updatesDialogVersion:w.dialogVersion,
                closeUpdatesDialog:w.closeDialog,
            }));
            return scope;
        });
        try {
            marker.resolve({
                installationApplied:false,
                installRequestedAt:Date.now(),
                pendingVersion:'1.1.0',
                startupAttempts:1,
                version:1,
            });
            await vi.advanceTimersByTimeAsync(0);
            await nextTick();
            console.log('R4_STARTUP_STATUSES', JSON.stringify(ui.map(w => ({...w.status.value}))));
            console.log('review-final live startup shell toasts', JSON.stringify(toasts.map(t=>t.map(x=>x.title))));
            expect(toasts.flat().filter(t=>t.title==='updates.errorTitle')).toHaveLength(1);
        } finally { for (const scope of scopes) scope.stop(); }
    });

    it('keeps native installation errors outside the shipped shutdown path', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('update-available', {version: '1.1.0'});
        });
        mocks.autoUpdater.downloadUpdate.mockImplementation(async () => {
            mocks.autoUpdater.emit('update-downloaded', {version: '1.1.0'});
            return [];
        });
        const owner = await loadUpdatesModule();
        const events = fanout(owner);
        let install: (() => Promise<void>) | undefined;
        owner.configureUpdateInstallShutdown(callback => {install = callback;});
        await owner.triggerManualUpdateCheck({senderId: 1});
        owner.downloadAvailableUpdate({senderId: 1});
        await vi.advanceTimersByTimeAsync(0);
        await owner.shutdownUpdates();
        await install!();
        mocks.autoUpdater.emit('error', new Error('native installer failed after cleanup'));
        expect(events.flat().filter(event => event.phase === 'error')).toEqual([]);
    });

    it('closing review: a registered window without a subscription cannot consume the startup failure', async () => {
        const marker = Promise.withResolvers<IMockPendingUpdateStartup | null>();
        mocks.recordPendingUpdateStartup.mockImplementation(() => marker.promise);
        const owner = await loadUpdatesModule();
        const sent: IAppUpdateStatus[] = [];
        // The production dispatcher enumerates registered BrowserWindows, even
        // before AppShell's mounted hook subscribes (or during a renderer reload).
        owner.initializeUpdates(snapshot => {
            sent.push(owner.projectUpdateStatusForWindow(snapshot, 1));
        });
        marker.resolve({
            installationApplied:false,
            installRequestedAt:Date.now(),
            pendingVersion:'1.1.0',
            startupAttempts:1,
            version:1,
        });
        await vi.advanceTimersByTimeAsync(0);
        const [late] = await renderers(owner,[1]);
        console.log('CLOSING_REGISTERED_NOT_SUBSCRIBED',JSON.stringify({
            sent,
            last:late!.status.value,
            dialog:{...late!.dialog.value},
        }));
        expect(late!.dialog.value).toMatchObject({
            open:true,
            phase:'error',
            reason:'install-failed',
        });
        late!.closeDialog();
        const later = await renderers(owner, [
            1,
            2,
            3,
        ]);
        expect(later.map(window => window.dialog.value.open)).toEqual([
            false,
            false,
            false,
        ]);
    });

    it('lets a subscribed window claim startup failure while an earlier registered window is mounting', async () => {
        const marker = Promise.withResolvers<IMockPendingUpdateStartup | null>();
        mocks.recordPendingUpdateStartup.mockImplementation(() => marker.promise);
        const owner = await loadUpdatesModule();
        const ui = await renderers(owner, [
            2,
            3,
        ]);
        marker.resolve({
            installationApplied: false,
            installRequestedAt: Date.now(),
            pendingVersion: '1.1.0',
            startupAttempts: 1,
            version: 1,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(ui.map(window => window.dialog.value.open)).toEqual([
            true,
            false,
        ]);
        ui[0]!.closeDialog();
        const [late] = await renderers(owner, [1]);
        expect(late!.dialog.value.open).toBe(false);
    });

});

afterAll(() => {
    Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform,
    });
    Object.defineProperty(process, 'arch', {
        configurable: true,
        value: originalArch,
    });
    Object.defineProperty(process, 'windowsStore', {
        configurable: true,
        value: originalWindowsStore,
    });
});
