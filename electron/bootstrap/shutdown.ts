import type { ILogger } from '@electron/utils/createLogger';
import { withTimeout } from 'es-toolkit/promise';
import { isTimeoutError } from '@contracts/isTimeoutError';
import { getErrorMessage } from '@electron/utils/error';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';

// Preservation is bounded by the timeout of each preservation step. The cleanup
// deadline starts only after preservation has settled, so it can never make an
// exit, update install, or recovery relaunch overtake renderer/checkpoint/write
// state.
const SHUTDOWN_CLEANUP_TIMEOUT_MS = parseIntegerEnv('EVB_SHUTDOWN_TIMEOUT_MS', 20_000, 3_000);
const SHUTDOWN_STEP_TIMEOUT_MS = parseIntegerEnv('EVB_SHUTDOWN_STEP_TIMEOUT_MS', 8_000, 1_000, SHUTDOWN_CLEANUP_TIMEOUT_MS);
const GRACEFUL_QUIT_FORCE_EXIT_DELAY_MS = parseIntegerEnv('EVB_GRACEFUL_QUIT_FORCE_EXIT_DELAY_MS', 3_000, 0);
// This covers the 30.5s critical-write drain and the other bounded preservation steps.
const SHUTDOWN_PRESERVATION_TIMEOUT_MS = 90_000;
const FATAL_SHUTDOWN_FORCE_EXIT_DELAY_MS = SHUTDOWN_PRESERVATION_TIMEOUT_MS
    + SHUTDOWN_CLEANUP_TIMEOUT_MS
    + GRACEFUL_QUIT_FORCE_EXIT_DELAY_MS;
const SYSTEM_SHUTDOWN_TIMEOUT_MS = parseIntegerEnv('EVB_SYSTEM_SHUTDOWN_TIMEOUT_MS', 4_500, 1_000, 15_000);

interface IAppLike {
    exit(code: number): void;
    quit(): void;
}

interface IShutdownStep {
    label: string;
    run: () => Promise<void> | void;
    timeoutMs?: number;
    /**
     * Runs after the cleanup deadline instead of competing for it. Only the log
     * flush qualifies: it is what makes every other step's timeout visible in
     * the next session, so a slow cleanup must not be the reason it is skipped.
     */
    runsAfterDeadline?: boolean;
}

export interface IShutdownContext {
    preserveRecoveryState: boolean;
    reason: 'fatal' | 'graceful' | 'recovery-relaunch' | 'system-shutdown';
    retryablePreservationFailure?: boolean;
}

interface ICreateShutdownCoordinatorOptions {
    app: IAppLike;
    logger: ILogger;
    runPreservationSteps: (context: IShutdownContext) => Promise<void>;
    runBestEffortCleanupSteps: (context: IShutdownContext) => Promise<void>;
}

interface IGracefulQuitOptions {
    afterCleanup?: () => void | Promise<void>;
    preserveRecoveryState?: boolean;
    reason?: 'graceful' | 'recovery-relaunch' | 'system-shutdown';
}

interface IShutdownPhaseOptions {
    createBestEffortCleanupSteps: (context: IShutdownContext) => IShutdownStep[];
    createPreservationSteps: (context: IShutdownContext) => IShutdownStep[];
}

interface IShutdownStepResult {failed: boolean;}

async function runStep(
    logger: ILogger,
    step: IShutdownStep,
    timeoutMs = step.timeoutMs ?? SHUTDOWN_STEP_TIMEOUT_MS,
): Promise<IShutdownStepResult> {
    const stepPromise = Promise.resolve().then(() => step.run());
    try {
        await withTimeout(() => stepPromise, timeoutMs);
        return {failed: false};
    } catch (error) {
        const timeout = isTimeoutError(error);
        logger.error(
            timeout
                ? `Shutdown step timed out (${step.label}, ${timeoutMs}ms)`
                : `Shutdown step failed (${step.label}): ${getErrorMessage(error)}`,
            {
                code: 'MAIN_SHUTDOWN_FAILED',
                context: {},
                cause: error,
            },
        );
        return {failed: true};
    } finally {
        // withTimeout cannot cancel the operation. Observe a late rejection so
        // a timed-out cleanup step cannot become an unhandled rejection.
        void stepPromise.catch(() => undefined);
    }
}

