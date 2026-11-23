import type { TPdfClampedVisibleRefineMode } from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';

const QUALITY_REFINE_INPUT_IDLE_MS = 160;

export interface ICreatePdfRasterQualityRefineGateOptions {
    getClampedVisibleRefineMode: () => TPdfClampedVisibleRefineMode | undefined;
    /** The view write port's physical-interaction epoch. */
    getInteractionEpoch: () => number;
    /** Whether a viewport transaction is live; its end republishes the demand. */
    hasActiveTransaction: () => boolean;
    requestReconcileFrame: () => void;
}

export interface IPdfRasterQualityRefineGate {
    /**
     * Whether a clamped buffer-preview raster may be refined to full quality
     * now. Under the constrained policy the refine waits for the viewport to
     * stay quiet, so a scroll or zoom is never competing with a repaint.
     */
    canRefineVisibleRaster: () => boolean;
    clearIdleTimer: () => void;
    /**
     * Restarts the idle window whenever the viewport interaction epoch moves.
     * Called from the demand loop as well, so a burst of scrolling keeps
     * pushing the refine out instead of landing mid-gesture.
     */
    synchronizeViewportInteractionEpoch: () => void;
}

export function createPdfRasterQualityRefineGate(
    options: ICreatePdfRasterQualityRefineGateOptions,
): IPdfRasterQualityRefineGate {
    let idleTimer: number | null = null;
    let observedInteractionEpoch = options.getInteractionEpoch();
    let lastInteractionAtMs = Date.now();

    function clearIdleTimer() {
        if (idleTimer !== null) {
            window.clearTimeout(idleTimer);
            idleTimer = null;
        }
    }

    function synchronizeViewportInteractionEpoch() {
        const epoch = options.getInteractionEpoch();
        if (epoch !== observedInteractionEpoch) {
            observedInteractionEpoch = epoch;
            lastInteractionAtMs = Date.now();
            clearIdleTimer();
        }
    }

    return {
        canRefineVisibleRaster() {
            if ((options.getClampedVisibleRefineMode() ?? 'immediate') === 'immediate') {
                return true;
            }
            synchronizeViewportInteractionEpoch();
            const remainingIdleMs = QUALITY_REFINE_INPUT_IDLE_MS - (Date.now() - lastInteractionAtMs);
            const scheduling = typeof navigator === 'undefined'
                ? undefined
                : (navigator as Navigator & {scheduling?: {isInputPending?: () => boolean}}).scheduling;
            const isInputPending = typeof scheduling?.isInputPending === 'function' && scheduling.isInputPending();
            if (remainingIdleMs <= 0 && !isInputPending) {
                // A live viewport transaction holds the refine without a
                // timer: its end republishes the demand, which reconciles.
                return !options.hasActiveTransaction();
            }
            // While the idle window is still open, come back exactly when it
            // closes; pending input has no such deadline, so it waits a full
            // idle window before asking again.
            idleTimer ??= window.setTimeout(() => {
                idleTimer = null;
                options.requestReconcileFrame();
            }, remainingIdleMs > 0 ? remainingIdleMs : QUALITY_REFINE_INPUT_IDLE_MS);
            return false;
        },
        clearIdleTimer,
        synchronizeViewportInteractionEpoch,
    };
}
