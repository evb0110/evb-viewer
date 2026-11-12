
import type { THostResourceTier } from '@contracts/hostResourceProfile';
import { getPerformanceProfile } from '@app/utils/performanceProfile';

const PERFORMANCE_TIER_CLASSES = [
    'performance-tier-low',
    'performance-tier-medium',
    'performance-tier-high',
] as const;
const LOW_GRAPHICS_CLASS = 'app-low-graphics';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function installPerformanceProfileRootClasses(
    root: HTMLElement,
    reducedMotionQuery: MediaQueryList,
    tier: THostResourceTier,
) {
    const tierClass = `performance-tier-${tier}`;
    root.classList.remove(...PERFORMANCE_TIER_CLASSES);
    root.classList.add(tierClass);

    function syncLowGraphicsClass() {
        root.classList.toggle(
            LOW_GRAPHICS_CLASS,
            tier === 'low' || reducedMotionQuery.matches,
        );
    }
    function cleanup() {
        reducedMotionQuery.removeEventListener('change', syncLowGraphicsClass);
        root.classList.remove(...PERFORMANCE_TIER_CLASSES, LOW_GRAPHICS_CLASS);
    }

    syncLowGraphicsClass();
    reducedMotionQuery.addEventListener('change', syncLowGraphicsClass);

    return cleanup;
}

export default defineNuxtPlugin(() => {
    const tier = getPerformanceProfile().tier;
    const cleanup = installPerformanceProfileRootClasses(
        document.documentElement,
        window.matchMedia(REDUCED_MOTION_QUERY),
        tier,
    );

    if (import.meta.hot) {
        import.meta.hot.dispose(cleanup);
    }
});
