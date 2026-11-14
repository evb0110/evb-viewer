import {
    BrowserWindow,
    dialog,
    type IpcMainInvokeEvent,
    type WebContents,
} from 'electron';
import {
    readFile, stat, writeFile,
} from 'fs/promises';
import {copyNewFile} from '@document-store/nodeStorePort';
import {usingManagedScratchScope} from '@electron/utils/managedScratchTemp';
import {
    basename,
    extname,
    join,
} from 'path';
import type {
    ICropMargins,
    TRequestId,
} from '@contracts/shared';
import { parseDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
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
    IPageOpsCommittedResult,
    IPageOpsMutationOptions,
    IPageOpsResult,
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
    getPdfPageCount,
    verifyPdfStructureStrict,
} from '@electron/features/page-ops/main/qpdf';
import {
    deletePageRanges,
    extractPageRanges,
    extractPages,
    movePageRanges,
    reorderPages,
    rotatePages,
} from '@electron/features/page-ops/main/pageStructure';
import type { TRotationAngle } from '@electron/features/page-ops/main/pageStructure';
import { resolveAllowedWritePath } from '@electron/utils/pathValidator';
import {
    assertQueuedWorkingCopyMutationPreconditions,
    ensureWorkingCopyDirectory,
    findWorkingCopyPathByOriginalPath,
    normalizeExpectedDocumentRevisionToken,
    getWorkingCopyOriginalPath,
    requireManagedWorkingCopyPath,
    appendToDocument,
    documentRevisionToken,
    requireOpenDocument,
    restoreOpenDocumentRevision,
    rewriteDocument,
    runWithWorkingCopyReadBacking,
} from '@electron/file-access/documentStore';
import {
    findSerializableErrorEnvelope,
} from '@contracts/serializableError';
import { NATIVE_ERROR_ENVELOPE_SCHEMA } from '@contracts/nativeErrors';
import { rewritePdfWithQpdf } from '@electron/pdf/pdfAppendBase';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { readNativePdfCatalogPart } from '@electron/features/page-ops/main/readNativePdfCatalog';
import { resolveNativePageOpsPath } from '@electron/features/page-ops/main/resolveNativePageOpsPath';
import { PDF_BOOKMARK_RECOVERY_ENTRY_SCHEMA } from '@contracts/pdfBookmarkEntry';
import * as v from 'valibot';
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
import {
    cancelUserCancellableMainOperations,
    isMainOperationUserCanceled,
    registerMainOperation,
} from '@electron/operation-lifecycle/mainOperationLifecycle';
import {getAppTempDir} from '@electron/utils/appTempDir';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {
    normalizePdfNativeTextBoxAppearanceMetadata, PDF_NATIVE_TEXT_BOX_APPEARANCE_LIMITS,
} from '@contracts/nativePdfMutations';
import type { IWorkingCopyMutationOperation } from '@electron/file-access/workingCopyMutationQueue';
import { runWithWorkingCopyMutationCommitSignal } from '@electron/file-access/workingCopyMutationCommitSignal';
import {
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
} from '@electron/file-access/pageIdentityDelta';
import { normalizeOptionalIpcRequestId } from '@electron/utils/ipcLimits';
import {
    getAutomationSaveDialogPath,
    getWorkingCopyDialogDefaultPath,
} from '@electron/utils/dialogDefaultPaths';
import { createIpcProgressPump } from '@electron/utils/createIpcProgressPump';
import type { ICreatePdfFromInputPathsProgress } from '@electron/image/pdfConversion';
import {
    applyPageMetadataRemap, resolvePageMetadataSourceTargets,
} from '@electron/features/page-ops/main/pageMetadataRemap';

const logger = createLogger('page-ops');

interface IPageOpsOperationContext {
    sender: WebContents;
    senderId: number;
    parentWindow: BrowserWindow | null;
    userCancel?: IPageOpUserCancelHandle;
}

// Pages per native rotation or crop pass; each pass reopens the document,
// which costs a 21,601-page PDF more than cropping all of its pages.
const PAGE_MUTATION_BATCH_SIZE = 10_000;

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

// Atomic file replaces normally mark a working-copy mutation as committing.
// Inside a page operation they write the next revision, which nothing names
// until the store commits it, so the operation marks its real commit point
// itself and stays cancellable until then.
const DEFERRED_COMMIT_SIGNAL = {markCommitStarted: () => undefined};

