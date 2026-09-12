import type { Ref } from 'vue';

export interface IPdfViewportUserNavigationEpochs {
    /** Advances on every scroll the viewer did not author itself. */
    readonly userViewportInteractionEpoch: Ref<number>;
    /** Advances only on trusted input the user aimed at the viewport. */
    readonly userPhysicalNavigationEpoch: Ref<number>;
    beginLayoutGeometryReplacement: () => () => void;
    markPhysicalNavigation: () => void;
    markScrollInteraction: (offset: IPdfViewportScrollOffset) => boolean;
    observeAuthoredScrollOffset: (top: number) => void;
}

export interface IPdfViewportScrollOffset {
    top: number;
    maxTop: number;
}

/**
 * Two epochs describe viewport ownership, because one cannot.
 *
 * The interaction epoch answers "did the scroll offset stop being the one the
 * viewer wrote?", which every scroll event satisfies - including the ones the
 * browser emits when a fit change rewrites every row's height. Guarding a
 * fit re-anchor on that epoch makes the command cancel itself.
 *
 * The physical epoch answers "did the user take the viewport?" and stays put
 * across viewer-driven geometry replacement, so a fit change is superseded
 * only by real wheel or pointer navigation.
 *
 * Geometry replacement cannot swallow every scroll, though. A macOS overlay
 * scrollbar drag reaches the viewer as scroll events and nothing else, so
 * treating the whole replacement window as viewer-driven loses the drag. The
 * viewport disables browser scroll anchoring, which leaves clamping to the new
 * bounds as the only offset change the replacement itself can produce. An
 * offset that clamping does not explain came from the user.
 */
export function createPdfViewportUserNavigationEpochs(): IPdfViewportUserNavigationEpochs {
    const userViewportInteractionEpoch = ref(0);
    const userPhysicalNavigationEpoch = ref(0);
    let layoutGeometryReplacementDepth = 0;
    let lastObservedScrollTop: number | null = null;

    // Scroll offsets are fractional under device-pixel scaling, so an exact
    // comparison would read a rounding difference as user input.
    const CLAMP_TOLERANCE_PX = 1;

    function isExplainedByClamp(offset: IPdfViewportScrollOffset) {
        if (lastObservedScrollTop === null) {
            return true;
        }
        const clamped = Math.min(lastObservedScrollTop, Math.max(0, offset.maxTop));
        return Math.abs(offset.top - clamped) <= CLAMP_TOLERANCE_PX;
    }

    return {
        userViewportInteractionEpoch,
        userPhysicalNavigationEpoch,
        beginLayoutGeometryReplacement() {
            layoutGeometryReplacementDepth += 1;
            let closed = false;
            return () => {
                if (closed) {
                    return;
                }
                closed = true;
                layoutGeometryReplacementDepth = Math.max(0, layoutGeometryReplacementDepth - 1);
            };
        },
        markPhysicalNavigation() {
            userViewportInteractionEpoch.value += 1;
            userPhysicalNavigationEpoch.value += 1;
        },
        markScrollInteraction(offset) {
            userViewportInteractionEpoch.value += 1;
            const isPhysicalNavigation = layoutGeometryReplacementDepth === 0
                || !isExplainedByClamp(offset);
            lastObservedScrollTop = offset.top;
            if (isPhysicalNavigation) {
                userPhysicalNavigationEpoch.value += 1;
            }
            return isPhysicalNavigation;
        },
        observeAuthoredScrollOffset(top) {
            lastObservedScrollTop = top;
        },
    };
}
