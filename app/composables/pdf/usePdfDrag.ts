import { ref } from 'vue';

export const usePdfDrag = (dragModeEnabled: () => boolean) => {
    const isDragging = ref(false);
    const dragStart = ref({
        x: 0,
        y: 0, 
    });

    function startDrag(e: MouseEvent, container: HTMLElement | null) {
        if (!dragModeEnabled() || !container) {
            return;
        }
        isDragging.value = true;
        dragStart.value = {
            x: e.clientX,
            y: e.clientY, 
        };
        e.preventDefault();
    }

    function onDrag(e: MouseEvent, container: HTMLElement | null) {
        if (!dragModeEnabled() || !isDragging.value || !container) {
            return;
        }
        const dx = e.clientX - dragStart.value.x;
        const dy = e.clientY - dragStart.value.y;
        container.scrollLeft -= dx;
        container.scrollTop -= dy;
        dragStart.value = {
            x: e.clientX,
            y: e.clientY, 
        };
    }

    function stopDrag() {
        isDragging.value = false;
    }

    return {
        isDragging,
        startDrag,
        onDrag,
        stopDrag,
    };
};
