import type { ILogger } from '@electron/utils/createLogger';
import { withTimeout } from 'es-toolkit/promise';
import { isTimeoutError } from '@contracts/isTimeoutError';
import { getErrorMessage } from '@electron/utils/error';
import {
    SHUTDOWN_CLEANUP_TIMEOUT_MS,
    SHUTDOWN_STEP_TIMEOUT_MS,
} from '@electron/bootstrap/shutdown';
import type { IShutdownContext } from '@electron/bootstrap/shutdown';

interface IShutdownStep {
    label: string;
    run: () => Promise<void> | void;
    timeoutMs?: number;
    onFailure?: () => void;
    /**
     * Runs after the cleanup deadline instead of competing for it. Only the log
     * flush qualifies: it is what makes every other step's timeout visible in
     * the next session, so a slow cleanup must not be the reason it is skipped.
     */
    runsAfterDeadline?: boolean;
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
        step.onFailure?.();
        logger.error(
            timeout
                ? `Shutdown step timed out (${step.label}, ${timeoutMs}ms)`
                : `Shutdown step failed (${step.label}): ${getErrorMessage(error)}`,
            {
                code: 'MAIN_SHUTDOWN_FAILED',
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
                    logger.error('Shutdown preservation was incomplete; retaining workspace recovery state', {code: 'MAIN_SHUTDOWN_FAILED'});
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
