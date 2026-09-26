import type { Ref } from 'vue';

export interface IPdfViewportUserNavigationEpochs {
    /** Advances on every scroll the viewer did not author itself. */
    readonly userViewportInteractionEpoch: Ref<number>;
    markPhysicalNavigation: () => void;
    markScrollInteraction: (offset: IPdfViewportScrollOffset) => boolean;
    observeAuthoredScrollOffset: (top: number) => void;
}

export interface IPdfViewportScrollOffset {
    top: number;
    maxTop: number;
}

/**
 * The viewport disables browser scroll anchoring, so clamping to new bounds
 * is the only offset change layout can produce on its own. Committed pages
 * kept at their painted scale during a navigation handoff shrink when the
 * handoff releases; that clamp must not read as the user taking the viewport
 * from the navigation. Any other offset came from the user.
 */
export function createPdfViewportUserNavigationEpochs(): IPdfViewportUserNavigationEpochs {
    const userViewportInteractionEpoch = ref(0);
    let lastObservedScrollTop: number | null = null;

    // Scroll offsets are fractional under device-pixel scaling, so an exact
    // comparison would read a rounding difference as user input.
    const CLAMP_TOLERANCE_PX = 1;

    function isStrictClamp(offset: IPdfViewportScrollOffset) {
        if (lastObservedScrollTop === null) {
            return false;
        }
        const maxTop = Math.max(0, offset.maxTop);
        return lastObservedScrollTop > maxTop + CLAMP_TOLERANCE_PX
            && Math.abs(offset.top - maxTop) <= CLAMP_TOLERANCE_PX;
    }

    return {
        userViewportInteractionEpoch,
        markPhysicalNavigation() {
            userViewportInteractionEpoch.value += 1;
        },
        markScrollInteraction(offset) {
            userViewportInteractionEpoch.value += 1;
            const isPhysicalNavigation = !isStrictClamp(offset);
            lastObservedScrollTop = offset.top;
            return isPhysicalNavigation;
        },
        observeAuthoredScrollOffset(top) {
            lastObservedScrollTop = top;
        },
    };
}
