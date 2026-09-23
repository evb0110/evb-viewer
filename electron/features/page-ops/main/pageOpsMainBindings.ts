import {
    BrowserWindow,
    dialog,
    type IpcMainInvokeEvent,
    type WebContents,
} from 'electron';
import { existsSync } from 'fs';
import { stat } from 'fs/promises';
import {
    basename,
    extname,
} from 'path';
import type {
    ICropMargins,
    TRequestId,
} from '@contracts/shared';
import { parseDocumentRef } from '@contracts/documentRef';
import {
    normalizeCropMargins,
    normalizeNonEmptyStringPaths,
    parseRequestId,
} from '@contracts/shared';
import type {
    TOpenBatchProgressOperation,
    TOpenDocumentDirectBatchProgress,
} from '@contracts/electronApiDocuments';
import { DOCUMENT_OPEN_PLATFORM_FEATURE } from '@contracts/documentsPlatformFeature';
import type {
    IPageOpsMutationOptions,
    IPageIdentityDelta,
    TPageOpsPageSelection,
} from '@contracts/electronApiPageOps';
import type { PAGE_OPS_PLATFORM_FEATURE } from '@contracts/pageOpsPlatformFeature';
import type { TFeatureMainBindings } from '@contracts/platformFeature';
import type { IPageMoveRangeSegment } from '@contracts/pageNumbers';
import { createPageMoveRanges } from '@pdf-core/pdfPageSelection';
import { te } from '@electron/te';
import { PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS } from '@electron/image/pdfCombineShared';
import {
    cropPages,
    getPageGeometry,
    removeCropFromPages,
} from '@electron/features/page-ops/main/crop';
import {
    deletePageRanges,
    deletePages,
    extractPageRanges,
    extractPages,
    getPdfPageCount,
    movePageRanges,
    movePages,
    reorderPages,
    rotatePages,
    rotatePagesIncremental,
    isIncrementalPageRotationAvailable,
    materializePageOperationWorkingCopy,
    verifyPdfStructureStrict,
} from '@electron/features/page-ops/main/qpdf';
import type { TRotationAngle } from '@electron/features/page-ops/main/qpdf';
import { resolveAllowedWritePath } from '@electron/utils/pathValidator';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import { findWorkingCopyPathByOriginalPath } from '@electron/file-access/workingCopyStore';
import {
    allowOpenPath,
    allowOpenPaths,
    requireOpenPath,
} from '@electron/file-access/openPathCapabilities';
import {
    formatPageRange,
    validatePageDeleteRanges,
    validatePageMoveRanges,
    validatePageMoveRange,
    validatePageNumbers,
    validateReorderPermutation,
} from '@electron/features/page-ops/domain/pageNumbers';
import { insertPagesFromSourcePaths } from '@electron/features/page-ops/main/insertPagesFromSourcePaths.service';
import { assertOpenInputPathCount } from '@electron/features/documents/public/assertOpenInputPathCount';
import {enqueueWorkingCopyMutation} from '@electron/file-access/workingCopyMutationQueue';
import type { IWorkingCopyMutationOperation } from '@electron/file-access/workingCopyMutationQueue';
import { transitionWorkingCopyContentRevision } from '@electron/file-access/documentRevisionStore';
import {
    awaitPageIdentityStoreInitialization,
    commitPageIdentityDelta,
    createCropIdentityDelta,
    createCropRangesIdentityDelta,
    createDeleteIdentityDelta,
    createDeleteRangesIdentityDelta,
    createInsertIdentityDelta,
    createMoveIdentityDelta,
    createPageMoveRangesIdentityDelta,
    createRemoveCropIdentityDelta,
    createRemoveCropRangesIdentityDelta,
    createReorderIdentityDelta,
    createRotateIdentityDelta,
    createRotateRangesIdentityDelta,
} from '@electron/file-access/pageIdentityStore';
import {
    assertQueuedWorkingCopyMutationPreconditions,
    normalizeExpectedDocumentRevisionToken,
} from '@electron/file-access/documentMutationGuards';
import { normalizeOptionalIpcRequestId } from '@electron/utils/ipcLimits';
import { getWorkingCopyDialogDefaultPath } from '@electron/utils/dialogDefaultPaths';
import { createIpcProgressPump } from '@electron/utils/createIpcProgressPump';
import type { ICreatePdfFromInputPathsProgress } from '@electron/image/pdfConversion';
import {applyPageMetadataRemap} from '@electron/features/page-ops/main/pageMetadataRemap';

