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
import {
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
    const page = Number(target.closest<HTMLElement>('[data-thumbnail-page]')?.dataset.thumbnailPage);
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
        scrollPageIntoKeyboardView,
        selectedPages = computed(() => []),
        selectedPageSelection,
        totalPages,
    } = options;

    const anchorPage = ref<number | null>(null);
    const selectionFocusPage = ref<number | null>(null);
    const keyboardFocusPage = ref<number | null>(null);

    /** The view's selection; an array-only parent's pages read as an explicit selection. */
    const pageSelection = computed<TPageSelection>(() => {
        const selection = selectedPageSelection?.value;
        if (onPageSelectionChange && selection && selection.pageCount === totalPages.value) {
            return selection;
        }
        return createExplicitPageSelection(
            totalPages.value,
            normalizeSelectedPageNumbers(selectedPages.value, totalPages.value),
        );
    });
    const hasSelection = computed(() => pageSelectionCount(pageSelection.value) > 0);
    watch(pageSelection, (selection) => {
        if (pageSelectionCount(selection) === 0) {
            anchorPage.value = null;
            selectionFocusPage.value = null;
        }
    }, {immediate: true});

    /**
     * A gesture's anchor or focus counts while something is selected and its
     * page exists. For an array-only parent it must be selected, else the
     * last selected page stands in.
     */
    function liveSelectionPage(page: number | null) {
        if (!hasSelection.value) {
            return null;
        }
        if (!onPageSelectionChange) {
            return page !== null && isPageSelected(pageSelection.value, page)
                ? page
                : normalizeSelectedPageNumbers(selectedPages.value, totalPages.value).at(-1) ?? null;
        }
        return page !== null && page >= 1 && page <= totalPages.value ? page : null;
    }

    /**
     * Publishes a gesture's selection. An array-only parent cannot hold a
     * selection past the materialization limit, so that gesture is refused.
     */
    function notifyPageSelection(selection: TPageSelection) {
        const fitsArray = pageSelectionCount(selection) <= LEGACY_SELECTION_MATERIALIZATION_LIMIT;
        if (!onPageSelectionChange && !fitsArray) {
            onSelectionRefused({
                kind: 'page-count-limit',
                limit: LEGACY_SELECTION_MATERIALIZATION_LIMIT,
                pageCount: totalPages.value,
            });
            return false;
        }
        onPageSelectionChange?.(selection);
        // A large lazy selection has no safe array form; the model is its owner.
        if (fitsArray) {
            onSelectedPagesChange(materializePageSelection(selection));
        }
        return true;
    }

    function clampPage(page: number) {
        return Math.min(Math.max(1, page), Math.max(1, totalPages.value));
    }

    function isSelected(page: number) {
        return isPageSelected(pageSelection.value, page);
    }

    /** The keyboard-focused row, independent of selection. */
    const rovingFocusPage = computed(() => (
        totalPages.value > 0 ? clampPage(keyboardFocusPage.value ?? currentPage.value) : null
    ));

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

        if (event.shiftKey) {
            const anchor = liveSelectionPage(anchorPage.value)
                ?? getThumbnailSelectionFallbackAnchor()
                ?? page;
            if (notifyPageSelection(createRangePageSelection(
                totalPages.value,
                Math.min(anchor, page),
                Math.max(anchor, page),
            ))) {
                anchorPage.value = anchor;
                selectionFocusPage.value = page;
            }
            return;
        }
        if (notifyPageSelection(event.metaKey || event.ctrlKey
            ? togglePageSelection(pageSelection.value, page)
            : createExplicitPageSelection(totalPages.value, [page]))) {
            selectionFocusPage.value = page;
        }
    }

    function toggleSinglePageSelection(page: number) {
        if (notifyPageSelection(togglePageSelection(pageSelection.value, page))) {
            anchorPage.value = page;
            selectionFocusPage.value = page;
        }
    }

    function handleThumbnailContextMenu(event: MouseEvent, page: number) {
        const selection = resolveThumbnailContextMenuSelection(
            page,
            pageSelection.value,
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
        return liveSelectionPage(selectionFocusPage.value)
            ?? normalizeSelectedPageNumbers(selectedPages.value, totalPages.value).at(-1)
            ?? clampPage(currentPage.value);
    }

    function getKeyboardSelectionAnchorPage(basePage: number) {
        return liveSelectionPage(anchorPage.value)
            ?? normalizeSelectedPageNumbers(selectedPages.value, totalPages.value)[0]
            ?? basePage;
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
        const anchor = getKeyboardSelectionAnchorPage(basePage);
        if (!notifyPageSelection(createRangePageSelection(
            totalPages.value,
            Math.min(anchor, nextFocusPage),
            Math.max(anchor, nextFocusPage),
        ))) {
            return;
        }
        anchorPage.value = anchor;
        selectionFocusPage.value = nextFocusPage;
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
        const selection = pageSelection.value;
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

    return {
        handleContainerFocusIn,
        handleContainerKeyDown,
        handleThumbnailClick,
        handleThumbnailContextMenu,
        isSelected,
        rovingFocusPage,
        toggleSinglePageSelection,
    };
};
