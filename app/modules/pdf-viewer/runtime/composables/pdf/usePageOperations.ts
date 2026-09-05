import type { Ref } from 'vue';
import { clamp } from 'es-toolkit/math';
import type { ICropMargins } from '@app/types/crop';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';
import type {IPdfPageLabelRange} from '@contracts/pdfPageLabels';
import type {
    IPageOpsMutationOptions,
    IPageOpsResult,
    TPageOpsPageSelection,
} from '@contracts/electronApiPageOps';
import type {
    IPageMoveRangeSegment,
    TPageMoveOperation,
    TPageSelection,
} from '@contracts/pageNumbers';
import {
    createExplicitPageSelection,
    iteratePageSelectionRanges,
    pageMoveRangesSelectedPageCount,
    pageSelectionCount,
} from '@contracts/pageNumbers';
import type { TTranslationKey } from '@i18n-app';
import { BrowserLogger } from '@app/utils/browserLogger';
import { useAnalytics } from '@app/composables/useAnalytics';
import {
    getDocumentOpenCapability,
    getPageOpsCapability,
} from '@app/utils/platformDocuments';
import { runWithoutDocumentOperationLease } from '@app/utils/runWithoutDocumentOperationLease';

type TPageOpsRotation = 90 | 180 | 270;
const MAX_PAGE_OP_SELECTION_RANGES = 100_000;
type TPageOperationRunner<TResult extends IPageOpsResult> = (path: TDocumentRef) => Promise<TResult>;
type TPageOperationSuccess<TResult extends IPageOpsResult> = (result: TResult) => boolean;

interface IPageOperationBatchProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

type TPageOperationErrorKey = Extract<
    TTranslationKey,
    | 'errors.pageOps.delete'
    | 'errors.pageOps.extract'
    | 'errors.pageOps.rotate'
    | 'errors.pageOps.insert'
    | 'errors.pageOps.insertFile'
    | 'errors.pageOps.reorder'
    | 'errors.pageOps.crop'
    | 'errors.pageOps.removeCrop'
>;

type TPageOperationStalePhase =
    | 'before-run'
    | 'history-baseline'
    | 'after-run'
    | 'reload'
    | 'after-success';

type TPageOperationBlockedReason =
    | 'missing-working-copy'
    | 'operation-in-progress'
    | 'empty-selection'
    | 'delete-all'
    | 'preflight'
    | 'history-baseline';

type TPageOperationOutcome<TResult extends IPageOpsResult = IPageOpsResult> =
    | {
        status: 'succeeded';
        result: TResult;
    }
    | {
        status: 'blocked';
        reason: TPageOperationBlockedReason;
    }
    | {
        status: 'canceled';
        result?: TResult;
    }
    | {
        status: 'stale';
        phase: TPageOperationStalePhase;
    }
    | {
        status: 'failed';
        error: string;
        result?: TResult;
    };

function didPageOperationSucceed(outcome: TPageOperationOutcome) {
    return outcome.status === 'succeeded';
}