interface IPageOpsOperationContext {
    sender: WebContents;
    senderId: number;
    parentWindow: BrowserWindow | null;
}

const QPDF_PAGE_BATCH_SIZE = 10_000;
const CROP_PAGE_BATCH_SIZE = 1_024;

function isCompactPageSelection(
    selection: TPageOpsPageSelection,
): selection is Exclude<TPageOpsPageSelection, number[]> {
    return !Array.isArray(selection);
}

function pageNumbersToRanges(pages: readonly number[]) {
    const sortedPages = [...pages].sort((left, right) => left - right);
    const ranges: IPageMoveRangeSegment[] = [];
    for (const page of sortedPages) {
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

function validatePageOpsSelection(
    selection: TPageOpsPageSelection,
    totalPages: number,
    operation: string,
) {
    if (Array.isArray(selection)) {
        validatePageNumbers(selection, operation, {
            totalPages,
            requireUnique: true,
        });
        return pageNumbersToRanges(selection);
    }
    if (selection.pageCount !== totalPages) {
        throw new Error('Renderer page count is stale');
    }
    validatePageDeleteRanges(selection.ranges, totalPages);
    return selection.ranges;
}

function* iteratePageRangeBatches(
    ranges: readonly IPageMoveRangeSegment[],
    batchSize: number,
) {
    let batch: number[] = [];
    for (const range of ranges) {
        for (let page = range.startPage; page <= range.endPage; page += 1) {
            batch.push(page);
            if (batch.length === batchSize) {
                yield batch;
                batch = [];
            }
        }
    }
    if (batch.length > 0) yield batch;
}

function formatSelectionLabel(ranges: readonly IPageMoveRangeSegment[]) {
    if (ranges.length > 8) {
        const selectedCount = ranges.reduce(
            (count, range) => count + range.endPage - range.startPage + 1,
            0,
        );
        return `${selectedCount} pages`;
    }
    return ranges.map(range => range.startPage === range.endPage
        ? String(range.startPage)
        : `${range.startPage}-${range.endPage}`).join(',');
}

function createOpenBatchProgressReporter(
    context: IPageOpsOperationContext,
    requestId: TRequestId,
    operation: TOpenBatchProgressOperation,
) {
    const pump = createIpcProgressPump<TOpenDocumentDirectBatchProgress>({
        channel: DOCUMENT_OPEN_PLATFORM_FEATURE.eventChannels.onOpenDocumentDirectBatchProgress,
        getTarget: () => context.sender,
        getKey: payload => payload.requestId,
        isTerminal: payload => payload.processed >= payload.total,
    });
    return (progress: ICreatePdfFromInputPathsProgress) => {
        pump.enqueue({
            operation,
            requestId,
            ...progress,
        });
    };
}

function createNativeOperationOptions(operation: IWorkingCopyMutationOperation) {
    return {
        signal: operation.signal,
        cancelGroup: operation.cancelGroup,
    };
}

async function beginQueuedPageMutation(
    operation: IWorkingCopyMutationOperation,
    normalizedWorkingCopyPath: string,
    senderId: number,
    expectedDocumentRevisionToken: Parameters<typeof assertQueuedWorkingCopyMutationPreconditions>[1],
) {
    const nativeOptions = createNativeOperationOptions(operation);
    const queuedWorkingCopyPath = await validateWorkingCopyPath(normalizedWorkingCopyPath, senderId);
    await assertQueuedWorkingCopyMutationPreconditions(queuedWorkingCopyPath, expectedDocumentRevisionToken);
    const pageCount = await getPdfPageCount(queuedWorkingCopyPath, nativeOptions);
    return {
        nativeOptions,
        pageCount,
        queuedWorkingCopyPath,
    };
}

async function transitionPageMutation<T>(input: {
    workingCopyPath: string;
    senderId?: number;
    options?: IPageOpsMutationOptions | undefined;
    operation: IWorkingCopyMutationOperation;
    contentBackupMode?: 'copy-on-write' | 'hard-link' | 'append';
    skipPageMetadataRemap?: boolean;
    nativeAppendStructureVerified?: boolean;
    mutate: () => Promise<{
        value: T;
        delta: IPageIdentityDelta
    }>;
}) {
    await awaitPageIdentityStoreInitialization(input.workingCopyPath);
    const values: T[] = [];
    let committedDelta = null as IPageIdentityDelta | null;
    const documentRevision = await transitionWorkingCopyContentRevision(
        input.workingCopyPath,
        'page-ops',
        async nextRevision => {
            const mutation = await input.mutate();
            if (!input.skipPageMetadataRemap) {
                await applyPageMetadataRemap({
                    workingCopyPath: input.workingCopyPath,
                    delta: mutation.delta,
                    ...(input.options?.metadataSnapshot
                        ? {metadataSnapshot: input.options.metadataSnapshot}
                        : {}),
                    signal: input.operation.signal,
                    cancelGroup: input.operation.cancelGroup,
                });
            }
            const actualPageCount = await getPdfPageCount(
                input.workingCopyPath,
                createNativeOperationOptions(input.operation),
            );
            const predictedPageCount = mutation.delta.nextPageCount ?? mutation.delta.pages?.length;
            if (predictedPageCount === undefined || predictedPageCount !== actualPageCount) {
                throw new Error(`Page operation reopen verification failed: predicted ${predictedPageCount ?? 'unknown'}, received ${actualPageCount}`);
            }
            // The incremental writer validates the appended xref/object set
            // and the selected page dictionaries before returning. Reopening
            // for page count below verifies the complete page tree without
            // asking qpdf to rewrite the 722 MB base streams a second time.
            if (!input.nativeAppendStructureVerified) {
                await verifyPdfStructureStrict(
                    input.workingCopyPath,
                    createNativeOperationOptions(input.operation),
                );
            }
            await commitPageIdentityDelta(input.workingCopyPath, mutation.delta, nextRevision);
            committedDelta = mutation.delta;
            values.push(mutation.value);
        },
        input.senderId,
        undefined,
        input.contentBackupMode,
    );
    if (values.length !== 1) throw new Error('Page operation did not publish a result');
    if (!committedDelta) throw new Error('Page operation did not publish an identity delta');
    const value = values[0]!;
    return {
        value,
        documentRevision,
        pageIdentityDelta: committedDelta,
    };
}

async function validateWorkingCopyPath(path: unknown, senderWebContentsId?: number) {
    const normalizedPath = typeof path === 'string' ? path.trim() : '';
    if (!normalizedPath) {
        throw new Error('Invalid working copy path');
    }

    const isManagedWorkingCopy = await ensureWorkingCopyDirectory(normalizedPath, senderWebContentsId);
    if (!isManagedWorkingCopy) {
        throw new Error('Path is not a managed working copy');
    }

    const resolvedPath = await resolveAllowedWritePath(normalizedPath);
    if (!resolvedPath) {
        throw new Error('Path is outside the allowed working directory');
    }
    if (!existsSync(resolvedPath)) {
        throw new Error(`Working copy not found: ${resolvedPath}`);
    }

    return resolvedPath;
}

async function resolveWorkingCopyPath(path: unknown, senderWebContentsId?: number) {
    const normalizedPath = typeof path === 'string' ? path.trim() : '';
    if (!normalizedPath) {
        throw new Error('Invalid working copy path');
    }

    const mappedWorkingCopyPath = findWorkingCopyPathByOriginalPath(normalizedPath, senderWebContentsId);
    const workingCopyPath = mappedWorkingCopyPath ?? normalizedPath;

    return validateWorkingCopyPath(workingCopyPath, senderWebContentsId);
}

function validateInsertPageArgs(
    workingCopyPath: unknown,
    totalPages: unknown,
    afterPage: unknown,
) {
    const normalizedWorkingCopyPath = typeof workingCopyPath === 'string' ? workingCopyPath.trim() : '';
    if (!normalizedWorkingCopyPath) {
        throw new Error('Invalid working copy path');
    }

    if (typeof totalPages !== 'number' || !Number.isSafeInteger(totalPages) || totalPages < 1) {
        throw new Error('Invalid totalPages');
    }
    const normalizedTotalPages = totalPages;
    if (
        typeof afterPage !== 'number'
        || !Number.isSafeInteger(afterPage)
        || afterPage < 0
        || afterPage > normalizedTotalPages
    ) {
        throw new Error('Invalid afterPage');
    }
    const normalizedAfterPage = afterPage;

    return {
        normalizedWorkingCopyPath,
        totalPages: normalizedTotalPages,
        afterPage: normalizedAfterPage,
    };
}

function validateExpectedTotalPages(totalPages: unknown) {
    if (typeof totalPages !== 'number' || !Number.isSafeInteger(totalPages) || totalPages < 1) {
        throw new Error('Invalid totalPages');
    }
    return totalPages;
}

async function handlePageOpsDelete(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
    pages: TPageOpsPageSelection,
    totalPages: number,
    options?: IPageOpsMutationOptions,
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    const expectedTotalPages = validateExpectedTotalPages(totalPages);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const result = await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async (operation) => {
        const {
            nativeOptions,
            pageCount: mainTotalPages,
            queuedWorkingCopyPath,
        } = await beginQueuedPageMutation(operation, normalizedWorkingCopyPath, context.senderId, expectedDocumentRevisionToken);
        if (mainTotalPages !== expectedTotalPages) {
            throw new Error('Renderer page count is stale');
        }
        const ranges = validatePageOpsSelection(pages, mainTotalPages, 'deletePages');
        return transitionPageMutation({
            workingCopyPath: queuedWorkingCopyPath,
            senderId: context.senderId,
            operation,
            options,
            mutate: async () => isCompactPageSelection(pages)
                ? {
                    value: await deletePageRanges(queuedWorkingCopyPath, ranges, expectedTotalPages, context.senderId, nativeOptions),
                    delta: createDeleteRangesIdentityDelta(expectedTotalPages, ranges),
                }
                : {
                    value: await deletePages(queuedWorkingCopyPath, pages, expectedTotalPages, context.senderId, nativeOptions),
                    delta: createDeleteIdentityDelta(expectedTotalPages, pages),
                },
        });
    });
    return {
        success: true,
        pageCount: result.value.pageCount,
        documentRevision: result.documentRevision,
        pageIdentityDelta: result.pageIdentityDelta,
    };
}

async function handlePageOpsDeleteRanges(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
    ranges: IPageMoveRangeSegment[],
    totalPages: number,
    options?: IPageOpsMutationOptions,
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    const expectedTotalPages = validateExpectedTotalPages(totalPages);
    validatePageDeleteRanges(ranges, expectedTotalPages);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const result = await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async (operation) => {
        const {
            nativeOptions,
            pageCount: mainTotalPages,
            queuedWorkingCopyPath,
        } = await beginQueuedPageMutation(operation, normalizedWorkingCopyPath, context.senderId, expectedDocumentRevisionToken);
        if (mainTotalPages !== expectedTotalPages) {
            throw new Error('Renderer page count is stale');
        }
        validatePageDeleteRanges(ranges, mainTotalPages);
        return transitionPageMutation({
            workingCopyPath: queuedWorkingCopyPath,
            senderId: context.senderId,
            operation,
            options,
            mutate: async () => ({
                value: await deletePageRanges(
                    queuedWorkingCopyPath,
                    ranges,
                    expectedTotalPages,
                    context.senderId,
                    nativeOptions,
                ),
                delta: createDeleteRangesIdentityDelta(expectedTotalPages, ranges),
            }),
        });
    });
    return {
        success: true,
        pageCount: result.value.pageCount,
        documentRevision: result.documentRevision,
        pageIdentityDelta: result.pageIdentityDelta,
    };
}

