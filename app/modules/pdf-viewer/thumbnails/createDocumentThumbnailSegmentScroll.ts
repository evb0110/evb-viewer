import type {Ref} from 'vue';
import type {IDocumentThumbnailScrollSegmentTransition} from '@app/modules/document-viewer/public';

interface IDocumentThumbnailSegmentScrollOptions {
    activeSegmentIndex: Readonly<Ref<number>>;
    applyTransition: (
        container: HTMLElement,
        transition: IDocumentThumbnailScrollSegmentTransition,
    ) => void;
    containerRef: Readonly<Ref<HTMLElement | null>>;
    markProgrammaticScroll: () => void;
    resolveTransition: (
        scrollTop: number,
        previousScrollTop: number,
        viewportHeight: number,
    ) => IDocumentThumbnailScrollSegmentTransition | null;
}

/**
 * Owns the small state machine that turns a bounded physical scroll segment
 * into the next one. The DOM write waits for Vue to update the segment wrapper,
 * otherwise an upward transition can be clamped against the old wrapper size.
 */
export function createDocumentThumbnailSegmentScroll(
    options: IDocumentThumbnailSegmentScrollOptions,
) {
    let lastObservedScrollTop = 0;
    let pendingSegmentIndex: number | null = null;

    function observeScrollTop(scrollTop: number) {
        lastObservedScrollTop = scrollTop;
    }

    function hasPendingTransition() {
        return pendingSegmentIndex !== null;
    }

    function handleScrollBoundary(recentProgrammaticScroll: boolean) {
        const container = options.containerRef.value;
        if (
            !container
            || recentProgrammaticScroll
            || pendingSegmentIndex !== null
        ) {
            return false;
        }

        const transition = options.resolveTransition(
            container.scrollTop,
            lastObservedScrollTop,
            container.clientHeight,
        );
        if (!transition) {
            observeScrollTop(container.scrollTop);
            return false;
        }

        pendingSegmentIndex = transition.segmentIndex;
        options.markProgrammaticScroll();
        void nextTick(() => {
            if (pendingSegmentIndex !== transition.segmentIndex) {
                return;
            }
            pendingSegmentIndex = null;
            const currentContainer = options.containerRef.value;
            if (
                !currentContainer
                || options.activeSegmentIndex.value !== transition.segmentIndex
            ) {
                return;
            }
            options.applyTransition(currentContainer, transition);
            observeScrollTop(currentContainer.scrollTop);
        });
        return true;
    }

    function cancel() {
        pendingSegmentIndex = null;
    }

    return {
        cancel,
        handleScrollBoundary,
        hasPendingTransition,
        observeScrollTop,
    };
}
