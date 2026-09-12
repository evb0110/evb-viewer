import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createShutdownCoordinator,
    createShutdownPhaseRunners,
} from '@electron/bootstrap/shutdown';
import type { IShutdownContext } from '@electron/bootstrap/shutdown';
import {
    drainCriticalMainOperations,
    registerMainOperation,
    resetMainOperationLifecycleForTests,
} from '@electron/operation-lifecycle/mainOperationLifecycle';

function createDeferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return {
        promise,
        reject,
        resolve,
    };
}

function createLogger() {
    return {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    };
}

function createCoordinator(overrides: {
    runBestEffortCleanupSteps?: (context: IShutdownContext) => Promise<void>;
    runPreservationSteps?: (context: IShutdownContext) => Promise<void>;
} = {}) {
    const app = {
        exit: vi.fn(),
        quit: vi.fn(),
    };
    const logger = createLogger();
    const coordinator = createShutdownCoordinator({
        app,
        logger,
        runBestEffortCleanupSteps: overrides.runBestEffortCleanupSteps ?? vi.fn(async () => {}),
        runPreservationSteps: overrides.runPreservationSteps ?? vi.fn(async () => {}),
    });
    return {
        app,
        coordinator,
        logger,
    };
}

describe('shutdown coordinator', () => {
    afterEach(() => {
        resetMainOperationLifecycleForTests();
        vi.useRealTimers();
    });

    it('registers direct cleanup as the shared shutdown so fatal requests upgrade it', async () => {
        const preservation = createDeferred();
        let observedContext: IShutdownContext | null = null;
        const fixture = createCoordinator({runPreservationSteps: (context) => {
            observedContext = context;
            return preservation.promise;
        }});

        const cleanup = fixture.coordinator.performCleanup();
        await vi.waitFor(() => {
            expect(observedContext).not.toBeNull();
        });
        fixture.coordinator.requestFatalShutdown('fatal during direct cleanup', 7);

        expect(observedContext).toMatchObject({
            preserveRecoveryState: true,
            reason: 'fatal',
        });
        preservation.resolve();
        await cleanup;
        await vi.waitFor(() => {
            expect(fixture.app.exit).toHaveBeenCalledWith(7);
        });
    });

    it('does not report cleanup-only work as graceful quit intent', async () => {
        const preservation = createDeferred();
        const fixture = createCoordinator({runPreservationSteps: () => preservation.promise});

        const cleanup = fixture.coordinator.performCleanup();
        expect(fixture.coordinator.isGracefulQuitInProgress()).toBe(false);

        preservation.resolve();
        await cleanup;
        expect(fixture.coordinator.isGracefulQuitInProgress()).toBe(false);
        expect(fixture.app.quit).not.toHaveBeenCalled();
    });

    it('structurally finishes preservation before starting globally bounded cleanup', async () => {
        vi.useFakeTimers();
        const preservation = createDeferred();
        const cleanup = vi.fn(async () => {});
        const fixture = createCoordinator({
            runBestEffortCleanupSteps: cleanup,
            runPreservationSteps: () => preservation.promise,
        });

        fixture.coordinator.requestGracefulQuit();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(cleanup).not.toHaveBeenCalled();
        expect(fixture.app.exit).not.toHaveBeenCalled();
        expect(fixture.app.quit).not.toHaveBeenCalled();

        preservation.resolve();
        await vi.runAllTimersAsync();

        expect(cleanup).toHaveBeenCalledOnce();
        expect(fixture.app.quit).toHaveBeenCalledOnce();
        expect(fixture.app.exit).not.toHaveBeenCalled();
    });

    it('bounds OS-initiated shutdown while retaining recovery state', async () => {
        vi.useFakeTimers();
        const preservation = createDeferred();
        let observedContext: IShutdownContext | null = null;
        const fixture = createCoordinator({runPreservationSteps: (context) => {
            observedContext = context;
            return preservation.promise;
        }});

        const shutdownStartedAt = Date.now();
        fixture.coordinator.requestSystemShutdown();
        await vi.waitFor(() => {
            expect(observedContext).toMatchObject({
                preserveRecoveryState: true,
                reason: 'system-shutdown',
            });
        });
        const elapsedDuringWait = Date.now() - shutdownStartedAt;
        await vi.advanceTimersByTimeAsync(Math.max(0, 4_499 - elapsedDuringWait));
        expect(fixture.app.exit).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(fixture.app.exit).toHaveBeenCalledWith(0);
        expect(fixture.app.quit).not.toHaveBeenCalled();

        preservation.resolve();
        await Promise.resolve();
    });

    it('lets system shutdown supersede a pending post-cleanup action', async () => {
        const preservation = createDeferred();
        const afterCleanup = vi.fn();
        const fixture = createCoordinator({runPreservationSteps: () => preservation.promise});

        fixture.coordinator.requestGracefulQuit({afterCleanup});
        fixture.coordinator.requestSystemShutdown();
        preservation.resolve();

        await vi.waitFor(() => {
            expect(fixture.app.quit).toHaveBeenCalledOnce();
        });
        expect(afterCleanup).not.toHaveBeenCalled();
        expect(fixture.app.exit).not.toHaveBeenCalled();
    });

    it('allows a committed critical operation to finish after the former 20s deadline', async () => {
        vi.useFakeTimers();
        const logger = createLogger();
        const criticalWrite = vi.fn(() => new Promise<void>((resolve) => {
            setTimeout(resolve, 25_000);
        }));
        const phases = createShutdownPhaseRunners(logger, {
            createBestEffortCleanupSteps: () => [],
            createPreservationSteps: () => [{
                label: 'critical-write',
                timeoutMs: 30_000,
                run: criticalWrite,
            }],
        });
        const context = {
            preserveRecoveryState: false,
            reason: 'graceful' as const,
        };
        let settled = false;
        const shutdown = phases.runPreservationSteps(context).finally(() => {
            settled = true;
        });

        await vi.advanceTimersByTimeAsync(20_000);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(5_000);
        await shutdown;

        expect(criticalWrite).toHaveBeenCalledOnce();
        expect(context.preserveRecoveryState).toBe(false);
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('gives tail cleanup steps their remaining turn and flushes logs after the cleanup deadline', async () => {
        vi.useFakeTimers();
        const logger = createLogger();
        const started: string[] = [];
        const phases = createShutdownPhaseRunners(logger, {
            createPreservationSteps: () => [],
            createBestEffortCleanupSteps: () => [
                {
                    label: 'slow-first-step',
                    timeoutMs: 15_000,
                    run: () => {
                        started.push('slow-first-step');
                        return new Promise<void>(() => undefined);
                    },
                },
                {
                    label: 'slow-second-step',
                    timeoutMs: 10_000,
                    run: () => {
                        started.push('slow-second-step');
                        return new Promise<void>(() => undefined);
                    },
                },
                {
                    label: 'working-copies',
                    run: () => {
                        started.push('working-copies');
                    },
                },
                {
                    label: 'log-flush',
                    runsAfterDeadline: true,
                    timeoutMs: 2_000,
                    run: () => {
                        started.push('log-flush');
                    },
                },
            ],
        });

        const cleanup = phases.runBestEffortCleanupSteps({
            preserveRecoveryState: false,
            reason: 'graceful',
        });

        await vi.advanceTimersByTimeAsync(20_000);
        await vi.runOnlyPendingTimersAsync();
        await cleanup;

        expect(started).toEqual([
            'slow-first-step',
            'slow-second-step',
            'working-copies',
            'log-flush',
        ]);
        expect(logger.error).toHaveBeenNthCalledWith(
            1,
            'Shutdown step timed out (slow-first-step, 6666ms)',
            expect.objectContaining({code: 'MAIN_SHUTDOWN_FAILED'}),
        );
        expect(logger.error).toHaveBeenNthCalledWith(
            2,
            'Shutdown step timed out (slow-second-step, 6667ms)',
            expect.objectContaining({code: 'MAIN_SHUTDOWN_FAILED'}),
        );
    });

    it('retains all recovery state when a preservation step fails', async () => {
        const logger = createLogger();
        const clearCheckpoint = vi.fn();
        const clearWorkingCopies = vi.fn();
        const failure = new Error('renderer unavailable');
        const phases = createShutdownPhaseRunners(logger, {
            createPreservationSteps: () => [{
                label: 'renderer-save-flush',
                run: () => {
                    throw failure;
                },
            }],
            createBestEffortCleanupSteps: context => [
                {
                    label: 'workspace-checkpoint',
                    run: () => context.preserveRecoveryState ? undefined : clearCheckpoint(),
                },
                {
                    label: 'working-copies',
                    run: () => context.preserveRecoveryState ? undefined : clearWorkingCopies(),
                },
            ],
        });
        const context = {
            preserveRecoveryState: false,
            reason: 'graceful' as const,
        };

        await phases.runPreservationSteps(context);
        await phases.runBestEffortCleanupSteps(context);

        expect(context.preserveRecoveryState).toBe(true);
        expect(clearCheckpoint).not.toHaveBeenCalled();
        expect(clearWorkingCopies).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledTimes(2);
        expect(logger.error).toHaveBeenNthCalledWith(
            1,
            'Shutdown step failed (renderer-save-flush): renderer unavailable',
            {
                code: 'MAIN_SHUTDOWN_FAILED',
                context: {},
                cause: failure,
            },
        );
        expect(logger.error).toHaveBeenNthCalledWith(
            2,
            'Shutdown preservation was incomplete; retaining workspace recovery state',
            {
                code: 'MAIN_SHUTDOWN_FAILED',
                context: {},
            },
        );
    });

    it('holds graceful quit for a retryable preservation failure', async () => {
        let attempt = 0;
        const cleanup = vi.fn(async () => {});
        const fixture = createCoordinator({
            runBestEffortCleanupSteps: cleanup,
            runPreservationSteps: async context => {
                attempt += 1;
                if (attempt === 1) {
                    context.retryablePreservationFailure = true;
                }
            },
        });

        fixture.coordinator.requestGracefulQuit();
        await vi.waitFor(() => {
            expect(fixture.coordinator.isGracefulQuitInProgress()).toBe(false);
        });
        expect(fixture.app.quit).not.toHaveBeenCalled();
        expect(cleanup).not.toHaveBeenCalled();

        fixture.coordinator.requestGracefulQuit();
        await vi.waitFor(() => {
            expect(fixture.app.quit).toHaveBeenCalledOnce();
        });
        expect(cleanup).toHaveBeenCalledOnce();
        expect(fixture.app.exit).not.toHaveBeenCalled();
    });

    it('records pending critical paths before ordinary cleanup may delete working copies', async () => {
        vi.useFakeTimers();
        const skipPaths = new Set<string>();
        const clearWorkingCopies = vi.fn((_paths: Set<string>) => {});
        const logger = createLogger();
        const operation = registerMainOperation({
            kind: 'critical-write',
            workingCopyPath: '/tmp/pending-write.pdf',
        });
        operation.markCommitStarted();
        const phases = createShutdownPhaseRunners(logger, {
            createPreservationSteps: () => [{
                label: 'main-critical-writes',
                timeoutMs: 30_500,
                run: async () => {
                    const result = await drainCriticalMainOperations({timeoutMs: 30_000});
                    for (const pending of result.pending) {
                        if (pending.workingCopyPath) {
                            skipPaths.add(pending.workingCopyPath);
                        }
                    }
                },
            }],
            createBestEffortCleanupSteps: () => [{
                label: 'working-copies',
                run: () => clearWorkingCopies(skipPaths),
            }],
        });
        const fixture = createCoordinator({
            runBestEffortCleanupSteps: phases.runBestEffortCleanupSteps,
            runPreservationSteps: phases.runPreservationSteps,
        });

        fixture.coordinator.requestGracefulQuit();
        await vi.advanceTimersByTimeAsync(29_999);
        expect(fixture.app.quit).not.toHaveBeenCalled();
        expect(clearWorkingCopies).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        await vi.waitFor(() => {
            expect(clearWorkingCopies).toHaveBeenCalledOnce();
            expect(fixture.app.quit).toHaveBeenCalledOnce();
        });
        expect(clearWorkingCopies).toHaveBeenCalledWith(new Set(['/tmp/pending-write.pdf']));
        expect(fixture.app.exit).not.toHaveBeenCalled();
    });

    it('quits once after ordinary graceful cleanup completes', async () => {
        const fixture = createCoordinator();

        fixture.coordinator.requestGracefulQuit();
        fixture.coordinator.requestGracefulQuit();

        await vi.waitFor(() => {
            expect(fixture.app.quit).toHaveBeenCalledOnce();
        });
        expect(fixture.app.exit).not.toHaveBeenCalled();
    });

    it('runs update installation only after both shutdown phases complete', async () => {
        const preservation = createDeferred();
        const cleanup = createDeferred();
        const fixture = createCoordinator({
            runBestEffortCleanupSteps: () => cleanup.promise,
            runPreservationSteps: () => preservation.promise,
        });
        const install = vi.fn();

        fixture.coordinator.requestGracefulQuit({afterCleanup: install});
        await Promise.resolve();
        expect(install).not.toHaveBeenCalled();

        preservation.resolve();
        await vi.waitFor(() => {
            expect(fixture.coordinator.isGracefulQuitInProgress()).toBe(true);
        });
        expect(install).not.toHaveBeenCalled();

        cleanup.resolve();
        await vi.waitFor(() => {
            expect(install).toHaveBeenCalledOnce();
        });
        expect(fixture.app.quit).not.toHaveBeenCalled();
        expect(fixture.app.exit).not.toHaveBeenCalled();
    });

    it('upgrades an in-progress graceful shutdown to preserve recovery state after a fatal error', async () => {
        const preservation = createDeferred();
        let observedContext: {preserveRecoveryState: boolean} | undefined;
        const fixture = createCoordinator({runPreservationSteps: async (context) => {
            observedContext = context;
            await preservation.promise;
        }});

        fixture.coordinator.requestGracefulQuit();
        await vi.waitFor(() => {
            expect(observedContext?.preserveRecoveryState).toBe(false);
        });

        fixture.coordinator.requestFatalShutdown('fatal');
        expect(observedContext?.preserveRecoveryState).toBe(true);
        preservation.resolve();

        await vi.waitFor(() => {
            expect(fixture.app.exit).toHaveBeenCalledWith(1);
        });
        expect(fixture.app.quit).not.toHaveBeenCalled();
    });
});