async function handlePageOpsExtract(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
    pages: TPageOpsPageSelection,
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    const actualPageCount = await getPdfPageCount(normalizedWorkingCopyPath);
    const ranges = validatePageOpsSelection(pages, actualPageCount, 'extractPages');

    const baseName = basename(normalizedWorkingCopyPath, extname(normalizedWorkingCopyPath));
    const rangeLabel = Array.isArray(pages)
        ? formatPageRange(pages)
        : formatSelectionLabel(ranges);
    const suggestedName = `${baseName} (${rangeLabel}).pdf`;
    const dialogOptions = {
        title: te('dialogs.extractPages'),
        defaultPath: suggestedName,
        filters: [{
            name: te('dialogs.pdfFiles'),
            extensions: ['pdf'],
        }],
    };
    const result = context.parentWindow
        ? await dialog.showSaveDialog(context.parentWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);

    if (result.canceled || !result.filePath) {
        return {
            success: false,
            canceled: true,
        };
    }

    let destPath = result.filePath;
    if (extname(destPath).toLowerCase() !== '.pdf') {
        destPath += '.pdf';
    }

    await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async (operation) => {
        const queuedWorkingCopyPath = await validateWorkingCopyPath(normalizedWorkingCopyPath, context.senderId);
        const nativeOptions = {
            ...createNativeOperationOptions(operation),
            senderWebContentsId: context.senderId,
        };
        if (Array.isArray(pages)) {
            await extractPages(queuedWorkingCopyPath, destPath, pages, nativeOptions);
        } else {
            await extractPageRanges(queuedWorkingCopyPath, destPath, ranges, nativeOptions);
        }
    });
    allowOpenPath(destPath, context.sender);
    const documentRef = parseDocumentRef(destPath);
    if (documentRef === null) {
        throw new Error('Page extraction returned an invalid document ref');
    }
    return {
        success: true,
        destPath: documentRef,
    };
}

