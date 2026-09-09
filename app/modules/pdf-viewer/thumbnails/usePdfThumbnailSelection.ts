import type {
    ComputedRef,
    Ref,
} from 'vue';
import {
    buildPageMoveOrder,
    buildPageMoveRangesOrder,
    createPageMoveRange,
    createPageMoveRanges,
    isPageMoveOperationNoOp,
    iteratePageSelectionRanges,
    mapPageNumberAfterPageMove,
} from '@pdf-core/pdfPageSelection';
import type { TPageMoveOperation } from '@pdf-core/pdfPageSelection';
import { useMultiSelection } from '@app/composables/useMultiSelection';
import {
    arePageNumberListsEqual,
    createExplicitPageSelection,
    createRangePageSelection,
    isPageSelected,
    materializePageSelection,
    pageSelectionCount,
    normalizeSelectedPageNumbers,
    resolveThumbnailContextMenuSelection,
    shouldSelectPageFromThumbnailClick,
    togglePageSelection,
} from '@app/utils/pdfPageSelection';
import type { TPageSelection } from '@app/utils/pdfPageSelection';

/** Rows PageUp/PageDown skip, matching the scan-cleanup rail. */
const PAGE_KEYBOARD_STEP = 5;
const LEGACY_SELECTION_MATERIALIZATION_LIMIT = 100_000;

interface IPdfThumbnailSelectionRefusal {
    kind: 'page-count-limit';
    pageCount: number;
    limit: number;
}

const NESTED_CONTROL_SELECTOR = 'button, input, select, textarea, a[href], [role="button"]';

/**
 * Keyboard events raised by a control nested inside a row belong to that
 * control: the rail must not also navigate or move its roving focus.
 */
function isNestedRowControl(target: EventTarget | null) {
    return target instanceof Element && target.closest(NESTED_CONTROL_SELECTOR) !== null;
}

function resolveRowPageFromElement(target: EventTarget | null) {
    if (!(target instanceof Element)) {
        return null;
    }
    const page = Number(target.closest<HTMLElement>('[data-page]')?.dataset.page);
    return Number.isInteger(page) ? page : null;
}

interface IUsePdfThumbnailSelectionOptions {
    consumeClickSkip: () => boolean;
    currentPage: ComputedRef<number>;
    focusPageElement: (page: number) => void;
    isDragging: Ref<boolean>;
    isExternalDragOver: Ref<boolean>;
    markUserInteraction: (reason: string) => void;
    onContextMenu: (payload: {
        clientX: number;
        clientY: number;
        clickedPage: number;
        pages: number[];
        selection: TPageSelection;
    }) => void;
    onGoToPage: (page: number) => void;
    onMove?: ((move: TPageMoveOperation) => void) | undefined;
    onReorder?: (newOrder: number[]) => void;
    onSelectionRefused?: (reason: IPdfThumbnailSelectionRefusal) => void;
    onSelectedPagesChange?: (pages: number[]) => void;
    onPageSelectionChange?: ((selection: TPageSelection) => void) | undefined;
    renderedPages: ComputedRef<number[]>;
    scrollPageIntoKeyboardView: (page: number) => void | Promise<void>;
    selectedPages?: ComputedRef<number[]>;
    selectedPageSelection?: ComputedRef<TPageSelection | null> | undefined;
    totalPages: ComputedRef<number>;
}