/**
 * Runs one page operation as a rewrite of the document: `mutate` reads its
 * current bytes at `source` and writes the next revision at `target`, which
 * the store commits once the page count and structure checks pass. With
 * `write: appendToDocument` the edit appends to the document's own file:
 * `source` and `target` are that file. The page-structure engine and the
 * incremental writer verify what they write; a tool that does not asks for
 * `strictStructureCheck`.
 */
async function runPageMutation<T>(input: {
    ref: string;
    senderId: number;
    token: TDocumentRevisionToken | null;
    expectedTotalPages?: number;
    options?: IPageOpsMutationOptions | undefined;
    operation: IWorkingCopyMutationOperation;
    skipPageMetadataRemap?: boolean;
    strictStructureCheck?: boolean;
    write?: typeof rewriteDocument;
    mutate: (source: string, target: string, pageCount: number) => Promise<{
        value: T;
        delta: IPageIdentityDelta
    }>;
}) {
    await assertQueuedWorkingCopyMutationPreconditions(input.ref, input.token);
    const nativeOptions = createNativeOperationOptions(input.operation);
    const entry = requireOpenDocument(input.ref, input.senderId);
    let committed = null as {value: T; delta: IPageIdentityDelta} | null;
    const write = () => (input.write ?? rewriteDocument)(
        entry,
        async (source, target) => {
            const pageCount = await getPdfPageCount(source, nativeOptions);
            if (input.expectedTotalPages !== undefined && input.expectedTotalPages !== pageCount) {
                throw new Error('Renderer page count is stale');
            }
            const metadataSnapshot = input.skipPageMetadataRemap ? undefined : await resolvePageMetadataSourceTargets(input.options?.metadataSnapshot, source, nativeOptions);
            const mutation = await input.mutate(source, target, pageCount);
            if (!input.skipPageMetadataRemap) {
                await applyPageMetadataRemap({
                    workingCopyPath: target,
                    delta: mutation.delta,
                    ...(metadataSnapshot ? {metadataSnapshot} : {}),
                    ...nativeOptions,
                });
            }
            const actualPageCount = await getPdfPageCount(target, nativeOptions);
            const predictedPageCount = mutation.delta.nextPageCount ?? mutation.delta.pages?.length;
            if (predictedPageCount === undefined || predictedPageCount !== actualPageCount) {
                throw new Error(`Page operation reopen verification failed: predicted ${predictedPageCount ?? 'unknown'}, received ${actualPageCount}`);
            }
            if (input.strictStructureCheck) {
                await verifyPdfStructureStrict(target, nativeOptions);
            }
            // The store's commit is the commit point. A cancel accepted before
            // it leaves the document as it was.
            input.operation.signal.throwIfAborted();
            input.operation.markCommitStarted();
            committed = mutation;
        },
        'page-ops',
    );
    const documentRevision = await runWithWorkingCopyMutationCommitSignal(DEFERRED_COMMIT_SIGNAL, async () => {
        try {
            return await write();
        } catch (error) {
            // The page engine could not read the document: repair its revision as its open does, then edit once more.
            if (findSerializableErrorEnvelope(error, NATIVE_ERROR_ENVELOPE_SCHEMA)?.code !== 'corrupt-xref') throw error;
            const refused = documentRevisionToken(entry);
            const repaired = await rewriteDocument(entry, (source, target) => rewritePdfWithQpdf(source, target, nativeOptions), 'open')
                .catch(() => {
                    throw error;
                });
            logger.debug('Repaired a revision the page engine could not read', {error: getErrorMessage(error)});
            try {
                return await write();
            } catch (retryError) {
                // The viewer holds the objects of the revision it edited, so that revision stays current.
                await restoreOpenDocumentRevision(entry, refused, repaired.token);
                throw retryError;
            }
        }
    });
    if (!committed) throw new Error('Page operation did not publish a result');
    return {
        value: committed.value,
        documentRevision,
        pageIdentityDelta: committed.delta,
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
): Promise<IPageOpsCommittedResult> {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    const expectedTotalPages = validateExpectedTotalPages(totalPages);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const result = await enqueuePageMutation(context, normalizedWorkingCopyPath, operation => runPageMutation({
        ref: normalizedWorkingCopyPath,
        senderId: context.senderId,
        token: expectedDocumentRevisionToken,
        expectedTotalPages,
        operation,
        options,
        mutate: async (source, target, pageCount) => {
            const ranges = validatePageOpsSelection(pages, pageCount, 'deletePages');
            return {
                value: await deletePageRanges(source, target, ranges, pageCount, createNativeOperationOptions(operation)),
                delta: isCompactPageSelection(pages)
                    ? createDeleteRangesIdentityDelta(pageCount, ranges)
                    : createDeleteIdentityDelta(pageCount, pages),
            };
        },
    }));
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
): Promise<IPageOpsCommittedResult> {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    const expectedTotalPages = validateExpectedTotalPages(totalPages);
    validatePageDeleteRanges(ranges, expectedTotalPages);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const result = await enqueuePageMutation(context, normalizedWorkingCopyPath, operation => runPageMutation({
        ref: normalizedWorkingCopyPath,
        senderId: context.senderId,
        token: expectedDocumentRevisionToken,
        expectedTotalPages,
        operation,
        options,
        mutate: async (source, target, pageCount) => ({
            value: await deletePageRanges(source, target, ranges, pageCount, createNativeOperationOptions(operation)),
            delta: createDeleteRangesIdentityDelta(pageCount, ranges),
        }),
    }));
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
    const readDocument = <T>(read: (path: string) => Promise<T>) => runWithWorkingCopyReadBacking(
        normalizedWorkingCopyPath,
        read,
        {ownerWebContentsId: context.senderId},
    );
    const actualPageCount = await readDocument(path => getPdfPageCount(path));
    const ranges = validatePageOpsSelection(pages, actualPageCount, 'extractPages');

    const namePath = getWorkingCopyOriginalPath(normalizedWorkingCopyPath, context.senderId)?.originalPath ?? normalizedWorkingCopyPath;
    const baseName = basename(namePath, extname(namePath));
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
    const automationTargetPath = getAutomationSaveDialogPath();
    const result = automationTargetPath
        ? {
            canceled: false,
            filePath: automationTargetPath,
        }
        : context.parentWindow
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

    await enqueuePageMutation(context, normalizedWorkingCopyPath, operation => readDocument(source => Array.isArray(pages)
        ? extractPages(source, destPath, pages, createNativeOperationOptions(operation))
        : extractPageRanges(source, destPath, ranges, createNativeOperationOptions(operation))));
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
): Promise<IPageOpsCommittedResult> {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    validatePageNumbers(newOrder, 'reorderPages', {requireUnique: true});
    validateReorderPermutation(newOrder);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const result = await enqueuePageMutation(context, normalizedWorkingCopyPath, operation => runPageMutation({
        ref: normalizedWorkingCopyPath,
        senderId: context.senderId,
        token: expectedDocumentRevisionToken,
        operation,
        options,
        mutate: async (source, target, pageCount) => {
            validatePageNumbers(newOrder, 'reorderPages', {
                requireUnique: true,
                totalPages: pageCount,
            });
            validateReorderPermutation(newOrder, pageCount);
            return {
                value: await reorderPages(source, target, newOrder, createNativeOperationOptions(operation)),
                delta: createReorderIdentityDelta(pageCount, newOrder),
            };
        },
    }));
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
): Promise<IPageOpsCommittedResult> {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    validatePageMoveRange(startPage, endPage, insertAt, totalPages);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const movedCount = endPage - startPage + 1;
    const destinationStart = insertAt < startPage - 1
        ? insertAt + 1
        : insertAt > endPage
            ? insertAt - movedCount + 1
            : startPage;
    const move = createPageMoveRanges(totalPages, [{
        startPage,
        endPage,
    }], insertAt);
    const result = await enqueuePageMutation(context, normalizedWorkingCopyPath, operation => runPageMutation({
        ref: normalizedWorkingCopyPath,
        senderId: context.senderId,
        token: expectedDocumentRevisionToken,
        expectedTotalPages: totalPages,
        operation,
        options,
        mutate: async (source, target) => ({
            value: await movePageRanges(source, target, move, createNativeOperationOptions(operation)),
            delta: createMoveIdentityDelta(totalPages, startPage, destinationStart, movedCount),
        }),
    }));
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
): Promise<IPageOpsCommittedResult> {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    validatePageMoveRanges(ranges, insertAt, totalPages);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const move = createPageMoveRanges(totalPages, ranges, insertAt);
    const result = await enqueuePageMutation(context, normalizedWorkingCopyPath, operation => runPageMutation({
        ref: normalizedWorkingCopyPath,
        senderId: context.senderId,
        token: expectedDocumentRevisionToken,
        expectedTotalPages: totalPages,
        operation,
        options,
        mutate: async (source, target) => ({
            value: await movePageRanges(source, target, move, createNativeOperationOptions(operation)),
            delta: createPageMoveRangesIdentityDelta(move),
        }),
    }));
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
): Promise<IPageOpsResult> {
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

    const mutation = await enqueuePageMutation(context, normalizedWorkingCopyPath, operation => runPageMutation({
        ref: normalizedWorkingCopyPath,
        senderId: context.senderId,
        token: expectedDocumentRevisionToken,
        expectedTotalPages: insertArgs.totalPages,
        operation,
        options,
        mutate: async (source, target, pageCount) => {
            const nativeOptions = createNativeOperationOptions(operation);
            await insertPagesFromSourcePaths(source, target, pageCount, trustedSourcePaths, insertArgs.afterPage, undefined, nativeOptions);
            const afterCount = await getPdfPageCount(target, nativeOptions);
            return {
                value: undefined,
                delta: createInsertIdentityDelta(pageCount, insertArgs.afterPage, afterCount - pageCount),
            };
        },
    }));
    return {
        success: true,
        documentRevision: mutation.documentRevision,
        pageIdentityDelta: mutation.pageIdentityDelta,
    };
}

async function handlePageOpsRotate(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
    pages: TPageOpsPageSelection,
    totalPages: number,
    angle: TRotationAngle,
    options?: IPageOpsMutationOptions,
): Promise<IPageOpsCommittedResult> {
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

    const mutation = await enqueuePageMutation(context, normalizedWorkingCopyPath, operation => runPageMutation({
        ref: normalizedWorkingCopyPath,
        senderId: context.senderId,
        token: expectedDocumentRevisionToken,
        expectedTotalPages,
        operation,
        options,
        skipPageMetadataRemap: true,
        write: appendToDocument,
        mutate: async (_source, target, pageCount) => {
            const ranges = validatePageOpsSelection(pages, pageCount, 'rotatePages');
            for (const batch of iteratePageRangeBatches(ranges, PAGE_MUTATION_BATCH_SIZE)) {
                await rotatePages(target, batch, angle, createNativeOperationOptions(operation));
            }
            return {
                value: undefined,
                delta: isCompactPageSelection(pages)
                    ? createRotateRangesIdentityDelta(pageCount, ranges)
                    : createRotateIdentityDelta(pageCount, pages),
            };
        },
    }));
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
): Promise<IPageOpsCommittedResult> {
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

    const mutation = await enqueuePageMutation(context, normalizedWorkingCopyPath, operation => runPageMutation({
        ref: normalizedWorkingCopyPath,
        senderId: context.senderId,
        token: expectedDocumentRevisionToken,
        expectedTotalPages: insertArgs.totalPages,
        operation,
        options,
        mutate: async (source, target, pageCount) => {
            const nativeOptions = createNativeOperationOptions(operation);
            await insertPagesFromSourcePaths(source, target, pageCount, trustedSourcePaths, insertArgs.afterPage, normalizedRequestId
                ? createOpenBatchProgressReporter(context, normalizedRequestId, 'page-insert')
                : undefined, nativeOptions);
            const afterCount = await getPdfPageCount(target, nativeOptions);
            return {
                value: undefined,
                delta: createInsertIdentityDelta(pageCount, insertArgs.afterPage, afterCount - pageCount),
            };
        },
    }));
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
): Promise<IPageOpsCommittedResult> {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    const expectedTotalPages = validateExpectedTotalPages(totalPages);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);
    const normalizedMargins = normalizeCropMargins(margins);

    const mutation = await enqueuePageMutation(context, normalizedWorkingCopyPath, operation => runPageMutation({
        ref: normalizedWorkingCopyPath,
        senderId: context.senderId,
        token: expectedDocumentRevisionToken,
        expectedTotalPages,
        operation,
        options,
        strictStructureCheck: true,
        mutate: async (source, target, pageCount) => {
            const ranges = validatePageOpsSelection(pages, pageCount, 'cropPages');
            await copyNewFile(source, target);
            for (const batch of iteratePageRangeBatches(ranges, PAGE_MUTATION_BATCH_SIZE)) {
                await cropPages(target, batch, normalizedMargins, context.senderId, operation.signal);
            }
            return {
                value: undefined,
                delta: isCompactPageSelection(pages)
                    ? createCropRangesIdentityDelta(pageCount, ranges)
                    : createCropIdentityDelta(pageCount, pages),
            };
        },
    }));
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
): Promise<IPageOpsCommittedResult> {
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    const expectedTotalPages = validateExpectedTotalPages(totalPages);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const mutation = await enqueuePageMutation(context, normalizedWorkingCopyPath, operation => runPageMutation({
        ref: normalizedWorkingCopyPath,
        senderId: context.senderId,
        token: expectedDocumentRevisionToken,
        expectedTotalPages,
        operation,
        options,
        strictStructureCheck: true,
        mutate: async (source, target, pageCount) => {
            const ranges = validatePageOpsSelection(pages, pageCount, 'removeCrop');
            await copyNewFile(source, target);
            for (const batch of iteratePageRangeBatches(ranges, PAGE_MUTATION_BATCH_SIZE)) {
                await removeCropFromPages(target, batch, context.senderId, operation.signal);
            }
            return {
                value: undefined,
                delta: isCompactPageSelection(pages)
                    ? createRemoveCropRangesIdentityDelta(pageCount, ranges)
                    : createRemoveCropIdentityDelta(pageCount, pages),
            };
        },
    }));
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

    return runWithWorkingCopyReadBacking(
        normalizedWorkingCopyPath,
        path => getPageGeometry(path, pageNumber, context.senderId),
        {ownerWebContentsId: context.senderId},
    );
}

