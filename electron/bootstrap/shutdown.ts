import type { ILogger } from '@electron/utils/createLogger';
import { withTimeout } from 'es-toolkit/promise';
import { isTimeoutError } from '@contracts/isTimeoutError';
import { getErrorMessage } from '@electron/utils/error';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';

// Preservation is bounded by the timeout of each preservation step. The global
// cap applies only after preservation has settled, so it can never make an exit,
// update install, or recovery relaunch overtake renderer/checkpoint/write state.
const SHUTDOWN_CLEANUP_TIMEOUT_MS = parseIntegerEnv('EVB_SHUTDOWN_TIMEOUT_MS', 20_000, 3_000);
const SHUTDOWN_STEP_TIMEOUT_MS = parseIntegerEnv('EVB_SHUTDOWN_STEP_TIMEOUT_MS', 8_000, 1_000, SHUTDOWN_CLEANUP_TIMEOUT_MS);
const GRACEFUL_QUIT_FORCE_EXIT_DELAY_MS = parseIntegerEnv('EVB_GRACEFUL_QUIT_FORCE_EXIT_DELAY_MS', 3_000, 0);
const SYSTEM_SHUTDOWN_TIMEOUT_MS = parseIntegerEnv('EVB_SYSTEM_SHUTDOWN_TIMEOUT_MS', 4_500, 1_000, 15_000);

interface IAppLike {
    exit(code: number): void;
    quit(): void;
}

interface IShutdownStep {
    label: string;
    run: () => Promise<void> | void;
    timeoutMs?: number;
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
    afterCleanup?: () => void;
    preserveRecoveryState?: boolean;
    reason?: 'graceful' | 'recovery-relaunch' | 'system-shutdown';
}

interface IShutdownPhaseOptions {
    createBestEffortCleanupSteps: (context: IShutdownContext) => IShutdownStep[];
    createPreservationSteps: (context: IShutdownContext) => IShutdownStep[];
}

interface IShutdownStepResult {failed: boolean;}

async function runStep(logger: ILogger, step: IShutdownStep): Promise<IShutdownStepResult> {
    const timeoutMs = step.timeoutMs ?? SHUTDOWN_STEP_TIMEOUT_MS;
    try {
        await withTimeout(async () => {
            await step.run();
        }, timeoutMs);
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
    }
}

async function runBoundedSteps(logger: ILogger, steps: IShutdownStep[]) {
    let failed = false;
    for (const step of steps) {
        const result = await runStep(logger, step);
        failed ||= result.failed;
    }
    return {failed};
}

/**
 * Defines the two production shutdown phases. Preservation is sequential and
 * bounded per step. Best-effort cleanup has both per-step bounds and a global
 * cap, but it cannot start until preservation has structurally completed.
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
        runBestEffortCleanupSteps(context: IShutdownContext) {
            return withTimeout(async () => {
                await runBoundedSteps(
                    logger,
                    options.createBestEffortCleanupSteps(context),
                );
            }, SHUTDOWN_CLEANUP_TIMEOUT_MS);
        },
    };
}

export function createShutdownCoordinator(options: ICreateShutdownCoordinatorOptions) {
    let shutdownPromise: Promise<void> | null = null;
    let shutdownContext: IShutdownContext | null = null;
    let gracefulQuitForceTimer: NodeJS.Timeout | null = null;
    let gracefulQuitAfterCleanup: (() => void) | null = null;
    let isGracefulQuitRequested = false;
    let isQuittingAfterCleanup = false;
    let isFatalShutdownInProgress = false;
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
        }).then(() => {
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
                    afterCleanup();
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
                clearSystemShutdownForceTimer();
                options.app.exit(exitCode);
            });
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
