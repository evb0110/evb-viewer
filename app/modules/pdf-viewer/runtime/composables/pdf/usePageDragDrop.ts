import type { Ref } from 'vue';
import { clamp } from 'es-toolkit/math';
import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IPageMoveRangeSegment,
    TPageSelection,
    TPageMoveOperation,
} from '@pdf-core/pdfPageSelection';
import {
    getFailureReceipt,
    type ExpectedOutcome,
} from '@contracts/diagnostics/failureReceipt';
import {
    buildPageMoveOrder,
    buildPageMoveRangesOrder,
    createPageMoveRange,
    createPageMoveRanges,
    isPageMoveRangesNoOp,
    isPageSelected,
    mapPageNumberAfterPageMove,
    pageMoveRangesRestInsertIndex,
} from '@pdf-core/pdfPageSelection';
import { getErrorMessage } from '@contracts/getErrorMessage';
import {
    useEventListener,
    useIntervalFn,
} from '@vueuse/core';
import {
    getDocumentPickerCapability,
    getDocumentWorkingCopyCapability,
} from '@app/utils/platformDocuments';
import { isSupportedPdfInsertFilePath } from '@app/utils/supportedDocumentPaths';
import { createRafCoalescedCallback } from '@app/utils/createRafCoalescedCallback';
import { useFailureToast } from '@app/composables/useFailureToast';
import { BrowserLogger } from '@app/utils/browserLogger';

interface IPageDragDropDeps {
    containerRef: Ref<HTMLElement | null>;
    totalPages: Ref<number>;
    selectedPages?: Readonly<Ref<number[]>>;
    selectedPageSelection?: Readonly<Ref<TPageSelection | null>>;
    onReorder: (newOrder: number[]) => void;
    onMove?: ((move: TPageMoveOperation) => void) | undefined;
    resolveDropIndex?: (clientY: number, container: HTMLElement) => number | null;
    onExternalFileDrop?: (afterPage: number, filePaths: TDocumentRef[]) => void;
}

interface IDragReorderContext {
    total: number;
    sortedPages: number[];
    restPages: number[];
    nonDraggedPrefixBySlot: number[];
    originalRestInsertIndex: number;
    canBeNoOp: boolean;
    compactMove?: {ranges: IPageMoveRangeSegment[];};
}

// The legacy browser reorder path sends a full permutation to pdf-lib. Keep
// that fallback bounded while desktop callers use the compact native move.
const LEGACY_REORDER_MAX_PAGES = 10_000;