// Reads the bytes the document has now, from its original until the working
// copy is materialized, without copying it.
async function handlePageOpsReadOutline(context: IPageOpsOperationContext, workingCopyPath: string) {
    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        throw new Error('Native page operations are required to read PDF bookmarks');
    }
    const bookmarks = await runWithWorkingCopyReadBacking(
        findWorkingCopyPathByOriginalPath(workingCopyPath, context.senderId) ?? workingCopyPath,
        physicalPath => readNativePdfCatalogPart(binaryPath, physicalPath, 'bookmarks', {commandLabel: 'evb-pdf-page-ops(read-outline)'}),
        {ownerWebContentsId: context.senderId},
    );
    return v.parse(v.array(PDF_BOOKMARK_RECOVERY_ENTRY_SCHEMA), bookmarks);
}

const PAGE_OPS_USER_CANCEL_SCOPE = 'page-ops';

class PageOperationUserCanceled extends Error {
    constructor() {
        super('Page operation canceled by the user');
        this.name = 'PageOperationUserCanceled';
    }
}

/**
 * Tracks one page-operation call from the moment its handler starts. A cancel
 * can arrive while the handler is still resolving paths, before the operation
 * reaches the working-copy queue; the handle carries that request into the
 * queue admission so it is never lost.
 */
