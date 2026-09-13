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
    let retainedAnchor: IDocumentZoomAnchor | null = null;
    let dragAnchor: IDocumentZoomAnchor | null = null;
    let layoutTransactionAnchor: IDocumentZoomAnchor | null = null;
    let activePointerAnchor: IDocumentZoomAnchor | null = null;
    let activeLayoutTransaction: number | null = null;
    let nextLayoutTransaction = 0;
    let transitionGeneration = 0;
    let pendingRestore: {
        anchor: IDocumentZoomAnchor | null;
        epoch: unknown;
        generation: number;
        pointerAuthored: boolean;
    } | null = null;
    let restoreGeneration = 0;
    let restoreScheduled = false;
    let disposed = false;
    let transitionFallbackTimer: ReturnType<typeof setTimeout> | null = null;
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
        container,
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
        const restored = resolveDocumentZoomAnchorScroll(container, layouts, anchor);
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

    const scheduleAnchorRestore = (
        anchor: IDocumentZoomAnchor | null,
        epoch: unknown,
    ) => {
        const retainedPointerRestore = activePointerAnchor === null
            && pendingRestore?.pointerAuthored === true
            ? pendingRestore
            : null;
        pendingRestore = {
            anchor: retainedPointerRestore?.anchor ?? anchor,
            epoch,
            generation: restoreGeneration,
            pointerAuthored: activePointerAnchor !== null || retainedPointerRestore !== null,
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
                if (
                    disposed
                    || !pending
                    || pending.generation !== restoreGeneration
                ) {
                    return;
                }
                applyAnchor(activePointerAnchor ?? layoutTransactionAnchor ?? pending.anchor, pending.epoch);
                if (!options.isResizing?.value) {
                    isResizeTransitionActive.value = false;
                    if (transitionFallbackTimer !== null) clearTimeout(transitionFallbackTimer);
                    transitionFallbackTimer = null;
                }
            });
        });
    };

    const cancelPendingRestore = () => {
        restoreGeneration += 1;
        pendingRestore = null;
        releasePointerAnchor();
        activeLayoutTransaction = null;
        layoutTransactionAnchor = null;
        dragAnchor = null;
        retainedAnchor = null;
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
                layoutTransactionAnchor = activePointerAnchor;
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
        const anchor = activePointerAnchor ?? layoutTransactionAnchor ?? (
            container ? captureAnchor(container, options.pageLayouts.value) : null
        );
        mutate();
        applyAnchor(anchor, epoch);
        scheduleAnchorRestore(anchor, epoch);
    };

    const beginLayoutTransaction = () => {
        activeLayoutTransaction = ++nextLayoutTransaction;
        layoutTransactionAnchor = captureCurrentAnchor();
        return activeLayoutTransaction;
    };

    const refreshLayoutTransactionAnchor = () => {
        const anchor = activePointerAnchor ?? captureCurrentAnchor();
        retainedAnchor = anchor;
        if (activeLayoutTransaction !== null) {
            layoutTransactionAnchor = anchor;
        }
    };

    const endLayoutTransaction = async (
        transaction = activeLayoutTransaction,
        restore = true,
    ) => {
        if (transaction === null || activeLayoutTransaction !== transaction) {
            return;
        }
        activeLayoutTransaction = null;
        const anchor = activePointerAnchor ?? layoutTransactionAnchor;
        layoutTransactionAnchor = null;
        if (!restore) {
            return;
        }
        const epoch = options.captureRestoreEpoch();
        const generation = restoreGeneration;
        await nextTick();
        applyAnchor(anchor, epoch, options.pageLayouts.value, generation);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (!applyAnchor(anchor, epoch, options.pageLayouts.value, generation)) {
            return;
        }
        retainedAnchor = anchor;
    };

    if (options.isResizing) {
        watch(options.isResizing, (resizing, wasResizing) => {
            const container = options.viewerContainer.value;
            if (resizing) {
                transitionGeneration += 1;
                if (transitionFallbackTimer !== null) clearTimeout(transitionFallbackTimer);
                isResizeTransitionActive.value = true;
                dragAnchor = container
                    ? resolveRetainedDocumentZoomAnchor(
                        container,
                        options.pageLayouts.value,
                        retainedAnchor,
                        1,
                        options.capturePageIndex?.(),
                    )
                    : null;
                return;
            }
            if (!wasResizing) {
                return;
            }
            retainedAnchor = dragAnchor;
            const generation = transitionGeneration;
            void nextTick(() => {
                options.onResizeSettled?.();
                dragAnchor = null;
                transitionFallbackTimer = setTimeout(() => {
                    if (generation === transitionGeneration && !options.isResizing?.value) {
                        isResizeTransitionActive.value = false;
                    }
                    transitionFallbackTimer = null;
                }, 500);
            });
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
        const anchor = activePointerAnchor
            ?? layoutTransactionAnchor
            ?? dragAnchor
            ?? (isResizeTransitionActive.value ? retainedAnchor : null)
            ?? captureAnchor(container, previousLayouts);
        scheduleAnchorRestore(anchor, epoch);
    }, {flush: 'pre'});

    onScopeDispose(() => {
        disposed = true;
        pendingRestore = null;
        if (transitionFallbackTimer !== null) clearTimeout(transitionFallbackTimer);
        if (pointerAnchorReleaseTimer !== null) clearTimeout(pointerAnchorReleaseTimer);
    });

    return {
        beginLayoutTransaction,
        cancelPendingRestore,
        capturePointerAnchor,
        endLayoutTransaction,
        hasPendingPointerRestore: () => pendingRestore?.pointerAuthored === true,
        isResizeTransitionActive,
        preserveLayoutMutation,
        refreshLayoutTransactionAnchor,
    };
};
