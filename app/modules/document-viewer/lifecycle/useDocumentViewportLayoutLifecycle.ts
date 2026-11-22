import type { Ref } from 'vue';
import type {
    IDocumentZoomAnchor,
    IDocumentZoomPageLayout,
} from '@app/modules/document-viewer/zoomAnchor';
import {
    captureDocumentZoomAnchor,
    resolveDocumentZoomAnchorScroll,
    resolveRetainedDocumentZoomAnchor,
} from '@app/modules/document-viewer/zoomAnchor';
import { DOCUMENT_WHEEL_ZOOM_GESTURE_GRACE_MS } from '@app/modules/document-viewer/input/documentWheelInteraction';

interface IUseDocumentViewportLayoutLifecycleOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pageLayouts: Ref<readonly IDocumentZoomPageLayout[]>;
    capturePageIndex?: () => number | null;
    readViewport?: (container: HTMLElement) => Parameters<typeof resolveRetainedDocumentZoomAnchor>[0];
    captureRestoreEpoch: () => unknown;
    canRestore: (epoch: unknown) => boolean;
    applyRestoredScroll: (restored: {
        left: number;
        top: number;
    }) => boolean;
    isResizing?: Ref<boolean>;
    onResizeSettled?: () => void;
}

/**
 * Keeps a semantic page position stable while physical page geometry changes.
 *
 * A raw scroll offset is not document state: zoom, viewport resize, and
 * progressive page-metric discovery can all move the same page to a different
 * offset. This lifecycle owns that translation for every document renderer.
 */
