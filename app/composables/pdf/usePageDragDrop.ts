import {
    ref,
    onUnmounted,
    type Ref,
} from 'vue';
import {
    getElectronAPI,
    hasElectronAPI,
} from '@app/utils/electron';

interface IPageDragDropDeps {
    containerRef: Ref<HTMLElement | null>;
    totalPages: Ref<number>;
    selectedPages: Ref<number[]>;
    onReorder: (newOrder: number[]) => void;
    onExternalFileDrop?: (afterPage: number, filePaths: string[]) => void;
}

export const usePageDragDrop = (deps: IPageDragDropDeps) => {
    const {
        containerRef,
        totalPages,
        selectedPages,
        onReorder,
        onExternalFileDrop,
    } = deps;

    const isDragging = ref(false);
    const isExternalDragOver = ref(false);
    const draggedPages = ref<number[]>([]);
    const dropInsertIndex = ref<number | null>(null);

    let startX = 0;
    let startY = 0;
    let startPage = 0;
    let clickSkip = false;
    let scrollTimer: ReturnType<typeof setInterval> | null = null;

    const THRESHOLD = 5;
    const SCROLL_ZONE = 40;
    const SCROLL_SPEED = 6;

    function getDragPages(page: number) {
        if (selectedPages.value.includes(page)) {
            return [...selectedPages.value].sort((a, b) => a - b);
        }
        return [page];
    }

    function findScrollContainer() {
        return containerRef.value?.closest('.pdf-sidebar-pages-thumbnails') as HTMLElement | null;
    }

    function calcDropIndex(clientY: number) {
        const el = containerRef.value;
        if (!el) {
            return 0;
        }

        const thumbs = el.querySelectorAll('.pdf-thumbnail');
        for (let i = 0; i < thumbs.length; i++) {
            const rect = thumbs[i]!.getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) {
                return i;
            }
        }
        return thumbs.length;
    }

    function buildNewOrder(insertAt: number, pages: number[]) {
        const total = totalPages.value;
        if (pages.length === 0 || total === 0) {
            return null;
        }

        const dragSet = new Set(pages);
        const rest: number[] = [];
        for (let i = 1; i <= total; i++) {
            if (!dragSet.has(i)) rest.push(i);
        }

        let idx = 0;
        for (let i = 0; i < insertAt && i < total; i++) {
            if (!dragSet.has(i + 1)) idx++;
        }

        const sorted = [...pages].sort((a, b) => a - b);
        const order = [...rest];
        order.splice(idx, 0, ...sorted);

        for (let i = 0; i < order.length; i++) {
            if (order[i] !== i + 1) {
                return order;
            }
        }
        return null;
    }

    function updateAutoScroll(clientY: number) {
        clearAutoScroll();
        const sc = findScrollContainer();
        if (!sc) {
            return;
        }

        const r = sc.getBoundingClientRect();
        if (clientY - r.top < SCROLL_ZONE) {
            scrollTimer = setInterval(() => { sc.scrollTop -= SCROLL_SPEED; }, 16);
        } else if (r.bottom - clientY < SCROLL_ZONE) {
            scrollTimer = setInterval(() => { sc.scrollTop += SCROLL_SPEED; }, 16);
        }
    }

    function clearAutoScroll() {
        if (scrollTimer !== null) {
            clearInterval(scrollTimer);
            scrollTimer = null;
        }
    }

    function onMove(e: MouseEvent) {
        if (!isDragging.value) {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (Math.sqrt(dx * dx + dy * dy) < THRESHOLD) {
                return;
            }

            isDragging.value = true;
            draggedPages.value = getDragPages(startPage);
            document.body.style.cursor = 'grabbing';
            document.body.style.userSelect = 'none';
        }

        const raw = calcDropIndex(e.clientY);
        const order = buildNewOrder(raw, draggedPages.value);
        dropInsertIndex.value = order !== null ? raw : null;
        updateAutoScroll(e.clientY);
    }

    function onUp() {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        clearAutoScroll();

        if (!isDragging.value) {
            return;
        }

        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        clickSkip = true;

        if (dropInsertIndex.value !== null) {
            const order = buildNewOrder(dropInsertIndex.value, draggedPages.value);
            if (order) onReorder(order);
        }

        isDragging.value = false;
        draggedPages.value = [];
        dropInsertIndex.value = null;
    }

    function handleMouseDown(e: MouseEvent, page: number) {
        if (e.button !== 0) {
            return;
        }
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
            return;
        }

        startX = e.clientX;
        startY = e.clientY;
        startPage = page;
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }

    function consumeClickSkip() {
        if (clickSkip) {
            clickSkip = false;
            return true;
        }
        return false;
    }

    function hasPdfFile(dt: DataTransfer | null) {
        if (!dt) {
            return false;
        }
        for (let i = 0; i < dt.items.length; i++) {
            const item = dt.items[i];
            if (item && item.kind === 'file') {
                return true;
            }
        }
        return false;
    }

    function isSupportedFilePath(filePath: string) {
        const lowerPath = filePath.toLowerCase();
        return lowerPath.endsWith('.pdf')
            || lowerPath.endsWith('.png')
            || lowerPath.endsWith('.jpg')
            || lowerPath.endsWith('.jpeg')
            || lowerPath.endsWith('.tif')
            || lowerPath.endsWith('.tiff')
            || lowerPath.endsWith('.bmp')
            || lowerPath.endsWith('.webp')
            || lowerPath.endsWith('.gif');
    }

    let dragEnterCounter = 0;

    function handleDragEnter(e: DragEvent) {
        if (!hasPdfFile(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        dragEnterCounter++;
        isExternalDragOver.value = true;
    }

    function handleDragOver(e: DragEvent) {
        if (!isExternalDragOver.value) {
            return;
        }
        e.preventDefault();
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'copy';
        }
        dropInsertIndex.value = calcDropIndex(e.clientY);
        updateAutoScroll(e.clientY);
    }

    function handleDragLeave(e: DragEvent) {
        if (!isExternalDragOver.value) {
            return;
        }
        e.preventDefault();
        dragEnterCounter--;
        if (dragEnterCounter <= 0) {
            dragEnterCounter = 0;
            isExternalDragOver.value = false;
            dropInsertIndex.value = null;
            clearAutoScroll();
        }
    }

    function handleDrop(e: DragEvent) {
        e.preventDefault();
        clearAutoScroll();
        const insertAt = dropInsertIndex.value ?? totalPages.value;
        isExternalDragOver.value = false;
        dropInsertIndex.value = null;
        dragEnterCounter = 0;

        if (!onExternalFileDrop || !e.dataTransfer || !hasElectronAPI()) {
            return;
        }

        const electronApi = getElectronAPI();
        const files = e.dataTransfer.files;
        const droppedPaths: string[] = [];
        const seen = new Set<string>();

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (!file) {
                continue;
            }

            const filePath = electronApi.getPathForFile(file);
            if (!filePath || seen.has(filePath) || !isSupportedFilePath(filePath)) {
                continue;
            }

            seen.add(filePath);
            droppedPaths.push(filePath);
        }

        if (droppedPaths.length > 0) {
            onExternalFileDrop(insertAt, droppedPaths);
        }
    }

    onUnmounted(() => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        clearAutoScroll();
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });

    return {
        isDragging,
        isExternalDragOver,
        draggedPages,
        dropInsertIndex,
        handleMouseDown,
        consumeClickSkip,
        handleDragEnter,
        handleDragOver,
        handleDragLeave,
        handleDrop,
    };
};
