import type {
    IPageIdentityDelta,
    IPageOpsMutationOptions,
    TPageIdentityDeltaPage,
    TPageOpsPageSelection,
    TPageOpsRotationAngle,
} from '@contracts/electronApiPageOps';
import type {
    PAGE_OPS_PLATFORM_FEATURE,
    IPageOpsCapability,
} from '@contracts/pageOpsPlatformFeature';
import {
    buildPageMoveOrder,
    buildPageMoveRangesOrder,
    createPageMoveRange,
    createPageMoveRanges,
    isPageMoveNoOp,
    isPageMoveRangesNoOp,
} from '@pdf-core/pdfPageSelection';
import type { IPageMoveRangeSegment } from '@pdf-core/pdfPageSelection';
import type { TFeatureBrowserBindings } from '@contracts/platformFeature';
import {
    PDF_BOOKMARK_RECOVERY_ENTRY_SCHEMA,
    type IPdfBookmarkEntry,
} from '@contracts/pdfBookmarkEntry';
import * as v from 'valibot';
import { readBrowserPdfCatalogPart } from '@contracts/browserPdfCatalog';
import {
    createRequestId,
    type ICropMargins,
    type IPageGeometry,
    type TRequestId,
} from '@contracts/shared';
import { isNativeLegacyDocumentRef } from '@contracts/documentRef';
import { normalizeCropMargins } from '@contracts/shared';
import type * as BrowserPageOpsCoreModule from '@app/platform/browser-api/browserPageOpsCore';
import {
    browserDocumentStore,
    getBrowserDocumentFileName,
} from '@app/platform/browserDocumentStore';
import type { IPickedBrowserFile } from '@app/platform/browser-api/browserFilePickerAdapter';
import { buildPdfSaveTypes } from '@app/platform/browser-api/browserFileAccepts';
import type { IFilePickerAcceptType } from '@app/platform/browser-api/browserFileAccepts';
import { ensurePdfExtension } from '@app/platform/browser-api/browserFileName';
import {
    BrowserPageOpsWorkerUnavailableError,
    canUseBrowserPageOpsWorker,
    runBrowserPageOpsWorkerRequest,
} from '@app/platform/browser-api/browserPageOpsWorkerClient';
import type {
    IBrowserBatchOpenProgressOptions,
    ICombinedPdfDocument,
} from '@app/platform/browser-api/createCombinedPdfFromPaths';
import type { TPageStructureEdit } from '@app/platform/browser/pdfPageEngine';
import type {
    IBrowserPageOpsWorkerRequestMap,
    IBrowserPageOpsWorkerResultMap,
    TBrowserPageOpsWorkerRequestType,
} from '@contracts/browserPageOpsWorker';
import {isBrowserPageOpsWasmFailure} from '@contracts/browserPageOpsWorker';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import {BROWSER_PAGE_OPS_MAX_REQUEST_BYTES} from '@contracts/browserPageOpsLimits';
import {REQUEST_HEADER} from '@contracts/browserPageOpsWasm.generated';
import { PdfPageOpsCapabilityError } from '@contracts/pageOpsErrors';
import { NATIVE_ERROR_ENVELOPE_SCHEMA } from '@contracts/nativeErrors';
import {
    findSerializableErrorEnvelope,
    SerializableError,
} from '@contracts/serializableError';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';

interface ISaveBytesResult {
    canceled: boolean;
    fileName: string;
    handle?: FileSystemFileHandle | null;
}

// Rotate, crop and the readers still send the whole document in one engine request.
const BROWSER_PAGE_OP_INPUT_MAX_BYTES = BROWSER_PAGE_OPS_MAX_REQUEST_BYTES - REQUEST_HEADER.bytes;

interface IStoredPageMutationResult {
    success: true;
    pageCount: number;
    pageIdentityDelta?: IPageIdentityDelta;
}

