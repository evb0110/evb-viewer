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
    /** Writes a restore; `onApplied` runs once the write has landed. */
    applyRestoredScroll: (restored: {
        left: number;
        top: number;
    }, onApplied?: () => void) => boolean;
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
    // The reader's point, and its only owner. The placements that move the
    // reader commit it: navigation and user scroll through commitReadingPoint,
    // a restore after its post-paint write. Echoes of authored writes never
    // re-read it, and a queued restore places the point current when it fires.
    let readingPoint: IDocumentZoomAnchor | null = null;
    // From hiding until the view's point is placed again, the view's offset is
    // not the reader's: hiding resets it, and showing does not restore it.
    let suspended = false;
    let activePointerAnchor: IDocumentZoomAnchor | null = null;
    // The admitted transition whose metric hydration is changing the layout,
    // plus any pointer anchor captured during it (kept apart from readingPoint).
    let activeLayoutTransaction: {
        token: object;
        pointerAnchor: IDocumentZoomAnchor | null;
    } | null = null;
    let pendingRestore: {
        epoch: unknown;
        generation: number;
        pointerAnchor: IDocumentZoomAnchor | null;
    } | null = null;
    // A document pointerdown or keydown cancels restores without moving the
    // reader or bumping the restore epoch, and a tab can be hidden and shown
    // again inside one restore frame. The epoch cannot tell those cancels
    // apart, so the generation fences the frames and ticks they cancel.
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

    const readLaidOutContainer = () => {
        const container = options.viewerContainer.value;
        return container && container.clientWidth > 0 && container.clientHeight > 0 ? container : null;
    };

    /** The box whose offset is the reader's: laid out, and not awaiting its point. */
    const readLiveContainer = () => (suspended ? null : readLaidOutContainer());

    const captureLiveAnchor = (layouts = options.pageLayouts.value) => {
        const container = readLiveContainer();
        return container ? captureAnchor(container, layouts) : null;
    };

    /** A placement landed: take the point from the live box. Without one the point stays. */
    const recaptureReadingPoint = () => {
        readingPoint = captureLiveAnchor() ?? readingPoint;
    };

    /**
     * The reader moved the view by navigation or scroll. On a laid-out box its
     * offset is the reader's again: a view being shown then places this point.
     */
    const commitReadingPoint = () => {
        if (readLaidOutContainer()) suspended = false;
        if (activeLayoutTransaction) activeLayoutTransaction.pointerAnchor = null;
        recaptureReadingPoint();
    };

    const applyAnchor = (
        anchor: IDocumentZoomAnchor | null,
        epoch: unknown,
        {
            layouts = options.pageLayouts.value,
            generation = restoreGeneration,
            commit = false,
        }: {
            layouts?: readonly IDocumentZoomPageLayout[];
            generation?: number;
            // Only a post-paint write commits: a pre-paint one can be clamped
            // by the old DOM height, and its echo must not become the point.
            commit?: boolean;
        } = {},
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
        return options.applyRestoredScroll(restored, commit ? recaptureReadingPoint : undefined);
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

    const readRestoreAnchor = () => (
        activePointerAnchor
        ?? pendingRestore?.pointerAnchor
        ?? activeLayoutTransaction?.pointerAnchor
        ?? readingPoint
    );

    /** A queued restore keeps the reading point it was queued for until an authored write moves it. */
    const scheduleAnchorRestore = (
        anchor: IDocumentZoomAnchor | null,
        epoch: unknown,
    ) => {
        const queued = readQueuedRestore(epoch);
        const pointerAnchor = activePointerAnchor ?? queued?.pointerAnchor ?? activeLayoutTransaction?.pointerAnchor ?? null;
        if (!queued && pointerAnchor === null) readingPoint = anchor ?? readingPoint;
        pendingRestore = {
            epoch,
            generation: restoreGeneration,
            pointerAnchor,
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
                    const isPointerRestore = activePointerAnchor !== null || pending.pointerAnchor !== null;
                    // A layout transaction holds its centre point until it ends and commits,
                    // except after a pointer zoom whose new centre replaces the pre-zoom one.
                    applyAnchor(activePointerAnchor ?? pending.pointerAnchor ?? activeLayoutTransaction?.pointerAnchor ?? readingPoint, pending.epoch, {
                        commit: activeLayoutTransaction === null || isPointerRestore,
                    });
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
        // Cancelling drops queued work. It does not move the reader, so the
        // point stays until a placement commits another.
        restoreGeneration += 1;
        pendingRestore = null;
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
                activeLayoutTransaction.pointerAnchor = activePointerAnchor;
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
        const epoch = options.captureRestoreEpoch();
        const queued = readQueuedRestore(epoch);
        const anchor = activePointerAnchor ?? queued?.pointerAnchor ?? (
            queued || activeLayoutTransaction !== null ? readingPoint : null
        ) ?? captureLiveAnchor();
        mutate();
        scheduleAnchorRestore(anchor, epoch);
        applyAnchor(readRestoreAnchor(), epoch);
    };

    /** The view is hidden: keep the point it was hidden at. */
    const suspend = () => {
        suspended = true;
    };

    /** The view is shown again: place its point now and after paint, in place of any queued one. */
    const resume = () => {
        suspended = false;
        if (!readingPoint) {
            // Hidden before its first placement: the opening or a navigation places it.
            return;
        }
        const epoch = options.captureRestoreEpoch();
        pendingRestore = null;
        applyAnchor(readingPoint, epoch);
        scheduleAnchorRestore(readingPoint, epoch);
    };

    /** Another document opens in this view: the previous document's point does not apply. */
    const resetReadingPoint = () => {
        readingPoint = null;
    };

    const beginLayoutTransaction = (transition: object) => {
        activeLayoutTransaction = {
            token: transition,
            pointerAnchor: null,
        };
        recaptureReadingPoint();
    };

    const endLayoutTransaction = async (
        transition: object,
        restore = true,
    ) => {
        if (activeLayoutTransaction?.token !== transition) {
            return;
        }
        const finalAnchor = readRestoreAnchor();
        activeLayoutTransaction = null;
        if (!restore) {
            return;
        }
        const epoch = options.captureRestoreEpoch();
        const generation = restoreGeneration;
        await nextTick();
        applyAnchor(activePointerAnchor ?? pendingRestore?.pointerAnchor ?? finalAnchor, epoch, {generation});
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        applyAnchor(activePointerAnchor ?? pendingRestore?.pointerAnchor ?? finalAnchor, epoch, {
            generation,
            commit: true,
        });
    };

    if (options.isResizing) {
        watch(options.isResizing, (resizing, wasResizing) => {
            const container = readLiveContainer();
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
                    : readingPoint;
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
        ) ?? captureLiveAnchor(previousLayouts), epoch);
        // Project the semantic point before the DOM adopts the new geometry.
        // A large scale decrease can otherwise let the browser clamp the old
        // raw offset and emit a trusted scroll before the queued restore runs.
        // The queued pass remains necessary for the post-patch layout.
        if (activePointerAnchor === null && !queued?.pointerAnchor && !activeLayoutTransaction?.pointerAnchor) {
            applyAnchor(readingPoint, epoch, {layouts});
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
        commitReadingPoint,
        endLayoutTransaction,
        hasPendingPointerRestore: () => Boolean(pendingRestore?.pointerAnchor),
        isResizeTransitionActive,
        preserveLayoutMutation,
        readReadingPoint: () => readingPoint,
        resetReadingPoint,
        resume,
        suspend,
    };
};