export const usePageDragDrop = (deps: IPageDragDropDeps) => {
    const {
        containerRef,
        totalPages,
        selectedPages = ref([]),
        selectedPageSelection,
        onReorder,
        onMove,
        resolveDropIndex,
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
    const isWindowDragListenerActive = ref(false);
    let dragReorderContext: IDragReorderContext | null = null;
    const autoScrollContainer = ref<HTMLElement | null>(null);
    const autoScrollStep = ref(0);
    const { t } = useTypedI18n();
    const { presentFailureToast } = useFailureToast();

    const THRESHOLD = 5;
    const SCROLL_ZONE = 40;
    const SCROLL_SPEED = 6;
    const AUTO_SCROLL_INTERVAL_MS = 16;

    function pageNumbersToRanges(pages: readonly number[]): IPageMoveRangeSegment[] {
        const ranges: IPageMoveRangeSegment[] = [];
        for (const page of pages) {
            const previous = ranges.at(-1);
            if (previous && page === previous.endPage + 1) {
                previous.endPage = page;
            } else {
                ranges.push({
                    startPage: page,
                    endPage: page,
                });
            }
        }
        return ranges;
    }

    function getCompactMoveSegments(page: number): IPageMoveRangeSegment[] | null {
        const selection = selectedPageSelection?.value;
        if (!selection || !isPageSelected(selection, page)) {
            return null;
        }
        if (selection.kind === 'range') {
            return [{
                startPage: selection.startPage,
                endPage: selection.endPage,
            }];
        }
        if (selection.kind === 'explicit') {
            return pageNumbersToRanges(selection.pages);
        }
        if (selection.kind === 'mapped' && selection.source.kind === 'explicit') {
            const mappedPages = selection.source.pages
                .map(sourcePage => selection.moves.reduce(
                    (currentPage, move) => mapPageNumberAfterPageMove(currentPage, move),
                    sourcePage,
                ))
                .sort((left, right) => left - right);
            return pageNumbersToRanges(mappedPages);
        }
        return null;
    }

    const {
        isActive: isAutoScrollActive,
        pause: pauseAutoScroll,
        resume: resumeAutoScroll,
    } = useIntervalFn(() => {
        const container = autoScrollContainer.value;
        if (!container || autoScrollStep.value === 0) {
            return;
        }
        container.scrollTop += autoScrollStep.value;
    }, AUTO_SCROLL_INTERVAL_MS, { immediate: false });

    function getDragPages(page: number) {
        const selection = selectedPageSelection?.value;
        if (selection && isPageSelected(selection, page)) {
            if (selection.kind === 'range') {
                if (!onMove && selection.endPage - selection.startPage + 1 > LEGACY_REORDER_MAX_PAGES) {
                    return [page];
                }
                return Array.from({length: selection.endPage - selection.startPage + 1}, (_value, index) => selection.startPage + index);
            }
            if (selection.kind === 'explicit' && selection.pages.length <= 100_000) {
                return [...selection.pages].sort((a, b) => a - b);
            }
            // A predicate/complement can describe a very large, sparse set.
            // A thumbnail drag still moves the page under the pointer unless
            // the caller supplies a compact contiguous selection.
            return [page];
        }
        if (selectedPages.value.includes(page)) {
            return [...selectedPages.value].sort((a, b) => a - b);
        }
        return [page];
    }

    function findScrollContainer() {
        const container = containerRef.value;
        if (!container) {
            return null;
        }

        if (container.scrollHeight > container.clientHeight + 1) {
            return container;
        }

        const closestContainer = container.closest('.pdf-sidebar-pages-thumbnails');
        return closestContainer instanceof HTMLElement ? closestContainer : null;
    }

    function resolveDropInsertIndex(clientY: number) {
        const el = containerRef.value;
        if (!el) {
            return 0;
        }

        if (resolveDropIndex) {
            const resolved = resolveDropIndex(clientY, el);
            if (typeof resolved === 'number' && Number.isFinite(resolved)) {
                return clamp(Math.floor(resolved), 0, totalPages.value);
            }
        }

        const thumbs = el.querySelectorAll('.pdf-thumbnail');
        for (let i = 0; i < thumbs.length; i++) {
            const thumb = thumbs[i];
            if (!thumb) {
                continue;
            }
            const rect = thumb.getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) {
                return i;
            }
        }
        return thumbs.length;
    }

    function prepareDragReorderContext(
        pages: number[],
        compactMoveRanges?: IPageMoveRangeSegment[],
    ): IDragReorderContext | null {
        const total = totalPages.value;
        if (pages.length === 0 || total === 0) {
            return null;
        }
        if (!onMove && total > LEGACY_REORDER_MAX_PAGES) {
            return null;
        }

        const sortedPages = [...pages].sort((a, b) => a - b);
        const firstSortedPage = sortedPages[0];
        if (firstSortedPage === undefined) {
            return null;
        }
        if (onMove && (compactMoveRanges || sortedPages.length === 1)) {
            const ranges = compactMoveRanges ?? [{
                startPage: firstSortedPage,
                endPage: firstSortedPage,
            }];
            const firstRange = ranges[0];
            if (!firstRange) {
                return null;
            }
            const page = firstRange.startPage;
            return {
                total,
                sortedPages,
                restPages: [],
                nonDraggedPrefixBySlot: [],
                originalRestInsertIndex: page - 1,
                canBeNoOp: true,
                compactMove: {ranges},
            };
        }
        const dragSet = new Set(sortedPages);
        const restPages: number[] = [];
        const nonDraggedPrefixBySlot = new Array<number>(total + 1);
        nonDraggedPrefixBySlot[0] = 0;

        for (let i = 1; i <= total; i++) {
            const previous = nonDraggedPrefixBySlot[i - 1] ?? 0;
            const isDragged = dragSet.has(i);
            nonDraggedPrefixBySlot[i] = previous + (isDragged ? 0 : 1);

            if (!isDragged) {
                restPages.push(i);
            }
        }

        const originalRestInsertIndex = nonDraggedPrefixBySlot[firstSortedPage - 1] ?? 0;
        const canBeNoOp = sortedPages.every(
            (page, index) => page === firstSortedPage + index,
        );

        return {
            total,
            sortedPages,
            restPages,
            nonDraggedPrefixBySlot,
            originalRestInsertIndex,
            canBeNoOp,
        };
    }

    function resolveRestInsertIndex(
        insertAt: number,
        context: IDragReorderContext,
    ) {
        if (context.compactMove) {
            return pageMoveRangesRestInsertIndexForContext(insertAt, context.total, context.compactMove);
        }
        const clamped = clamp(Math.floor(insertAt), 0, context.total);
        return context.nonDraggedPrefixBySlot[clamped] ?? 0;
    }

    function pageMoveRangesRestInsertIndexForContext(
        insertAt: number,
        total: number,
        compactMove: NonNullable<IDragReorderContext['compactMove']>,
    ) {
        const move = createPageMoveRanges(
            total,
            compactMove.ranges,
            clamp(Math.floor(insertAt), 0, total),
        );
        return pageMoveRangesRestInsertIndex(move);
    }

    function canApplyReorder(
        insertAt: number,
        context: IDragReorderContext | null,
    ) {
        if (!context) {
            return false;
        }

        if (context.compactMove) {
            return !isPageMoveRangesNoOp(createPageMoveRanges(
                context.total,
                context.compactMove.ranges,
                clamp(Math.floor(insertAt), 0, context.total),
            ));
        }

        const restInsertIndex = resolveRestInsertIndex(insertAt, context);
        if (!context.canBeNoOp) {
            return true;
        }

        return restInsertIndex !== context.originalRestInsertIndex;
    }

    function buildNewOrder(
        insertAt: number,
        context: IDragReorderContext | null,
    ) {
        if (!context) {
            return null;
        }

        if (context.compactMove) {
            const move = createPageMoveRanges(
                context.total,
                context.compactMove.ranges,
                clamp(Math.floor(insertAt), 0, context.total),
            );
            return isPageMoveRangesNoOp(move) ? null : buildPageMoveRangesOrder(move);
        }

        const restInsertIndex = resolveRestInsertIndex(insertAt, context);
        if (context.canBeNoOp && restInsertIndex === context.originalRestInsertIndex) {
            return null;
        }

        const order = [...context.restPages];
        order.splice(restInsertIndex, 0, ...context.sortedPages);
        return order;
    }

    function syncAutoScroll(clientY: number) {
        const sc = findScrollContainer();
        if (!sc) {
            clearAutoScroll();
            return;
        }

        const r = sc.getBoundingClientRect();
        let nextScrollStep = 0;
        if (clientY - r.top < SCROLL_ZONE) {
            nextScrollStep = -SCROLL_SPEED;
        } else if (r.bottom - clientY < SCROLL_ZONE) {
            nextScrollStep = SCROLL_SPEED;
        }

        if (nextScrollStep === 0) {
            clearAutoScroll();
            return;
        }

        if (
            isAutoScrollActive.value
            && autoScrollContainer.value === sc
            && autoScrollStep.value === nextScrollStep
        ) {
            return;
        }

        autoScrollContainer.value = sc;
        autoScrollStep.value = nextScrollStep;
        resumeAutoScroll();
    }

    function clearAutoScroll() {
        autoScrollContainer.value = null;
        autoScrollStep.value = 0;
        pauseAutoScroll();
    }

    function cleanupWindowDragListeners() {
        isWindowDragListenerActive.value = false;
    }

    function clearBodyDragStyles() {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    }

    function resetInternalDragState() {
        clearBodyDragStyles();
        isDragging.value = false;
        draggedPages.value = [];
        dropInsertIndex.value = null;
        dragReorderContext = null;
    }

    function cancelInternalDrag() {
        internalDragMove.cancel();
        const wasDragging = isDragging.value;
        cleanupWindowDragListeners();
        clearAutoScroll();
        resetInternalDragState();
        if (wasDragging) {
            clickSkip = true;
        }
    }

    function applyInternalDragMove(e: MouseEvent, allowReleasedPointer = false) {
        if (!allowReleasedPointer && e.buttons === 0) {
            cancelInternalDrag();
            return;
        }

        if (!isDragging.value) {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (Math.sqrt(dx * dx + dy * dy) < THRESHOLD) {
                return;
            }

            isDragging.value = true;
            const compactMoveRanges = onMove ? getCompactMoveSegments(startPage) : null;
            // A compact range is already the complete drag payload. Keep the
            // visual marker bounded as well. The native move receives the
            // ranges below and never needs a page-sized selected-page array.
            const pages = compactMoveRanges
                ? compactMoveRanges.map(range => range.startPage)
                : getDragPages(startPage);
            draggedPages.value = pages;
            dragReorderContext = prepareDragReorderContext(pages, compactMoveRanges ?? undefined);
            document.body.style.cursor = 'grabbing';
            document.body.style.userSelect = 'none';
        }

        const raw = resolveDropInsertIndex(e.clientY);
        dropInsertIndex.value = canApplyReorder(raw, dragReorderContext) ? raw : null;
        syncAutoScroll(e.clientY);
    }

    const internalDragMove = createRafCoalescedCallback((event: MouseEvent) => {
        applyInternalDragMove(event);
    });

    function onUp(event: MouseEvent) {
        internalDragMove.cancel();
        applyInternalDragMove(event, true);
        cleanupWindowDragListeners();
        clearAutoScroll();

        if (!isDragging.value) {
            resetInternalDragState();
            return;
        }

        const insertAt = dropInsertIndex.value;
        const reorderContext = dragReorderContext;
        resetInternalDragState();
        clickSkip = true;

        if (insertAt !== null) {
            if (reorderContext?.compactMove) {
                const move = createPageMoveRanges(
                    reorderContext.total,
                    reorderContext.compactMove.ranges,
                    insertAt,
                );
                if (!isPageMoveRangesNoOp(move)) {
                    let operation: TPageMoveOperation = move;
                    if (move.ranges.length === 1) {
                        const firstRange = move.ranges[0];
                        if (!firstRange) {
                            return;
                        }
                        operation = createPageMoveRange(
                            move.pageCount,
                            firstRange.startPage,
                            firstRange.endPage,
                            move.insertAt,
                        );
                    }
                    if (onMove) onMove(operation);
                    else onReorder(
                        'ranges' in operation
                            ? buildPageMoveRangesOrder(operation)
                            : buildPageMoveOrder(operation),
                    );
                }
                return;
            }
            const order = buildNewOrder(insertAt, reorderContext);
            if (order) onReorder(order);
        }
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
        dragReorderContext = null;
        cleanupWindowDragListeners();
        if (typeof window === 'undefined') {
            return;
        }
        isWindowDragListenerActive.value = true;
    }

    const windowDragTarget = computed(() => (
        isWindowDragListenerActive.value && typeof window !== 'undefined'
            ? window
            : null
    ));
    useEventListener(windowDragTarget, 'mousemove', internalDragMove.schedule);
    useEventListener(windowDragTarget, 'mouseup', onUp);
    useEventListener(windowDragTarget, 'blur', cancelInternalDrag);
    useEventListener(windowDragTarget, 'pointercancel', cancelInternalDrag);
    useEventListener(windowDragTarget, 'lostpointercapture', cancelInternalDrag);

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

    let dragEnterCounter = 0;

    function handleDragEnter(e: DragEvent) {
        if (!hasPdfFile(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        dragEnterCounter++;
        isExternalDragOver.value = true;
    }

    function applyExternalDragOver(e: DragEvent) {
        if (!isExternalDragOver.value) {
            return;
        }
        dropInsertIndex.value = resolveDropInsertIndex(e.clientY);
        syncAutoScroll(e.clientY);
    }

    const externalDragOver = createRafCoalescedCallback(applyExternalDragOver);

    function handleDragOver(e: DragEvent) {
        if (!isExternalDragOver.value) {
            return;
        }
        e.preventDefault();
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'copy';
        }
        externalDragOver.schedule(e);
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
            externalDragOver.cancel();
        }
    }

    function notifyRegistrationFailure(error: unknown) {
        const failure = BrowserLogger.error(
            'page-drag-drop',
            'Failed to register dropped page file',
            error,
            getFailureReceipt(error) ?? {
                code: 'RENDERER_PDF_PAGE_OPERATION_FAILED',
                context: {},
            },
        );
        presentFailureToast({
            failure,
            title: t('errors.file.open'),
            description: getErrorMessage(error),
        });
    }

    async function registerExternalDropFiles(files: File[]) {
        const droppedPaths: TDocumentRef[] = [];
        const seen = new Set<TDocumentRef>();
        const documentPicker = getDocumentPickerCapability();

        for (const file of files) {
            let filePaths: TDocumentRef[];
            try {
                filePaths = await documentPicker.registerFilesForOpen([file]);
            } catch (error) {
                notifyRegistrationFailure(error);
                continue;
            }

            for (const filePath of filePaths) {
                if (!filePath || seen.has(filePath)) {
                    continue;
                }
                if (!isSupportedPdfInsertFilePath(filePath)) {
                    BrowserLogger.warn('page-drag-drop', 'Dropped page file type is unsupported', {
                        kind: 'expected',
                        code: 'unsupported-input',
                    } satisfies ExpectedOutcome);
                    void getDocumentWorkingCopyCapability().cleanupFile(filePath)
                        .catch(() => undefined);
                    continue;
                }

                seen.add(filePath);
                droppedPaths.push(filePath);
            }
        }

        return droppedPaths;
    }

    async function handleExternalDrop(e: DragEvent) {
        e.preventDefault();
        externalDragOver.flush(e);
        clearAutoScroll();
        const insertAt = dropInsertIndex.value ?? totalPages.value;
        isExternalDragOver.value = false;
        dropInsertIndex.value = null;
        dragEnterCounter = 0;

        if (!onExternalFileDrop || !e.dataTransfer) {
            return;
        }

        const droppedPaths = await registerExternalDropFiles(Array.from(e.dataTransfer.files));

        if (droppedPaths.length > 0) {
            onExternalFileDrop(insertAt, droppedPaths);
        }
    }

    onUnmounted(() => {
        cancelInternalDrag();
        externalDragOver.cancel();
    });

    return {
        isDragging,
        isExternalDragOver,
        draggedPages,
        dropInsertIndex,
        handleMouseDown,
        handlePointerCancel: cancelInternalDrag,
        consumeClickSkip,
        handleDragEnter,
        handleDragOver,
        handleDragLeave,
        handleExternalDrop,
    };
};