interface ICreateBrowserPageOpsOptions {
    clearSearchCaches: () => void | Promise<void>;
    openInputAccept: string;
    pickFiles: (options: {
        accept: string;
        multiple?: boolean;
        pickerTypes?: IFilePickerAcceptType[];
    }) => Promise<IPickedBrowserFile[]>;
    buildOpenPdfPickerTypes: () => IFilePickerAcceptType[];
    createCombinedPdfFromPaths: (
        paths: string[],
        progressOptions?: IBrowserBatchOpenProgressOptions,
        output?: ICombinedPdfDocument,
    ) => Promise<string>;
    pickSaveTarget: (options: {
        suggestedName: string;
        pickerTypes: IFilePickerAcceptType[];
    }) => Promise<ISaveBytesResult>;
    saveBytesToPickerOrDownload: (
        bytes: Uint8Array | Blob,
        options: {
            suggestedName: string;
            mimeType: string;
            pickerTypes: IFilePickerAcceptType[];
        },
    ) => Promise<ISaveBytesResult>;
    writeBytesToHandle: (
        handle: FileSystemFileHandle,
        data: Uint8Array | Blob,
    ) => Promise<void>;
    /** Commits the open's qpdf rewrite of a working copy's revision; whether it did. */
    repairWorkingCopy: (workingCopyPath: string, signal: AbortSignal) => Promise<boolean>;
}

type TBrowserPageOpsCoreModule = typeof BrowserPageOpsCoreModule;

let browserPageOpsCorePromise: Promise<TBrowserPageOpsCoreModule> | null = null;

function loadBrowserPageOpsCore() {
    browserPageOpsCorePromise ??= import('@app/platform/browser-api/browserPageOpsCore');
    return browserPageOpsCorePromise;
}

function assertBrowserPageOpsSource(path: string, operation: string) {
    if (!isNativeLegacyDocumentRef(path)) {
        return;
    }
    throw new PdfPageOpsCapabilityError(
        'native-unavailable',
        `Native page operations are unavailable for desktop path: ${path}`,
        {operation},
    );
}

function materializePageRanges(
    ranges: readonly IPageMoveRangeSegment[],
    totalPages: number,
    operation = 'Deleting page ranges',
) {
    const selectedCount = ranges.reduce(
        (count, range) => count + range.endPage - range.startPage + 1,
        0,
    );
    if (selectedCount <= 0) {
        throw new Error(`${operation} received an empty selection`);
    }
    const pages: number[] = [];
    for (const range of ranges) {
        for (let page = range.startPage; page <= range.endPage; page += 1) {
            pages.push(page);
        }
    }
    if (pages.some(page => page < 1 || page > totalPages)) {
        throw new Error(`${operation} received an out-of-range page`);
    }
    return pages;
}

function materializePageSelection(
    selection: TPageOpsPageSelection,
    totalPages: number,
    operation: string,
) {
    if (!Array.isArray(selection) && selection.pageCount !== totalPages) {
        throw new Error(`${operation} received a selection for a different document`);
    }
    const selectedCount = Array.isArray(selection)
        ? selection.length
        : selection.ranges.reduce(
            (count, range) => count + range.endPage - range.startPage + 1,
            0,
        );
    if (selectedCount <= 0) {
        throw new Error(`${operation} received an empty selection`);
    }
    if (Array.isArray(selection)) {
        return selection;
    }
    return materializePageRanges(selection.ranges, totalPages, operation);
}

function createDeletePageIdentityDelta(
    previousPageCount: number,
    deletedPages: readonly number[],
): IPageIdentityDelta {
    const deleted = new Set(deletedPages);
    const pages: TPageIdentityDeltaPage[] = [];
    for (let pageNumber = 1; pageNumber <= previousPageCount; pageNumber += 1) {
        if (!deleted.has(pageNumber)) {
            pages.push({fromPageNumber: pageNumber});
        }
    }
    return {
        previousPageCount,
        pages,
    };
}

