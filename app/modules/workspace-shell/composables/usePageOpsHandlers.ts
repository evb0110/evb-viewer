import type { Ref } from 'vue';
import { difference } from 'es-toolkit/array';
import { range } from 'es-toolkit/math';
import type { ICropMargins } from '@app/types/crop';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';
import type {IPdfPageLabelRange} from '@contracts/pdfPageLabels';
import {
    getPageIdentityDeltaNextPageCount,
    mapPageNumberThroughPageIdentityDelta,
    type IPageIdentityDelta,
} from '@contracts/electronApiPageOps';
import type {
    IPageMoveRangeSegment,
    TPageMoveOperation,
    TPageSelection,
} from '@contracts/pageNumbers';
import {
    createAllPageSelection,
    createExplicitPageSelection,
    createMappedPageSelection,
    invertPageSelection,
    iteratePageSelectionRanges,
    materializePageSelection,
    mapPageNumberAfterPageMove,
    pageSelectionCount,
} from '@contracts/pageNumbers';
import { usePageOperations } from '@app/modules/pdf-viewer/public';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import { runDetached } from '@app/utils/asyncGuard';
import { getDocumentWorkingCopyCapability } from '@app/utils/platformDocuments';

type TPageSelectionInput = number[] | TPageSelection;
const PAGE_OPERATION_RANGE_LIMIT = 100_000;

interface IPdfViewerForPageOps {
    invalidatePages: (pages: number[]) => void;
    remapPageIdentityDelta?: (delta: IPageIdentityDelta) => void;
}

export interface IPageOpsHandlersDeps {
    workingCopyPath: Ref<TDocumentRef | null>;
    documentRevisionToken?: Ref<TDocumentRevisionToken | null>;
    pageLabels: Ref<string[] | null>;
    pageLabelRanges?: Ref<IPdfPageLabelRange[]>;
    pageLabelsResolved?: Ref<boolean>;
    bookmarkItems: Ref<IPdfBookmarkEntry[]>;
    bookmarksResolved?: Ref<boolean>;
    currentPage: Ref<number>;
    totalPages: Ref<number>;
    selectedThumbnailPages: Ref<number[]>;
    setSelectedThumbnailPages: (pages: number[]) => void;
    selectedPageSelection?: Ref<TPageSelection | null>;
    setSelectedPageSelection?: (selection: TPageSelection) => void;
    invalidateThumbnailPages: (pages: number[]) => void;
    pdfViewerRef: Ref<IPdfViewerForPageOps | null>;
    pageContextMenu: Ref<{
        visible: boolean;
        clickedPage?: number | null;
        pages: number[];
        selection?: TPageSelection | null;
    }>;
    closePageContextMenu: () => void;
    onExportPages: (pages: TPageSelectionInput) => void;
    canMutatePages?: Ref<boolean>;
    onExtractedDocument?: (path: TDocumentRef) => Promise<void> | void;
    ensureHistoryBaselineForMutation: () => Promise<boolean>;
    saveAnnotationsForPageMutation: () => Promise<boolean>;
    reloadWorkingCopyIntoHistory: (opts?: { markDirty?: boolean }) => Promise<boolean>;
    preparePdfReloadWaiter: (
        pageToRestore: number,
        opts?: { captureScrollSnapshot?: boolean },
    ) => {
        promise: Promise<void>;
        cancel: () => void;
    };
    clearOcrCache: (path: TDocumentRef) => void;
    resetSearchCache: () => void;
    ensureWorkingCopyFreshForRead?: () => Promise<boolean>;
    runWithDocumentOperationLease?: <T>(
        kind: TDocumentOperationKind,
        operation: () => Promise<T>,
    ) => Promise<T>;
}