interface IPageOpUserCancelHandle {
    senderId: number;
    workingCopyPath: unknown;
    enqueued: boolean;
    canceled: boolean;
}

const activePageOpCalls = new Set<IPageOpUserCancelHandle>();

// Page mutations run in the working-copy queue so they serialize with saves.
// Only the renderer that started one may cancel it, and only through this
// scope, so a cancel can never reach a save sharing the same queue.
async function enqueuePageMutation<T>(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
    run: (operation: IWorkingCopyMutationOperation) => Promise<T>,
): Promise<T> {
    if (context.userCancel?.canceled) {
        throw new PageOperationUserCanceled();
    }
    let signal: AbortSignal | null = null;
    try {
        const mutation = enqueueWorkingCopyMutation(workingCopyPath, run, {
            kind: 'page-op',
            userCancel: {
                scope: PAGE_OPS_USER_CANCEL_SCOPE,
                ownerWebContentsId: context.senderId,
            },
            onEnqueued: (enqueuedSignal) => {
                signal = enqueuedSignal;
            },
        });
        if (context.userCancel) {
            context.userCancel.enqueued = true;
        }
        return await mutation;
    } catch (error) {
        if (isMainOperationUserCanceled(signal)) {
            throw new PageOperationUserCanceled();
        }
        throw error;
    }
}