export const usePdfThumbnailSelection = (options: IUsePdfThumbnailSelectionOptions) => {
    const {
        consumeClickSkip,
        currentPage,
        focusPageElement,
        isDragging,
        isExternalDragOver,
        markUserInteraction,
        onContextMenu,
        onGoToPage,
        onMove,
        onReorder,
        onSelectionRefused = () => {},
        onSelectedPagesChange = () => {},
        onPageSelectionChange,
        renderedPages,
        scrollPageIntoKeyboardView,
        selectedPages = computed(() => []),
        selectedPageSelection,
        totalPages,
    } = options;

    const multiSelection = useMultiSelection<number>();
    const selectionFocusPage = ref<number | null>(null);
    const keyboardFocusPage = ref<number | null>(null);
    const usesPageSelectionModel = onPageSelectionChange !== undefined;
    const selectedPagesSet = computed(() => usesPageSelectionModel
        ? null
        : new Set(selectedPages.value));

    function getPageSelection(): TPageSelection {
        if (usesPageSelectionModel) {
            const selection = selectedPageSelection?.value;
            if (selection && selection.pageCount === totalPages.value) {
                return selection;
            }
        }
        return createExplicitPageSelection(totalPages.value, selectedPages.value);
    }

    function notifyPageSelection(selection: TPageSelection) {
        if (onPageSelectionChange) {
            onPageSelectionChange(selection);
        }
        // Keep the old array contract for the existing UI and tests.  A
        // large lazy selection has no safe legacy representation, so the
        // model callback is the source of truth in that case.
        if (!usesPageSelectionModel || pageSelectionCount(selection) <= LEGACY_SELECTION_MATERIALIZATION_LIMIT) {
            onSelectedPagesChange(materializePageSelection(selection));
        }
    }

    function clampPage(page: number) {
        return Math.min(Math.max(1, page), Math.max(1, totalPages.value));
    }

    function isSelected(page: number) {
        return usesPageSelectionModel
            ? isPageSelected(getPageSelection(), page)
            : selectedPagesSet.value?.has(page) === true;
    }

    /**
     * The single row that carries `tabindex=0`. Keyboard focus is deliberately
     * independent of selection, and it is clamped into the virtualized window
     * so the rail always keeps exactly one tab stop even after the user has
     * scrolled the focused row out of the rendered range.
     */
    const rovingFocusPage = computed(() => {
        const pages = renderedPages.value;
        const firstRenderedPage = pages[0];
        const lastRenderedPage = pages.at(-1);
        if (firstRenderedPage === undefined || lastRenderedPage === undefined) {
            return null;
        }

        const target = keyboardFocusPage.value ?? clampPage(currentPage.value);
        return Math.min(Math.max(target, firstRenderedPage), lastRenderedPage);
    });

    function focusThumbnailPage(page: number) {
        keyboardFocusPage.value = page;
        const scrollResult = scrollPageIntoKeyboardView(page);
        if (scrollResult && typeof scrollResult.then === 'function') {
            void scrollResult.then(() => focusPageElement(page));
            return;
        }
        focusPageElement(page);
    }

    function handleContainerFocusIn(event: FocusEvent) {
        const page = resolveRowPageFromElement(event.target);
        if (page !== null && page >= 1 && page <= totalPages.value) {
            keyboardFocusPage.value = page;
        }
    }

    function getThumbnailSelectionFallbackAnchor() {
        if (totalPages.value <= 0) {
            return null;
        }
        return clampPage(currentPage.value);
    }

    function handleThumbnailClick(event: MouseEvent, page: number) {
        if (consumeClickSkip()) {
            return;
        }

        keyboardFocusPage.value = page;
        if (!shouldSelectPageFromThumbnailClick(event)) {
            onGoToPage(page);
            return;
        }

        if (usesPageSelectionModel) {
            let nextSelection: TPageSelection;
            if (event.shiftKey) {
                const anchor = multiSelection.anchor.value
                    ?? getThumbnailSelectionFallbackAnchor()
                    ?? page;
                nextSelection = createRangePageSelection(
                    totalPages.value,
                    Math.min(anchor, page),
                    Math.max(anchor, page),
                );
                multiSelection.anchor.value = anchor;
            } else if (event.metaKey || event.ctrlKey) {
                nextSelection = togglePageSelection(getPageSelection(), page);
            } else {
                nextSelection = createExplicitPageSelection(totalPages.value, [page]);
            }
            selectionFocusPage.value = page;
            notifyPageSelection(nextSelection);
            return;
        }

        // A legacy consumer only accepts a page array. Keep ordinary document
        // semantics, but refuse a range that would require a page-sized array.
        if (totalPages.value > LEGACY_SELECTION_MATERIALIZATION_LIMIT) {
            if (event.shiftKey) {
                onSelectionRefused({
                    kind: 'page-count-limit',
                    limit: LEGACY_SELECTION_MATERIALIZATION_LIMIT,
                    pageCount: totalPages.value,
                });
                return;
            }
            if (event.metaKey || event.ctrlKey) {
                toggleSinglePageSelection(page);
                return;
            }
            multiSelection.selected.value = new Set([page]);
            multiSelection.anchor.value = page;
            selectionFocusPage.value = page;
            onSelectedPagesChange([page]);
            return;
        }

        // The legacy path retains its Set semantics for ordinary documents.
        const allPages = Array.from({length: totalPages.value}, (_value, index) => index + 1);
        multiSelection.toggle(page, allPages, {
            shift: event.shiftKey,
            meta: event.metaKey || event.ctrlKey,
            fallbackAnchor: event.shiftKey ? getThumbnailSelectionFallbackAnchor() : null,
        });
        selectionFocusPage.value = page;
        const normalized = normalizeSelectedPageNumbers(
            Array.from(multiSelection.selected.value),
            totalPages.value,
        );
        onSelectedPagesChange(normalized);
    }

    function toggleSinglePageSelection(page: number) {
        if (usesPageSelectionModel) {
            const nextSelection = togglePageSelection(getPageSelection(), page);
            multiSelection.anchor.value = page;
            selectionFocusPage.value = page;
            notifyPageSelection(nextSelection);
            return;
        }
        const nextSelection = new Set(selectedPages.value);
        if (nextSelection.has(page)) {
            nextSelection.delete(page);
        } else {
            nextSelection.add(page);
        }
        multiSelection.selected.value = nextSelection;
        multiSelection.anchor.value = page;
        selectionFocusPage.value = page;
        onSelectedPagesChange(normalizeSelectedPageNumbers(
            Array.from(nextSelection),
            totalPages.value,
        ));
    }

    function handleThumbnailContextMenu(event: MouseEvent, page: number) {
        const selection = resolveThumbnailContextMenuSelection(
            page,
            getPageSelection(),
            totalPages.value,
        );
        onContextMenu({
            clientX: event.clientX,
            clientY: event.clientY,
            clickedPage: page,
            pages: pageSelectionCount(selection) <= 100_000
                ? materializePageSelection(selection)
                : [],
            selection,
        });
    }

    function getKeyboardSelectionBasePage() {
        if (
            selectionFocusPage.value !== null
            && selectionFocusPage.value >= 1
            && selectionFocusPage.value <= totalPages.value
        ) {
            return selectionFocusPage.value;
        }

        const normalized = normalizeSelectedPageNumbers(selectedPages.value, totalPages.value);
        return normalized.at(-1) ?? clampPage(currentPage.value);
    }

    function getKeyboardSelectionAnchorPage(basePage: number) {
        if (
            multiSelection.anchor.value !== null
            && multiSelection.anchor.value >= 1
            && multiSelection.anchor.value <= totalPages.value
        ) {
            return multiSelection.anchor.value;
        }

        const normalized = normalizeSelectedPageNumbers(selectedPages.value, totalPages.value);
        return normalized[0] ?? basePage;
    }

    function resolveArrowDirection(key: string) {
        if (key === 'ArrowUp' || key === 'ArrowLeft') {
            return -1;
        }
        if (key === 'ArrowDown' || key === 'ArrowRight') {
            return 1;
        }
        return 0;
    }

    function extendSelectionByArrow(event: KeyboardEvent, direction: number) {
        event.preventDefault();
        markUserInteraction('keyboard-selection');

        const basePage = getKeyboardSelectionBasePage();
        const nextFocusPage = clampPage(basePage + direction);
        const anchorPage = getKeyboardSelectionAnchorPage(basePage);
        if (usesPageSelectionModel) {
            const nextSelection = createRangePageSelection(
                totalPages.value,
                Math.min(anchorPage, nextFocusPage),
                Math.max(anchorPage, nextFocusPage),
            );
            multiSelection.anchor.value = anchorPage;
            selectionFocusPage.value = nextFocusPage;
            notifyPageSelection(nextSelection);
            onGoToPage(nextFocusPage);
            focusThumbnailPage(nextFocusPage);
            return;
        }

        if (totalPages.value > LEGACY_SELECTION_MATERIALIZATION_LIMIT) {
            onSelectionRefused({
                kind: 'page-count-limit',
                limit: LEGACY_SELECTION_MATERIALIZATION_LIMIT,
                pageCount: totalPages.value,
            });
            return;
        }

        const allPages = Array.from({length: totalPages.value}, (_value, index) => index + 1);

        multiSelection.anchor.value = anchorPage;
        multiSelection.toggle(nextFocusPage, allPages, {shift: true});
        selectionFocusPage.value = nextFocusPage;

        const normalized = normalizeSelectedPageNumbers(
            Array.from(multiSelection.selected.value),
            totalPages.value,
        );
        onSelectedPagesChange(normalized);
        onGoToPage(nextFocusPage);
        focusThumbnailPage(nextFocusPage);
    }

    function resolveKeyboardFocusTarget(key: string, basePage: number) {
        const direction = resolveArrowDirection(key);
        if (direction !== 0) {
            return basePage + direction;
        }
        if (key === 'PageUp') {
            return basePage - PAGE_KEYBOARD_STEP;
        }
        if (key === 'PageDown') {
            return basePage + PAGE_KEYBOARD_STEP;
        }
        if (key === 'Home') {
            return 1;
        }
        if (key === 'End') {
            return totalPages.value;
        }
        return null;
    }

    function isActivationKey(key: string) {
        return key === 'Enter' || key === ' ' || key === 'Spacebar';
    }

    function resolveKeyboardMoveRanges(basePage: number) {
        const selection = getPageSelection();
        const selectionCount = pageSelectionCount(selection);
        if (selectionCount > LEGACY_SELECTION_MATERIALIZATION_LIMIT) {
            return [{
                startPage: basePage,
                endPage: basePage,
            }];
        }

        const ranges = [...iteratePageSelectionRanges(selection)];
        return ranges.length > 0 && isPageSelected(selection, basePage)
            ? ranges
            : [{
                startPage: basePage,
                endPage: basePage,
            }];
    }

    function moveFocusedPagesByKeyboard(event: KeyboardEvent, direction: -1 | 1) {
        if (!onMove && !onReorder) {
            return false;
        }

        const focusedPage = rovingFocusPage.value;
        if (focusedPage === null || totalPages.value <= 0) {
            return false;
        }

        const ranges = resolveKeyboardMoveRanges(focusedPage);
        const firstRange = ranges[0];
        const lastRange = ranges.at(-1);
        if (!firstRange || !lastRange) {
            return false;
        }

        const insertAt = direction < 0
            ? firstRange.startPage - 2
            : lastRange.endPage + 1;
        const move = createPageMoveRanges(
            totalPages.value,
            ranges,
            Math.min(Math.max(0, insertAt), totalPages.value),
        );
        if (isPageMoveOperationNoOp(move)) {
            return false;
        }
        const firstMoveRange = move.ranges[0];
        if (!firstMoveRange) {
            return false;
        }

        event.preventDefault();
        markUserInteraction('keyboard-reorder');
        const operation: TPageMoveOperation = move.ranges.length === 1
            ? createPageMoveRange(
                move.pageCount,
                firstMoveRange.startPage,
                firstMoveRange.endPage,
                move.insertAt,
            )
            : move;
        if (onMove) {
            onMove(operation);
        } else if (onReorder) {
            onReorder('ranges' in operation
                ? buildPageMoveRangesOrder(operation)
                : buildPageMoveOrder(operation));
        }

        const nextFocusPage = mapPageNumberAfterPageMove(focusedPage, operation);
        void nextTick(() => focusThumbnailPage(clampPage(nextFocusPage)));
        return true;
    }

    function handleContainerKeyDown(event: KeyboardEvent) {
        if (
            totalPages.value <= 0
            || isDragging.value
            || isExternalDragOver.value
            || isNestedRowControl(event.target)
        ) {
            return;
        }

        if (
            event.altKey
            && !event.shiftKey
            && !event.metaKey
            && !event.ctrlKey
        ) {
            const direction = resolveArrowDirection(event.key);
            if (direction !== 0 && moveFocusedPagesByKeyboard(event, direction < 0 ? -1 : 1)) {
                return;
            }
        }

        if (event.altKey || event.metaKey || event.ctrlKey) {
            return;
        }

        if (event.shiftKey) {
            const direction = resolveArrowDirection(event.key);
            if (direction !== 0) {
                extendSelectionByArrow(event, direction);
            }
            return;
        }

        const focusedPage = rovingFocusPage.value;
        if (focusedPage === null) {
            return;
        }
        if (isActivationKey(event.key)) {
            event.preventDefault();
            markUserInteraction('keyboard-activate');
            onGoToPage(focusedPage);
            return;
        }

        const target = resolveKeyboardFocusTarget(event.key, focusedPage);
        if (target === null) {
            return;
        }

        event.preventDefault();
        markUserInteraction('keyboard-focus');
        focusThumbnailPage(clampPage(target));
    }

    function syncInternalSelection(normalized: number[]) {
        if (usesPageSelectionModel) {
            if (normalized.length === 0) {
                multiSelection.anchor.value = null;
                selectionFocusPage.value = null;
            }
            return;
        }
        multiSelection.selected.value = new Set(normalized);

        if (normalized.length === 0) {
            multiSelection.anchor.value = null;
            selectionFocusPage.value = null;
            return;
        }

        if (
            multiSelection.anchor.value === null ||
            !normalized.includes(multiSelection.anchor.value)
        ) {
            multiSelection.anchor.value = normalized[normalized.length - 1] ?? null;
        }
        if (
            selectionFocusPage.value === null ||
            !normalized.includes(selectionFocusPage.value)
        ) {
            selectionFocusPage.value = normalized[normalized.length - 1] ?? null;
        }
    }

    watch(
        [
            () => selectedPages.value.join(','),
            () => selectedPageSelection?.value,
            totalPages,
        ],
        () => {
            if (usesPageSelectionModel) {
                const selection = selectedPageSelection?.value;
                if (!selection || selection.pageCount !== totalPages.value) {
                    return;
                }
                if (pageSelectionCount(selection) === 0) {
                    multiSelection.anchor.value = null;
                    selectionFocusPage.value = null;
                }
                if (keyboardFocusPage.value !== null) {
                    keyboardFocusPage.value = totalPages.value <= 0 ? null : clampPage(keyboardFocusPage.value);
                }
                return;
            }
            const pages = selectedPages.value;
            const normalized = normalizeSelectedPageNumbers(pages, totalPages.value);
            if (!arePageNumberListsEqual(normalized, pages)) {
                onSelectedPagesChange(normalized);
            }

            syncInternalSelection(normalized);
            if (keyboardFocusPage.value !== null) {
                keyboardFocusPage.value = totalPages.value <= 0 ? null : clampPage(keyboardFocusPage.value);
            }
        },
        {immediate: true},
    );

    return {
        handleContainerFocusIn,
        handleContainerKeyDown,
        handleThumbnailClick,
        handleThumbnailContextMenu,
        isSelected,
        rovingFocusPage,
        selectedPagesSet,
        toggleSinglePageSelection,
    };
};