async function handlePageOpsReorder(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
    newOrder: number[],
    options?: IPageOpsMutationOptions,
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    validatePageNumbers(newOrder, 'reorderPages', {requireUnique: true});
    validateReorderPermutation(newOrder);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const result = await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async (operation) => {
        const nativeOptions = createNativeOperationOptions(operation);
        const queuedWorkingCopyPath = await validateWorkingCopyPath(normalizedWorkingCopyPath, context.senderId);
        await assertQueuedWorkingCopyMutationPreconditions(queuedWorkingCopyPath, expectedDocumentRevisionToken);
        const actualPageCount = await getPdfPageCount(queuedWorkingCopyPath, nativeOptions);
        validatePageNumbers(newOrder, 'reorderPages', {
            requireUnique: true,
            totalPages: actualPageCount,
        });
        validateReorderPermutation(newOrder, actualPageCount);
        return transitionPageMutation({
            workingCopyPath: queuedWorkingCopyPath,
            senderId: context.senderId,
            operation,
            options,
            mutate: async () => ({
                value: await reorderPages(queuedWorkingCopyPath, newOrder, context.senderId, nativeOptions),
                delta: createReorderIdentityDelta(actualPageCount, newOrder),
            }),
        });
    });
    return {
        success: true,
        pageCount: result.value.pageCount,
        documentRevision: result.documentRevision,
        pageIdentityDelta: result.pageIdentityDelta,
    };
}