function createReorderPageIdentityDelta(
    previousPageCount: number,
    newOrder: readonly number[],
): IPageIdentityDelta {
    return {
        previousPageCount,
        pages: newOrder.map(fromPageNumber => ({fromPageNumber})),
    };
}

function createInsertPageIdentityDelta(
    previousPageCount: number,
    afterPage: number,
    insertedPageCount: number,
): IPageIdentityDelta {
    const pages: TPageIdentityDeltaPage[] = [];
    for (let pageNumber = 1; pageNumber <= afterPage; pageNumber += 1) {
        pages.push({fromPageNumber: pageNumber});
    }
    for (let index = 0; index < insertedPageCount; index += 1) {
        pages.push({insertedId: globalThis.crypto.randomUUID()});
    }
    for (let pageNumber = afterPage + 1; pageNumber <= previousPageCount; pageNumber += 1) {
        pages.push({fromPageNumber: pageNumber});
    }
    return {
        previousPageCount,
        pages,
    };
}

/**
 * One page-operation call, from its start until its result is written. As on
 * desktop, a cancel before the write stops it and the call returns canceled;
 * once the write has started it completes and counts as committing.
 */
interface IActivePageOperation {
    workingCopyPath: string;
    controller: AbortController;
    committing: boolean;
}

// Stopping the engine ends its dedicated worker; the result is never written.
function beginPageOperationCommit(operation: IActivePageOperation) {
    operation.controller.signal.throwIfAborted();
    operation.committing = true;
}

/**
 * Runs a page-structure edit in its own worker, which reads `sources` by range and writes the new file at the
 * store path `output`, or returns the bytes when `output` is null. A full store is the storage-full result.
 */
async function runPageStructure(edit: TPageStructureEdit, sources: Blob[], output: string | null, signal?: AbortSignal) {
    const result = await runBrowserPageOpsWorkerRequest('pageStructure', {edit, sources, output}, {
        dedicated: true,
        ...(signal ? {signal} : {}),
    });
    if (result.status === 'storage-full') {
        throw new DOMException('The browser\'s storage is full. Free space for this site and try again.', 'QuotaExceededError');
    }
    if (result.status === 'failed') {
        throw new SerializableError(result.error);
    }
    return result;
}

/** Writes `edit` over `sources` into the new document `ref` holds, which starts clean. */
export async function writePageStructureDocument(ref: string, edit: TPageStructureEdit, sources: Blob[], signal?: AbortSignal) {
    let pageCount = 0;
    await browserDocumentStore.rewrite(ref, null, async (_empty, output) => {
        const result = await runPageStructure(edit, sources, output, signal);
        pageCount = result.pageCount;
        return result.data;
    }, {imported: true});
    return pageCount;
}

