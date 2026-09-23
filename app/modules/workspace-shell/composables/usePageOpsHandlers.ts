import type { Ref } from 'vue';
import { difference } from 'es-toolkit/array';
import { range } from 'es-toolkit/math';
import type { ICropMargins } from '@app/types/crop';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';
import type {IPdfPageLabelRange} from '@contracts/pdfPageLabels';
import {
    requirePageNumber,
    createAllPageSelection,
    createExplicitPageSelection,
    createMappedPageSelection,
    invertPageSelection,
    iteratePageSelectionRanges,
    materializePageSelection,
    mapPageNumberAfterPageMove,
    pageMoveRangesSelectedPageCount,
    pageSelectionCount,
} from '@pdf-core/pdfPageSelection';
import {
    getPageIdentityDeltaNextPageCount,
    mapPageNumberThroughPageIdentityDelta,
    type IPageIdentityDelta,
} from '@contracts/electronApiPageOps';
import type {
    IPageMoveRangeSegment,
    TPageMoveOperation,
    TPageSelection,
} from '@pdf-core/pdfPageSelection';
import { usePageOperations } from '@app/modules/pdf-viewer/public';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import { runDetached } from '@app/utils/asyncGuard';
import { getDocumentWorkingCopyCapability } from '@app/utils/platformDocuments';

type TPageSelectionInput = number[] | TPageSelection;
type TPageRotationDelta = 90 | 180 | 270;
const PAGE_OPERATION_RANGE_LIMIT = 100_000;

export type TPageOperationPresentationKind =
    | 'delete'
    | 'extract'
    | 'insert'
    | 'insertFile'
    | 'reorder'
    | 'move'
    | 'rotate'
    | 'crop'
    | 'removeCrop';

export interface IPageOperationPresentation {
    kind: TPageOperationPresentationKind;
    pageCount: number;
    direction?: 'cw' | 'ccw';
    rotationDelta?: TPageRotationDelta;
}