function withUserCancel<TArgs extends [unknown, ...unknown[]], TResult>(
    handler: (context: IPageOpsOperationContext, ...args: TArgs) => Promise<TResult>,
) {
    return async (
        context: {
            sender: WebContents;
            senderId: number;
        },
        ...args: TArgs
    ): Promise<TResult | {
        success: false;
        canceled: true
    }> => {
        const userCancel: IPageOpUserCancelHandle = {
            senderId: context.senderId,
            workingCopyPath: args[0],
            enqueued: false,
            canceled: false,
        };
        activePageOpCalls.add(userCancel);
        try {
            return await handler({
                ...createPageOpsOperationContext(context),
                userCancel,
            }, ...args);
        } catch (error) {
            if (error instanceof PageOperationUserCanceled) {
                return {
                    success: false,
                    canceled: true,
                };
            }
            throw error;
        } finally {
            activePageOpCalls.delete(userCancel);
        }
    };
}

async function handlePageOpsCancelActive(
    context: IPageOpsOperationContext,
    workingCopyPath: string,
) {
    // Marked before the first await: a call that has not reached the queue yet
    // sees the request when it gets there.
    let canceledBeforeQueue = 0;
    for (const call of activePageOpCalls) {
        if (call.senderId === context.senderId && call.workingCopyPath === workingCopyPath && !call.enqueued) {
            call.canceled = true;
            canceledBeforeQueue += 1;
        }
    }
    const normalizedWorkingCopyPath = await resolveWorkingCopyPath(workingCopyPath, context.senderId);
    const queued = cancelUserCancellableMainOperations({
        scope: PAGE_OPS_USER_CANCEL_SCOPE,
        ownerWebContentsId: context.senderId,
        workingCopyPath: normalizedWorkingCopyPath,
    });
    return {
        canceled: canceledBeforeQueue + queued.canceled,
        committing: queued.committing,
    };
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
    async renderTextBoxAppearance(context, workingCopyPath, request) {
        const path = workingCopyPath === null ? undefined : await requireManagedWorkingCopyPath(workingCopyPath, context.senderId);
        const operation = registerMainOperation({
            kind: 'abortable-work',
            ownerWebContentsId: context.senderId,
            workingCopyPath: path,
            ownerLifecycle: {
                destroyed: 'cancel',
                renderProcessGone: 'cancel',
                mainFrameNavigation: 'cancel',
            },
        });
        try {
            const binary = resolveNativePageOpsPath();
            if (!binary) throw new Error('Native text appearance generation is unavailable');
            operation.signal.throwIfAborted();
            return await usingManagedScratchScope('pdf-page-ops-', getAppTempDir(), async directory => {
                const input = join(directory, 'request.json');
                const output = join(directory, 'appearance.pdf');
                const metadata = join(directory, 'metadata.json');
                await writeFile(input, JSON.stringify(request));
                await runNativeToolCommand(binary, [
                    'text-box-appearance',
                    '--input',
                    input,
                    '--output',
                    output,
                    '--metadata-file',
                    metadata,
                ], {
                    signal: operation.signal,
                    timeoutMs: 30_000,
                    commandLabel: 'evb-pdf-page-ops(text-box-appearance)',
                    maxStdoutBytes: 64 * 1024,
                    maxStderrBytes: 512 * 1024,
                    rejectOnStdoutTruncation: true,
                });
                operation.signal.throwIfAborted();
                const [
                    pdfStat,
                    metadataStat,
                ] = await Promise.all([
                    stat(output),
                    stat(metadata),
                ]);
                if (pdfStat.size <= 0 || pdfStat.size > PDF_NATIVE_TEXT_BOX_APPEARANCE_LIMITS.outputBytes || metadataStat.size > 1024 * 1024) {
                    throw new RangeError('Native text appearance exceeds the output budget');
                }
                const [
                    pdf,
                    json,
                ] = await Promise.all([
                    readFile(output),
                    readFile(metadata, 'utf8'),
                ]);
                return {
                    ...normalizePdfNativeTextBoxAppearanceMetadata(JSON.parse(json)),
                    data: new Uint8Array(pdf),
                };
            });
        } finally {
            operation.complete();
        }
    },
    delete: withUserCancel(handlePageOpsDelete),
    deleteRanges: withUserCancel(handlePageOpsDeleteRanges),
    extract: withUserCancel(handlePageOpsExtract),
    reorder: withUserCancel(handlePageOpsReorder),
    move: withUserCancel(handlePageOpsMove),
    moveRanges: withUserCancel(handlePageOpsMoveRanges),
    insert: withUserCancel(handlePageOpsInsert),
    insertFile: withUserCancel(handlePageOpsInsertFile),
    rotate: withUserCancel(handlePageOpsRotate),
    crop: withUserCancel(handlePageOpsCrop),
    removeCrop: withUserCancel(handlePageOpsRemoveCrop),
    cancelActive: (context, ...args) => handlePageOpsCancelActive(createPageOpsOperationContext(context), ...args),
    getPageGeometry: (context, ...args) =>
        handlePageOpsGetPageGeometry(createPageOpsOperationContext(context), ...args),
    readOutline: (context, ...args) => handlePageOpsReadOutline(createPageOpsOperationContext(context), ...args),
} satisfies TFeatureMainBindings<typeof PAGE_OPS_PLATFORM_FEATURE, IpcMainInvokeEvent>;