async function handlePageOpsMove(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
    startPage: number,
    endPage: number,
    insertAt: number,
    totalPages: number,
    options?: IPageOpsMutationOptions,
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    validatePageMoveRange(startPage, endPage, insertAt, totalPages);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const result = await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async (operation) => {
        const {
            nativeOptions,
            pageCount: actualPageCount,
            queuedWorkingCopyPath,
        } = await beginQueuedPageMutation(
            operation,
            normalizedWorkingCopyPath,
            context.senderId,
            expectedDocumentRevisionToken,
        );
        if (actualPageCount !== totalPages) {
            throw new Error('Renderer page count is stale');
        }
        validatePageMoveRange(startPage, endPage, insertAt, actualPageCount);

        const movedCount = endPage - startPage + 1;
        const destinationStart = insertAt < startPage - 1
            ? insertAt + 1
            : insertAt > endPage
                ? insertAt - movedCount + 1
                : startPage;
        return transitionPageMutation({
            workingCopyPath: queuedWorkingCopyPath,
            senderId: context.senderId,
            operation,
            options,
            mutate: async () => ({
                value: await movePages(
                    queuedWorkingCopyPath,
                    startPage,
                    endPage,
                    insertAt,
                    actualPageCount,
                    context.senderId,
                    nativeOptions,
                ),
                delta: createMoveIdentityDelta(
                    actualPageCount,
                    startPage,
                    destinationStart,
                    movedCount,
                ),
            }),
        });
    });
    return {
        success: true,
        pageCount: result.value.pageCount,
        documentRevision: result.documentRevision,
        pageIdentityDelta: result.pageIdentityDelta,
    };
}