export function createBrowserPageOpsCapability(
    options: ICreateBrowserPageOpsOptions,
): IPageOpsCapability {
    const workingCopyMutationQueues = new Map<string, Promise<unknown>>();
    const activePageOperations = new Set<IActivePageOperation>();

    function withUserCancel<TArgs extends [string, ...unknown[]], TResult>(
        run: (operation: IActivePageOperation, ...args: TArgs) => Promise<TResult>,
    ) {
        return async (...args: TArgs): Promise<TResult | {
            success: false;
            canceled: true
        }> => {
            const operation: IActivePageOperation = {
                workingCopyPath: args[0],
                controller: new AbortController(),
                committing: false,
            };
            activePageOperations.add(operation);
            try {
                return await run(operation, ...args);
            } catch (error) {
                if (operation.controller.signal.aborted) {
                    return {
                        success: false,
                        canceled: true,
                    };
                }
                throw error;
            } finally {
                activePageOperations.delete(operation);
            }
        };
    }

    /**
     * Runs `run` after the working copy's earlier mutations; the result names the revision it committed. When the
     * page engine cannot read the working copy, its revision is repaired as its open repairs it and `run` runs once
     * more, on the repaired revision.
     */
    async function serializeWorkingCopyMutation(
        operation: IActivePageOperation,
        mutationOptions: IPageOpsMutationOptions | undefined,
        run: (mutationOptions: IPageOpsMutationOptions | undefined) => Promise<IStoredPageMutationResult>,
    ) {
        const {workingCopyPath} = operation;
        const previous = workingCopyMutationQueues.get(workingCopyPath) ?? Promise.resolve();
        const next = previous
            .catch(() => {})
            .then(async () => {
                // A call canceled while it waited behind another never starts.
                operation.controller.signal.throwIfAborted();
                await browserDocumentStore.assertDocumentRevisionCurrent(
                    workingCopyPath,
                    mutationOptions?.expectedDocumentRevisionToken,
                );
                return {
                    ...await runOnReadableRevision(operation, mutationOptions, run),
                    documentRevision: await browserDocumentStore.getDocumentRevision(workingCopyPath),
                };
            });
        workingCopyMutationQueues.set(workingCopyPath, next);
        try {
            return await next;
        } finally {
            if (workingCopyMutationQueues.get(workingCopyPath) === next) {
                workingCopyMutationQueues.delete(workingCopyPath);
            }
        }
    }

    async function runOnReadableRevision(
        operation: IActivePageOperation,
        mutationOptions: IPageOpsMutationOptions | undefined,
        run: (mutationOptions: IPageOpsMutationOptions | undefined) => Promise<IStoredPageMutationResult>,
    ) {
        try {
            return await run(mutationOptions);
        } catch (error) {
            const {workingCopyPath, controller: {signal}} = operation;
            if (findSerializableErrorEnvelope(error, NATIVE_ERROR_ENVELOPE_SCHEMA)?.code !== 'corrupt-xref') throw error;
            const refused = await browserDocumentStore.getDocumentRevision(workingCopyPath);
            if (!await options.repairWorkingCopy(workingCopyPath, signal).catch(() => false)) throw error;
            BrowserLogger.debug('page-ops', 'Repaired a revision the page engine could not read', {error: getErrorMessage(error)});
            const repaired = await browserDocumentStore.getDocumentRevision(workingCopyPath);
            try {
                return await run({...mutationOptions, expectedDocumentRevisionToken: repaired.token});
            } catch (retryError) {
                // The viewer holds the objects of the revision it edited, so that revision stays current.
                await browserDocumentStore.restoreRevision(workingCopyPath, refused.token, repaired.token);
                throw retryError;
            }
        }
    }

    async function readWorkingCopyBytes(path: string) {
        assertBrowserPageOpsSource(path, 'Reading page-operation input');
        await yieldToBrowser();
        return browserDocumentStore.read(path, {maxBytes: BROWSER_PAGE_OP_INPUT_MAX_BYTES});
    }

    /** The pages to insert as one PDF, and what to remove once they are inserted. */
    async function readInsertion(sourcePaths: string[], requestId: TRequestId | undefined, signal: AbortSignal) {
        for (const sourcePath of sourcePaths) {
            assertBrowserPageOpsSource(sourcePath, 'Inserting pages');
        }
        const [sourcePath] = sourcePaths;
        if (sourcePaths.length === 1 && sourcePath && /\.pdf$/iu.test(getBrowserDocumentFileName(sourcePath))) {
            return {blob: await browserDocumentStore.readableBlob(sourcePath), release: async () => {}};
        }
        const combined = await options.createCombinedPdfFromPaths(sourcePaths, {
            operation: 'page-insert',
            requestId: requestId ?? createRequestId('browser-page-op-insert'),
            signal,
        });
        return {
            blob: await browserDocumentStore.readableBlob(combined),
            release: () => browserDocumentStore.remove(combined),
        };
    }

    async function readPickedInsertion(pickedFiles: IPickedBrowserFile[], signal: AbortSignal) {
        const [single] = pickedFiles;
        // One picked PDF is read where it is, as desktop reads its path.
        if (pickedFiles.length === 1 && single && /\.pdf$/iu.test(single.file.name)) {
            return {blob: single.file as Blob, release: async () => {}};
        }
        const sourcePaths = await Promise.all(pickedFiles.map(picked => browserDocumentStore.registerFile(picked.file, {
            kind: 'source',
            retention: 'transient',
            saveKind: 'generic',
            saveHandle: picked.handle ?? null,
        })));
        try {
            return await readInsertion(sourcePaths, undefined, signal);
        } finally {
            await Promise.allSettled(sourcePaths.map(sourcePath => browserDocumentStore.cleanupDetachedDocument(sourcePath)));
        }
    }

    async function runDirectPdfOperation<T>(
        run: () => Promise<T>,
    ) {
        await yieldToBrowser();
        const result = await run();
        await yieldToBrowser();
        return result;
    }

    async function runWorkerBackedPdfOperation<K extends TBrowserPageOpsWorkerRequestType>(options: {
        path: string;
        // A cancellable call runs on its own worker, so canceling it stops
        // only that engine.
        signal?: AbortSignal;
        type: K;
        createPayload: (data: Uint8Array) => IBrowserPageOpsWorkerRequestMap[K];
        runDirect: (data: Uint8Array) => Promise<IBrowserPageOpsWorkerResultMap[K]>;
    }) {
        const data = await readWorkingCopyBytes(options.path);
        let directData = data;
        if (canUseBrowserPageOpsWorker()) {
            try {
                return await runBrowserPageOpsWorkerRequest(
                    options.type,
                    options.createPayload(data),
                    options.signal ? {
                        dedicated: true,
                        signal: options.signal,
                        transferInput: true,
                    } : {},
                );
            } catch (error) {
                if (!(error instanceof BrowserPageOpsWorkerUnavailableError)) {
                    throw error;
                }
                directData = await readWorkingCopyBytes(options.path);
            }
        }

        // Without a worker the engine runs here, as one long task.
        return runDirectPdfOperation(() => options.runDirect(directData));
    }

    /** Rewrites the working copy with `edit` over its bytes and `extraSources`; returns the new page count. */
    async function rewriteWorkingCopy(
        operation: IActivePageOperation,
        mutationOptions: IPageOpsMutationOptions | undefined,
        edit: TPageStructureEdit,
        extraSources: Blob[] = [],
    ) {
        assertBrowserPageOpsSource(operation.workingCopyPath, 'Rewriting pages');
        let pageCount = 0;
        await browserDocumentStore.rewrite(operation.workingCopyPath, mutationOptions?.expectedDocumentRevisionToken, async (source, output) => {
            const result = await runPageStructure(edit, [
                source,
                ...extraSources,
            ], output, operation.controller.signal);
            beginPageOperationCommit(operation);
            pageCount = result.pageCount;
            return result.data;
        });
        await options.clearSearchCaches();
        return pageCount;
    }

    async function writePageMutationResult(
        operation: IActivePageOperation,
        data: Uint8Array,
        pageCount: number,
        mutationOptions: IPageOpsMutationOptions | undefined,
    ): Promise<IStoredPageMutationResult> {
        beginPageOperationCommit(operation);
        await browserDocumentStore.write(operation.workingCopyPath, data, mutationOptions ?? {});
        await options.clearSearchCaches();
        return {
            success: true,
            pageCount,
        };
    }

    async function deletePages(
        operation: IActivePageOperation,
        pages: TPageOpsPageSelection,
        totalPages: number,
        mutationOptions: IPageOpsMutationOptions | undefined,
    ) {
        const selectedPages = materializePageSelection(pages, totalPages, 'Deleting pages');
        return serializeWorkingCopyMutation(operation, mutationOptions, async (revision) => ({
            success: true,
            pageCount: await rewriteWorkingCopy(operation, revision, {kind: 'delete', pages: selectedPages}),
            pageIdentityDelta: createDeletePageIdentityDelta(totalPages, selectedPages),
        }));
    }

    async function reorderPages(
        operation: IActivePageOperation,
        newOrder: number[],
        mutationOptions: IPageOpsMutationOptions | undefined,
    ) {
        return serializeWorkingCopyMutation(operation, mutationOptions, async (revision) => ({
            success: true,
            pageCount: await rewriteWorkingCopy(operation, revision, {kind: 'reorder', pages: newOrder}),
            pageIdentityDelta: createReorderPageIdentityDelta(newOrder.length, newOrder),
        }));
    }

    /** `readPages` gives the pages to insert as one PDF, read when the call's turn comes. */
    async function insertPages(
        operation: IActivePageOperation,
        totalPages: number,
        afterPage: number,
        readPages: () => Promise<{blob: Blob; release: () => Promise<void>}>,
        mutationOptions: IPageOpsMutationOptions | undefined,
    ) {
        return serializeWorkingCopyMutation(operation, mutationOptions, async (revision) => {
            const insertion = await readPages();
            try {
                const pageCount = await rewriteWorkingCopy(operation, revision, {kind: 'insert', afterPage}, [insertion.blob]);
                return {
                    success: true,
                    pageCount,
                    pageIdentityDelta: createInsertPageIdentityDelta(totalPages, afterPage, pageCount - totalPages),
                };
            } finally {
                await insertion.release();
            }
        });
    }

    async function rewriteSelectedPages<K extends 'rotate' | 'crop' | 'removeCrop'>(
        operation: IActivePageOperation,
        selectedPages: number[],
        mutationOptions: IPageOpsMutationOptions | undefined,
        type: K,
        createPayload: (data: Uint8Array) => IBrowserPageOpsWorkerRequestMap[K],
        runDirect: (data: Uint8Array) => Promise<IBrowserPageOpsWorkerResultMap[K]>,
    ) {
        return serializeWorkingCopyMutation(operation, mutationOptions, async (revision) => {
            const result = await runWorkerBackedPdfOperation({
                path: operation.workingCopyPath,
                signal: operation.controller.signal,
                type,
                createPayload,
                runDirect,
            });
            return writePageMutationResult(operation, result.data, result.pageCount, revision);
        });
    }

    const pageOps: IPageOpsCapability = {
        delete: withUserCancel((operation, _workingCopyPath: string, pages: TPageOpsPageSelection, totalPages: number, mutationOptions?: IPageOpsMutationOptions) => (
            deletePages(operation, pages, totalPages, mutationOptions)
        )),
        deleteRanges: withUserCancel((operation, _workingCopyPath: string, ranges: readonly IPageMoveRangeSegment[], totalPages: number, mutationOptions?: IPageOpsMutationOptions) => (
            deletePages(operation, materializePageRanges(ranges, totalPages), totalPages, mutationOptions)
        )),
        extract: withUserCancel(async (operation, workingCopyPath: string, pages: TPageOpsPageSelection) => {
            const selectedPages = materializePageSelection(
                pages,
                Array.isArray(pages) ? Number.MAX_SAFE_INTEGER : pages.pageCount,
                'Extracting pages',
            );
            const sourceName = getBrowserDocumentFileName(workingCopyPath).replace(
                /\.pdf$/iu,
                '',
            );
            const saveTarget = await options.pickSaveTarget({
                suggestedName: ensurePdfExtension(`${sourceName}-extract`),
                pickerTypes: buildPdfSaveTypes(),
            });
            if (saveTarget.canceled) {
                return {
                    success: false,
                    canceled: true,
                };
            }

            assertBrowserPageOpsSource(workingCopyPath, 'Extracting pages');
            // The extracted PDF is written into its own stored document, then published from there.
            const normalizedFileName = ensurePdfExtension(saveTarget.fileName);
            const destPath = await browserDocumentStore.createStoredDocument(normalizedFileName, new Uint8Array(), {
                mimeType: 'application/pdf',
                saveKind: 'pdf',
                kind: 'source',
                saveHandle: saveTarget.handle ?? null,
            });
            let published = false;
            try {
                await writePageStructureDocument(destPath, {kind: 'extract', pages: selectedPages}, [
                    await browserDocumentStore.readableBlob(workingCopyPath),
                ], operation.controller.signal);
                beginPageOperationCommit(operation);
                const output = await browserDocumentStore.readableBlob(destPath);
                if (saveTarget.handle) {
                    await options.writeBytesToHandle(saveTarget.handle, output);
                    await browserDocumentStore.replaceWithHandleBackedDocument(destPath, {
                        fileSize: output.size,
                        saveHandle: saveTarget.handle,
                        saveName: normalizedFileName,
                    });
                } else {
                    const saveResult = await options.saveBytesToPickerOrDownload(output, {
                        suggestedName: normalizedFileName,
                        mimeType: 'application/pdf',
                        pickerTypes: buildPdfSaveTypes(),
                    });
                    if (saveResult.canceled) {
                        return {
                            success: false,
                            canceled: true,
                        };
                    }
                }
                published = true;
            } finally {
                if (!published) await browserDocumentStore.remove(destPath).catch(() => undefined);
            }
            await browserDocumentStore.touchRecentFile(destPath);
            return {
                success: true,
                destPath,
            };
        }),
        reorder: withUserCancel((operation, _workingCopyPath: string, newOrder: number[], mutationOptions?: IPageOpsMutationOptions) => (
            reorderPages(operation, newOrder, mutationOptions)
        )),
        move: withUserCancel(async (operation, workingCopyPath: string, startPage: number, endPage: number, insertAt: number, totalPages: number, mutationOptions?: IPageOpsMutationOptions) => {
            assertBrowserPageOpsSource(workingCopyPath, 'Moving pages');
            const move = createPageMoveRange(totalPages, startPage, endPage, insertAt);
            if (isPageMoveNoOp(move)) {
                return serializeWorkingCopyMutation(operation, mutationOptions, () => Promise.resolve({
                    success: true,
                    pageCount: move.pageCount,
                }));
            }
            return reorderPages(operation, buildPageMoveOrder(move), mutationOptions);
        }),
        moveRanges: withUserCancel(async (operation, workingCopyPath: string, ranges: readonly IPageMoveRangeSegment[], insertAt: number, totalPages: number, mutationOptions?: IPageOpsMutationOptions) => {
            assertBrowserPageOpsSource(workingCopyPath, 'Moving pages');
            const move = createPageMoveRanges(totalPages, ranges, insertAt);
            if (isPageMoveRangesNoOp(move)) {
                return serializeWorkingCopyMutation(operation, mutationOptions, () => Promise.resolve({
                    success: true,
                    pageCount: move.pageCount,
                }));
            }
            return reorderPages(operation, buildPageMoveRangesOrder(move), mutationOptions);
        }),
        insert: withUserCancel(async (operation, _workingCopyPath: string, totalPages: number, afterPage: number, mutationOptions?: IPageOpsMutationOptions) => {
            const pickedFiles = await options.pickFiles({
                accept: options.openInputAccept,
                multiple: true,
                pickerTypes: options.buildOpenPdfPickerTypes(),
            });
            if (pickedFiles.length === 0) {
                return {
                    success: false,
                    canceled: true,
                } as const;
            }

            return insertPages(
                operation,
                totalPages,
                afterPage,
                () => readPickedInsertion(pickedFiles, operation.controller.signal),
                mutationOptions,
            );
        }),
        insertFile: withUserCancel((operation, _workingCopyPath: string, totalPages: number, afterPage: number, sourcePaths: string[], requestId?: TRequestId, mutationOptions?: IPageOpsMutationOptions) => (
            insertPages(
                operation,
                totalPages,
                afterPage,
                () => readInsertion(sourcePaths, requestId, operation.controller.signal),
                mutationOptions,
            )
        )),
        rotate: withUserCancel((operation, _workingCopyPath: string, pages: TPageOpsPageSelection, totalPages: number, angle: TPageOpsRotationAngle, mutationOptions?: IPageOpsMutationOptions) => {
            const selectedPages = materializePageSelection(pages, totalPages, 'Rotating pages');
            return rewriteSelectedPages(operation, selectedPages, mutationOptions, 'rotate', data => ({
                data,
                pages: selectedPages,
                angle,
            }), async (data) => {
                const { rotatePdfBytes } = await loadBrowserPageOpsCore();
                return rotatePdfBytes(data, selectedPages, angle);
            });
        }),
        crop: withUserCancel((operation, _workingCopyPath: string, pages: TPageOpsPageSelection, totalPages: number, margins: ICropMargins, mutationOptions?: IPageOpsMutationOptions) => {
            const selectedPages = materializePageSelection(pages, totalPages, 'Cropping pages');
            const normalizedMargins = normalizeCropMargins(margins);
            return rewriteSelectedPages(operation, selectedPages, mutationOptions, 'crop', data => ({
                data,
                pages: selectedPages,
                margins: normalizedMargins,
            }), async (data) => {
                const { cropPdfBytes } = await loadBrowserPageOpsCore();
                return cropPdfBytes(data, selectedPages, normalizedMargins);
            });
        }),
        removeCrop: withUserCancel((operation, _workingCopyPath: string, pages: TPageOpsPageSelection, totalPages: number, mutationOptions?: IPageOpsMutationOptions) => {
            const selectedPages = materializePageSelection(pages, totalPages, 'Removing crop');
            return rewriteSelectedPages(operation, selectedPages, mutationOptions, 'removeCrop', data => ({
                data,
                pages: selectedPages,
            }), async (data) => {
                const { removeCropPdfBytes } = await loadBrowserPageOpsCore();
                return removeCropPdfBytes(data, selectedPages);
            });
        }),
        cancelActive(workingCopyPath) {
            let canceled = 0;
            let committing = 0;
            for (const operation of activePageOperations) {
                if (operation.workingCopyPath !== workingCopyPath || operation.controller.signal.aborted) continue;
                if (operation.committing) {
                    committing += 1;
                } else {
                    operation.controller.abort(new DOMException('Page operation canceled by the user', 'AbortError'));
                    canceled += 1;
                }
            }
            return Promise.resolve({
                canceled,
                committing,
            });
        },
        async renderTextBoxAppearance(_workingCopyPath, request, options) {
            const result = await runBrowserPageOpsWorkerRequest('textBoxAppearance', request, options);
            if (isBrowserPageOpsWasmFailure(result)) {
                throw new PdfPageOpsCapabilityError(
                    result.error.code === 'too-large' ? 'too-large' : 'native-unavailable',
                    result.error.message,
                    {operation: 'text-box appearance'},
                );
            }
            return result;
        },
        async getPageGeometry(workingCopyPath, pageNumber): Promise<IPageGeometry> {
            return runWorkerBackedPdfOperation({
                path: workingCopyPath,
                type: 'getPageGeometry',
                createPayload: (data) => ({
                    data,
                    pageNumber,
                }),
                runDirect: async (data) => {
                    const { getPageGeometryFromPdfBytes } = await loadBrowserPageOpsCore();
                    return getPageGeometryFromPdfBytes(data, pageNumber);
                },
            });
        },
        async readOutline(workingCopyPath): Promise<IPdfBookmarkEntry[]> {
            assertBrowserPageOpsSource(workingCopyPath, 'Reading the outline');
            const catalog = await runBrowserPageOpsWorkerRequest('readCatalog', {source: await browserDocumentStore.readableBlob(workingCopyPath)});
            return v.parse(v.array(PDF_BOOKMARK_RECOVERY_ENTRY_SCHEMA), readBrowserPdfCatalogPart(catalog, 'bookmarks'));
        },
    } satisfies TFeatureBrowserBindings<typeof PAGE_OPS_PLATFORM_FEATURE>;

    return pageOps;
}