interface IPdfViewerForPageOps {
    invalidatePages: (pages: number[]) => void;
    remapPageIdentityDelta?: (delta: IPageIdentityDelta) => void;
    preparePageMutationRevisionSwap?: (input: {
        documentRevision: TDocumentRevisionToken;
        invalidatedPages: readonly number[];
        pageNumber: number;
        rotationDelta?: TPageRotationDelta;
    }) => boolean | Promise<boolean>;
    beginPageRotationPreview?: (input: {
        invalidatedPages: readonly number[];
        rotationDelta: TPageRotationDelta;
    }) => boolean | Promise<boolean>;
    cancelPageRotationPreview?: (input: {invalidatedPages: readonly number[]}) => boolean | Promise<boolean>;
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
    invalidateThumbnailPages: (
        pages: number[],
        expectedDocumentRevision?: string,
        options?: {rotationOnly?: boolean},
    ) => void;
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
    let stagedPageIdentityDelta: IPageIdentityDelta | null = null;

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
        cancelState: pageOperationCancelState,
        canCancelOperation: canCancelPageOperation,
        cancelActiveOperation: cancelActivePageOperation,
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
        preparePageMutationRevisionSwap: async ({
            path, result, invalidatedPages,
        }) => {
            const expectedDocumentRevision = result.documentRevision?.documentRef === path
                ? result.documentRevision.token
                : undefined;
            const rotationDelta = pageOperationPresentation.value?.kind === 'rotate'
                ? pageOperationPresentation.value.rotationDelta
                : undefined;
            deps.invalidateThumbnailPages(
                invalidatedPages,
                expectedDocumentRevision,
                {rotationOnly: rotationDelta !== undefined},
            );
            const delta = result.pageIdentityDelta;
            if (delta) {
                const mappedPageNumber = mapPageNumberThroughPageIdentityDelta(
                    delta,
                    requirePageNumber(currentPage.value),
                );
                const nextPageCount = getPageIdentityDeltaNextPageCount(delta);
                currentPage.value = mappedPageNumber
                    ?? Math.min(currentPage.value, nextPageCount ?? currentPage.value);
                stagedPageIdentityDelta = delta;
            }
            if (result.documentRevision?.documentRef !== path) {
                if (rotationDelta !== undefined) {
                    await deps.pdfViewerRef.value?.cancelPageRotationPreview?.({invalidatedPages});
                }
                return;
            }
            try {
                const didPrepare = await deps.pdfViewerRef.value?.preparePageMutationRevisionSwap?.({
                    documentRevision: result.documentRevision.token,
                    invalidatedPages,
                    pageNumber: currentPage.value,
                    ...(rotationDelta === undefined ? {} : {rotationDelta}),
                });
                if (!didPrepare && rotationDelta !== undefined) {
                    await deps.pdfViewerRef.value?.cancelPageRotationPreview?.({invalidatedPages});
                }
            } catch (error) {
                if (rotationDelta !== undefined) {
                    await deps.pdfViewerRef.value?.cancelPageRotationPreview?.({invalidatedPages});
                }
                throw error;
            }
        },
    });

    const hasPageSelectionModel = selectedPageSelection !== undefined
        && setSelectedPageSelection !== undefined;
    const pageOperationPresentation = ref<IPageOperationPresentation | null>(null);

    async function runTrackedPageOperation<TResult>(
        kind: TPageOperationPresentationKind,
        pageCount: number,
        run: () => Promise<TResult>,
        direction?: 'cw' | 'ccw',
        rotationDelta?: TPageRotationDelta,
    ) {
        pageOperationPresentation.value = {
            kind,
            pageCount: Math.max(1, pageCount),
            ...(direction === undefined ? {} : {direction}),
            ...(rotationDelta === undefined ? {} : {rotationDelta}),
        };
        try {
            return await run();
        } finally {
            pageOperationPresentation.value = null;
        }
    }

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
        operation?: IPageOperationPresentation,
    ) {
        if (isPdfPageOperationBlocked()) {
            return false;
        }
        const execute = async () => {
            const didSucceed = await run();
            if (didSucceed) {
                const outcome = lastPageOperationOutcome.value;
                const delta = outcome?.status === 'succeeded' && 'pageIdentityDelta' in outcome.result
                    ? outcome.result.pageIdentityDelta
                    : undefined;
                if (delta) {
                    if (delta !== stagedPageIdentityDelta) {
                        const mappedPageNumber = mapPageNumberThroughPageIdentityDelta(
                            delta,
                            requirePageNumber(currentPage.value),
                        );
                        const nextPageCount = getPageIdentityDeltaNextPageCount(delta);
                        currentPage.value = mappedPageNumber
                            ?? Math.min(currentPage.value, nextPageCount ?? currentPage.value);
                    }
                    stagedPageIdentityDelta = null;
                    deps.pdfViewerRef.value?.remapPageIdentityDelta?.(delta);
                }
                setSelectedThumbnailPages(remapSelection(selectedThumbnailPages.value));
            } else {
                stagedPageIdentityDelta = null;
            }
            return didSucceed;
        };
        return operation
            ? runTrackedPageOperation(operation.kind, operation.pageCount, execute)
            : execute();
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
                    undefined,
                    {
                        kind: 'delete',
                        pageCount: selectedCount,
                    },
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
                undefined,
                {
                    kind: 'delete',
                    pageCount: selectedCount,
                },
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
            {
                kind: 'delete',
                pageCount: pages.length,
            },
        );
    }

    async function pageOpsInsertAndClearSelection(expectedTotalPages: number, afterPage: number) {
        return runStructuralPageMutation(
            () => pageOpsInsert(expectedTotalPages, afterPage),
            undefined,
            {
                kind: 'insert',
                pageCount: 1,
            },
        );
    }

    async function pageOpsInsertFileAndClearSelection(
        expectedTotalPages: number,
        afterPage: number,
        filePaths: TDocumentRef[],
    ) {
        return runStructuralPageMutation(
            () => pageOpsInsertFile(expectedTotalPages, afterPage, filePaths),
            undefined,
            {
                kind: 'insertFile',
                pageCount: filePaths.length,
            },
        );
    }

    async function pageOpsReorderAndClearSelection(newOrder: number[]) {
        const newPageByOldPage = new Map(newOrder.map((oldPage, index) => [
            oldPage,
            index + 1,
        ]));
        return runStructuralPageMutation(
            () => pageOpsReorder(newOrder),
            selection => selection.flatMap(page => newPageByOldPage.get(page) ?? []),
            {
                kind: 'reorder',
                pageCount: newOrder.length,
            },
        );
    }

    async function pageOpsMoveAndClearSelection(move: TPageMoveOperation) {
        const selectionBeforeMove = selectedPageSelection?.value;
        const didMove = await runStructuralPageMutation(
            () => pageOpsMove(move),
            selection => selection
                .map(page => mapPageNumberAfterPageMove(page, move))
                .sort((left, right) => left - right),
            {
                kind: 'move',
                pageCount: 'ranges' in move
                    ? pageMoveRangesSelectedPageCount(move)
                    : move.endPage - move.startPage + 1,
            },
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
            if (pages.length === 0) {
                return false;
            }
            return runTrackedPageOperation(
                'extract',
                pages.length,
                () => pageOpsExtract(pages),
            );
        }
        const selection = normalizePageSelectionInput(pages);
        if (pageSelectionCount(selection) === 0) {
            return false;
        }
        return runTrackedPageOperation(
            'extract',
            pageSelectionCount(selection),
            () => pageOpsExtract(selection),
        );
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
        const selection = normalizePageSelectionInput(pages);
        if (pageSelectionCount(selection) === 0) {
            return false;
        }
        return runTrackedPageOperation(
            'rotate',
            pageSelectionCount(selection),
            async () => {
                const invalidatedPages = Array.isArray(selection)
                    ? [...selection]
                    : materializePageSelection(selection);
                try {
                    await deps.pdfViewerRef.value?.beginPageRotationPreview?.({
                        invalidatedPages,
                        rotationDelta: angle,
                    });
                } catch {
                    // The page operation remains authoritative if the viewer
                    // cannot stage its immediate visual preview.
                }
                const reloadWaiter = preparePdfReloadWaiter(currentPage.value, { captureScrollSnapshot: false });
                try {
                    const didRotate = await pageOpsRotate(
                        selection,
                        totalPages.value,
                        angle,
                    );
                    if (!didRotate) {
                        reloadWaiter.cancel();
                        await deps.pdfViewerRef.value?.cancelPageRotationPreview?.({invalidatedPages});
                        return false;
                    }
                    await reloadWaiter.promise;
                    return true;
                } catch (error) {
                    reloadWaiter.cancel();
                    await deps.pdfViewerRef.value?.cancelPageRotationPreview?.({invalidatedPages});
                    throw error;
                }
            },
            angle === 270 ? 'ccw' : 'cw',
            angle,
        );
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
        const pageCount = Array.isArray(pages) ? pages.length : pageSelectionCount(pages);
        if (pageCount === 0) {
            return false;
        }
        return runTrackedPageOperation('crop', pageCount, async () => {
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
        });
    }

    async function handleRemoveCrop(pages: number[] | TPageSelection) {
        if (isPdfPageOperationBlocked()) {
            return false;
        }
        const pageCount = Array.isArray(pages) ? pages.length : pageSelectionCount(pages);
        if (pageCount === 0) {
            return false;
        }
        return runTrackedPageOperation('removeCrop', pageCount, async () => {
            // Removing crop also changes the effective viewport size.
            const reloadWaiter = preparePdfReloadWaiter(currentPage.value, { captureScrollSnapshot: false });
            const didRemoveCrop = await pageOpsRemoveCrop(pages, totalPages.value);
            if (!didRemoveCrop) {
                reloadWaiter.cancel();
                return false;
            }
            await reloadWaiter.promise;
            return true;
        });
    }

    return {
        isPageOperationInProgress,
        pageOperationPresentation,
        pageOpBatchProgress,
        lastPageOperationOutcome,
        pageOperationCancelState,
        canCancelPageOperation,
        cancelActivePageOperation,
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