/**
 * Sharing a deadline is not enough on its own: letting each step take all the
 * time left would let one stalled step spend the whole budget and leave the
 * tail with nothing, which is the defect being fixed. The remaining time is
 * divided by the steps still to run, so every step keeps a turn, and a step
 * that finishes early hands its unused share to the ones after it.
 */
async function runBoundedSteps(logger: ILogger, steps: IShutdownStep[], deadlineAt?: number) {
    let failed = false;
    for (const [
        index,
        step,
    ] of steps.entries()) {
        const stepTimeoutMs = step.timeoutMs ?? SHUTDOWN_STEP_TIMEOUT_MS;
        const timeoutMs = deadlineAt === undefined
            ? stepTimeoutMs
            : Math.max(0, Math.min(
                stepTimeoutMs,
                Math.floor((deadlineAt - Date.now()) / (steps.length - index)),
            ));
        const result = await runStep(logger, step, timeoutMs);
        failed ||= result.failed;
    }
    return {failed};
}

/**
 * Defines the two production shutdown phases. Preservation is sequential and
 * bounded per step. Best-effort cleanup has a shared deadline for its ordinary
 * steps, but it cannot start until preservation has structurally completed. The
 * final log flush runs after that deadline so timeout diagnostics reach disk.
 */
export function createShutdownPhaseRunners(
    logger: ILogger,
    options: IShutdownPhaseOptions,
) {
    return {
        async runPreservationSteps(context: IShutdownContext) {
            const startedAt = Date.now();
            try {
                const result = await runBoundedSteps(
                    logger,
                    options.createPreservationSteps(context),
                );
                // If any preservation step itself failed, retain every recovery
                // artifact. A partial path list is not sufficient evidence that
                // it is safe to delete the remainder.
                if (result.failed) {
                    context.preserveRecoveryState = true;
                    logger.error('Shutdown preservation was incomplete; retaining workspace recovery state', {
                        code: 'MAIN_SHUTDOWN_FAILED',
                        context: {},
                    });
                }
            } finally {
                logger.info(
                    `Shutdown preservation settled (reason=${context.reason}, durationMs=${Date.now() - startedAt})`,
                );
            }
        },
        async runBestEffortCleanupSteps(context: IShutdownContext) {
            const steps = options.createBestEffortCleanupSteps(context);
            const deadlineAt = Date.now() + SHUTDOWN_CLEANUP_TIMEOUT_MS;

            try {
                await runBoundedSteps(logger, steps.filter(step => !step.runsAfterDeadline), deadlineAt);
            } finally {
                await runBoundedSteps(logger, steps.filter(step => step.runsAfterDeadline));
            }
        },
    };
}

