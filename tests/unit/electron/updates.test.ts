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
vi.mock('@electron/updates/checkMacCodeSignature', () => ({checkMacCodeSignature: vi.fn(async () => true)}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));

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

async function loadUpdatesModule() {
    vi.resetModules();
    return import('@electron/updates');
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
            const updates = await import('@electron/updates');
            await updates.shutdownUpdates();
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

    it('redacts endpoint credentials and URL values from updater status messages', async () => {
        const endpointError = new Error(
            'GET https://user:pass@updates.example.test:8443/latest?channel=stable&token=secret#private failed',
        );
        mocks.fetch.mockRejectedValue(endpointError);
        mocks.autoUpdater.checkForUpdates.mockRejectedValue(endpointError);

        const updates = await loadUpdatesModule();
        const statuses: Array<Record<string, unknown>> = [];
        updates.initializeUpdates(status => statuses.push({...status}));

        await updates.triggerManualUpdateCheck();

        expect(statuses.at(-1)).toMatchObject({
            phase: 'error',
            message: 'Update check failed: Release rollout metadata failed (https://updates.example.test/latest: GET https://[redacted]@updates.example.test:8443/latest?channel=[redacted]&token=[redacted]#[redacted] failed)',
        });
    });

    it('classifies a manual updater failure with its bounded check context', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockRejectedValue(new Error('updater rejected the feed'));

        const updates = await loadUpdatesModule();
        await updates.triggerManualUpdateCheck();
        await flushPromises();

        expect(mocks.logger.error).toHaveBeenCalledWith(
            'Update check failed: updater rejected the feed',
            {
                code: 'MAIN_UPDATE_CHECK_FAILED',
                context: {origin: 'manual'},
                cause: expect.any(Error),
            },
        );
    });

    it('keeps ordinary offline update checks at warning level without an occurrence', async () => {
        mocks.fetch.mockRejectedValue(Object.assign(new Error('network is offline'), {code: 'ENETUNREACH'}));

        const updates = await loadUpdatesModule();
        await updates.triggerManualUpdateCheck();
        await flushPromises();

        expect(mocks.logger.error).not.toHaveBeenCalled();
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('network is offline'),
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
        updates.initializeUpdates(status => statuses.push({ ...status }));
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
                context: {
                    phase: 'installation',
                    attempt: 1,
                },
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

        updates.initializeUpdates((status) => {
            statuses.push({ ...status });
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

        await updates.triggerManualUpdateCheck();
        await flushPromises();
        expect(mocks.session.defaultSession.cookies.get).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(29_999);
        await updates.triggerManualUpdateCheck();
        await flushPromises();
        expect(mocks.session.defaultSession.cookies.get).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(1);
        await updates.triggerManualUpdateCheck();
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
        updates.initializeUpdates(status => statuses.push({ ...status }));

        await updates.triggerManualUpdateCheck();
        await flushPromises();

        expect(mocks.autoUpdater.autoDownload).toBe(false);
        expect(mocks.autoUpdater.downloadUpdate).not.toHaveBeenCalled();
        expect(statuses.at(-1)).toMatchObject({
            origin: 'manual',
            phase: 'available',
            version: '1.1.0',
        });

        expect(updates.downloadAvailableUpdate()).toEqual({started: true});
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
        updates.initializeUpdates(status => statuses.push({...status}));

        await updates.triggerManualUpdateCheck();

        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
        expect(statuses.at(-1)).toMatchObject({
            phase: 'unsupported',
            message: 'Updates for the Microsoft Store build are delivered by Microsoft Store.',
        });
    });

    it('reports Windows builds as unsupported instead of checking for updates', async () => {
        Object.defineProperty(process, 'platform', {
            configurable: true,
            value: 'win32',
        });

        const updates = await loadUpdatesModule();
        const statuses: Array<Record<string, unknown>> = [];
        updates.initializeUpdates(status => statuses.push({...status}));

        await updates.triggerManualUpdateCheck();

        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
        expect(statuses.at(-1)).toMatchObject({
            origin: 'manual',
            phase: 'unsupported',
            message: null,
        });
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
        await updates.triggerManualUpdateCheck();
        expect(updates.downloadAvailableUpdate()).toEqual({started: true});
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
        await updates.triggerManualUpdateCheck();

        expect(updates.downloadAvailableUpdate()).toEqual({started: true});
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

        updates.initializeUpdates((status) => {
            statuses.push({ ...status });
        });

        await vi.advanceTimersByTimeAsync(1_000);
        await flushPromises();

        const manualCheckPromise = updates.triggerManualUpdateCheck();
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

        updates.initializeUpdates((status) => {
            statuses.push({ ...status });
        });

        await updates.triggerManualUpdateCheck();
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

        await updates.triggerManualUpdateCheck();
        await flushPromises();

        mocks.fetch.mockRejectedValue(new Error('rollout endpoint unavailable'));
        await updates.triggerManualUpdateCheck();
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
        await updates.triggerManualUpdateCheck();
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

        updates.initializeUpdates((status) => {
            statuses.push({ ...status });
        });

        await updates.triggerManualUpdateCheck();
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

        await updates.triggerManualUpdateCheck();
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

        updates.initializeUpdates((status) => {
            statuses.push({ ...status });
        });

        await updates.triggerManualUpdateCheck();
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
        updates.initializeUpdates(status => statuses.push({...status}));

        await updates.triggerManualUpdateCheck();
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
        updates.initializeUpdates(status => statuses.push({...status}));

        const firstCheck = updates.triggerManualUpdateCheck();
        await flushPromises();
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(firstCheck).resolves.toMatchObject({started: true});
        expect(timeoutSpy).toHaveBeenCalledWith(10_000);
        expect(firstFeedSignal).not.toBeNull();
        expect(firstFeedAborted).toBe(true);
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

        await updates.triggerManualUpdateCheck();
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
        updates.initializeUpdates(status => statuses.push({ ...status }));

        await updates.triggerManualUpdateCheck();
        await flushPromises();

        expect(statuses.at(-1)).toMatchObject({
            origin: 'manual',
            phase: 'no-update',
            version: '1.0.0',
        });
        await expect(updates.installDownloadedUpdate()).resolves.toEqual({started: false});
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            `Discarding downloaded update ${staleVersion} during download event; running version is 1.0.0`,
        );

        mocks.autoUpdater.checkForUpdates.mockImplementationOnce(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-not-available', { version: '1.0.0' });
        });
        await updates.triggerManualUpdateCheck();
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
        await updates.triggerManualUpdateCheck();
        await flushPromises();

        mocks.app.getVersion.mockReturnValue('1.1.0');
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.2.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementationOnce(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-not-available', { version: '1.1.0' });
        });
        await updates.triggerManualUpdateCheck();
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
        await updates.triggerManualUpdateCheck();
        await flushPromises();

        mocks.app.getVersion.mockReturnValue('1.1.0');
        await expect(updates.installDownloadedUpdate()).resolves.toEqual({started: false});
        await expect(updates.installDownloadedUpdate()).resolves.toEqual({started: false});
        expect(mocks.markUpdateInstallPending).not.toHaveBeenCalled();
        expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            'Update installation failed: Downloaded update 1.1.0 is not newer than the running version 1.1.0',
        );
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
        await updates.triggerManualUpdateCheck();
        await flushPromises();

        await expect(updates.installDownloadedUpdate()).resolves.toEqual({started: true});
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

    it('installs downloaded updates immediately when no shutdown hook is configured', async () => {
        mocks.fetch.mockResolvedValue(createMetadataResponse('1.1.0'));
        mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
            mocks.autoUpdater.emit('checking-for-update');
            mocks.autoUpdater.emit('update-available', { version: '1.1.0' });
            mocks.autoUpdater.emit('update-downloaded', { version: '1.1.0' });
        });

        const updates = await loadUpdatesModule();

        updates.initializeUpdates(() => undefined);
        await updates.triggerManualUpdateCheck();
        await flushPromises();

        await expect(updates.installDownloadedUpdate()).resolves.toEqual({started: true});
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
        await updates.triggerManualUpdateCheck();
        await flushPromises();

        mocks.fetch.mockResolvedValue(createMetadataResponse('1.2.0'));
        mocks.autoUpdater.checkForUpdates.mockResolvedValue(undefined);
        await updates.triggerManualUpdateCheck();
        await flushPromises();

        await expect(updates.installDownloadedUpdate()).resolves.toEqual({started: false});
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
        await updates.triggerManualUpdateCheck();
        await flushPromises();

        const fetchCallsBeforeInstall = mocks.fetch.mock.calls.length;
        mocks.fetch.mockRejectedValue(new Error('getaddrinfo ENOTFOUND updates.example.test'));

        await expect(updates.installDownloadedUpdate()).resolves.toEqual({started: true});
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
        await updates.triggerManualUpdateCheck();
        await flushPromises();

        mocks.fetch.mockImplementation(async (_url: string, init?: {method?: string}) => {
            if (init?.method === 'HEAD') {
                return createEmptyResponse(404);
            }
            return createMetadataResponse('1.1.0');
        });
        mocks.autoUpdater.checkForUpdates.mockResolvedValue(undefined);
        await updates.triggerManualUpdateCheck();
        await flushPromises();

        await expect(updates.installDownloadedUpdate()).resolves.toEqual({started: false});
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
        await updates.triggerManualUpdateCheck();
        await flushPromises();

        await expect(updates.installDownloadedUpdate()).resolves.toEqual({started: true});
        expect(mocks.logger.error).toHaveBeenCalledWith(
            'Update installation aborted: failed to write update health marker: disk is read-only',
            {
                code: 'MAIN_UPDATE_INSTALL_PREPARATION_FAILED',
                context: {},
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

        const updates = await loadUpdatesModule();
        const statuses: Array<Record<string, unknown>> = [];
        const installAfterCleanup: Array<() => void | Promise<void>> = [];
        updates.configureUpdateInstallShutdown((install) => {
            installAfterCleanup.push(install);
        });

        updates.initializeUpdates((status) => {
            statuses.push({ ...status });
        });

        await updates.triggerManualUpdateCheck();
        await flushPromises();

        expect(updates.downloadAvailableUpdate()).toEqual({started: true});

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
        await flushPromises();
        await flushPromises();

        expect(mocks.markUpdateInstallPending).not.toHaveBeenCalled();
        expect(installAfterCleanup).toHaveLength(1);
        expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();

        await installAfterCleanup[0]?.();
        expect(mocks.markUpdateInstallPending).toHaveBeenCalledWith('1.1.0');
        expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
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
