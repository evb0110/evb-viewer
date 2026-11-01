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
import {BROWSER_PAGE_OPS_MAX_REQUEST_BYTES} from '@contracts/browserPageOpsLimits';
import {REQUEST_HEADER} from '@contracts/browserPageOpsWasm.generated';
import type { IPickedBrowserFile } from '@app/platform/browser-api/browserFilePickerAdapter';
import { buildPdfSaveTypes } from '@app/platform/browser-api/browserFileAccepts';
import type { IFilePickerAcceptType } from '@app/platform/browser-api/browserFileAccepts';
import { ensurePdfExtension } from '@app/platform/browser-api/browserFileName';
import {
    BrowserPageOpsWorkerUnavailableError,
    canUseBrowserPageOpsWorker,
    runBrowserPageOpsWorkerRequest,
} from '@app/platform/browser-api/browserPageOpsWorkerClient';
import type { IBrowserBatchOpenProgressOptions } from '@app/platform/browser-api/createCombinedPdfFromPaths';
import type {
    IBrowserPageOpsWorkerRequestMap,
    IBrowserPageOpsWorkerResultMap,
    TBrowserPageOpsWorkerRequestType,
} from '@contracts/browserPageOpsWorker';
import {isBrowserPageOpsWasmFailure} from '@contracts/browserPageOpsWorker';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { PdfPageOpsCapabilityError } from '@contracts/pageOpsErrors';

interface ISaveBytesResult {
    canceled: boolean;
    fileName: string;
    handle?: FileSystemFileHandle | null;
}

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
    ) => Promise<Uint8Array>;
    pickSaveTarget: (options: {
        suggestedName: string;
        pickerTypes: IFilePickerAcceptType[];
    }) => Promise<ISaveBytesResult>;
    saveBytesToPickerOrDownload: (
        bytes: Uint8Array,
        options: {
            suggestedName: string;
            mimeType: string;
            pickerTypes: IFilePickerAcceptType[];
        },
    ) => Promise<ISaveBytesResult>;
    writeBytesToHandle: (
        handle: FileSystemFileHandle,
        data: Uint8Array,
    ) => Promise<void>;
}

