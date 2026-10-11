import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import {
    createExternalOpenManager,
    createMacOpenFileRouter,
} from '@electron/bootstrap/externalOpen';
import {
    bootSingleInstance,
    createStartupExternalOpenClaimTracker,
} from '@electron/bootstrap/runInitSequence';
import { createTestEventSender } from '@tests/helpers/electronEventEmitterHarness';

const mocks = vi.hoisted(() => ({existsSync: vi.fn((_path: string) => true)}));

vi.mock('fs', () => ({existsSync: (path: string) => mocks.existsSync(path)}));

function createLogger() {
    return {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
    };
}

afterEach(() => {
    vi.useRealTimers();
    mocks.existsSync.mockReset();
    mocks.existsSync.mockReturnValue(true);
});

describe('createMacOpenFileRouter', () => {
    it('buffers supported open-file paths before the externalOpen manager is attached', () => {
        const logger = createLogger();
        const router = createMacOpenFileRouter({ logger });
        const externalOpenManager = {
            queueOpenRequest: vi.fn(),
            requestMainWindowForExternalOpen: vi.fn(),
        };

        mocks.existsSync.mockImplementation(path => path === '/Users/test/Documents/sample.PDF');
        router.handleOpenFile('/Users/test/Documents/sample.PDF');
        router.attachExternalOpenManager(externalOpenManager);

        expect(externalOpenManager.queueOpenRequest).toHaveBeenCalledTimes(1);
        expect(externalOpenManager.queueOpenRequest).toHaveBeenCalledWith(['/Users/test/Documents/sample.PDF']);
        expect(externalOpenManager.requestMainWindowForExternalOpen).toHaveBeenCalledTimes(1);
        expect(logger.debug).toHaveBeenCalledWith(
            'Buffered macOS open-file path before external open manager init: /Users/test/Documents/sample.PDF',
        );
        expect(logger.info).toHaveBeenCalledWith('Flushing 1 early macOS open-file path(s)');
    });

    it('ignores unsupported open-file paths', () => {
        const logger = createLogger();
        const router = createMacOpenFileRouter({ logger });
        const externalOpenManager = {
            queueOpenRequest: vi.fn(),
            requestMainWindowForExternalOpen: vi.fn(),
        };

        router.handleOpenFile('/Users/test/Documents/readme.txt');
        router.attachExternalOpenManager(externalOpenManager);

        expect(externalOpenManager.queueOpenRequest).not.toHaveBeenCalled();
        expect(externalOpenManager.requestMainWindowForExternalOpen).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            'Ignoring unsupported macOS open-file path: /Users/test/Documents/readme.txt',
        );
    });

    it('routes later open-file events directly once the externalOpen manager is attached', () => {
        const logger = createLogger();
        const router = createMacOpenFileRouter({ logger });
        const externalOpenManager = {
            queueOpenRequest: vi.fn(),
            requestMainWindowForExternalOpen: vi.fn(),
        };

        router.attachExternalOpenManager(externalOpenManager);
        router.handleOpenFile('/Users/test/Documents/live.pdf');

        expect(externalOpenManager.queueOpenRequest).toHaveBeenCalledTimes(1);
        expect(externalOpenManager.queueOpenRequest).toHaveBeenCalledWith(['/Users/test/Documents/live.pdf']);
        expect(externalOpenManager.requestMainWindowForExternalOpen).toHaveBeenCalledTimes(1);
    });

    it('preserves an existing trailing-whitespace path from the macOS open-file event', () => {
        const logger = createLogger();
        const router = createMacOpenFileRouter({ logger });
        const externalOpenManager = {
            queueOpenRequest: vi.fn(),
            requestMainWindowForExternalOpen: vi.fn(),
        };
        const exactPath = '/Users/test/Documents/report.pdf ';
        mocks.existsSync.mockImplementation(path => path === exactPath || path === exactPath.trim());

        router.attachExternalOpenManager(externalOpenManager);
        router.handleOpenFile(exactPath);

        expect(externalOpenManager.queueOpenRequest).toHaveBeenCalledWith([exactPath]);
    });
});