async function handlePageOpsMoveRanges(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
    ranges: IPageMoveRangeSegment[],
    insertAt: number,
    totalPages: number,
    options?: IPageOpsMutationOptions,
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    validatePageMoveRanges(ranges, insertAt, totalPages);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const result = await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async (operation) => {
        const {
            nativeOptions,
            pageCount: actualPageCount,
            queuedWorkingCopyPath,
        } = await beginQueuedPageMutation(
            operation,
            normalizedWorkingCopyPath,
            context.senderId,
            expectedDocumentRevisionToken,
        );
        if (actualPageCount !== totalPages) {
            throw new Error('Renderer page count is stale');
        }
        const move = createPageMoveRanges(actualPageCount, ranges, insertAt);
        return transitionPageMutation({
            workingCopyPath: queuedWorkingCopyPath,
            senderId: context.senderId,
            operation,
            options,
            mutate: async () => ({
                value: await movePageRanges(
                    queuedWorkingCopyPath,
                    move,
                    actualPageCount,
                    context.senderId,
                    nativeOptions,
                ),
                delta: createPageMoveRangesIdentityDelta(move),
            }),
        });
    });
    return {
        success: true,
        pageCount: result.value.pageCount,
        documentRevision: result.documentRevision,
        pageIdentityDelta: result.pageIdentityDelta,
    };
}

async function handlePageOpsInsert(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
    totalPages: number,
    afterPage: number,
    options?: IPageOpsMutationOptions,
) {
    const insertArgs = validateInsertPageArgs(workingCopyPath, totalPages, afterPage);
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(insertArgs.normalizedWorkingCopyPath, context.senderId);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const dialogOptions = {
        title: te('dialogs.insertPagesFromPdf'),
        defaultPath: getWorkingCopyDialogDefaultPath(normalizedWorkingCopyPath),
        filters: [{
            name: te('dialogs.documentsFilter'),
            extensions: [
                'pdf',
                ...PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS.map(ext => ext.slice(1)),
            ],
        }],
        properties: [
            'openFile',
            'multiSelections',
        ] as Array<'openFile' | 'multiSelections'>,
    };
    const result = context.parentWindow
        ? await dialog.showOpenDialog(context.parentWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

    if (result.canceled || result.filePaths.length === 0) {
        return {
            success: false,
            canceled: true,
        };
    }
    assertOpenInputPathCount(result.filePaths);
    allowOpenPaths(result.filePaths, context.sender);
    const trustedSourcePaths = normalizeNonEmptyStringPaths(result.filePaths)
        .map(path => requireOpenPath(path, context.sender));

    const mutation = await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async (operation) => {
        const {
            nativeOptions,
            pageCount: beforeCount,
            queuedWorkingCopyPath,
        } = await beginQueuedPageMutation(operation, normalizedWorkingCopyPath, context.senderId, expectedDocumentRevisionToken);
        return transitionPageMutation({
            workingCopyPath: queuedWorkingCopyPath,
            senderId: context.senderId,
            operation,
            options,
            mutate: async () => {
                await insertPagesFromSourcePaths(queuedWorkingCopyPath, insertArgs.totalPages, trustedSourcePaths, insertArgs.afterPage, context.senderId, undefined, nativeOptions);
                const afterCount = await getPdfPageCount(queuedWorkingCopyPath, nativeOptions);
                return {
                    value: undefined,
                    delta: createInsertIdentityDelta(beforeCount, insertArgs.afterPage, afterCount - beforeCount),
                };
            },
        });
    });
    return {
        success: true,
        documentRevision: mutation.documentRevision,
        pageIdentityDelta: mutation.pageIdentityDelta,
    };
}

// An in-place append writes through every hard link to the file. A save can
// leave the working copy sharing its inode with the original, so only an
// unshared working copy may take the append path; the rewrite path detaches it.
async function isWorkingCopyInodeExclusive(workingCopyPath: string) {
    const workingCopyStat = await stat(workingCopyPath);
    return workingCopyStat.isFile() && workingCopyStat.nlink === 1;
}