// A page operation's input and any insertion source travel in one engine
// request; the engine refuses the framed remainder exactly.
const BROWSER_PAGE_OP_INPUT_MAX_BYTES = BROWSER_PAGE_OPS_MAX_REQUEST_BYTES - REQUEST_HEADER.bytes;

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

    async function serializeWorkingCopyMutation<T>(
        operation: IActivePageOperation,
        mutationOptions: IPageOpsMutationOptions | undefined,
        run: () => Promise<T>,
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
                return run();
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

    async function readWorkingCopyBytes(path: string) {
        assertBrowserPageOpsSource(path, 'Reading page-operation input');
        await yieldToBrowser();
        return browserDocumentStore.read(path, {maxBytes: BROWSER_PAGE_OP_INPUT_MAX_BYTES});
    }

    function shouldReadSinglePdfInsertionSource(sourcePaths: string[]) {
        if (sourcePaths.length !== 1) {
            return false;
        }

        const [sourcePath] = sourcePaths;
        return !!sourcePath && /\.pdf$/iu.test(getBrowserDocumentFileName(sourcePath));
    }

    async function readInsertionBytes(
        sourcePaths: string[],
        requestId: TRequestId | undefined,
        destinationBytes: number,
        signal: AbortSignal,
    ) {
        for (const sourcePath of sourcePaths) {
            assertBrowserPageOpsSource(sourcePath, 'Inserting pages');
        }
        if (shouldReadSinglePdfInsertionSource(sourcePaths)) {
            const sourcePath = sourcePaths[0];
            if (sourcePath === undefined) {
                throw new Error('A single PDF insertion source is required');
            }
            return browserDocumentStore.read(sourcePath, {maxBytes: BROWSER_PAGE_OP_INPUT_MAX_BYTES - destinationBytes});
        }

        return options.createCombinedPdfFromPaths(
            sourcePaths,
            {
                operation: 'page-insert',
                requestId: requestId ?? createRequestId('browser-page-op-insert'),
                signal,
            },
        );
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

    async function writePageMutationResult(
        operation: IActivePageOperation,
        data: Uint8Array,
        pageCount: number,
        mutationOptions: IPageOpsMutationOptions | undefined,
        pageIdentityDelta?: IPageIdentityDelta,
    ): Promise<IStoredPageMutationResult> {
        beginPageOperationCommit(operation);
        const {workingCopyPath} = operation;
        if (mutationOptions === undefined) {
            await browserDocumentStore.write(workingCopyPath, data);
        } else {
            await browserDocumentStore.write(workingCopyPath, data, mutationOptions);
        }
        await options.clearSearchCaches();
        return {
            success: true,
            pageCount,
            ...(pageIdentityDelta === undefined ? {} : {pageIdentityDelta}),
        };
    }

    async function deletePages(
        operation: IActivePageOperation,
        pages: TPageOpsPageSelection,
        totalPages: number,
        mutationOptions: IPageOpsMutationOptions | undefined,
    ) {
        const selectedPages = materializePageSelection(pages, totalPages, 'Deleting pages');
        return serializeWorkingCopyMutation(operation, mutationOptions, async () => {
            const result = await runWorkerBackedPdfOperation({
                path: operation.workingCopyPath,
                signal: operation.controller.signal,
                type: 'deletePages',
                createPayload: (data) => ({
                    data,
                    pages: selectedPages,
                }),
                runDirect: async (data) => {
                    const { deletePdfPages } = await loadBrowserPageOpsCore();
                    return deletePdfPages(data, selectedPages);
                },
            });
            return writePageMutationResult(
                operation,
                result.data,
                result.pageCount,
                mutationOptions,
                createDeletePageIdentityDelta(totalPages, selectedPages),
            );
        });
    }

    async function reorderPages(
        operation: IActivePageOperation,
        newOrder: number[],
        mutationOptions: IPageOpsMutationOptions | undefined,
    ) {
        return serializeWorkingCopyMutation(operation, mutationOptions, async () => {
            const result = await runWorkerBackedPdfOperation({
                path: operation.workingCopyPath,
                signal: operation.controller.signal,
                type: 'reorderPages',
                createPayload: (data) => ({
                    data,
                    newOrder,
                }),
                runDirect: async (data) => {
                    const { reorderPdfPages } = await loadBrowserPageOpsCore();
                    return reorderPdfPages(data, newOrder);
                },
            });
            return writePageMutationResult(
                operation,
                result.data,
                result.pageCount,
                mutationOptions,
                createReorderPageIdentityDelta(newOrder.length, newOrder),
            );
        });
    }

    async function insertPagesFromFiles(
        operation: IActivePageOperation,
        totalPages: number,
        afterPage: number,
        sourcePaths: string[],
        requestId: TRequestId | undefined,
        mutationOptions: IPageOpsMutationOptions | undefined,
    ) {
        const {
            workingCopyPath,
            controller: {signal},
        } = operation;
        return serializeWorkingCopyMutation(operation, mutationOptions, async () => {
            assertBrowserPageOpsSource(workingCopyPath, 'Inserting pages');
            const destinationData = await readWorkingCopyBytes(workingCopyPath);
            const insertionData = await readInsertionBytes(sourcePaths, requestId, destinationData.byteLength, signal);

            let directInputs: [Uint8Array, Uint8Array] = [
                destinationData,
                insertionData,
            ];
            let result: IBrowserPageOpsWorkerResultMap['insertPages'] | null = null;
            if (canUseBrowserPageOpsWorker()) {
                try {
                    result = await runBrowserPageOpsWorkerRequest('insertPages', {
                        data: destinationData,
                        insertionData,
                        afterPage,
                    }, {
                        dedicated: true,
                        signal,
                        transferInput: true,
                    });
                } catch (error) {
                    if (!(error instanceof BrowserPageOpsWorkerUnavailableError)) {
                        throw error;
                    }
                    // The worker took the transferred inputs; read them again.
                    const directDestinationData = await readWorkingCopyBytes(workingCopyPath);
                    directInputs = [
                        directDestinationData,
                        await readInsertionBytes(sourcePaths, requestId, directDestinationData.byteLength, signal),
                    ];
                }
            }
            if (result === null) {
                const [
                    directDestinationData,
                    directInsertionData,
                ] = directInputs;
                result = await runDirectPdfOperation(async () => {
                    const { insertPdfPages } = await loadBrowserPageOpsCore();
                    return insertPdfPages(
                        directDestinationData,
                        directInsertionData,
                        afterPage,
                    );
                });
            }
            return writePageMutationResult(
                operation,
                result.data,
                result.pageCount,
                mutationOptions,
                createInsertPageIdentityDelta(
                    totalPages,
                    afterPage,
                    result.pageCount - totalPages,
                ),
            );
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
        return serializeWorkingCopyMutation(operation, mutationOptions, async () => {
            const result = await runWorkerBackedPdfOperation({
                path: operation.workingCopyPath,
                signal: operation.controller.signal,
                type,
                createPayload,
                runDirect,
            });
            return writePageMutationResult(
                operation,
                result.data,
                result.pageCount,
                mutationOptions,
            );
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

            const result = await runWorkerBackedPdfOperation({
                path: workingCopyPath,
                signal: operation.controller.signal,
                type: 'extractPages',
                createPayload: (data) => ({
                    data,
                    pages: selectedPages,
                }),
                runDirect: async (data) => {
                    const { extractPdfPages } = await loadBrowserPageOpsCore();
                    return extractPdfPages(data, selectedPages);
                },
            });
            const outputBytes = result.data;
            beginPageOperationCommit(operation);

            if (saveTarget.handle) {
                await options.writeBytesToHandle(saveTarget.handle, outputBytes);
            } else {
                const saveResult = await options.saveBytesToPickerOrDownload(outputBytes, {
                    suggestedName: ensurePdfExtension(saveTarget.fileName),
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

            const normalizedFileName = ensurePdfExtension(saveTarget.fileName);
            const destPath = await browserDocumentStore.createStoredDocument(
                normalizedFileName,
                saveTarget.handle ? new Uint8Array() : outputBytes,
                {
                    mimeType: 'application/pdf',
                    saveKind: 'pdf',
                    kind: 'source',
                    saveHandle: saveTarget.handle ?? null,
                    ...(saveTarget.handle ? { storageMode: 'handle' as const } : {}),
                },
            );
            if (saveTarget.handle) {
                await browserDocumentStore.replaceWithHandleBackedDocument(destPath, {
                    fileSize: outputBytes.byteLength,
                    saveHandle: saveTarget.handle,
                    saveName: normalizedFileName,
                });
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
                };
            }

            const sourcePaths = await Promise.all(
                pickedFiles.map(async (picked) =>
                    browserDocumentStore.registerFile(picked.file, {
                        kind: 'source',
                        retention: 'transient',
                        saveKind: 'generic',
                        saveHandle: picked.handle ?? null,
                    }),
                ),
            );

            try {
                return await insertPagesFromFiles(
                    operation,
                    totalPages,
                    afterPage,
                    sourcePaths,
                    undefined,
                    mutationOptions,
                );
            } finally {
                await Promise.allSettled(
                    sourcePaths.map(async (sourcePath) => {
                        await browserDocumentStore.cleanupDetachedDocument(sourcePath);
                    }),
                );
            }
        }),
        insertFile: withUserCancel((operation, _workingCopyPath: string, totalPages: number, afterPage: number, sourcePaths: string[], requestId?: TRequestId, mutationOptions?: IPageOpsMutationOptions) => (
            insertPagesFromFiles(operation, totalPages, afterPage, sourcePaths, requestId, mutationOptions)
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
            const catalog = await runWorkerBackedPdfOperation({
                path: workingCopyPath,
                type: 'readCatalog',
                createPayload: (data) => ({data}),
                runDirect: async (data) => {
                    const { readPdfCatalog } = await loadBrowserPageOpsCore();
                    return readPdfCatalog(data);
                },
            });
            return v.parse(v.array(PDF_BOOKMARK_RECOVERY_ENTRY_SCHEMA), readBrowserPdfCatalogPart(catalog, 'bookmarks'));
        },
    } satisfies TFeatureBrowserBindings<typeof PAGE_OPS_PLATFORM_FEATURE>;

    return pageOps;
}
