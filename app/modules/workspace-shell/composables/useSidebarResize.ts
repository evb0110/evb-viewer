import type { Ref } from 'vue';
import { useEventListener } from '@vueuse/core';
import { clamp } from 'es-toolkit/math';
import { SIDEBAR } from '@app/constants/pdfLayout';
import { BrowserLogger } from '@app/utils/browserLogger';
import { createRafCoalescedCallback } from '@app/utils/createRafCoalescedCallback';

export function resolveSidebarEffectiveMaxWidth(containerWidth: number) {
    if (!Number.isFinite(containerWidth)) {
        return SIDEBAR.MAX_WIDTH;
    }

    return Math.max(
        SIDEBAR.MIN_WIDTH,
        Math.min(SIDEBAR.MAX_WIDTH, containerWidth - SIDEBAR.MIN_VIEWER_WIDTH),
    );
}

export const useSidebarResize = (deps: {
    showSidebar: Ref<boolean>;
    initialWidth?: number | undefined;
}) => {
    const { showSidebar } = deps;

    const initialWidth = clamp(
        deps.initialWidth ?? SIDEBAR.DEFAULT_WIDTH,
        SIDEBAR.MIN_WIDTH,
        SIDEBAR.MAX_WIDTH,
    );
    const sidebarWidth = ref(initialWidth);
    const lastOpenSidebarWidth = ref(initialWidth);
    const isPointerResizingSidebar = ref(false);
    // The sidebar host reports the open/close slide it animates; while either
    // a pointer drag or that slide runs, the viewer beside the sidebar is
    // resizing continuously and must not commit a fit scale per frame.
    const isSlidingSidebar = ref(false);
    const isResizingSidebar = computed(() => isPointerResizingSidebar.value || isSlidingSidebar.value);
    const containerWidth = ref(Number.POSITIVE_INFINITY);
    const effectiveMaxWidth = computed(() => resolveSidebarEffectiveMaxWidth(containerWidth.value));

    let resizeStartX = 0;
    let resizeStartWidth = 0;
    const sidebarWrapperStyle = computed(() => ({
        width: `${sidebarWidth.value + SIDEBAR.RESIZER_WIDTH}px`,
        minWidth: '0',
    }));

    let detachDragListeners: (() => void) | null = null;

    function cleanupSidebarResizeListeners() {
        sidebarResize.cancel();
        detachDragListeners?.();
        detachDragListeners = null;
    }

    function handleSidebarResize(event: PointerEvent) {
        if (!isPointerResizingSidebar.value) {
            return;
        }
        const deltaX = event.clientX - resizeStartX;
        const nextWidth = resizeStartWidth + deltaX;

        const clampedWidth = clamp(nextWidth, SIDEBAR.MIN_WIDTH, effectiveMaxWidth.value);

        if (Math.round(clampedWidth) !== Math.round(sidebarWidth.value)) {
            BrowserLogger.diagnostic('pdf-nav', `[sidebar-resize] width ${Math.round(sidebarWidth.value)}->${Math.round(clampedWidth)}`, {
                previousWidth: Math.round(sidebarWidth.value),
                nextWidth: Math.round(clampedWidth),
                deltaX: Math.round(deltaX),
                pointerX: Math.round(event.clientX),
            });
        }
        sidebarWidth.value = clampedWidth;
        lastOpenSidebarWidth.value = clampedWidth;
    }

    const sidebarResize = createRafCoalescedCallback(handleSidebarResize);

    function stopSidebarResize(event?: PointerEvent) {
        if (!isPointerResizingSidebar.value) {
            return;
        }

        if (event) {
            sidebarResize.flush(event);
        } else {
            sidebarResize.flushPending();
        }
        isPointerResizingSidebar.value = false;
        cleanupSidebarResizeListeners();
    }

    function startSidebarResize(event: PointerEvent) {
        if (!showSidebar.value) {
            return;
        }

        event.preventDefault();

        isPointerResizingSidebar.value = true;
        resizeStartX = event.clientX;
        resizeStartWidth = sidebarWidth.value;
        BrowserLogger.diagnostic('pdf-nav', '[sidebar-resize] start', {
            pointerX: Math.round(event.clientX),
            startWidth: Math.round(resizeStartWidth),
        });

        cleanupSidebarResizeListeners();
        attachDragListeners();
    }

    // Window-level pointer listeners exist only for the duration of a drag so idle
    // mouse movement does not schedule a frame callback for every pointermove.
    function attachDragListeners() {
        const target = typeof window !== 'undefined' ? window : undefined;
        const stops = [
            useEventListener(target, 'pointermove', sidebarResize.schedule),
            useEventListener(target, 'pointerup', stopSidebarResize),
            useEventListener(target, 'pointercancel', stopSidebarResize),
        ];
        detachDragListeners = () => {
            for (const stop of stops) {
                stop();
            }
        };
    }

    onScopeDispose(cleanupSidebarResizeListeners, true);

    watch(showSidebar, (isOpen) => {
        BrowserLogger.diagnostic('pdf-nav', `[sidebar-state] open=${isOpen}`, {
            isOpen,
            sidebarWidth: Math.round(sidebarWidth.value),
            lastOpenSidebarWidth: Math.round(lastOpenSidebarWidth.value),
            isResizingSidebar: isResizingSidebar.value,
            isPointerResizingSidebar: isPointerResizingSidebar.value,
        });
        if (isOpen) {
            const width = Math.min(
                Math.max(lastOpenSidebarWidth.value, SIDEBAR.MIN_WIDTH),
                effectiveMaxWidth.value,
            );
            sidebarWidth.value = width;
            lastOpenSidebarWidth.value = width;
            return;
        }

        stopSidebarResize();
    });

    watch(sidebarWidth, (next, previous) => {
        if (Math.round(next) === Math.round(previous)) {
            return;
        }
        BrowserLogger.diagnostic('pdf-nav', `[sidebar-width-ref] ${Math.round(previous)}->${Math.round(next)}`, {
            previous: Math.round(previous),
            next: Math.round(next),
            open: showSidebar.value,
            isResizingSidebar: isResizingSidebar.value,
            isPointerResizingSidebar: isPointerResizingSidebar.value,
        });
    });

    function setSidebarContainerWidth(width: number) {
        containerWidth.value = width;
        sidebarWidth.value = Math.min(sidebarWidth.value, effectiveMaxWidth.value);
        lastOpenSidebarWidth.value = Math.min(lastOpenSidebarWidth.value, effectiveMaxWidth.value);
    }

    return {
        sidebarWidth,
        sidebarWrapperStyle,
        isResizingSidebar,
        isPointerResizingSidebar,
        isSlidingSidebar,
        effectiveMaxWidth,
        setSidebarContainerWidth,
        startSidebarResize,
        cleanupSidebarResizeListeners,
    };
};