async function handlePageOpsRotate(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
    pages: TPageOpsPageSelection,
    totalPages: number,
    angle: TRotationAngle,
    options?: IPageOpsMutationOptions,
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    const expectedTotalPages = validateExpectedTotalPages(totalPages);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);
    if (![
        90,
        180,
        270,
    ].includes(angle)) {
        throw new Error(`Invalid rotation angle: ${angle}`);
    }

    const mutation = await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async (operation) => {
        const {
            nativeOptions,
            pageCount: mainTotalPages,
            queuedWorkingCopyPath,
        } = await beginQueuedPageMutation(operation, normalizedWorkingCopyPath, context.senderId, expectedDocumentRevisionToken);
        if (mainTotalPages !== expectedTotalPages) {
            throw new Error('Renderer page count is stale');
        }
        const ranges = validatePageOpsSelection(pages, mainTotalPages, 'rotatePages');
        const useIncrementalRotation = isIncrementalPageRotationAvailable()
            && await isWorkingCopyInodeExclusive(await materializePageOperationWorkingCopy(
                queuedWorkingCopyPath,
                context.senderId,
                operation.signal,
            ));
        return transitionPageMutation({
            workingCopyPath: queuedWorkingCopyPath,
            senderId: context.senderId,
            operation,
            options,
            ...(useIncrementalRotation
                ? {
                    contentBackupMode: 'append' as const,
                    skipPageMetadataRemap: true,
                    nativeAppendStructureVerified: true,
                }
                : {}),
            mutate: async () => {
                for (const batch of iteratePageRangeBatches(ranges, QPDF_PAGE_BATCH_SIZE)) {
                    if (useIncrementalRotation) {
                        await rotatePagesIncremental(
                            queuedWorkingCopyPath,
                            batch,
                            angle,
                            context.senderId,
                            nativeOptions,
                        );
                    } else {
                        await rotatePages(queuedWorkingCopyPath, batch, angle, context.senderId, nativeOptions);
                    }
                }
                return {
                    value: undefined,
                    delta: isCompactPageSelection(pages)
                        ? createRotateRangesIdentityDelta(mainTotalPages, ranges)
                        : createRotateIdentityDelta(mainTotalPages, pages),
                };
            },
        });
    });
    return {
        success: true,
        documentRevision: mutation.documentRevision,
        pageIdentityDelta: mutation.pageIdentityDelta,
    };
}

async function handlePageOpsInsertFile(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
    totalPages: number,
    afterPage: number,
    sourcePaths: string[],
    requestId?: string,
    options?: IPageOpsMutationOptions,
) {
    const insertArgs = validateInsertPageArgs(workingCopyPath, totalPages, afterPage);
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(insertArgs.normalizedWorkingCopyPath, context.senderId);
    if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
        throw new Error('Invalid source paths');
    }
    assertOpenInputPathCount(sourcePaths);
    const trustedSourcePaths = normalizeNonEmptyStringPaths(sourcePaths)
        .map(path => requireOpenPath(path, context.sender));
    const normalizedRequestId = parseRequestId(normalizeOptionalIpcRequestId(requestId));
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const mutation = await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async (operation) => {
        const {
            nativeOptions,
            pageCount: beforeCount,
            queuedWorkingCopyPath,
        } = await beginQueuedPageMutation(operation, normalizedWorkingCopyPath, context.senderId, expectedDocumentRevisionToken);
        return transitionPageMutation({
            workingCopyPath: queuedWorkingCopyPath,
            senderId: context.senderId,
            operation,
            options,
            mutate: async () => {
                await insertPagesFromSourcePaths(queuedWorkingCopyPath, insertArgs.totalPages, trustedSourcePaths, insertArgs.afterPage, context.senderId, normalizedRequestId
                    ? createOpenBatchProgressReporter(context, normalizedRequestId, 'page-insert')
                    : undefined, nativeOptions);
                const afterCount = await getPdfPageCount(queuedWorkingCopyPath, nativeOptions);
                return {
                    value: undefined,
                    delta: createInsertIdentityDelta(beforeCount, insertArgs.afterPage, afterCount - beforeCount),
                };
            },
        });
    });
    return {
        success: true,
        documentRevision: mutation.documentRevision,
        pageIdentityDelta: mutation.pageIdentityDelta,
    };
}

async function handlePageOpsCrop(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
    pages: TPageOpsPageSelection,
    totalPages: number,
    margins: ICropMargins,
    options?: IPageOpsMutationOptions,
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    const expectedTotalPages = validateExpectedTotalPages(totalPages);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);
    const normalizedMargins = normalizeCropMargins(margins);

    const mutation = await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async (operation) => {
        const {
            pageCount: mainTotalPages,
            queuedWorkingCopyPath,
        } = await beginQueuedPageMutation(operation, normalizedWorkingCopyPath, context.senderId, expectedDocumentRevisionToken);
        if (mainTotalPages !== expectedTotalPages) {
            throw new Error('Renderer page count is stale');
        }
        const ranges = validatePageOpsSelection(pages, mainTotalPages, 'cropPages');
        return transitionPageMutation({
            workingCopyPath: queuedWorkingCopyPath,
            senderId: context.senderId,
            operation,
            options,
            mutate: async () => {
                for (const batch of iteratePageRangeBatches(ranges, CROP_PAGE_BATCH_SIZE)) {
                    await cropPages(queuedWorkingCopyPath, batch, normalizedMargins, context.senderId, operation.signal);
                }
                return {
                    value: undefined,
                    delta: isCompactPageSelection(pages)
                        ? createCropRangesIdentityDelta(mainTotalPages, ranges)
                        : createCropIdentityDelta(mainTotalPages, pages),
                };
            },
        });
    });
    return {
        success: true,
        documentRevision: mutation.documentRevision,
        pageIdentityDelta: mutation.pageIdentityDelta,
    };
}