export const useDocumentViewportLayoutLifecycle = (
    options: IUseDocumentViewportLayoutLifecycleOptions,
) => {
    // The reader's point. Authored writes move it, and a queued restore places
    // the point current when it fires: a navigation that lands first wins.
    let readingPoint: IDocumentZoomAnchor | null = null;
    let activePointerAnchor: IDocumentZoomAnchor | null = null;
    let activeLayoutTransaction: number | null = null;
    let nextLayoutTransaction = 0;
    let pendingRestore: {
        epoch: unknown;
        generation: number;
        pointerAnchor: IDocumentZoomAnchor | null;
    } | null = null;
    let restoreGeneration = 0;
    let restoreScheduled = false;
    let disposed = false;
    let pointerAnchorReleaseTimer: ReturnType<typeof setTimeout> | null = null;
    let lastPointerAnchorPacketAt = 0;
    const isResizeTransitionActive = ref(false);

    const captureAnchor = (
        container: HTMLElement,
        layouts: readonly IDocumentZoomPageLayout[],
        point?: {
            x: number;
            y: number
        },
    ) => captureDocumentZoomAnchor(
        options.readViewport?.(container) ?? container,
        layouts,
        point,
        options.capturePageIndex?.(),
    );

    const captureCurrentAnchor = () => {
        const container = options.viewerContainer.value;
        return container
            ? captureAnchor(container, options.pageLayouts.value)
            : null;
    };

    const applyAnchor = (
        anchor: IDocumentZoomAnchor | null,
        epoch: unknown,
        layouts = options.pageLayouts.value,
        generation = restoreGeneration,
    ) => {
        const container = options.viewerContainer.value;
        if (
            generation !== restoreGeneration
            || !container
            || !options.canRestore(epoch)
        ) {
            return false;
        }
        const restored = resolveDocumentZoomAnchorScroll(options.readViewport?.(container) ?? container, layouts, anchor);
        if (!restored) {
            return false;
        }
        return options.applyRestoredScroll(restored);
    };

    const releasePointerAnchor = () => {
        activePointerAnchor = null;
        lastPointerAnchorPacketAt = 0;
        if (pointerAnchorReleaseTimer !== null) clearTimeout(pointerAnchorReleaseTimer);
        pointerAnchorReleaseTimer = null;
    };

    const readQueuedRestore = (epoch: unknown) => (
        activePointerAnchor === null
        && pendingRestore?.generation === restoreGeneration
        && pendingRestore.epoch === epoch
            ? pendingRestore
            : null
    );

    const readRestoreAnchor = () => activePointerAnchor ?? pendingRestore?.pointerAnchor ?? readingPoint;

    /** A queued restore keeps the reading point it was queued for until an authored write moves it. */
    const scheduleAnchorRestore = (
        anchor: IDocumentZoomAnchor | null,
        epoch: unknown,
    ) => {
        const queued = readQueuedRestore(epoch);
        if (!queued && activePointerAnchor === null) readingPoint = anchor ?? readingPoint;
        pendingRestore = {
            epoch,
            generation: restoreGeneration,
            pointerAnchor: activePointerAnchor ?? queued?.pointerAnchor ?? null,
        };
        if (restoreScheduled) {
            return;
        }
        restoreScheduled = true;
        void nextTick(() => {
            requestAnimationFrame(() => {
                restoreScheduled = false;
                const pending = pendingRestore;
                pendingRestore = null;
                if (disposed) {
                    return;
                }
                if (pending?.generation === restoreGeneration) {
                    applyAnchor(activePointerAnchor ?? pending.pointerAnchor ?? readingPoint, pending.epoch);
                }
                if (isResizeTransitionActive.value && !options.isResizing?.value) {
                    isResizeTransitionActive.value = false;
                    options.onResizeSettled?.();
                }
            });
        });
    };

    const cancelPendingRestore = () => {
        releasePointerAnchor();
        activeLayoutTransaction = null;
        if (isResizeTransitionActive.value) {
            // A pane deactivation or pointerdown during a workspace layout
            // transition does not move the viewport. The resize anchor must
            // survive it: a split moves the pane in the DOM, which resets
            // scrollTop to 0, and recapturing from that origin restores page 1.
            if (pendingRestore?.pointerAnchor) {
                pendingRestore = null;
            }
            return;
        }
        restoreGeneration += 1;
        pendingRestore = null;
        readingPoint = null;
    };

    const capturePointerAnchor = (point: {
        clientX: number;
        clientY: number;
    }, packetAt = performance.now(), forceNewGesture = false) => {
        const container = options.viewerContainer.value;
        if (!container) {
            activePointerAnchor = null;
            return;
        }
        const startsNewGesture = forceNewGesture
            || !activePointerAnchor
            || packetAt < lastPointerAnchorPacketAt
            || packetAt - lastPointerAnchorPacketAt >= DOCUMENT_WHEEL_ZOOM_GESTURE_GRACE_MS;
        if (startsNewGesture) {
            const rect = container.getBoundingClientRect();
            activePointerAnchor = captureAnchor(container, options.pageLayouts.value, {
                x: point.clientX - rect.left,
                y: point.clientY - rect.top,
            });
            if (activeLayoutTransaction !== null) {
                readingPoint = activePointerAnchor;
            }
        }
        lastPointerAnchorPacketAt = packetAt;
        if (pointerAnchorReleaseTimer !== null) clearTimeout(pointerAnchorReleaseTimer);
        pointerAnchorReleaseTimer = setTimeout(() => {
            releasePointerAnchor();
        }, DOCUMENT_WHEEL_ZOOM_GESTURE_GRACE_MS);
    };

    /**
     * Mutate layout inputs without exposing the viewport to an intermediate
     * raw-offset state. A post-paint replay accounts for DOM scroll clamping.
     */
    const preserveLayoutMutation = (mutate: () => void) => {
        const container = options.viewerContainer.value;
        const epoch = options.captureRestoreEpoch();
        const queued = readQueuedRestore(epoch);
        const anchor = activePointerAnchor ?? queued?.pointerAnchor ?? (
            queued || activeLayoutTransaction !== null ? readingPoint : null
        ) ?? (container ? captureAnchor(container, options.pageLayouts.value) : null);
        mutate();
        scheduleAnchorRestore(anchor, epoch);
        applyAnchor(readRestoreAnchor(), epoch);
    };

    /** Place a recorded reading point now and after paint, in place of any queued one. */
    const placeAnchor = (anchor: IDocumentZoomAnchor | null) => {
        const epoch = options.captureRestoreEpoch();
        pendingRestore = null;
        readingPoint = anchor ?? readingPoint;
        applyAnchor(anchor, epoch);
        scheduleAnchorRestore(anchor, epoch);
    };

    const beginLayoutTransaction = () => {
        activeLayoutTransaction = ++nextLayoutTransaction;
        readingPoint = captureCurrentAnchor();
        return activeLayoutTransaction;
    };

    const refreshLayoutTransactionAnchor = () => {
        // A restore that may write owns the point, so its clamped write's echo
        // cannot move it. A navigation closes that gate, and its write does.
        if (pendingRestore?.generation === restoreGeneration && options.canRestore(pendingRestore.epoch)) return;
        readingPoint = captureCurrentAnchor();
    };

    const endLayoutTransaction = async (
        transaction = activeLayoutTransaction,
        restore = true,
    ) => {
        if (transaction === null || activeLayoutTransaction !== transaction) {
            return;
        }
        activeLayoutTransaction = null;
        if (!restore) {
            return;
        }
        const epoch = options.captureRestoreEpoch();
        const generation = restoreGeneration;
        await nextTick();
        applyAnchor(readRestoreAnchor(), epoch, options.pageLayouts.value, generation);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (applyAnchor(readRestoreAnchor(), epoch, options.pageLayouts.value, generation)) {
            readingPoint = captureCurrentAnchor();
        }
    };

    if (options.isResizing) {
        watch(options.isResizing, (resizing, wasResizing) => {
            const container = options.viewerContainer.value;
            if (resizing) {
                isResizeTransitionActive.value = true;
                readingPoint = container
                    ? resolveRetainedDocumentZoomAnchor(
                        options.readViewport?.(container) ?? container,
                        options.pageLayouts.value,
                        readingPoint,
                        1,
                        options.capturePageIndex?.(),
                    )
                    : null;
                return;
            }
            if (!wasResizing) {
                return;
            }
            // Settle even when the final size did not change pageLayouts.
            // The restore frame releases the render guard before repainting.
            scheduleAnchorRestore(readingPoint, options.captureRestoreEpoch());
        }, {flush: 'sync'});
    }

    watch(options.pageLayouts, (layouts, previousLayouts) => {
        const container = options.viewerContainer.value;
        const epoch = options.captureRestoreEpoch();
        if (
            !container
            || layouts.length === 0
            || previousLayouts.length !== layouts.length
            || !options.canRestore(epoch)
        ) {
            return;
        }
        const queued = readQueuedRestore(epoch);
        // The reader's point was last placed in a viewport of another size: a
        // window or pane resize since keeps that point at the new centre. The
        // live offset cannot say where it was, because widening clamps it first.
        const resizedSinceRead = readingPoint?.viewportBox !== undefined
            && (
                readingPoint.viewportBox.offsetWidth !== container.offsetWidth
                || readingPoint.viewportBox.offsetHeight !== container.offsetHeight
            );
        scheduleAnchorRestore(activePointerAnchor ?? queued?.pointerAnchor ?? (
            queued || activeLayoutTransaction !== null || isResizeTransitionActive.value || resizedSinceRead
                ? readingPoint
                : null
        ) ?? captureAnchor(container, previousLayouts), epoch);
        // Project the semantic point before the DOM adopts the new geometry.
        // A large scale decrease can otherwise let the browser clamp the old
        // raw offset and emit a trusted scroll before the queued restore runs.
        // The queued pass remains necessary for the post-patch layout.
        if (activePointerAnchor === null && !queued?.pointerAnchor) {
            applyAnchor(readingPoint, epoch, layouts);
        }
    }, {flush: 'pre'});

    onScopeDispose(() => {
        disposed = true;
        pendingRestore = null;
        if (pointerAnchorReleaseTimer !== null) clearTimeout(pointerAnchorReleaseTimer);
    });

    return {
        beginLayoutTransaction,
        cancelPendingRestore,
        capturePointerAnchor,
        endLayoutTransaction,
        hasPendingPointerRestore: () => Boolean(pendingRestore?.pointerAnchor),
        isResizeTransitionActive,
        placeAnchor,
        preserveLayoutMutation,
        refreshLayoutTransactionAnchor,
    };
};
