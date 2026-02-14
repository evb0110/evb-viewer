import {
    ref,
    readonly,
    nextTick,
    onUnmounted,
    type Ref,
} from 'vue';

interface ICachedRect {
    left: number;
    width: number;
    mid: number;
}

export const useTabDragReorder = (
    containerRef: Ref<HTMLElement | null>,
    onReorder: (fromIndex: number, toIndex: number) => void,
) => {
    const isDragging = ref(false);
    const dragIndex = ref(-1);
    const dragTranslateX = ref(0);

    let startX = 0;
    let cachedRects: ICachedRect[] = [];
    let clickSkip = false;
    let activeElement: HTMLElement | null = null;

    const THRESHOLD = 5;

    function cacheTabRects() {
        const el = containerRef.value;
        if (!el) {
            cachedRects = [];
            return;
        }

        const tabs = el.querySelectorAll<HTMLElement>('[data-tab-id]');
        cachedRects = Array.from(tabs).map((tab) => {
            const rect = tab.getBoundingClientRect();
            return {
                left: rect.left,
                width: rect.width,
                mid: rect.left + rect.width / 2,
            };
        });
    }

    function calcDropIndex(clientX: number) {
        for (let i = 0; i < cachedRects.length; i++) {
            if (clientX < cachedRects[i]!.mid) {
                return i;
            }
        }
        return Math.max(0, cachedRects.length - 1);
    }

    function cleanup() {
        isDragging.value = false;
        dragIndex.value = -1;
        dragTranslateX.value = 0;
        document.body.style.cursor = '';

        if (activeElement) {
            activeElement.removeEventListener('pointermove', onPointerMove);
            activeElement.removeEventListener('pointerup', onPointerUp);
            activeElement.removeEventListener('lostpointercapture', onLostCapture);
            activeElement = null;
        }
    }

    function onPointerMove(e: PointerEvent) {
        const deltaX = e.clientX - startX;

        if (!isDragging.value) {
            if (Math.abs(deltaX) < THRESHOLD) {
                return;
            }
            isDragging.value = true;
            document.body.style.cursor = 'grabbing';
        }

        dragTranslateX.value = deltaX;

        const newIndex = calcDropIndex(e.clientX);
        if (newIndex !== dragIndex.value) {
            const oldIndex = dragIndex.value;
            const displacedRect = cachedRects[newIndex];
            if (!displacedRect) {
                return;
            }

            onReorder(oldIndex, newIndex);
            dragIndex.value = newIndex;

            if (newIndex > oldIndex) {
                startX += displacedRect.width;
            } else {
                startX -= displacedRect.width;
            }
            dragTranslateX.value = e.clientX - startX;

            nextTick(() => {
                cacheTabRects();
            });
        }
    }

    function onPointerUp() {
        if (isDragging.value) {
            clickSkip = true;
        }
        cleanup();
    }

    function onLostCapture() {
        if (isDragging.value) {
            clickSkip = true;
        }
        cleanup();
    }

    function onPointerDown(e: PointerEvent, index: number) {
        if (e.button !== 0) {
            return;
        }

        const el = e.currentTarget as HTMLElement;
        el.setPointerCapture(e.pointerId);

        activeElement = el;
        startX = e.clientX;
        dragIndex.value = index;

        cacheTabRects();

        el.addEventListener('pointermove', onPointerMove);
        el.addEventListener('pointerup', onPointerUp);
        el.addEventListener('lostpointercapture', onLostCapture);
    }

    function shouldSuppressClick() {
        if (clickSkip) {
            clickSkip = false;
            return true;
        }
        return false;
    }

    onUnmounted(() => {
        cleanup();
    });

    return {
        isDragging: readonly(isDragging),
        dragIndex: readonly(dragIndex),
        dragTranslateX: readonly(dragTranslateX),
        onPointerDown,
        shouldSuppressClick,
    };
};
