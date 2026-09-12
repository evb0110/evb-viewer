import { EventEmitter } from 'events';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { runInitSequence } from '@electron/bootstrap/runInitSequence';
import { canonicalBundledApplicationVersion } from '@electron/appVersion';
import { config } from '@electron/config';
import {requireDocumentRef} from '@contracts/documentRef';
import { DEFAULT_SETTINGS } from '@contracts/settings';

vi.mock('@electron/config', () => ({config: {
    automation: { noFocus: false },
    isMac: false,
}}));

type TRegisteredExternalOpenIpcHandlers =
    Parameters<Parameters<typeof runInitSequence>[0]['registerIpcHandlers']>[0];

describe('runInitSequence external open IPC', () => {
    async function createHarness(options: {
        allowMultipleAutomationSessions?: boolean;
        appVersion?: string;
        gracefulQuitInProgress?: boolean;
        hasWindows?: boolean;
        initRecentFilesCache?: () => Promise<void>;
        isPackaged?: boolean;
        onPrimaryInstanceReady?: () => void;
        singleInstanceLock?: boolean;
    } = {}) {
        const app = new EventEmitter() as EventEmitter & {
            dock?: { hide: () => void; };
            hide: () => void;
            isPackaged: boolean;
            getVersion: () => string;
            quit: () => void;
            requestSingleInstanceLock: () => boolean;
            setAboutPanelOptions: (options: unknown) => void;
            whenReady: () => Promise<void>;
        };
        app.isPackaged = options.isPackaged ?? true;
        app.getVersion = vi.fn(() => options.appVersion ?? '1.0.0');
        app.hide = vi.fn();
        app.quit = vi.fn();
        const requestSingleInstanceLock = vi.fn(() => options.singleInstanceLock ?? true);
        app.requestSingleInstanceLock = requestSingleInstanceLock;
        app.setAboutPanelOptions = vi.fn();
        app.whenReady = vi.fn(async () => {});

        const mainWebContents = {};
        const otherWebContents = {};
        const mainWindow = Object.assign(new EventEmitter(), {
            id: 1,
            webContents: Object.assign(new EventEmitter(), mainWebContents),
        });
        const otherWindow = Object.assign(new EventEmitter(), {
            id: 2,
            webContents: Object.assign(new EventEmitter(), otherWebContents),
        });
        const capturedHandlers: TRegisteredExternalOpenIpcHandlers = {};
        const externalOpenManager = {
            queueOpenRequestFromArgs: vi.fn(),
            requestMainWindowForExternalOpen: vi.fn(),
            scheduleFlushPendingFiles: vi.fn(),
            claimPendingOpenPaths: vi.fn(async () => ['/docs/startup.pdf']),
            acknowledgeClaimedOpenPaths: vi.fn(),
            markBootstrapReady: vi.fn(),
        };
        const allowOpenPaths = vi.fn();
        const focusMainWindow = vi.fn();
        const createWindow = vi.fn(async () => mainWindow as never);
        const initializeResourceRuntime = vi.fn(async () => {});
        const initializeElectronTranslations = vi.fn(async () => {});
        const cleanupStaleWorkingCopyDirectories = vi.fn(async () => ({
            removedDirectories: 0,
            removedOcrDirectories: 0,
        }));
        const sweepStaleDefaultAppTempPdfs = vi.fn(async () => {});
        const pruneStaleDjvuArtifactJobs = vi.fn(async () => {});
        const sweepStaleOcrTempArtifacts = vi.fn(async () => {});
        const sweepStaleManagedScratchTempDirs = vi.fn(async () => {});
        const initRecentFilesCache = vi.fn(options.initRecentFilesCache ?? (async () => {}));
        const loadSettings = vi.fn(async () => ({...DEFAULT_SETTINGS}));
        const setupMenu = vi.fn();
        const updateRecentFilesMenu = vi.fn();
        const shutdownCoordinator = options.gracefulQuitInProgress === undefined
            ? null
            : {
                isFatalShutdownInProgress: vi.fn(() => false),
                isGracefulQuitInProgress: vi.fn(() => options.gracefulQuitInProgress ?? false),
                isQuittingAfterCleanup: vi.fn(() => false),
                requestGracefulQuit: vi.fn(),
            };

        await runInitSequence({
            app: app as never,
            aboutIconPath: '/app/icon.png',
            allowMultipleAutomationSessions: options.allowMultipleAutomationSessions ?? false,
            allowOpenPaths,
            attachHostEnvironmentToWindow: vi.fn(),
            broadcastUpdateStatus: vi.fn(),
            cleanupStaleWorkingCopyDirectories,
            createWindow,
            devDockBadgeText: '',
            devDockIconPath: '',
            externalOpenManager,
            focusMainWindow,
            getMainWindow: vi.fn(() => mainWindow as never),
            getWindowFromWebContents: vi.fn((webContents: object) => {
                if (webContents === mainWindow.webContents) {
                    return mainWindow as never;
                }
                if (webContents === otherWindow.webContents) {
                    return otherWindow as never;
                }
                return null;
            }),
            hasWindows: vi.fn(() => options.hasWindows ?? true),
            initRecentFilesCache,
            initializeElectronTranslations,
            initializeResourceRuntime,
            initializeUpdates: vi.fn(),
            installHostEnvironmentDisplayWatcher: vi.fn(),
            logger: {
                debug: vi.fn(),
                error: vi.fn(),
                info: vi.fn(),
                warn: vi.fn(),
            },
            loadSettings,
            logStartupPhase: vi.fn(),
            markWindowRendererReady: vi.fn(),
            onPrimaryInstanceReady: options.onPrimaryInstanceReady ?? vi.fn(),
            markWindowTabTransferNotReady: vi.fn(),
            markWindowTabTransferReady: vi.fn(),
            markWindowTabTransferWindowClosed: vi.fn(),
            maybePromptForDefaultViewer: vi.fn(),
            readyWindowIds: new Set<number>(),
            registerIpcHandlers: vi.fn((handlers: TRegisteredExternalOpenIpcHandlers) => {
                Object.assign(capturedHandlers, handlers);
            }),
            setupAppProtocolHandler: vi.fn(),
            setupMenu,
            shouldResetRendererReadyOnNavigation: vi.fn(() => true),
            shutdownCoordinator,
            sweepStaleDefaultAppTempPdfs,
            sweepStaleManagedScratchTempDirs,
            sweepStaleOcrTempArtifacts,
            pruneStaleDjvuArtifactJobs,
            updateRecentFilesMenu,
        });

        return {
            app,
            allowOpenPaths,
            capturedHandlers,
            createWindow,
            cleanupStaleWorkingCopyDirectories,
            externalOpenManager,
            focusMainWindow,
            initializeResourceRuntime,
            initializeElectronTranslations,
            mainWindow,
            otherWindow,
            initRecentFilesCache,
            loadSettings,
            pruneStaleDjvuArtifactJobs,
            requestSingleInstanceLock,
            setupMenu,
            shutdownCoordinator,
            sweepStaleDefaultAppTempPdfs,
            sweepStaleManagedScratchTempDirs,
            sweepStaleOcrTempArtifacts,
            updateRecentFilesMenu,
        };
    }

    async function claimStartupPath(harness: Awaited<ReturnType<typeof createHarness>>) {
        await expect(harness.capturedHandlers.claimPendingExternalOpenPaths?.(
            harness.mainWindow.webContents as never,
        )).resolves.toEqual(['/docs/startup.pdf']);
    }

    it('uses the canonical application version in the macOS About panel', async () => {
        const harness = await createHarness({appVersion: '0.1.387'});

        expect(harness.app.setAboutPanelOptions).toHaveBeenCalledWith({
            applicationName: 'EVB Viewer',
            applicationVersion: '0.1.387',
            version: 'Beta',
            copyright: 'Copyright © 2026 Eugene Barsky',
            iconPath: '/app/icon.png',
            authors: ['Eugene Barsky'],
        });
    });

    it('initializes the resource runtime before creating a window', async () => {
        const harness = await createHarness();

        expect(harness.initializeResourceRuntime).toHaveBeenCalledOnce();
        expect(harness.initializeResourceRuntime.mock.invocationCallOrder[0])
            .toBeLessThan(harness.createWindow.mock.invocationCallOrder[0]!);
    });

    it('initializes translations before IPC registration and window creation', async () => {
        const harness = await createHarness();

        expect(harness.initializeElectronTranslations).toHaveBeenCalledOnce();
        expect(harness.initializeElectronTranslations.mock.invocationCallOrder[0])
            .toBeLessThan(harness.createWindow.mock.invocationCallOrder[0]!);
    });

    it('notifies startup diagnostics only after acquiring the single-instance lock', async () => {
        const onPrimaryInstanceReady = vi.fn();
        const harness = await createHarness({onPrimaryInstanceReady});

        expect(harness.requestSingleInstanceLock).toHaveBeenCalledOnce();
        expect(onPrimaryInstanceReady).toHaveBeenCalledOnce();
        expect(onPrimaryInstanceReady.mock.invocationCallOrder[0])
            .toBeGreaterThan(harness.requestSingleInstanceLock.mock.invocationCallOrder[0]!);
    });

    it('does not notify startup diagnostics in a secondary instance', async () => {
        const onPrimaryInstanceReady = vi.fn();
        const processExit = vi.spyOn(process, 'exit').mockImplementation(() => {
            throw new Error('secondary instance exit');
        });
        try {
            await expect(createHarness({
                onPrimaryInstanceReady,
                singleInstanceLock: false,
            })).rejects.toThrow('secondary instance exit');
            expect(onPrimaryInstanceReady).not.toHaveBeenCalled();
        } finally {
            processExit.mockRestore();
        }
    });

    it('never displays the generic Electron runtime version in the development About panel', async () => {
        const harness = await createHarness({
            appVersion: '42.3.3',
            isPackaged: false,
        });

        expect(harness.app.setAboutPanelOptions).toHaveBeenCalledWith(expect.objectContaining({
            applicationVersion: canonicalBundledApplicationVersion,
            version: 'Beta',
        }));
    });

    it('omits build metadata from the About panel version', async () => {
        const harness = await createHarness({appVersion: `0.1.387+${'a'.repeat(40)}`});

        expect(harness.app.setAboutPanelOptions).toHaveBeenCalledWith(expect.objectContaining({
            applicationVersion: '0.1.387',
            version: 'Beta',
        }));
    });

    it('shows and focuses the main window when its renderer becomes ready', async () => {
        const harness = await createHarness();

        harness.capturedHandlers.onRendererReady?.({sender: harness.mainWindow.webContents} as never);

        expect(harness.focusMainWindow).toHaveBeenCalledTimes(1);
    });

    it('does not refocus the main window when the existing renderer signals ready after a reload', async () => {
        const harness = await createHarness();

        harness.capturedHandlers.onRendererReady?.({sender: harness.mainWindow.webContents} as never);
        harness.capturedHandlers.onRendererReady?.({sender: harness.mainWindow.webContents} as never);

        expect(harness.focusMainWindow).toHaveBeenCalledTimes(1);
    });

    it('acknowledges failed startup opens only from the claiming WebContents and claimed paths', async () => {
        const harness = await createHarness();

        await expect(harness.capturedHandlers.claimPendingExternalOpenPaths?.(
            harness.mainWindow.webContents as never,
        )).resolves.toEqual(['/docs/startup.pdf']);

        expect(harness.allowOpenPaths).toHaveBeenCalledWith(
            ['/docs/startup.pdf'],
            harness.mainWindow.webContents,
        );

        harness.capturedHandlers.acknowledgePendingExternalOpenPaths?.(
            harness.otherWindow.webContents as never,
            [requireDocumentRef('/docs/startup.pdf')],
        );
        harness.capturedHandlers.acknowledgePendingExternalOpenPaths?.(
            harness.mainWindow.webContents as never,
            [requireDocumentRef('/docs/other.pdf')],
        );

        expect(harness.externalOpenManager.acknowledgeClaimedOpenPaths).not.toHaveBeenCalled();

        harness.capturedHandlers.acknowledgePendingExternalOpenPaths?.(
            harness.mainWindow.webContents as never,
            [requireDocumentRef('/docs/startup.pdf')],
        );

        expect(harness.externalOpenManager.acknowledgeClaimedOpenPaths).toHaveBeenCalledTimes(1);
        expect(harness.externalOpenManager.acknowledgeClaimedOpenPaths).toHaveBeenCalledWith(['/docs/startup.pdf']);
    });

    it('queues startup argv open paths on macOS when the automation harness is active', async () => {
        const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', {
            configurable: true,
            value: 'darwin',
        });
        try {
            const automationHarness = await createHarness({allowMultipleAutomationSessions: true});
            expect(automationHarness.externalOpenManager.queueOpenRequestFromArgs)
                .toHaveBeenCalledWith(process.argv.slice(1));

            const finderHarness = await createHarness();
            expect(finderHarness.externalOpenManager.queueOpenRequestFromArgs).not.toHaveBeenCalled();
        } finally {
            if (platformDescriptor) {
                Object.defineProperty(process, 'platform', platformDescriptor);
            }
        }
    });

    it('defers startup maintenance until the main renderer is ready and runs it once', async () => {
        vi.useFakeTimers();
        const harness = await createHarness();
        const sweeps = [
            harness.sweepStaleDefaultAppTempPdfs,
            harness.pruneStaleDjvuArtifactJobs,
            harness.sweepStaleOcrTempArtifacts,
            harness.sweepStaleManagedScratchTempDirs,
            harness.cleanupStaleWorkingCopyDirectories,
        ];
        expect(sweeps.every(sweep => sweep.mock.calls.length === 0)).toBe(true);

        harness.capturedHandlers.onRendererReady?.({sender: harness.otherWindow.webContents} as never);
        await vi.runAllTimersAsync();
        expect(sweeps.every(sweep => sweep.mock.calls.length === 0)).toBe(true);

        harness.capturedHandlers.onRendererReady?.({sender: harness.mainWindow.webContents} as never);
        harness.capturedHandlers.onRendererReady?.({sender: harness.mainWindow.webContents} as never);
        await vi.runAllTimersAsync();

        expect(sweeps.every(sweep => sweep.mock.calls.length === 1)).toBe(true);
        vi.useRealTimers();
    });

    it('installs the cached menu before Recent refresh and patches it only after success', async () => {
        let resolveRecentRefresh: () => void = () => {};
        const recentRefresh = new Promise<void>((resolve) => {
            resolveRecentRefresh = resolve;
        });
        const harness = await createHarness({initRecentFilesCache: () => recentRefresh});
        await vi.waitFor(() => expect(harness.setupMenu).toHaveBeenCalledOnce());
        expect(harness.initRecentFilesCache).toHaveBeenCalledOnce();
        expect(harness.updateRecentFilesMenu).not.toHaveBeenCalled();

        resolveRecentRefresh();
        await vi.waitFor(() => expect(harness.updateRecentFilesMenu).toHaveBeenCalledOnce());
    });

    it('retains the cached menu when Recent refresh fails', async () => {
        const initRecentFilesCache = async () => {
            throw new Error('refresh failed');
        };
        const harness = await createHarness({initRecentFilesCache});

        await vi.waitFor(() => expect(harness.initRecentFilesCache).toHaveBeenCalledOnce());
        expect(harness.setupMenu).toHaveBeenCalledOnce();
        expect(harness.updateRecentFilesMenu).not.toHaveBeenCalled();
    });

    it('continues serialized startup maintenance after a failed step', async () => {
        vi.useFakeTimers();
        const harness = await createHarness();
        const order: string[] = [];
        harness.sweepStaleDefaultAppTempPdfs.mockImplementation(async () => {
            order.push('default');
        });
        harness.pruneStaleDjvuArtifactJobs.mockImplementation(async () => {
            order.push('djvu');
            throw new Error('failed');
        });
        harness.sweepStaleOcrTempArtifacts.mockImplementation(async () => {
            order.push('ocr');
        });
        harness.sweepStaleManagedScratchTempDirs.mockImplementation(async () => {
            order.push('scratch');
        });
        harness.cleanupStaleWorkingCopyDirectories.mockImplementation(async () => {
            order.push('working');
            return {
                removedDirectories: 0,
                removedOcrDirectories: 0,
            };
        });

        harness.capturedHandlers.onRendererReady?.({sender: harness.mainWindow.webContents} as never);
        await vi.runAllTimersAsync();

        expect(order).toEqual([
            'default',
            'djvu',
            'ocr',
            'scratch',
            'working',
        ]);
        vi.useRealTimers();
    });

    it('quits when the last window closes outside macOS', async () => {
        const harness = await createHarness();

        harness.app.emit('window-all-closed');

        expect(harness.app.quit).toHaveBeenCalledOnce();
    });

    it('does not recreate a window while graceful quit cleanup is running', async () => {
        const harness = await createHarness({
            gracefulQuitInProgress: true,
            hasWindows: false,
        });
        expect(harness.createWindow).toHaveBeenCalledOnce();

        harness.app.emit('activate');

        expect(harness.createWindow).toHaveBeenCalledOnce();
    });

    it('routes non-macOS last-window close through coordinated cleanup when available', async () => {
        const harness = await createHarness({gracefulQuitInProgress: false});

        harness.app.emit('window-all-closed');

        expect(harness.shutdownCoordinator?.requestGracefulQuit).toHaveBeenCalledOnce();
        expect(harness.app.quit).not.toHaveBeenCalled();
    });

    it('keeps the macOS application alive after its last window closes', async () => {
        const originalIsMac = config.isMac;
        (config as { isMac: boolean }).isMac = true;
        try {
            const harness = await createHarness({gracefulQuitInProgress: false});

            harness.app.emit('window-all-closed');

            expect(harness.shutdownCoordinator?.requestGracefulQuit).not.toHaveBeenCalled();
            expect(harness.app.quit).not.toHaveBeenCalled();
        } finally {
            (config as { isMac: boolean }).isMac = originalIsMac;
        }
    });

    it('quits an isolated macOS automation app after its last window closes', async () => {
        const originalIsMac = config.isMac;
        (config as { isMac: boolean }).isMac = true;
        try {
            const harness = await createHarness({
                allowMultipleAutomationSessions: true,
                gracefulQuitInProgress: false,
            });

            harness.app.emit('window-all-closed');

            expect(harness.shutdownCoordinator?.requestGracefulQuit).toHaveBeenCalledOnce();
            expect(harness.app.quit).not.toHaveBeenCalled();
        } finally {
            (config as { isMac: boolean }).isMac = originalIsMac;
        }
    });

    it('requeues an unacknowledged startup claim when the main renderer navigates', async () => {
        const harness = await createHarness();
        harness.app.emit('browser-window-created', {}, harness.mainWindow);

        await claimStartupPath(harness);
        expect(harness.externalOpenManager.acknowledgeClaimedOpenPaths).not.toHaveBeenCalled();

        harness.mainWindow.webContents.emit('did-start-navigation', {}, 'app://renderer/reload', false, true);

        expect(harness.externalOpenManager.acknowledgeClaimedOpenPaths).toHaveBeenCalledWith(['/docs/startup.pdf']);
    });

    it('requeues an unacknowledged startup claim when the renderer process is gone', async () => {
        const harness = await createHarness();
        harness.app.emit('browser-window-created', {}, harness.mainWindow);

        await claimStartupPath(harness);
        harness.mainWindow.webContents.emit('render-process-gone');

        expect(harness.externalOpenManager.acknowledgeClaimedOpenPaths).toHaveBeenCalledWith(['/docs/startup.pdf']);
    });

    it('uses creation-time window identities after Electron destroys closed-window getters', async () => {
        const harness = await createHarness();
        harness.app.emit('browser-window-created', {}, harness.mainWindow);
        await claimStartupPath(harness);

        Object.defineProperties(harness.mainWindow, {
            id: {get: () => { throw new TypeError('Object has been destroyed'); }},
            webContents: {get: () => { throw new TypeError('Object has been destroyed'); }},
        });

        expect(() => harness.mainWindow.emit('closed')).not.toThrow();
        expect(harness.externalOpenManager.acknowledgeClaimedOpenPaths).toHaveBeenCalledWith(['/docs/startup.pdf']);
    });

    it('requeues an unacknowledged startup claim after the claim timeout', async () => {
        vi.useFakeTimers();
        try {
            const harness = await createHarness();

            await claimStartupPath(harness);
            await vi.advanceTimersByTimeAsync(30_000);

            expect(harness.externalOpenManager.acknowledgeClaimedOpenPaths).toHaveBeenCalledWith(['/docs/startup.pdf']);
        } finally {
            vi.useRealTimers();
        }
    });
});