export const usePageOpsHandlers = (deps: IPageOpsHandlersDeps) => {
    const {
        workingCopyPath,
        documentRevisionToken,
        pageLabels,
        pageLabelRanges,
        pageLabelsResolved,
        bookmarkItems,
        bookmarksResolved,
        currentPage,
        totalPages,
        selectedThumbnailPages,
        setSelectedThumbnailPages,
        selectedPageSelection,
        setSelectedPageSelection,
        pageContextMenu,
        closePageContextMenu,
        onExportPages,
        canMutatePages,
        onExtractedDocument,
        ensureHistoryBaselineForMutation,
        saveAnnotationsForPageMutation,
        reloadWorkingCopyIntoHistory,
        preparePdfReloadWaiter,
        clearOcrCache,
        resetSearchCache,
        ensureWorkingCopyFreshForRead,
        runWithDocumentOperationLease,
    } = deps;

    function runPageOperationDetached(label: string, task: () => Promise<unknown>) {
        return runDetached(task, {
            category: 'user-visible-operation',
            scope: 'page-operations',
            message: `Failed to ${label}`,
        });
    }

    const {
        isOperationInProgress: isPageOperationInProgress,
        batchProgress: pageOpBatchProgress,
        lastOutcome: lastPageOperationOutcome,
        deletePages: pageOpsDelete,
        deletePageRanges: pageOpsDeleteRanges,
        extractPages: pageOpsExtract,
        rotatePages: pageOpsRotate,
        insertPages: pageOpsInsert,
        insertFile: pageOpsInsertFile,
        reorderPages: pageOpsReorder,
        movePages: pageOpsMove,
        cropPages: pageOpsCrop,
        removeCrop: pageOpsRemoveCrop,
    } = usePageOperations({
        workingCopyPath,
        ...(documentRevisionToken !== undefined ? { documentRevisionToken } : {}),
        pageLabels,
        ...(pageLabelRanges !== undefined ? {pageLabelRanges} : {}),
        ...(pageLabelsResolved !== undefined ? {pageLabelsResolved} : {}),
        bookmarkItems,
        ...(bookmarksResolved !== undefined ? {bookmarksResolved} : {}),
        ensureHistoryBaselineForMutation,
        saveAnnotationsForPageMutation,
        reloadWorkingCopyIntoHistory,
        clearOcrCache,
        resetSearchCache,
        ...(ensureWorkingCopyFreshForRead !== undefined ? { ensureWorkingCopyFreshForRead } : {}),
        ...(onExtractedDocument !== undefined ? { onExtractedDocument } : {}),
        ...(runWithDocumentOperationLease !== undefined ? { runWithDocumentOperationLease } : {}),
    });

    const hasPageSelectionModel = selectedPageSelection !== undefined
        && setSelectedPageSelection !== undefined;

    function getCurrentPageSelection(): TPageSelection {
        const selection = selectedPageSelection?.value;
        if (selection && selection.pageCount === totalPages.value) {
            return selection;
        }
        return createExplicitPageSelection(totalPages.value, selectedThumbnailPages.value);
    }

    function normalizePageSelectionInput(
        pages: TPageSelectionInput,
        expectedTotalPages = totalPages.value,
    ): TPageSelection {
        if (Array.isArray(pages)) {
            return createExplicitPageSelection(expectedTotalPages, pages);
        }
        return pages.pageCount === expectedTotalPages
            ? pages
            : createExplicitPageSelection(expectedTotalPages, []);
    }

    function publishPageSelection(selection: TPageSelection) {
        if (hasPageSelectionModel) {
            setSelectedPageSelection(selection);
        }
        // Existing consumers still use the array for menus and small-document
        // operations. Keep that compatibility without expanding a large lazy
        // selection into a document-sized renderer collection.
        setSelectedThumbnailPages(pageSelectionCount(selection) <= 100_000
            ? materializePageSelection(selection)
            : []);
    }

    function collectCompactPageSelectionRanges(selection: TPageSelection): IPageMoveRangeSegment[] | null {
        const ranges: IPageMoveRangeSegment[] = [];
        for (const range of iteratePageSelectionRanges(selection)) {
            ranges.push(range);
            if (ranges.length > PAGE_OPERATION_RANGE_LIMIT) {
                return null;
            }
        }
        return ranges;
    }

    function getDeleteRangesForSelection(
        selection: TPageSelection,
        expectedTotalPages: number,
    ): IPageMoveRangeSegment[] | null {
        const selectedCount = pageSelectionCount(selection);
        if (selectedCount === 0) {
            return [];
        }
        if (selectedCount >= expectedTotalPages) {
            // Keep the first page so qpdf never has to create an empty PDF.
            return expectedTotalPages > 1
                ? [{
                    startPage: 2,
                    endPage: expectedTotalPages,
                }]
                : [];
        }
        return collectCompactPageSelectionRanges(selection);
    }

    function isPdfPageOperationBlocked() {
        return canMutatePages?.value === false;
    }

    async function runStructuralPageMutation(
        run: () => Promise<boolean>,
        remapSelection: (pages: readonly number[]) => number[] = () => [],
    ) {
        if (isPdfPageOperationBlocked()) {
            return false;
        }
        const didSucceed = await run();
        if (didSucceed) {
            const outcome = lastPageOperationOutcome?.value;
            const delta = outcome?.status === 'succeeded' && 'pageIdentityDelta' in outcome.result
                ? outcome.result.pageIdentityDelta
                : undefined;
            if (delta) {
                const mappedPageNumber = mapPageNumberThroughPageIdentityDelta(delta, currentPage.value);
                const nextPageCount = getPageIdentityDeltaNextPageCount(delta);
                currentPage.value = mappedPageNumber
                    ?? Math.min(currentPage.value, nextPageCount ?? currentPage.value);
                deps.pdfViewerRef.value?.remapPageIdentityDelta?.(delta);
            }
            setSelectedThumbnailPages(remapSelection(selectedThumbnailPages.value));
        }
        return didSucceed;
    }

    async function pageOpsDeleteAndClearSelection(
        pages: TPageSelectionInput,
        expectedTotalPages: number,
    ) {
        if (!Array.isArray(pages)) {
            const selection = normalizePageSelectionInput(pages, expectedTotalPages);
            const selectedCount = pageSelectionCount(selection);
            if (selectedCount === 0) {
                return false;
            }

            const compactDeleteRanges = getDeleteRangesForSelection(selection, expectedTotalPages);
            if (compactDeleteRanges !== null) {
                if (compactDeleteRanges.length === 0) {
                    return false;
                }
                const deletedCount = compactDeleteRanges.reduce(
                    (count, range) => count + range.endPage - range.startPage + 1,
                    0,
                );
                const didDelete = await runStructuralPageMutation(
                    () => pageOpsDeleteRanges(compactDeleteRanges, expectedTotalPages),
                );
                if (!didDelete) {
                    return false;
                }
                publishPageSelection({
                    kind: 'none',
                    pageCount: Math.max(0, expectedTotalPages - deletedCount),
                });
                return true;
            }

            const didDelete = await runStructuralPageMutation(
                () => pageOpsDelete(selection, expectedTotalPages),
            );
            if (didDelete) {
                publishPageSelection({
                    kind: 'none',
                    pageCount: expectedTotalPages - selectedCount,
                });
            }
            return didDelete;
        }
        const deleted = new Set(pages);
        return runStructuralPageMutation(
            () => pageOpsDelete(pages, expectedTotalPages),
            selection => selection.flatMap((page) => {
                if (deleted.has(page)) {
                    return [];
                }
                return [page - pages.filter(deletedPage => deletedPage < page).length];
            }),
        );
    }

    async function pageOpsInsertAndClearSelection(expectedTotalPages: number, afterPage: number) {
        return runStructuralPageMutation(() => pageOpsInsert(expectedTotalPages, afterPage));
    }

    async function pageOpsInsertFileAndClearSelection(
        expectedTotalPages: number,
        afterPage: number,
        filePaths: TDocumentRef[],
    ) {
        return runStructuralPageMutation(() => pageOpsInsertFile(expectedTotalPages, afterPage, filePaths));
    }

    async function pageOpsReorderAndClearSelection(newOrder: number[]) {
        const newPageByOldPage = new Map(newOrder.map((oldPage, index) => [
            oldPage,
            index + 1,
        ]));
        return runStructuralPageMutation(
            () => pageOpsReorder(newOrder),
            selection => selection.flatMap(page => newPageByOldPage.get(page) ?? []),
        );
    }

    async function pageOpsMoveAndClearSelection(move: TPageMoveOperation) {
        const selectionBeforeMove = selectedPageSelection?.value;
        const didMove = await runStructuralPageMutation(
            () => pageOpsMove(move),
            selection => selection
                .map(page => mapPageNumberAfterPageMove(page, move))
                .sort((left, right) => left - right),
        );
        if (didMove && hasPageSelectionModel && selectionBeforeMove?.pageCount === move.pageCount) {
            publishPageSelection(createMappedPageSelection(selectionBeforeMove, move));
        }
        return didMove;
    }

    async function pageOpsExtractWithDjvuGuard(pages: TPageSelectionInput) {
        if (isPdfPageOperationBlocked()) {
            return false;
        }
        if (Array.isArray(pages)) {
            return pageOpsExtract(pages);
        }
        const selection = normalizePageSelectionInput(pages);
        if (pageSelectionCount(selection) === 0) {
            return false;
        }
        return pageOpsExtract(selection);
    }

    function handlePageContextMenuDelete() {
        const pages = pageContextMenu.value.selection ?? pageContextMenu.value.pages;
        closePageContextMenu();
        void runPageOperationDetached('delete PDF pages', () => pageOpsDeleteAndClearSelection(pages, totalPages.value));
    }

    function handlePageContextMenuExtract() {
        const pages = pageContextMenu.value.selection ?? pageContextMenu.value.pages;
        closePageContextMenu();
        void runPageOperationDetached('extract PDF pages', () => pageOpsExtractWithDjvuGuard(pages));
    }

    function handlePageContextMenuExport() {
        const pages = pageContextMenu.value.selection ?? pageContextMenu.value.pages;
        closePageContextMenu();
        if (isPdfPageOperationBlocked()) {
            return;
        }
        onExportPages(Array.isArray(pages) ? [...pages] : pages);
    }

    async function handlePageRotate(pages: TPageSelectionInput, angle: 90 | 180 | 270) {
        if (isPdfPageOperationBlocked()) {
            return false;
        }
        const reloadWaiter = preparePdfReloadWaiter(currentPage.value, { captureScrollSnapshot: false });
        const selection = normalizePageSelectionInput(pages);
        if (pageSelectionCount(selection) === 0) {
            reloadWaiter.cancel();
            return false;
        }
        const didRotate = await pageOpsRotate(
            selection,
            totalPages.value,
            angle,
        );
        if (!didRotate) {
            reloadWaiter.cancel();
            return false;
        }
        await reloadWaiter.promise;
        return true;
    }

    function handlePageContextMenuRotateCw() {
        const pages = pageContextMenu.value.selection ?? pageContextMenu.value.pages;
        closePageContextMenu();
        void runPageOperationDetached('rotate PDF pages', () => handlePageRotate(pages, 90));
    }

    function handlePageContextMenuRotateCcw() {
        const pages = pageContextMenu.value.selection ?? pageContextMenu.value.pages;
        closePageContextMenu();
        void runPageOperationDetached('rotate PDF pages', () => handlePageRotate(pages, 270));
    }

    function handlePageContextMenuInsertBefore() {
        const clickedPage = pageContextMenu.value.clickedPage ?? pageContextMenu.value.pages[0];
        closePageContextMenu();
        if (clickedPage === undefined) {
            return;
        }
        void runPageOperationDetached(
            'insert PDF pages',
            () => pageOpsInsertAndClearSelection(totalPages.value, clickedPage - 1),
        );
    }

    function handlePageContextMenuInsertAfter() {
        const clickedPage = pageContextMenu.value.clickedPage ?? pageContextMenu.value.pages[0];
        closePageContextMenu();
        if (clickedPage === undefined) {
            return;
        }
        void runPageOperationDetached(
            'insert PDF pages',
            () => pageOpsInsertAndClearSelection(totalPages.value, clickedPage),
        );
    }

    function handlePageFileDrop(payload: {
        afterPage: number;
        filePaths: TDocumentRef[];
    }) {
        const cleanupDroppedFiles = async () => {
            await Promise.allSettled(payload.filePaths.map(path => (
                getDocumentWorkingCopyCapability().cleanupFile(path)
            )));
        };
        if (isPdfPageOperationBlocked()) {
            return cleanupDroppedFiles();
        }
        return runPageOperationDetached(
            'insert PDF files',
            () => pageOpsInsertFileAndClearSelection(totalPages.value, payload.afterPage, payload.filePaths),
        ).then(cleanupDroppedFiles);
    }

    function handlePageContextMenuSelectAll() {
        closePageContextMenu();
        if (totalPages.value <= 0) {
            return;
        }
        if (hasPageSelectionModel) {
            publishPageSelection(createAllPageSelection(totalPages.value));
            return;
        }
        const allPages = range(1, totalPages.value + 1);
        setSelectedThumbnailPages(allPages);
    }

    function handlePageContextMenuInvertSelection() {
        closePageContextMenu();
        if (totalPages.value <= 0) {
            return;
        }
        if (hasPageSelectionModel) {
            publishPageSelection(invertPageSelection(getCurrentPageSelection()));
            return;
        }
        setSelectedThumbnailPages(difference(
            range(1, totalPages.value + 1),
            selectedThumbnailPages.value,
        ));
    }

    async function handleCropPages(pages: number[] | TPageSelection, margins: ICropMargins) {
        if (isPdfPageOperationBlocked()) {
            return false;
        }
        // Cropping changes page geometry, so forcing selective rerendering
        // reuses stale layout metrics and can visibly stretch pages.
        const reloadWaiter = preparePdfReloadWaiter(currentPage.value, { captureScrollSnapshot: false });
        const didCrop = await pageOpsCrop(pages, totalPages.value, margins);
        if (!didCrop) {
            reloadWaiter.cancel();
            return false;
        }
        await reloadWaiter.promise;
        return true;
    }

    async function handleRemoveCrop(pages: number[] | TPageSelection) {
        if (isPdfPageOperationBlocked()) {
            return false;
        }
        // Removing crop also changes the effective viewport size.
        const reloadWaiter = preparePdfReloadWaiter(currentPage.value, { captureScrollSnapshot: false });
        const didRemoveCrop = await pageOpsRemoveCrop(pages, totalPages.value);
        if (!didRemoveCrop) {
            reloadWaiter.cancel();
            return false;
        }
        await reloadWaiter.promise;
        return true;
    }

    return {
        isPageOperationInProgress,
        pageOpBatchProgress,
        lastPageOperationOutcome,
        pageOpsDelete: pageOpsDeleteAndClearSelection,
        pageOpsExtract: pageOpsExtractWithDjvuGuard,
        pageOpsInsert: pageOpsInsertAndClearSelection,
        pageOpsReorder: pageOpsReorderAndClearSelection,
        pageOpsMove: pageOpsMoveAndClearSelection,
        handlePageContextMenuDelete,
        handlePageContextMenuExtract,
        handlePageContextMenuExport,
        handlePageRotate,
        handlePageContextMenuRotateCw,
        handlePageContextMenuRotateCcw,
        handlePageContextMenuInsertBefore,
        handlePageContextMenuInsertAfter,
        handlePageFileDrop,
        handlePageContextMenuSelectAll,
        handlePageContextMenuInvertSelection,
        handleCropPages,
        handleRemoveCrop,
    };
};