describe('createExternalOpenManager', () => {
    function createManagerHarness(options: {
        isRendererReady?: boolean;
        hasWindows?: boolean;
        noFocus?: boolean;
        dispatchOpenPaths?: (paths: string[]) => boolean;
    } = {}) {
        const logger = createLogger();
        let rendererReady = options.isRendererReady ?? true;
        let hasWindows = options.hasWindows ?? true;
        const dispatchOpenPaths = options.dispatchOpenPaths ?? vi.fn((_paths: string[]) => true);
        const createWindow = vi.fn(async () => {
            hasWindows = true;
        });
        const focus = vi.fn();
        const webContentsFocus = vi.fn();
        const restore = vi.fn();
        const show = vi.fn();
        const applicationFocus = vi.fn();
        const isDestroyed = vi.fn(() => false);
        const isMinimized = vi.fn(() => false);
        const isVisible = vi.fn(() => true);

        const manager = createExternalOpenManager({
            application: { focus: applicationFocus },
            logger,
            noFocus: options.noFocus ?? false,
            logStartupPhase: vi.fn(),
            isMainWindowRendererReady: () => rendererReady,
            getMainWindow: () => ({
                isDestroyed,
                isMinimized,
                isVisible,
                restore,
                show,
                focus,
                webContents: {focus: webContentsFocus},
            }),
            hasWindows: () => hasWindows,
            createWindow,
            dispatchOpenPaths,
        });

        return {
            manager,
            applicationFocus,
            logger,
            dispatchOpenPaths,
            focus,
            isVisible,
            restore,
            show,
            setRendererReady(value: boolean) {
                rendererReady = value;
            },
        };
    }

    it('uses the shared foreground recovery path for external document activation', async () => {
        const harness = createManagerHarness();
        harness.isVisible.mockReturnValue(false);

        harness.manager.markBootstrapReady();
        harness.manager.requestMainWindowForExternalOpen();
        await vi.waitFor(() => expect(harness.focus).toHaveBeenCalledTimes(1));

        expect(harness.show).toHaveBeenCalledTimes(1);
        if (process.platform === 'darwin') {
            expect(harness.applicationFocus).toHaveBeenCalledWith({ steal: true });
        } else {
            expect(harness.applicationFocus).not.toHaveBeenCalled();
        }
    });

    it('keeps external activation inert in no-focus automation', async () => {
        const harness = createManagerHarness({ noFocus: true });
        harness.isVisible.mockReturnValue(false);

        harness.manager.markBootstrapReady();
        harness.manager.requestMainWindowForExternalOpen();
        await Promise.resolve();

        expect(harness.restore).not.toHaveBeenCalled();
        expect(harness.show).not.toHaveBeenCalled();
        expect(harness.focus).not.toHaveBeenCalled();
        expect(harness.applicationFocus).not.toHaveBeenCalled();
    });

    it('flushes newly queued paths immediately once bootstrap, window, and renderer are ready', () => {
        const harness = createManagerHarness();

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequest(['/Users/test/Documents/live.pdf']);

        expect(harness.dispatchOpenPaths).toHaveBeenCalledTimes(1);
        expect(harness.dispatchOpenPaths).toHaveBeenCalledWith(['/Users/test/Documents/live.pdf']);
    });

    it('keeps an existing trailing-whitespace filename through dispatch', () => {
        const harness = createManagerHarness();
        const exactPath = '/docs/report.pdf ';
        mocks.existsSync.mockImplementation(path => path === exactPath || path === exactPath.trim());

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequest([exactPath]);

        expect(harness.dispatchOpenPaths).toHaveBeenCalledWith([exactPath]);
    });

    it('resolves relative command-line paths before dispatch', () => {
        const harness = createManagerHarness();
        const relativePath = 'landing/public/evb-viewer-og.png';

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequestFromArgs([relativePath], process.cwd());

        expect(harness.dispatchOpenPaths).toHaveBeenCalledWith([resolve(relativePath)]);
    });

    it('resolves a second instance relative path against its own working directory', () => {
        const harness = createManagerHarness();
        const secondInstanceCwd = resolve('/work/folder-b');
        const expectedPath = resolve(secondInstanceCwd, 'report.pdf');
        mocks.existsSync.mockImplementation(path => path === expectedPath);

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequestFromArgs(['report.pdf'], secondInstanceCwd);

        expect(harness.dispatchOpenPaths).toHaveBeenCalledWith([expectedPath]);
    });

    it('keeps a relative trailing-whitespace filename in the second instance folder', () => {
        const harness = createManagerHarness();
        const secondInstanceCwd = resolve('/work/folder-b');
        const exactPath = resolve(secondInstanceCwd, 'report.pdf ');
        mocks.existsSync.mockImplementation(path => path === exactPath || path === exactPath.trim());

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequestFromArgs(['report.pdf '], secondInstanceCwd);

        expect(harness.dispatchOpenPaths).toHaveBeenCalledWith([exactPath]);
    });

    it('keeps an existing trailing-whitespace command-line filename through dispatch', () => {
        const harness = createManagerHarness();
        const exactPath = resolve('/docs/report.pdf ');
        mocks.existsSync.mockImplementation(path => path === exactPath || path === exactPath.trim());

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequestFromArgs([exactPath], process.cwd());

        expect(harness.dispatchOpenPaths).toHaveBeenCalledWith([exactPath]);
    });

    it('rejects a missing exact path instead of opening its trimmed sibling', () => {
        const harness = createManagerHarness();
        const sibling = resolve('/docs/missing-exact.pdf');
        mocks.existsSync.mockImplementation(path => path === sibling);

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequestFromArgs([`${sibling} `], process.cwd());

        expect(harness.dispatchOpenPaths).not.toHaveBeenCalled();
        expect(harness.logger.warn).toHaveBeenCalledWith(
            `Ignoring missing dispatch external open path: ${sibling} `,
        );
    });

    it('keeps literal quote characters in an already-tokenized filename', () => {
        const harness = createManagerHarness();
        const exactPath = resolve('/docs/"quoted.pdf"');
        const sibling = resolve('/docs/quoted.pdf');
        mocks.existsSync.mockImplementation(path => path === exactPath || path === sibling);

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequestFromArgs([exactPath], process.cwd());

        expect(harness.dispatchOpenPaths).toHaveBeenCalledWith([exactPath]);
    });

    it('does not join separate argv tokens into another existing filename', () => {
        const harness = createManagerHarness();
        const sibling = resolve('/docs/report final.pdf');
        mocks.existsSync.mockImplementation(path => path === sibling);

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequestFromArgs([
            'report',
            'final.pdf',
        ], resolve('/docs'));

        expect(harness.dispatchOpenPaths).not.toHaveBeenCalled();
    });

    it('decodes an explicit file URI exactly once at argv admission', () => {
        const harness = createManagerHarness();
        const exactPath = resolve('/docs/Отчёт%20 空.pdf ');
        mocks.existsSync.mockImplementation(path => path === exactPath);

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequestFromArgs([pathToFileURL(exactPath).href], process.cwd());

        expect(harness.dispatchOpenPaths).toHaveBeenCalledWith([exactPath]);
    });

    it('does not decode a plain percent-containing native path', () => {
        const harness = createManagerHarness();
        const exactPath = resolve('/docs/report%20name.pdf');
        mocks.existsSync.mockImplementation(path => path === exactPath);

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequestFromArgs([exactPath], process.cwd());

        expect(harness.dispatchOpenPaths).toHaveBeenCalledWith([exactPath]);
    });

    it('dispatches a timed-out claim after renderer ready without another arrival', async () => {
        vi.useFakeTimers();
        const harness = createManagerHarness({ isRendererReady: false });
        const tracker = createStartupExternalOpenClaimTracker({
            externalOpenManager: harness.manager,
            logger: harness.logger,
        });
        const sender = createTestEventSender(1) as never;
        const exactPath = '/docs/startup.pdf';
        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequest([exactPath]);
        tracker.track(sender, await harness.manager.claimPendingOpenPaths());
        harness.setRendererReady(true);
        harness.manager.scheduleFlushPendingFiles();

        await vi.advanceTimersByTimeAsync(30_100);

        expect(harness.dispatchOpenPaths).toHaveBeenCalledExactlyOnceWith([exactPath]);
    });

    it('does not acknowledge a deleted exact path as its remaining sibling', async () => {
        vi.useFakeTimers();
        const harness = createManagerHarness({ isRendererReady: false });
        const exactPath = '/docs/report.pdf ';
        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequest([exactPath]);
        await expect(harness.manager.claimPendingOpenPaths()).resolves.toEqual([exactPath]);
        mocks.existsSync.mockImplementation(path => path === exactPath.trim());

        harness.manager.acknowledgeClaimedOpenPaths([exactPath]);
        harness.setRendererReady(true);
        harness.manager.scheduleFlushPendingFiles();
        await vi.advanceTimersByTimeAsync(1000);

        expect(harness.dispatchOpenPaths).not.toHaveBeenCalled();
    });

    it('dispatches a later singleton after 100 ms', async () => {
        vi.useFakeTimers();
        const harness = createManagerHarness();

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequest(['/docs/first.pdf']);
        harness.manager.queueOpenRequest(['/docs/second.pdf']);

        await vi.advanceTimersByTimeAsync(99);
        expect(harness.dispatchOpenPaths).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);

        expect(harness.dispatchOpenPaths).toHaveBeenCalledTimes(2);
        expect(harness.dispatchOpenPaths).toHaveBeenNthCalledWith(2, ['/docs/second.pdf']);
    });

    it('escalates a singleton when a distinct path arrives at 99 ms', async () => {
        vi.useFakeTimers();
        const harness = createManagerHarness();

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequest(['/docs/initial.pdf']);
        harness.manager.queueOpenRequest(['/docs/one.pdf']);

        await vi.advanceTimersByTimeAsync(99);
        harness.manager.queueOpenRequest(['/docs/two.pdf']);
        await vi.advanceTimersByTimeAsync(799);

        expect(harness.dispatchOpenPaths).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);

        expect(harness.dispatchOpenPaths).toHaveBeenCalledTimes(2);
        expect(harness.dispatchOpenPaths).toHaveBeenNthCalledWith(2, [
            '/docs/one.pdf',
            '/docs/two.pdf',
        ]);
    });

    it('does not re-arm the singleton phase for a duplicate path', async () => {
        vi.useFakeTimers();
        const harness = createManagerHarness();

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequest(['/docs/initial.pdf']);
        harness.manager.queueOpenRequest(['/docs/repeated.pdf']);

        await vi.advanceTimersByTimeAsync(99);
        harness.manager.queueOpenRequest(['/docs/repeated.pdf']);
        await vi.advanceTimersByTimeAsync(1);

        expect(harness.dispatchOpenPaths).toHaveBeenCalledTimes(2);
        expect(harness.dispatchOpenPaths).toHaveBeenNthCalledWith(2, ['/docs/repeated.pdf']);
    });

    it('uses a trailing 800 ms phase for multi-path batches', async () => {
        vi.useFakeTimers();
        const harness = createManagerHarness();

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequest(['/docs/initial.pdf']);
        harness.manager.queueOpenRequest([
            '/docs/one.pdf',
            '/docs/two.pdf',
        ]);

        await vi.advanceTimersByTimeAsync(799);
        harness.manager.queueOpenRequest(['/docs/three.pdf']);
        await vi.advanceTimersByTimeAsync(799);

        expect(harness.dispatchOpenPaths).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);

        expect(harness.dispatchOpenPaths).toHaveBeenCalledTimes(2);
        expect(harness.dispatchOpenPaths).toHaveBeenNthCalledWith(2, [
            '/docs/one.pdf',
            '/docs/two.pdf',
            '/docs/three.pdf',
        ]);
    });

    it('caps a continuously extended multi-path batch at 10 seconds', async () => {
        vi.useFakeTimers();
        const harness = createManagerHarness();

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequest(['/docs/initial.pdf']);
        harness.manager.queueOpenRequest([
            '/docs/one.pdf',
            '/docs/two.pdf',
        ]);

        for (let index = 0; index < 12; index += 1) {
            await vi.advanceTimersByTimeAsync(799);
            harness.manager.queueOpenRequest([`/docs/extension-${index}.pdf`]);
        }
        await vi.advanceTimersByTimeAsync(411);

        expect(harness.dispatchOpenPaths).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);

        expect(harness.dispatchOpenPaths).toHaveBeenCalledTimes(2);
    });

    it('keeps queued paths until renderer readiness returns', () => {
        const harness = createManagerHarness({ isRendererReady: false });

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequest(['/docs/retry.pdf']);
        harness.manager.scheduleFlushPendingFiles();

        expect(harness.dispatchOpenPaths).not.toHaveBeenCalled();

        harness.setRendererReady(true);
        harness.manager.scheduleFlushPendingFiles();

        expect(harness.dispatchOpenPaths).toHaveBeenCalledTimes(1);
        expect(harness.dispatchOpenPaths).toHaveBeenCalledWith(['/docs/retry.pdf']);
    });

    it('lets the startup renderer claim queued paths before rendererReady dispatch', async () => {
        const harness = createManagerHarness({ isRendererReady: false });

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequest(['/docs/startup.pdf']);

        await expect(harness.manager.claimPendingOpenPaths()).resolves.toEqual(['/docs/startup.pdf']);

        harness.setRendererReady(true);
        harness.manager.scheduleFlushPendingFiles();

        expect(harness.dispatchOpenPaths).not.toHaveBeenCalled();
    });

    it('requeues failed startup claims for later renderer dispatch', async () => {
        vi.useFakeTimers();
        const harness = createManagerHarness({ isRendererReady: false });

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequest(['/docs/startup.pdf']);

        await expect(harness.manager.claimPendingOpenPaths()).resolves.toEqual(['/docs/startup.pdf']);

        harness.manager.acknowledgeClaimedOpenPaths(['/docs/startup.pdf']);
        harness.setRendererReady(true);
        harness.manager.scheduleFlushPendingFiles();
        await vi.advanceTimersByTimeAsync(800);

        expect(harness.dispatchOpenPaths).toHaveBeenCalledTimes(1);
        expect(harness.dispatchOpenPaths).toHaveBeenCalledWith(['/docs/startup.pdf']);
        expect(harness.logger.warn).toHaveBeenCalledWith('Requeued 1 failed startup external open path(s)');
    });

    it('redelivers a failed trailing-space startup path at once, not at the claim timeout', async () => {
        vi.useFakeTimers();
        const harness = createManagerHarness({ isRendererReady: false });
        const startupClaims = createStartupExternalOpenClaimTracker({
            externalOpenManager: harness.manager,
            logger: harness.logger,
        });
        const sender = createTestEventSender(1) as never;
        const exactPath = '/docs/report.pdf ';

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequest([exactPath]);
        startupClaims.track(sender, await harness.manager.claimPendingOpenPaths());

        startupClaims.acknowledge(sender, [exactPath]);
        harness.setRendererReady(true);
        harness.manager.scheduleFlushPendingFiles();
        await vi.advanceTimersByTimeAsync(800);

        expect(harness.dispatchOpenPaths).toHaveBeenCalledWith([exactPath]);
    });

    it('does not claim unsupported or missing startup paths for capability grants', async () => {
        const harness = createManagerHarness({ isRendererReady: false });
        mocks.existsSync.mockImplementation((path: string) => path === '/docs/startup.pdf');

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequest([
            '/docs/startup.pdf',
            '/docs/readme.txt',
            '/docs/missing.pdf',
        ]);

        await expect(harness.manager.claimPendingOpenPaths()).resolves.toEqual(['/docs/startup.pdf']);
        expect(harness.logger.warn).toHaveBeenCalledWith(
            'Ignoring unsupported startup claim external open path: /docs/readme.txt',
        );
        expect(harness.logger.warn).toHaveBeenCalledWith(
            'Ignoring missing startup claim external open path: /docs/missing.pdf',
        );
    });

    it('does not requeue failed startup acknowledgement paths that were removed or unsupported', async () => {
        vi.useFakeTimers();
        const harness = createManagerHarness({ isRendererReady: false });

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequest(['/docs/startup.pdf']);

        await expect(harness.manager.claimPendingOpenPaths()).resolves.toEqual(['/docs/startup.pdf']);

        mocks.existsSync.mockImplementation((path: string) => path !== '/docs/missing.pdf');
        harness.manager.acknowledgeClaimedOpenPaths([
            '/docs/missing.pdf',
            '/docs/readme.txt',
        ]);
        harness.setRendererReady(true);
        harness.manager.scheduleFlushPendingFiles();
        await vi.advanceTimersByTimeAsync(800);

        expect(harness.dispatchOpenPaths).not.toHaveBeenCalled();
    });

    it('briefly waits for a startup open-file event before returning an empty initial claim', async () => {
        vi.useFakeTimers();
        const harness = createManagerHarness({ isRendererReady: false });

        harness.manager.markBootstrapReady();
        const claimPromise = harness.manager.claimPendingOpenPaths();
        await vi.advanceTimersByTimeAsync(100);
        harness.manager.queueOpenRequest(['/docs/late-startup.pdf']);

        await expect(claimPromise).resolves.toEqual(['/docs/late-startup.pdf']);

        harness.setRendererReady(true);
        harness.manager.scheduleFlushPendingFiles();

        expect(harness.dispatchOpenPaths).not.toHaveBeenCalled();
    });

    it('retries a failed dispatch after 1 second without another batching delay', async () => {
        vi.useFakeTimers();
        const dispatchOpenPaths = vi
            .fn(() => true)
            .mockReturnValueOnce(true)
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(true);
        const harness = createManagerHarness({ dispatchOpenPaths });

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequest(['/docs/initial.pdf']);
        harness.manager.queueOpenRequest(['/docs/failure.pdf']);

        await vi.advanceTimersByTimeAsync(100);

        expect(dispatchOpenPaths).toHaveBeenCalledTimes(2);
        expect(dispatchOpenPaths).toHaveBeenNthCalledWith(2, ['/docs/failure.pdf']);

        await vi.advanceTimersByTimeAsync(999);
        expect(dispatchOpenPaths).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(1);

        expect(dispatchOpenPaths).toHaveBeenCalledTimes(3);
        expect(dispatchOpenPaths).toHaveBeenNthCalledWith(3, ['/docs/failure.pdf']);
        expect(harness.logger.warn).toHaveBeenCalledWith(
            'External open dispatch could not reach the renderer; keeping paths queued for retry',
        );
    });

    it('drops a batch once the retry budget is spent', async () => {
        vi.useFakeTimers();
        const dispatchOpenPaths = vi.fn(() => false);
        const harness = createManagerHarness({ dispatchOpenPaths });

        harness.manager.markBootstrapReady();
        harness.manager.queueOpenRequest(['/docs/undeliverable.pdf']);

        await vi.advanceTimersByTimeAsync(10_000);

        expect(dispatchOpenPaths).toHaveBeenCalledTimes(10);
        expect(harness.logger.warn).toHaveBeenCalledWith(
            'External open dispatch failed 10 times; dropping 1 queued path(s)',
        );

        await vi.advanceTimersByTimeAsync(10_000);

        expect(dispatchOpenPaths).toHaveBeenCalledTimes(10);
    });

    describe('second-instance hand-off', () => {
        type TSecondInstanceListener = (event: unknown, commandLine: string[], workingDirectory: string, additionalData: unknown) => void;

        function createSingleInstanceApp(lockGranted: boolean) {
            const lockRequests: unknown[] = [];
            const listeners: TSecondInstanceListener[] = [];
            return {
                app: {
                    on: (_event: 'second-instance', listener: TSecondInstanceListener) => {
                        listeners.push(listener);
                    },
                    quit: vi.fn(),
                    requestSingleInstanceLock: (additionalData?: unknown) => {
                        lockRequests.push(additionalData);
                        return lockGranted;
                    },
                },
                lockRequests,
                emitSecondInstance: (commandLine: string[], workingDirectory: string, additionalData: unknown) => {
                    for (const listener of listeners) {
                        listener({}, commandLine, workingDirectory, additionalData);
                    }
                },
            };
        }

        function launchOptions(
            app: ReturnType<typeof createSingleInstanceApp>['app'],
            externalOpenManager: ReturnType<typeof createManagerHarness>['manager'],
        ) {
            return {
                allowMultipleAutomationSessions: false,
                app,
                externalOpenManager,
                logger: createLogger(),
                onPrimaryInstanceReady: vi.fn(),
            };
        }

        // Electron's argv for a launch: the executable, the entry script, a switch, then the user's arguments.
        function appArgv(...userArguments: string[]) {
            return [
                '/opt/evb/evb-viewer',
                '/opt/evb/main.js',
                '--',
                ...userArguments,
            ];
        }

        // Boots a launch whose argv and working directory come from the process.
        function bootLaunch(argv: string[], cwd: string, options: ReturnType<typeof launchOptions>) {
            const originalArgv = process.argv;
            const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
            process.argv = argv;
            try {
                bootSingleInstance(options);
            } finally {
                process.argv = originalArgv;
                cwdSpy.mockRestore();
            }
        }

        // A launch whose lock request is refused exits right after sending it.
        function bootRefusedLaunch(argv: string[], cwd: string, options: ReturnType<typeof launchOptions>) {
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
                throw new Error('refused launch exits');
            });
            try {
                expect(() => bootLaunch(argv, cwd, options)).toThrow('refused launch exits');
            } finally {
                exitSpy.mockRestore();
            }
        }

        it('opens the trailing-space file a second launch named when the event argv has lost the space', () => {
            const harness = createManagerHarness();
            const primary = createSingleInstanceApp(true);
            const second = createSingleInstanceApp(false);
            const secondCwd = resolve('/work/folder-c');
            const exactPath = resolve(secondCwd, 'report.pdf ');
            mocks.existsSync.mockImplementation(path => path === exactPath);

            bootLaunch(appArgv(), resolve('/work/folder-a'), launchOptions(primary.app, harness.manager));
            bootRefusedLaunch(appArgv('report.pdf '), secondCwd, launchOptions(second.app, harness.manager));
            harness.manager.markBootstrapReady();
            // The event's argv arrives without the trailing space; the exact launch travels in the lock request.
            primary.emitSecondInstance(appArgv('report.pdf'), secondCwd, second.lockRequests[0]);

            expect(harness.dispatchOpenPaths).toHaveBeenCalledWith([exactPath]);
        });

        it.each([
            undefined,
            null,
        ])('opens a legacy sender event when the additional payload is absent: %j', (payload) => {
            const harness = createManagerHarness();
            const primary = createSingleInstanceApp(true);
            const secondCwd = resolve('/work/folder-b');
            const expectedPath = resolve(secondCwd, 'report.pdf');
            mocks.existsSync.mockImplementation(path => path === expectedPath);
            bootLaunch(appArgv(), resolve('/work/folder-a'), launchOptions(primary.app, harness.manager));
            harness.manager.markBootstrapReady();

            primary.emitSecondInstance(appArgv('report.pdf'), secondCwd, payload);

            expect(harness.dispatchOpenPaths).toHaveBeenCalledWith([expectedPath]);
        });

        it.each([
            {},
            {
                argv: [4],
                workingDirectory: '/work/folder-b',
            },
        ])(
            'rejects a malformed payload without falling back to event argv: %j',
            (payload) => {
                const harness = createManagerHarness();
                const primary = createSingleInstanceApp(true);
                bootLaunch(appArgv(), resolve('/work/folder-a'), launchOptions(primary.app, harness.manager));
                harness.manager.markBootstrapReady();

                primary.emitSecondInstance(appArgv('report.pdf'), resolve('/work/folder-b'), payload);

                expect(harness.dispatchOpenPaths).not.toHaveBeenCalled();
            },
        );

        it('opens a relative file name from the second launch folder, not the first', () => {
            const harness = createManagerHarness();
            const primary = createSingleInstanceApp(true);
            const second = createSingleInstanceApp(false);
            const secondCwd = resolve('/work/folder-b');
            const expectedPath = resolve(secondCwd, 'report.pdf');
            mocks.existsSync.mockImplementation(path => path === expectedPath);

            bootLaunch(appArgv(), resolve('/work/folder-a'), launchOptions(primary.app, harness.manager));
            bootRefusedLaunch(appArgv('report.pdf'), secondCwd, launchOptions(second.app, harness.manager));
            harness.manager.markBootstrapReady();
            primary.emitSecondInstance(appArgv('report.pdf'), secondCwd, second.lockRequests[0]);

            expect(harness.dispatchOpenPaths).toHaveBeenCalledWith([expectedPath]);
        });
    });
});
