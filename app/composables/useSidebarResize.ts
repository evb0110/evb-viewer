import {
    ref,
    computed,
    watch,
    type Ref,
} from 'vue';
import { useEventListener } from '@vueuse/core';
import { SIDEBAR } from '@app/constants/pdf-layout';

export const useSidebarResize = (deps: {showSidebar: Ref<boolean>;}) => {
    const { showSidebar } = deps;

    const sidebarWidth = ref(SIDEBAR.DEFAULT_WIDTH);
    const lastOpenSidebarWidth = ref(SIDEBAR.DEFAULT_WIDTH);
    const isResizingSidebar = ref(false);

    let resizeStartX = 0;
    let resizeStartWidth = 0;
    let stopResizeMoveListener: (() => void) | null = null;
    let stopResizeUpListener: (() => void) | null = null;
    let stopResizeCancelListener: (() => void) | null = null;

    const sidebarWrapperStyle = computed(() => ({
        width: `${sidebarWidth.value + SIDEBAR.RESIZER_WIDTH}px`,
        minWidth: `${sidebarWidth.value + SIDEBAR.RESIZER_WIDTH}px`,
    }));

    function cleanupSidebarResizeListeners() {
        stopResizeMoveListener?.();
        stopResizeMoveListener = null;
        stopResizeUpListener?.();
        stopResizeUpListener = null;
        stopResizeCancelListener?.();
        stopResizeCancelListener = null;
    }

    function handleSidebarResize(event: PointerEvent) {
        const deltaX = event.clientX - resizeStartX;
        const nextWidth = resizeStartWidth + deltaX;

        if (nextWidth < SIDEBAR.COLLAPSE_WIDTH) {
            isResizingSidebar.value = false;
            cleanupSidebarResizeListeners();
            lastOpenSidebarWidth.value = SIDEBAR.MIN_WIDTH;
            sidebarWidth.value = SIDEBAR.MIN_WIDTH;
            showSidebar.value = false;
            return;
        }

        const clampedWidth = Math.min(
            Math.max(nextWidth, SIDEBAR.MIN_WIDTH),
            SIDEBAR.MAX_WIDTH,
        );

        sidebarWidth.value = clampedWidth;
        lastOpenSidebarWidth.value = clampedWidth;
    }

    function stopSidebarResize() {
        if (!isResizingSidebar.value) {
            return;
        }

        isResizingSidebar.value = false;
        cleanupSidebarResizeListeners();
    }

    function startSidebarResize(event: PointerEvent) {
        if (!showSidebar.value) {
            return;
        }

        event.preventDefault();

        isResizingSidebar.value = true;
        resizeStartX = event.clientX;
        resizeStartWidth = sidebarWidth.value;

        cleanupSidebarResizeListeners();
        stopResizeMoveListener = useEventListener(window, 'pointermove', handleSidebarResize);
        stopResizeUpListener = useEventListener(window, 'pointerup', stopSidebarResize);
        stopResizeCancelListener = useEventListener(window, 'pointercancel', stopSidebarResize);
    }

    watch(showSidebar, (isOpen) => {
        if (isOpen) {
            const width = Math.min(
                Math.max(lastOpenSidebarWidth.value, SIDEBAR.DEFAULT_WIDTH),
                SIDEBAR.MAX_WIDTH,
            );
            sidebarWidth.value = width;
            lastOpenSidebarWidth.value = width;
            return;
        }

        stopSidebarResize();
    });

    return {
        sidebarWidth,
        sidebarWrapperStyle,
        isResizingSidebar,
        startSidebarResize,
        cleanupSidebarResizeListeners,
    };
};