async function handlePageOpsRemoveCrop(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
    pages: TPageOpsPageSelection,
    totalPages: number,
    options?: IPageOpsMutationOptions,
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    const expectedTotalPages = validateExpectedTotalPages(totalPages);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const mutation = await enqueueWorkingCopyMutation(normalizedWorkingCopyPath, async (operation) => {
        const {
            pageCount: mainTotalPages,
            queuedWorkingCopyPath,
        } = await beginQueuedPageMutation(operation, normalizedWorkingCopyPath, context.senderId, expectedDocumentRevisionToken);
        if (mainTotalPages !== expectedTotalPages) {
            throw new Error('Renderer page count is stale');
        }
        const ranges = validatePageOpsSelection(pages, mainTotalPages, 'removeCrop');
        return transitionPageMutation({
            workingCopyPath: queuedWorkingCopyPath,
            senderId: context.senderId,
            operation,
            options,
            mutate: async () => {
                for (const batch of iteratePageRangeBatches(ranges, CROP_PAGE_BATCH_SIZE)) {
                    await removeCropFromPages(queuedWorkingCopyPath, batch, context.senderId, operation.signal);
                }
                return {
                    value: undefined,
                    delta: isCompactPageSelection(pages)
                        ? createRemoveCropRangesIdentityDelta(mainTotalPages, ranges)
                        : createRemoveCropIdentityDelta(mainTotalPages, pages),
                };
            },
        });
    });
    return {
        success: true,
        documentRevision: mutation.documentRevision,
        pageIdentityDelta: mutation.pageIdentityDelta,
    };
}

async function handlePageOpsGetPageGeometry(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
    pageNumber: number,
) {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
        throw new Error('Invalid page number');
    }

    return getPageGeometry(normalizedWorkingCopyPath, pageNumber, context.senderId);
}

function createPageOpsOperationContext(context: {
    sender: WebContents;
    senderId: number;
}): IPageOpsOperationContext {
    return {
        ...context,
        parentWindow: BrowserWindow.fromWebContents(context.sender),
    };
}

export const pageOpsMainBindings = {
    delete: (context, ...args) => handlePageOpsDelete(createPageOpsOperationContext(context), ...args),
    deleteRanges: (context, ...args) => handlePageOpsDeleteRanges(createPageOpsOperationContext(context), ...args),
    extract: (context, ...args) => handlePageOpsExtract(createPageOpsOperationContext(context), ...args),
    reorder: (context, ...args) => handlePageOpsReorder(createPageOpsOperationContext(context), ...args),
    move: (context, ...args) => handlePageOpsMove(createPageOpsOperationContext(context), ...args),
    moveRanges: (context, ...args) => handlePageOpsMoveRanges(createPageOpsOperationContext(context), ...args),
    insert: (context, ...args) => handlePageOpsInsert(createPageOpsOperationContext(context), ...args),
    insertFile: (context, ...args) => handlePageOpsInsertFile(createPageOpsOperationContext(context), ...args),
    rotate: (context, ...args) => handlePageOpsRotate(createPageOpsOperationContext(context), ...args),
    crop: (context, ...args) => handlePageOpsCrop(createPageOpsOperationContext(context), ...args),
    removeCrop: (context, ...args) => handlePageOpsRemoveCrop(createPageOpsOperationContext(context), ...args),
    getPageGeometry: (context, ...args) =>
        handlePageOpsGetPageGeometry(createPageOpsOperationContext(context), ...args),
} satisfies TFeatureMainBindings<typeof PAGE_OPS_PLATFORM_FEATURE, IpcMainInvokeEvent>;
