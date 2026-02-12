import {
    ref,
    computed,
    watch,
    type Ref,
} from 'vue';
import { SIDEBAR } from '@app/constants/pdf-layout';

export const useSidebarResize = (deps: {showSidebar: Ref<boolean>;}) => {
    const { showSidebar } = deps;

    const sidebarWidth = ref(SIDEBAR.DEFAULT_WIDTH);
    const lastOpenSidebarWidth = ref(SIDEBAR.DEFAULT_WIDTH);
    const isResizingSidebar = ref(false);

    let resizeStartX = 0;
    let resizeStartWidth = 0;

    const sidebarWrapperStyle = computed(() => ({
        width: `${sidebarWidth.value + SIDEBAR.RESIZER_WIDTH}px`,
        minWidth: `${sidebarWidth.value + SIDEBAR.RESIZER_WIDTH}px`,
    }));

    function cleanupSidebarResizeListeners() {
        window.removeEventListener('pointermove', handleSidebarResize);
        window.removeEventListener('pointerup', stopSidebarResize);
        window.removeEventListener('pointercancel', stopSidebarResize);
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

        window.addEventListener('pointermove', handleSidebarResize);
        window.addEventListener('pointerup', stopSidebarResize);
        window.addEventListener('pointercancel', stopSidebarResize);
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