export function createShutdownCoordinator(options: ICreateShutdownCoordinatorOptions) {
    let shutdownPromise: Promise<void> | null = null;
    let shutdownContext: IShutdownContext | null = null;
    let gracefulQuitForceTimer: NodeJS.Timeout | null = null;
    let gracefulQuitAfterCleanup: (() => void | Promise<void>) | null = null;
    let isGracefulQuitRequested = false;
    let isQuittingAfterCleanup = false;
    let isFatalShutdownInProgress = false;
    let fatalShutdownForceTimer: NodeJS.Timeout | null = null;
    let systemShutdownForceTimer: NodeJS.Timeout | null = null;

    function clearGracefulQuitForceTimer() {
        if (!gracefulQuitForceTimer) {
            return;
        }
        clearTimeout(gracefulQuitForceTimer);
        gracefulQuitForceTimer = null;
    }

    function clearSystemShutdownForceTimer() {
        if (!systemShutdownForceTimer) {
            return;
        }
        clearTimeout(systemShutdownForceTimer);
        systemShutdownForceTimer = null;
    }

    function clearFatalShutdownForceTimer() {
        if (!fatalShutdownForceTimer) {
            return;
        }
        clearTimeout(fatalShutdownForceTimer);
        fatalShutdownForceTimer = null;
    }

    function startFatalShutdownForceDeadline(exitCode: number) {
        if (fatalShutdownForceTimer) {
            return;
        }
        fatalShutdownForceTimer = setTimeout(() => {
            options.logger.error(`Fatal shutdown exceeded deadline (${FATAL_SHUTDOWN_FORCE_EXIT_DELAY_MS}ms); forcing exit`, {
                code: 'MAIN_SHUTDOWN_FAILED',
                context: {},
            });
            fatalShutdownForceTimer = null;
            isQuittingAfterCleanup = true;
            options.app.exit(exitCode);
        }, FATAL_SHUTDOWN_FORCE_EXIT_DELAY_MS);
        fatalShutdownForceTimer.unref();
    }

    function startBestEffortCleanupDeadline() {
        if (gracefulQuitForceTimer) {
            return;
        }
        gracefulQuitForceTimer = setTimeout(() => {
            options.logger.error(`Best-effort shutdown cleanup exceeded deadline (${SHUTDOWN_CLEANUP_TIMEOUT_MS + GRACEFUL_QUIT_FORCE_EXIT_DELAY_MS}ms); forcing exit`, {
                code: 'MAIN_SHUTDOWN_FAILED',
                context: {},
            });
            isQuittingAfterCleanup = true;
            options.app.exit(1);
        }, SHUTDOWN_CLEANUP_TIMEOUT_MS + GRACEFUL_QUIT_FORCE_EXIT_DELAY_MS);
        gracefulQuitForceTimer.unref();
    }

    async function performCleanup(context: IShutdownContext, armForceExit: boolean) {
        try {
            await options.runPreservationSteps(context);
        } catch (error) {
            context.preserveRecoveryState = true;
            options.logger.error(`Shutdown preservation failed; retaining workspace recovery state: ${getErrorMessage(error)}`, {
                code: 'MAIN_SHUTDOWN_FAILED',
                context: {},
                cause: error,
            });
        }

        if (context.retryablePreservationFailure === true && !isFatalShutdownInProgress) {
            isGracefulQuitRequested = false;
            shutdownPromise = null;
            shutdownContext = null;
            options.logger.warn('Graceful quit was held for a retryable preservation failure');
            return;
        }

        if (armForceExit) {
            startBestEffortCleanupDeadline();
        }
        try {
            await options.runBestEffortCleanupSteps(context);
        } catch (error) {
            if (isTimeoutError(error)) {
                options.logger.error(`Best-effort shutdown cleanup timed out after ${SHUTDOWN_CLEANUP_TIMEOUT_MS}ms`, {
                    code: 'MAIN_SHUTDOWN_FAILED',
                    context: {},
                    cause: error,
                });
                return;
            }
            options.logger.error(`Best-effort shutdown cleanup failed: ${getErrorMessage(error)}`, {
                code: 'MAIN_SHUTDOWN_FAILED',
                context: {},
                cause: error,
            });
        }
    }

    function startShutdown(context: IShutdownContext, armForceExit: boolean) {
        shutdownContext = context;
        shutdownPromise = performCleanup(context, armForceExit);
        return shutdownPromise;
    }

    function requestGracefulQuit(quitOptions?: IGracefulQuitOptions) {
        if (isQuittingAfterCleanup || isFatalShutdownInProgress) {
            return;
        }
        if (quitOptions?.afterCleanup) {
            gracefulQuitAfterCleanup = quitOptions.afterCleanup;
        }
        isGracefulQuitRequested = true;
        const cleanupPromise = shutdownPromise ?? startShutdown({
            preserveRecoveryState: quitOptions?.preserveRecoveryState === true,
            reason: quitOptions?.reason ?? 'graceful',
        }, true);
        const cleanupContext = shutdownContext;

        void cleanupPromise.catch((error: unknown) => {
            options.logger.error(`Shutdown cleanup rejected unexpectedly: ${getErrorMessage(error)}`, {
                code: 'MAIN_SHUTDOWN_FAILED',
                context: {},
                cause: error,
            });
        }).then(async () => {
            clearGracefulQuitForceTimer();
            clearSystemShutdownForceTimer();
            if (isQuittingAfterCleanup || isFatalShutdownInProgress) {
                return;
            }
            if (cleanupContext?.retryablePreservationFailure === true) {
                return;
            }
            isQuittingAfterCleanup = true;
            const afterCleanup = gracefulQuitAfterCleanup;
            gracefulQuitAfterCleanup = null;
            if (afterCleanup) {
                try {
                    await afterCleanup();
                } catch (error) {
                    options.logger.error(`Graceful quit post-cleanup action failed: ${getErrorMessage(error)}`, {
                        code: 'MAIN_SHUTDOWN_FAILED',
                        context: {},
                        cause: error,
                    });
                    options.app.quit();
                }
                return;
            }
            options.app.quit();
        });
    }

    return {
        clearGracefulQuitForceTimer,
        isFatalShutdownInProgress: () => isFatalShutdownInProgress,
        isGracefulQuitInProgress: () => isGracefulQuitRequested && !isFatalShutdownInProgress,
        isQuittingAfterCleanup: () => isQuittingAfterCleanup,
        async performCleanup() {
            shutdownPromise ??= startShutdown({
                preserveRecoveryState: false,
                reason: 'graceful',
            }, false);
            await shutdownPromise;
        },
        requestFatalShutdown(reason: string, exitCode = 1) {
            if (isFatalShutdownInProgress) {
                return;
            }

            isFatalShutdownInProgress = true;
            options.logger.error(reason, {
                code: 'MAIN_SHUTDOWN_FAILED',
                context: {},
            });
            if (shutdownContext) {
                shutdownContext.preserveRecoveryState = true;
                shutdownContext.reason = 'fatal';
            }
            shutdownPromise ??= startShutdown({
                preserveRecoveryState: true,
                reason: 'fatal',
            }, false);
            void shutdownPromise.finally(() => {
                clearFatalShutdownForceTimer();
                clearSystemShutdownForceTimer();
                if (!isQuittingAfterCleanup) {
                    isQuittingAfterCleanup = true;
                    options.app.exit(exitCode);
                }
            });
            startFatalShutdownForceDeadline(exitCode);
        },
        requestGracefulQuit,
        requestSystemShutdown() {
            if (isQuittingAfterCleanup) {
                return;
            }
            // System shutdown supersedes update installation and recovery
            // relaunch callbacks; the current process must terminate cleanly.
            gracefulQuitAfterCleanup = null;
            if (shutdownContext) {
                shutdownContext.preserveRecoveryState = true;
                shutdownContext.reason = 'system-shutdown';
                if (!isFatalShutdownInProgress) {
                    requestGracefulQuit();
                }
            } else {
                requestGracefulQuit({
                    preserveRecoveryState: true,
                    reason: 'system-shutdown',
                });
            }
            if (!systemShutdownForceTimer) {
                systemShutdownForceTimer = setTimeout(() => {
                    options.logger.error(`System shutdown preservation exceeded deadline (${SYSTEM_SHUTDOWN_TIMEOUT_MS}ms); forcing exit with recovery state retained`, {
                        code: 'MAIN_SHUTDOWN_FAILED',
                        context: {},
                    });
                    clearGracefulQuitForceTimer();
                    systemShutdownForceTimer = null;
                    const exitCode = isFatalShutdownInProgress ? 1 : 0;
                    isQuittingAfterCleanup = true;
                    options.app.exit(exitCode);
                }, SYSTEM_SHUTDOWN_TIMEOUT_MS);
                systemShutdownForceTimer.unref();
            }
        },
    };
}