export const usePageOperations = (deps: {
    workingCopyPath: Ref<TDocumentRef | null>;
    documentRevisionToken?: Ref<TDocumentRevisionToken | null>;
    pageLabels?: Ref<string[] | null>;
    pageLabelRanges?: Ref<IPdfPageLabelRange[]>;
    pageLabelsResolved?: Ref<boolean>;
    bookmarkItems?: Ref<IPdfBookmarkEntry[]>;
    bookmarksResolved?: Ref<boolean>;
    ensureHistoryBaselineForMutation: () => Promise<boolean>;
    saveAnnotationsForPageMutation?: () => Promise<boolean>;
    reloadWorkingCopyIntoHistory: (opts?: { markDirty?: boolean }) => Promise<boolean>;
    clearOcrCache: (path: TDocumentRef) => void;
    resetSearchCache: () => void;
    onExtractedDocument?: (path: TDocumentRef) => Promise<void> | void;
    ensureWorkingCopyFreshForRead?: () => Promise<boolean>;
    runWithDocumentOperationLease?: <T>(
        kind: TDocumentOperationKind,
        operation: () => Promise<T>,
    ) => Promise<T>;
}) => {
    const analytics = useAnalytics();
    const { t } = useTypedI18n();
    const { reportRuntimeError } = useRuntimeErrorReports();
    const {
        workingCopyPath,
        documentRevisionToken,
        pageLabels,
        pageLabelRanges,
        pageLabelsResolved,
        bookmarkItems,
        bookmarksResolved,
        ensureHistoryBaselineForMutation,
        saveAnnotationsForPageMutation,
        reloadWorkingCopyIntoHistory,
        clearOcrCache,
        resetSearchCache,
        onExtractedDocument,
        ensureWorkingCopyFreshForRead,
        runWithDocumentOperationLease = runWithoutDocumentOperationLease,
    } = deps;

    const isOperationInProgress = ref(false);
    const error = ref<string | null>(null);
    const batchProgress = ref<IPageOperationBatchProgress | null>(null);
    const lastOutcome = ref<TPageOperationOutcome | null>(null);

    function recordOutcome<TResult extends IPageOpsResult>(
        outcome: TPageOperationOutcome<TResult>,
    ) {
        lastOutcome.value = outcome;
        return outcome;
    }

    function getLocalizedError(errorKey: TPageOperationErrorKey) {
        return t(errorKey, undefined);
    }

    function isCanceledResult(result: IPageOpsResult) {
        return 'canceled' in result
            && result.canceled === true;
    }

    function invalidateCaches(path: TDocumentRef) {
        clearOcrCache(path);
        resetSearchCache();
    }

    function capturePageMutationOptions(): IPageOpsMutationOptions | undefined {
        const token = documentRevisionToken?.value;
        const metadataSnapshot = pageLabels || pageLabelRanges || bookmarkItems
            ? {
                ...(pageLabelsResolved?.value === false ? {} : pageLabels
                    ? {pageLabels: pageLabels.value ? [...pageLabels.value] : null}
                    : {}),
                ...(pageLabelsResolved?.value === false ? {} : pageLabelRanges
                    ? {pageLabelRanges: structuredClone(pageLabelRanges.value)}
                    : {}),
                ...(bookmarksResolved?.value === false ? {} : bookmarkItems
                    ? {bookmarks: structuredClone(bookmarkItems.value)}
                    : {}),
                untitledBookmarkLabel: t('bookmarks.untitled', undefined),
            }
            : undefined;
        if (!token && !metadataSnapshot) {
            return undefined;
        }
        return {
            ...(token ? {expectedDocumentRevisionToken: token} : {}),
            ...(metadataSnapshot ? {metadataSnapshot} : {}),
        };
    }

    function runDeletePageOp(
        path: TDocumentRef,
        pages: TPageOpsPageSelection,
        totalPages: number,
        mutationOptions?: IPageOpsMutationOptions,
    ) {
        return mutationOptions
            ? getPageOpsCapability().delete(path, pages, totalPages, mutationOptions)
            : getPageOpsCapability().delete(path, pages, totalPages);
    }

    function runDeletePageRangesOp(
        path: TDocumentRef,
        ranges: IPageMoveRangeSegment[],
        totalPages: number,
        mutationOptions?: IPageOpsMutationOptions,
    ) {
        return mutationOptions
            ? getPageOpsCapability().deleteRanges(path, ranges, totalPages, mutationOptions)
            : getPageOpsCapability().deleteRanges(path, ranges, totalPages);
    }

    function runRotatePageOp(
        path: TDocumentRef,
        pages: TPageOpsPageSelection,
        totalPages: number,
        angle: TPageOpsRotation,
        mutationOptions?: IPageOpsMutationOptions,
    ) {
        return mutationOptions
            ? getPageOpsCapability().rotate(path, pages, totalPages, angle, mutationOptions)
            : getPageOpsCapability().rotate(path, pages, totalPages, angle);
    }

    function runInsertPageOp(
        path: TDocumentRef,
        totalPages: number,
        afterPage: number,
        mutationOptions?: IPageOpsMutationOptions,
    ) {
        return mutationOptions
            ? getPageOpsCapability().insert(path, totalPages, afterPage, mutationOptions)
            : getPageOpsCapability().insert(path, totalPages, afterPage);
    }

    function runInsertFilePageOp(
        path: TDocumentRef,
        totalPages: number,
        afterPage: number,
        sourcePaths: TDocumentRef[],
        requestId: string | undefined,
        mutationOptions?: IPageOpsMutationOptions,
    ) {
        return mutationOptions
            ? getPageOpsCapability().insertFile(path, totalPages, afterPage, sourcePaths, requestId, mutationOptions)
            : getPageOpsCapability().insertFile(path, totalPages, afterPage, sourcePaths, requestId);
    }

    function runReorderPageOp(
        path: TDocumentRef,
        newOrder: number[],
        mutationOptions?: IPageOpsMutationOptions,
    ) {
        return mutationOptions
            ? getPageOpsCapability().reorder(path, newOrder, mutationOptions)
            : getPageOpsCapability().reorder(path, newOrder);
    }

    function runMovePageOp(
        path: TDocumentRef,
        move: TPageMoveOperation,
        mutationOptions?: IPageOpsMutationOptions,
    ) {
        if ('ranges' in move) {
            return mutationOptions
                ? getPageOpsCapability().moveRanges(
                    path,
                    move.ranges,
                    move.insertAt,
                    move.pageCount,
                    mutationOptions,
                )
                : getPageOpsCapability().moveRanges(
                    path,
                    move.ranges,
                    move.insertAt,
                    move.pageCount,
                );
        }
        return mutationOptions
            ? getPageOpsCapability().move(
                path,
                move.startPage,
                move.endPage,
                move.insertAt,
                move.pageCount,
                mutationOptions,
            )
            : getPageOpsCapability().move(
                path,
                move.startPage,
                move.endPage,
                move.insertAt,
                move.pageCount,
            );
    }

    function runCropPageOp(
        path: TDocumentRef,
        pages: TPageOpsPageSelection,
        totalPages: number,
        margins: ICropMargins,
        mutationOptions?: IPageOpsMutationOptions,
    ) {
        return mutationOptions
            ? getPageOpsCapability().crop(path, pages, totalPages, margins, mutationOptions)
            : getPageOpsCapability().crop(path, pages, totalPages, margins);
    }

    function runRemoveCropPageOp(
        path: TDocumentRef,
        pages: TPageOpsPageSelection,
        totalPages: number,
        mutationOptions?: IPageOpsMutationOptions,
    ) {
        return mutationOptions
            ? getPageOpsCapability().removeCrop(path, pages, totalPages, mutationOptions)
            : getPageOpsCapability().removeCrop(path, pages, totalPages);
    }

    function toPageOpsSelection(
        pages: number[] | TPageSelection,
    ): TPageOpsPageSelection {
        if (Array.isArray(pages)) {
            return [...pages];
        }
        const ranges: IPageMoveRangeSegment[] = [];
        for (const range of iteratePageSelectionRanges(pages)) {
            if (ranges.length >= MAX_PAGE_OP_SELECTION_RANGES) {
                throw new Error(`Page operation selections support at most ${MAX_PAGE_OP_SELECTION_RANGES} ranges`);
            }
            ranges.push(range);
        }
        return {
            pageCount: pages.pageCount,
            ranges,
        };
    }

    async function runOperationDetailed<TResult extends IPageOpsResult>(options: {
        operationName: string;
        errorKey: TPageOperationErrorKey;
        run: TPageOperationRunner<TResult>;
        beforeRun?: () => Promise<boolean>;
        shouldReload?: boolean;
        isSuccessful?: TPageOperationSuccess<TResult>;
        onSuccess?: (result: TResult) => Promise<void> | void;
    }) {
        const path = workingCopyPath.value;
        if (!path) {
            return recordOutcome<TResult>({
                status: 'blocked',
                reason: 'missing-working-copy',
            });
        }
        if (isOperationInProgress.value) {
            BrowserLogger.warn('page-ops', `Skipped overlapping ${options.operationName} request`, { operationName: options.operationName });
            return recordOutcome<TResult>({
                status: 'blocked',
                reason: 'operation-in-progress',
            });
        }

        isOperationInProgress.value = true;
        error.value = null;

        try {
            return await runWithDocumentOperationLease('page-operation', async () => {
                if (workingCopyPath.value !== path) {
                    return recordOutcome<TResult>({
                        status: 'stale',
                        phase: 'before-run',
                    });
                }
                if (options.shouldReload) {
                    const didPrimeHistory = await ensureHistoryBaselineForMutation();
                    if (!didPrimeHistory) {
                        return recordOutcome<TResult>({
                            status: 'blocked',
                            reason: 'history-baseline',
                        });
                    }
                    if (workingCopyPath.value !== path) {
                        return recordOutcome<TResult>({
                            status: 'stale',
                            phase: 'history-baseline',
                        });
                    }
                }
                if (options.shouldReload && ensureWorkingCopyFreshForRead) {
                    const isFresh = await ensureWorkingCopyFreshForRead();
                    if (!isFresh) {
                        return recordOutcome<TResult>({
                            status: 'blocked',
                            reason: 'preflight',
                        });
                    }
                    if (workingCopyPath.value !== path) {
                        return recordOutcome<TResult>({
                            status: 'stale',
                            phase: 'before-run',
                        });
                    }
                }
                if (options.shouldReload && saveAnnotationsForPageMutation) {
                    const didMaterialize = await saveAnnotationsForPageMutation();
                    if (!didMaterialize) {
                        return recordOutcome<TResult>({
                            status: 'blocked',
                            reason: 'preflight',
                        });
                    }
                    if (workingCopyPath.value !== path) {
                        return recordOutcome<TResult>({
                            status: 'stale',
                            phase: 'before-run',
                        });
                    }
                }
                if (options.beforeRun) {
                    const canRun = await options.beforeRun();
                    if (!canRun) {
                        return recordOutcome<TResult>({
                            status: 'blocked',
                            reason: 'preflight',
                        });
                    }
                    if (workingCopyPath.value !== path) {
                        return recordOutcome<TResult>({
                            status: 'stale',
                            phase: 'before-run',
                        });
                    }
                }
                const result = await options.run(path);
                const isSuccessful = options.isSuccessful ?? ((apiResult) => apiResult.success);
                if (!isSuccessful(result)) {
                    if (isCanceledResult(result)) {
                        return recordOutcome({
                            status: 'canceled',
                            result,
                        });
                    }
                    return recordOutcome({
                        status: 'failed',
                        error: getLocalizedError(options.errorKey),
                        result,
                    });
                }

                if (workingCopyPath.value !== path) {
                    return recordOutcome<TResult>({
                        status: 'stale',
                        phase: 'after-run',
                    });
                }

                if (options.shouldReload) {
                    invalidateCaches(path);
                    const didReload = await reloadWorkingCopyIntoHistory({ markDirty: true });
                    if (!didReload || workingCopyPath.value !== path) {
                        return recordOutcome<TResult>({
                            status: 'stale',
                            phase: 'reload',
                        });
                    }
                }

                if (workingCopyPath.value !== path) {
                    return recordOutcome<TResult>({
                        status: 'stale',
                        phase: 'after-success',
                    });
                }
                await options.onSuccess?.(result);

                return recordOutcome({
                    status: 'succeeded',
                    result,
                });
            });
        } catch (e) {
            const failure = BrowserLogger.error('page-ops', `${options.operationName} failed`, e, {
                code: 'RENDERER_PDF_PAGE_OPERATION_FAILED',
                context: {},
            });
            reportRuntimeError({
                failure,
                title: getLocalizedError(options.errorKey),
            });
            const errorMessage = e instanceof Error ? e.message : getLocalizedError(options.errorKey);
            error.value = errorMessage;
            return recordOutcome<TResult>({
                status: 'failed',
                error: errorMessage,
            });
        } finally {
            isOperationInProgress.value = false;
        }
    }

    async function deletePagesDetailed(pages: number[] | TPageSelection, totalPages: number) {
        const selectedPageCount = Array.isArray(pages)
            ? pages.length
            : pageSelectionCount(pages);
        if (selectedPageCount === 0) {
            return recordOutcome({
                status: 'blocked',
                reason: 'empty-selection',
            });
        }
        if (selectedPageCount >= totalPages) {
            error.value = t('errors.pageOps.deleteAll');
            return recordOutcome({
                status: 'blocked',
                reason: 'delete-all',
            });
        }

        const startedAt = Date.now();
        const outcome = await runOperationDetailed({
            operationName: 'deletePages',
            errorKey: 'errors.pageOps.delete',
            shouldReload: true,
            run: (path) => runDeletePageOp(path, toPageOpsSelection(pages), totalPages, capturePageMutationOptions()),
        });
        if (didPageOperationSucceed(outcome)) {
            analytics.track('page_operation_completed', {
                affectedPageCount: selectedPageCount,
                durationMs: Math.max(0, Date.now() - startedAt),
                operation: 'delete',
                totalPagesBefore: totalPages,
            });
        }
        return outcome;
    }

    async function deletePages(pages: number[] | TPageSelection, totalPages: number) {
        return didPageOperationSucceed(await deletePagesDetailed(pages, totalPages));
    }

    async function deletePageRangesDetailed(
        ranges: IPageMoveRangeSegment[],
        totalPages: number,
    ) {
        if (ranges.length === 0) {
            return recordOutcome({
                status: 'blocked',
                reason: 'empty-selection',
            });
        }
        const deletedCount = ranges.reduce(
            (count, range) => count + range.endPage - range.startPage + 1,
            0,
        );
        if (deletedCount >= totalPages) {
            error.value = t('errors.pageOps.deleteAll');
            return recordOutcome({
                status: 'blocked',
                reason: 'delete-all',
            });
        }

        const startedAt = Date.now();
        const outcome = await runOperationDetailed({
            operationName: 'deletePageRanges',
            errorKey: 'errors.pageOps.delete',
            shouldReload: true,
            run: (path) => runDeletePageRangesOp(
                path,
                [...ranges],
                totalPages,
                capturePageMutationOptions(),
            ),
        });
        if (didPageOperationSucceed(outcome)) {
            analytics.track('page_operation_completed', {
                affectedPageCount: deletedCount,
                durationMs: Math.max(0, Date.now() - startedAt),
                operation: 'delete',
                totalPagesBefore: totalPages,
            });
        }
        return outcome;
    }

    async function deletePageRanges(ranges: IPageMoveRangeSegment[], totalPages: number) {
        return didPageOperationSucceed(await deletePageRangesDetailed(ranges, totalPages));
    }

    async function extractPagesDetailed(pages: number[] | TPageSelection) {
        const selectedPageCount = Array.isArray(pages)
            ? pages.length
            : pageSelectionCount(pages);
        if (selectedPageCount === 0) {
            return recordOutcome({
                status: 'blocked',
                reason: 'empty-selection',
            });
        }

        const startedAt = Date.now();
        const outcome = await runOperationDetailed({
            operationName: 'extractPages',
            errorKey: 'errors.pageOps.extract',
            run: (path) => getPageOpsCapability().extract(path, toPageOpsSelection(pages)),
            ...(ensureWorkingCopyFreshForRead ? { beforeRun: ensureWorkingCopyFreshForRead } : {}),
            isSuccessful: result => result.success && !result.canceled,
            onSuccess: async (result) => {
                if (result.destPath) {
                    await onExtractedDocument?.(result.destPath);
                }
            },
        });
        if (didPageOperationSucceed(outcome)) {
            analytics.track('page_operation_completed', {
                affectedPageCount: selectedPageCount,
                durationMs: Math.max(0, Date.now() - startedAt),
                operation: 'extract',
            });
        }
        return outcome;
    }

    async function extractPages(pages: number[] | TPageSelection) {
        return didPageOperationSucceed(await extractPagesDetailed(pages));
    }

    async function rotatePagesDetailed(pages: number[] | TPageSelection, totalPages: number, angle: TPageOpsRotation) {
        const selectedPageCount = Array.isArray(pages)
            ? pages.length
            : pageSelectionCount(pages);
        if (selectedPageCount === 0) {
            return recordOutcome({
                status: 'blocked',
                reason: 'empty-selection',
            });
        }

        const startedAt = Date.now();
        const outcome = await runOperationDetailed({
            operationName: 'rotatePages',
            errorKey: 'errors.pageOps.rotate',
            shouldReload: true,
            run: (path) => runRotatePageOp(path, toPageOpsSelection(pages), totalPages, angle, capturePageMutationOptions()),
        });
        if (didPageOperationSucceed(outcome)) {
            analytics.track('page_operation_completed', {
                affectedPageCount: selectedPageCount,
                angle,
                durationMs: Math.max(0, Date.now() - startedAt),
                operation: 'rotate',
            });
        }
        return outcome;
    }

    async function rotatePages(pages: number[] | TPageSelection, totalPages: number, angle: TPageOpsRotation) {
        return didPageOperationSucceed(await rotatePagesDetailed(pages, totalPages, angle));
    }

    async function insertPagesDetailed(totalPages: number, afterPage: number) {
        const startedAt = Date.now();
        const outcome = await runOperationDetailed({
            operationName: 'insertPages',
            errorKey: 'errors.pageOps.insert',
            shouldReload: true,
            run: (path) => runInsertPageOp(path, totalPages, afterPage, capturePageMutationOptions()),
        });
        if (didPageOperationSucceed(outcome)) {
            analytics.track('page_operation_completed', {
                afterPage,
                durationMs: Math.max(0, Date.now() - startedAt),
                operation: 'insert_blank',
            });
        }
        return outcome;
    }

    async function insertPages(totalPages: number, afterPage: number) {
        return didPageOperationSucceed(await insertPagesDetailed(totalPages, afterPage));
    }

    async function insertFileDetailed(totalPages: number, afterPage: number, sourcePaths: TDocumentRef[]) {
        const startedAt = Date.now();
        const requestId = sourcePaths.length > 1
            ? `browser-page-op-insert-${crypto.randomUUID()}`
            : undefined;
        const stopProgress = requestId
            ? getDocumentOpenCapability().onOpenDocumentDirectBatchProgress((progress) => {
                if (
                    progress.operation !== 'page-insert'
                    || progress.requestId !== requestId
                ) {
                    return;
                }

                batchProgress.value = {
                    processed: Math.max(0, progress.processed),
                    total: Math.max(0, progress.total),
                    percent: clamp(progress.percent, 0, 100),
                    elapsedMs: Math.max(0, progress.elapsedMs),
                    estimatedRemainingMs:
                        typeof progress.estimatedRemainingMs === 'number'
                            ? Math.max(0, progress.estimatedRemainingMs)
                            : null,
                };
            })
            : null;

        if (requestId) {
            batchProgress.value = {
                processed: 0,
                total: sourcePaths.length,
                percent: 0,
                elapsedMs: 0,
                estimatedRemainingMs: null,
            };
        }

        try {
            const outcome = await runOperationDetailed({
                operationName: 'insertFile',
                errorKey: 'errors.pageOps.insertFile',
                shouldReload: true,
                run: (path) => runInsertFilePageOp(
                    path,
                    totalPages,
                    afterPage,
                    sourcePaths,
                    requestId,
                    capturePageMutationOptions(),
                ),
            });
            if (didPageOperationSucceed(outcome)) {
                analytics.track('page_operation_completed', {
                    afterPage,
                    durationMs: Math.max(0, Date.now() - startedAt),
                    operation: 'insert_file',
                    sourceFileCount: sourcePaths.length,
                });
            }
            return outcome;
        } finally {
            stopProgress?.();
            batchProgress.value = null;
        }
    }

    async function insertFile(totalPages: number, afterPage: number, sourcePaths: TDocumentRef[]) {
        return didPageOperationSucceed(await insertFileDetailed(totalPages, afterPage, sourcePaths));
    }

    async function reorderPagesDetailed(newOrder: number[]) {
        if (newOrder.length === 0) {
            return recordOutcome({
                status: 'blocked',
                reason: 'empty-selection',
            });
        }

        const startedAt = Date.now();
        const outcome = await runOperationDetailed({
            operationName: 'reorderPages',
            errorKey: 'errors.pageOps.reorder',
            shouldReload: true,
            run: (path) => runReorderPageOp(path, [...newOrder], capturePageMutationOptions()),
        });
        if (didPageOperationSucceed(outcome)) {
            analytics.track('page_operation_completed', {
                affectedPageCount: newOrder.length,
                durationMs: Math.max(0, Date.now() - startedAt),
                operation: 'reorder',
            });
        }
        return outcome;
    }

    async function reorderPages(newOrder: number[]) {
        return didPageOperationSucceed(await reorderPagesDetailed(newOrder));
    }

    async function movePagesDetailed(move: TPageMoveOperation) {
        if (move.pageCount <= 0) {
            return recordOutcome({
                status: 'blocked',
                reason: 'empty-selection',
            });
        }

        const startedAt = Date.now();
        const outcome = await runOperationDetailed({
            operationName: 'movePages',
            errorKey: 'errors.pageOps.reorder',
            shouldReload: true,
            run: (path) => runMovePageOp(path, move, capturePageMutationOptions()),
        });
        if (didPageOperationSucceed(outcome)) {
            analytics.track('page_operation_completed', {
                affectedPageCount: 'ranges' in move
                    ? pageMoveRangesSelectedPageCount(move)
                    : move.endPage - move.startPage + 1,
                durationMs: Math.max(0, Date.now() - startedAt),
                operation: 'move',
                totalPages: move.pageCount,
            });
        }
        return outcome;
    }

    async function movePages(move: TPageMoveOperation) {
        return didPageOperationSucceed(await movePagesDetailed(move));
    }

    async function cropPagesDetailed(
        pages: number[] | TPageSelection,
        totalPages: number,
        margins: ICropMargins,
    ) {
        const selection = Array.isArray(pages)
            ? createExplicitPageSelection(totalPages, pages)
            : pages;
        if (pageSelectionCount(selection) === 0) {
            return recordOutcome({
                status: 'blocked',
                reason: 'empty-selection',
            });
        }
        const startedAt = Date.now();
        const outcome = await runOperationDetailed({
            operationName: 'cropPages',
            errorKey: 'errors.pageOps.crop',
            shouldReload: true,
            run: (path) => runCropPageOp(
                path,
                toPageOpsSelection(pages),
                totalPages,
                margins,
                capturePageMutationOptions(),
            ),
        });
        if (didPageOperationSucceed(outcome)) {
            analytics.track('page_operation_completed', {
                affectedPageCount: pageSelectionCount(selection),
                durationMs: Math.max(0, Date.now() - startedAt),
                operation: 'crop',
            });
        }
        return outcome;
    }

    async function cropPages(pages: number[] | TPageSelection, totalPages: number, margins: ICropMargins) {
        return didPageOperationSucceed(await cropPagesDetailed(pages, totalPages, margins));
    }

    async function removeCropDetailed(pages: number[] | TPageSelection, totalPages: number) {
        const selection = Array.isArray(pages)
            ? createExplicitPageSelection(totalPages, pages)
            : pages;
        if (pageSelectionCount(selection) === 0) {
            return recordOutcome({
                status: 'blocked',
                reason: 'empty-selection',
            });
        }
        const startedAt = Date.now();
        const outcome = await runOperationDetailed({
            operationName: 'removeCrop',
            errorKey: 'errors.pageOps.removeCrop',
            shouldReload: true,
            run: (path) => runRemoveCropPageOp(
                path,
                toPageOpsSelection(pages),
                totalPages,
                capturePageMutationOptions(),
            ),
        });
        if (didPageOperationSucceed(outcome)) {
            analytics.track('page_operation_completed', {
                affectedPageCount: pageSelectionCount(selection),
                durationMs: Math.max(0, Date.now() - startedAt),
                operation: 'remove_crop',
            });
        }
        return outcome;
    }

    async function removeCrop(pages: number[] | TPageSelection, totalPages: number) {
        return didPageOperationSucceed(await removeCropDetailed(pages, totalPages));
    }

    return {
        isOperationInProgress,
        error,
        batchProgress,
        lastOutcome,
        deletePagesDetailed,
        deletePages,
        deletePageRangesDetailed,
        deletePageRanges,
        extractPagesDetailed,
        extractPages,
        rotatePagesDetailed,
        rotatePages,
        insertPagesDetailed,
        insertPages,
        insertFileDetailed,
        insertFile,
        reorderPagesDetailed,
        reorderPages,
        movePagesDetailed,
        movePages,
        cropPagesDetailed,
        cropPages,
        removeCropDetailed,
        removeCrop,
    };
};
