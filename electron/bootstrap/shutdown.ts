import type { ILogger } from '@electron/utils/createLogger';
import { isTimeoutError } from '@contracts/isTimeoutError';
import { getErrorMessage } from '@electron/utils/error';

// Preservation is bounded by the timeout of each preservation step. The cleanup
// deadline starts only after preservation has settled, so it can never make an
// exit, update install, or recovery relaunch overtake renderer/checkpoint/write
// state.
export const SHUTDOWN_CLEANUP_TIMEOUT_MS = 20_000;
export const SHUTDOWN_STEP_TIMEOUT_MS = 8_000;
const GRACEFUL_QUIT_FORCE_EXIT_DELAY_MS = 3_000;
// This covers the 30.5s critical-write drain and the other bounded preservation steps.
const SHUTDOWN_PRESERVATION_TIMEOUT_MS = 90_000;
const FATAL_SHUTDOWN_FORCE_EXIT_DELAY_MS = SHUTDOWN_PRESERVATION_TIMEOUT_MS
    + SHUTDOWN_CLEANUP_TIMEOUT_MS
    + GRACEFUL_QUIT_FORCE_EXIT_DELAY_MS;
const SYSTEM_SHUTDOWN_TIMEOUT_MS = 4_500;

interface IAppLike {
    exit(code: number): void;
    quit(): void;
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
            options.logger.error(`Fatal shutdown exceeded deadline (${FATAL_SHUTDOWN_FORCE_EXIT_DELAY_MS}ms); forcing exit`, {code: 'MAIN_SHUTDOWN_FAILED'});
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
            options.logger.error(`Best-effort shutdown cleanup exceeded deadline (${SHUTDOWN_CLEANUP_TIMEOUT_MS + GRACEFUL_QUIT_FORCE_EXIT_DELAY_MS}ms); forcing exit`, {code: 'MAIN_SHUTDOWN_FAILED'});
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
                cause: error,
            });
        }

        if (context.retryablePreservationFailure === true && !isFatalShutdownInProgress) {
            isGracefulQuitRequested = false;
            options.logger.warn('Graceful quit was held for a retryable preservation failure');
        }

        if (armForceExit && context.retryablePreservationFailure !== true) {
            startBestEffortCleanupDeadline();
        }
        try {
            await options.runBestEffortCleanupSteps(context);
        } catch (error) {
            if (isTimeoutError(error)) {
                options.logger.error(`Best-effort shutdown cleanup timed out after ${SHUTDOWN_CLEANUP_TIMEOUT_MS}ms`, {
                    code: 'MAIN_SHUTDOWN_FAILED',
                    cause: error,
                });
                return;
            }
            options.logger.error(`Best-effort shutdown cleanup failed: ${getErrorMessage(error)}`, {
                code: 'MAIN_SHUTDOWN_FAILED',
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
        if (quitOptions?.afterCleanup && shutdownContext?.reason !== 'system-shutdown') {
            gracefulQuitAfterCleanup = quitOptions.afterCleanup;
        }
        if (shutdownPromise && shutdownContext?.retryablePreservationFailure === true) {
            const pendingShutdown = shutdownPromise;
            void pendingShutdown.then(() => {
                if (
                    shutdownPromise !== pendingShutdown
                    || isQuittingAfterCleanup
                    || isFatalShutdownInProgress
                ) {
                    return;
                }
                shutdownPromise = null;
                requestGracefulQuit(quitOptions);
            });
            return;
        }
        isGracefulQuitRequested = true;
        const cleanupPromise = shutdownPromise ?? startShutdown({
            preserveRecoveryState: shutdownContext?.reason === 'system-shutdown' || quitOptions?.preserveRecoveryState === true,
            reason: shutdownContext?.reason === 'system-shutdown' ? 'system-shutdown' : quitOptions?.reason ?? 'graceful',
        }, true);
        const cleanupContext = shutdownContext;

        void cleanupPromise.catch((error: unknown) => {
            options.logger.error(`Shutdown cleanup rejected unexpectedly: ${getErrorMessage(error)}`, {
                code: 'MAIN_SHUTDOWN_FAILED',
                cause: error,
            });
        }).then(async () => {
            clearGracefulQuitForceTimer();
            if (isQuittingAfterCleanup || isFatalShutdownInProgress) {
                return;
            }
            if (cleanupContext?.retryablePreservationFailure === true) {
                return;
            }
            clearSystemShutdownForceTimer();
            isQuittingAfterCleanup = true;
            const afterCleanup = gracefulQuitAfterCleanup;
            gracefulQuitAfterCleanup = null;
            if (afterCleanup) {
                try {
                    await afterCleanup();
                } catch (error) {
                    options.logger.error(`Graceful quit post-cleanup action failed: ${getErrorMessage(error)}`, {
                        code: 'MAIN_SHUTDOWN_FAILED',
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
            options.logger.error(reason, {code: 'MAIN_SHUTDOWN_FAILED'});
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
                    options.logger.error(`System shutdown preservation exceeded deadline (${SYSTEM_SHUTDOWN_TIMEOUT_MS}ms); forcing exit with recovery state retained`, {code: 'MAIN_SHUTDOWN_FAILED'});
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
