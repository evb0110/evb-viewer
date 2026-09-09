import type {
    IPageOpsMutationOptions,
    TPageOpsPageSelection,
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
    createRequestId,
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
import { BROWSER_MAX_FULL_READ_BYTES } from '@app/platform/browser/browserDocumentConstants';
import type { IPickedBrowserFile } from '@app/platform/browser-api/browserFilePickerAdapter';
import { buildPdfSaveTypes } from '@app/platform/browser-api/browserFileAccepts';
import type { IFilePickerAcceptType } from '@app/platform/browser-api/browserFileAccepts';
import { ensurePdfExtension } from '@app/platform/browser-api/browserFileName';
import { buildBrowserByteLimitError } from '@app/platform/browser-api/browserPlatformHelpers';
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
} from '@app/platform/browser-api/browserPageOpsWorker.types';
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

const BROWSER_PAGE_OP_PDF_MAX_BYTES = BROWSER_MAX_FULL_READ_BYTES;
const BROWSER_PAGE_OP_DIRECT_FALLBACK_MAX_BYTES = BROWSER_MAX_FULL_READ_BYTES;
const BROWSER_PAGE_OP_IN_PLACE_MUTATION_MAX_BYTES = BROWSER_PAGE_OP_PDF_MAX_BYTES;
const BROWSER_PAGE_OP_INSERT_MAX_BYTES = BROWSER_PAGE_OP_IN_PLACE_MUTATION_MAX_BYTES;
const BROWSER_PAGE_OP_GEOMETRY_MAX_BYTES = BROWSER_PAGE_OP_PDF_MAX_BYTES;
const BROWSER_PAGE_OP_COMBINED_INPUT_MAX_BYTES = BROWSER_MAX_FULL_READ_BYTES;
const BROWSER_PAGE_OP_INSERT_WORKING_SET_MAX_BYTES = 96 * 1024 * 1024;
/**
 * Browser page moves still need a full permutation for pdf-lib. Keep that
 * fallback deliberately small. Desktop uses the qpdf range operation and has
 * no corresponding page-count cap.
 */
export const BROWSER_PAGE_OP_MOVE_MAX_PAGES = 10_000;
export const BROWSER_PAGE_OP_SELECTION_MATERIALIZATION_MAX_PAGES = 10_000;

type TBrowserPageOpsCoreModule = typeof BrowserPageOpsCoreModule;

let browserPageOpsCorePromise: Promise<TBrowserPageOpsCoreModule> | null = null;

function loadBrowserPageOpsCore() {
    browserPageOpsCorePromise ??= import('@app/platform/browser-api/browserPageOpsCore');
    return browserPageOpsCorePromise;
}

function buildBrowserPageOpLimitError(label: string, maxBytes: number) {
    return buildBrowserByteLimitError(label, maxBytes, 'PDFs');
}

function buildBrowserPageOpJobLimitError(label: string, maxBytes: number) {
    return buildBrowserByteLimitError(label, maxBytes, 'jobs');
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
    if (selectedCount <= 0 || selectedCount > BROWSER_PAGE_OP_SELECTION_MATERIALIZATION_MAX_PAGES) {
        throw new Error(
            `${operation} in the browser is limited to ${BROWSER_PAGE_OP_SELECTION_MATERIALIZATION_MAX_PAGES} pages; use the desktop app for larger documents`,
        );
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
    if (selectedCount <= 0 || selectedCount > BROWSER_PAGE_OP_SELECTION_MATERIALIZATION_MAX_PAGES) {
        throw new PdfPageOpsCapabilityError(
            'too-large',
            `${operation} in the browser is limited to ${BROWSER_PAGE_OP_SELECTION_MATERIALIZATION_MAX_PAGES} selected pages; use the desktop app for larger documents`,
            {operation},
        );
    }
    if (Array.isArray(selection)) {
        return selection;
    }
    return materializePageRanges(selection.ranges, totalPages, operation);
}

export function createBrowserPageOpsCapability(
    options: ICreateBrowserPageOpsOptions,
): IPageOpsCapability {
    const workingCopyMutationQueues = new Map<string, Promise<unknown>>();

    async function serializeWorkingCopyMutation<T>(
        workingCopyPath: string,
        mutationOptions: IPageOpsMutationOptions | undefined,
        run: () => Promise<T>,
    ) {
        const previous = workingCopyMutationQueues.get(workingCopyPath) ?? Promise.resolve();
        const next = previous
            .catch(() => {})
            .then(async () => {
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

    async function ensurePdfWithinBudget(
        path: string,
        label: string,
        maxBytes = BROWSER_PAGE_OP_PDF_MAX_BYTES,
    ) {
        assertBrowserPageOpsSource(path, label);
        const { size } = await browserDocumentStore.stat(path);
        if (size > maxBytes) {
            throw buildBrowserPageOpLimitError(label, maxBytes);
        }
    }

    async function getCombinedInputBytes(paths: string[], maxBytes?: number) {
        let totalBytes = 0;
        for (const [
            index,
            path,
        ] of paths.entries()) {
            assertBrowserPageOpsSource(path, 'Combining page-operation inputs');
            if (index > 0) {
                await yieldToBrowser();
            }

            const { size } = await browserDocumentStore.stat(path);
            totalBytes += size;
            if (typeof maxBytes === 'number' && totalBytes > maxBytes) {
                return totalBytes;
            }
        }
        return totalBytes;
    }

    async function ensureCombinedInputsWithinBudget(paths: string[], label: string) {
        const totalBytes = await getCombinedInputBytes(paths, BROWSER_PAGE_OP_COMBINED_INPUT_MAX_BYTES);
        if (totalBytes > BROWSER_PAGE_OP_COMBINED_INPUT_MAX_BYTES) {
            throw buildBrowserPageOpLimitError(label, BROWSER_PAGE_OP_COMBINED_INPUT_MAX_BYTES);
        }
    }

    async function readWorkingCopyBytes(path: string) {
        assertBrowserPageOpsSource(path, 'Reading page-operation input');
        await yieldToBrowser();
        return browserDocumentStore.read(path);
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
    ) {
        for (const sourcePath of sourcePaths) {
            assertBrowserPageOpsSource(sourcePath, 'Inserting pages');
        }
        if (shouldReadSinglePdfInsertionSource(sourcePaths)) {
            const sourcePath = sourcePaths[0];
            if (sourcePath === undefined) {
                throw new Error('A single PDF insertion source is required');
            }
            return browserDocumentStore.read(sourcePath);
        }

        return options.createCombinedPdfFromPaths(
            sourcePaths,
            {
                operation: 'page-insert',
                requestId: requestId ?? createRequestId('browser-page-op-insert'),
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
        label: string;
        maxBytes: number;
        type: K;
        createPayload: (data: Uint8Array) => IBrowserPageOpsWorkerRequestMap[K];
        runDirect: (data: Uint8Array) => Promise<IBrowserPageOpsWorkerResultMap[K]>;
    }) {
        await ensurePdfWithinBudget(
            options.path,
            options.label,
            options.maxBytes,
        );

        const { size } = await browserDocumentStore.stat(options.path);
        const workerAvailable = canUseBrowserPageOpsWorker();
        if (
            !workerAvailable
            && size > BROWSER_PAGE_OP_DIRECT_FALLBACK_MAX_BYTES
        ) {
            throw buildBrowserPageOpLimitError(
                options.label,
                BROWSER_PAGE_OP_DIRECT_FALLBACK_MAX_BYTES,
            );
        }

        const data = await readWorkingCopyBytes(options.path);
        let directData = data;
        if (workerAvailable) {
            try {
                return await runBrowserPageOpsWorkerRequest(
                    options.type,
                    options.createPayload(data),
                );
            } catch (error) {
                if (!(error instanceof BrowserPageOpsWorkerUnavailableError)) {
                    throw error;
                }
                directData = await readWorkingCopyBytes(options.path);
            }
        }

        if (size > BROWSER_PAGE_OP_DIRECT_FALLBACK_MAX_BYTES) {
            throw buildBrowserPageOpLimitError(
                options.label,
                BROWSER_PAGE_OP_DIRECT_FALLBACK_MAX_BYTES,
            );
        }

        return runDirectPdfOperation(() => options.runDirect(directData));
    }

    async function writePageMutationResult(
        workingCopyPath: string,
        data: Uint8Array,
        pageCount: number,
        mutationOptions: IPageOpsMutationOptions | undefined,
    ): Promise<IStoredPageMutationResult> {
        if (mutationOptions === undefined) {
            await browserDocumentStore.write(workingCopyPath, data);
        } else {
            await browserDocumentStore.write(workingCopyPath, data, mutationOptions);
        }
        await options.clearSearchCaches();
        return {
            success: true,
            pageCount,
        };
    }

    const pageOps: IPageOpsCapability = {
        async delete(workingCopyPath, pages, _totalPages, mutationOptions) {
            const selectedPages = materializePageSelection(pages, _totalPages, 'Deleting pages');
            return serializeWorkingCopyMutation(workingCopyPath, mutationOptions, async () => {
                const result = await runWorkerBackedPdfOperation({
                    path: workingCopyPath,
                    label: 'Deleting pages',
                    maxBytes: BROWSER_PAGE_OP_IN_PLACE_MUTATION_MAX_BYTES,
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
                    workingCopyPath,
                    result.data,
                    result.pageCount,
                    mutationOptions,
                );
            });
        },
        async deleteRanges(workingCopyPath, ranges, _totalPages, mutationOptions) {
            const pages = materializePageRanges(ranges, _totalPages);
            return pageOps.delete(workingCopyPath, pages, _totalPages, mutationOptions);
        },
        async extract(workingCopyPath, pages) {
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
                label: 'Extracting pages',
                maxBytes: BROWSER_PAGE_OP_IN_PLACE_MUTATION_MAX_BYTES,
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
        },
        async reorder(workingCopyPath, newOrder, mutationOptions) {
            return serializeWorkingCopyMutation(workingCopyPath, mutationOptions, async () => {
                const result = await runWorkerBackedPdfOperation({
                    path: workingCopyPath,
                    label: 'Reordering pages',
                    maxBytes: BROWSER_PAGE_OP_IN_PLACE_MUTATION_MAX_BYTES,
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
                    workingCopyPath,
                    result.data,
                    result.pageCount,
                    mutationOptions,
                );
            });
        },
        async move(workingCopyPath, startPage, endPage, insertAt, totalPages, mutationOptions) {
            assertBrowserPageOpsSource(workingCopyPath, 'Moving pages');
            if (totalPages > BROWSER_PAGE_OP_MOVE_MAX_PAGES) {
                throw new Error(
                    `Moving pages in the browser is limited to ${BROWSER_PAGE_OP_MOVE_MAX_PAGES} pages; use the desktop app for larger documents`,
                );
            }
            const move = createPageMoveRange(totalPages, startPage, endPage, insertAt);
            if (isPageMoveNoOp(move)) {
                return serializeWorkingCopyMutation(workingCopyPath, mutationOptions, () => Promise.resolve({
                    success: true,
                    pageCount: move.pageCount,
                }));
            }
            return pageOps.reorder(
                workingCopyPath,
                buildPageMoveOrder(move),
                mutationOptions,
            );
        },
        async moveRanges(workingCopyPath, ranges, insertAt, totalPages, mutationOptions) {
            assertBrowserPageOpsSource(workingCopyPath, 'Moving pages');
            if (totalPages > BROWSER_PAGE_OP_MOVE_MAX_PAGES) {
                throw new Error(
                    `Moving pages in the browser is limited to ${BROWSER_PAGE_OP_MOVE_MAX_PAGES} pages; use the desktop app for larger documents`,
                );
            }
            const move = createPageMoveRanges(totalPages, ranges, insertAt);
            if (isPageMoveRangesNoOp(move)) {
                return serializeWorkingCopyMutation(workingCopyPath, mutationOptions, () => Promise.resolve({
                    success: true,
                    pageCount: move.pageCount,
                }));
            }
            return pageOps.reorder(
                workingCopyPath,
                buildPageMoveRangesOrder(move),
                mutationOptions,
            );
        },
        async insert(workingCopyPath, _totalPages, afterPage, mutationOptions) {
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
                return await pageOps.insertFile(
                    workingCopyPath,
                    0,
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
        },
        async insertFile(workingCopyPath, _totalPages, afterPage, sourcePaths, requestId, mutationOptions) {
            return serializeWorkingCopyMutation(workingCopyPath, mutationOptions, async () => {
                await ensurePdfWithinBudget(
                    workingCopyPath,
                    'Inserting pages',
                    BROWSER_PAGE_OP_INSERT_MAX_BYTES,
                );
                await ensureCombinedInputsWithinBudget(sourcePaths, 'Inserting pages');
                const [
                    { size },
                    totalInputBytes,
                ] = await Promise.all([
                    browserDocumentStore.stat(workingCopyPath),
                    getCombinedInputBytes(sourcePaths),
                ]);
                if (size + totalInputBytes > BROWSER_PAGE_OP_INSERT_WORKING_SET_MAX_BYTES) {
                    throw buildBrowserPageOpJobLimitError(
                        'Inserting pages',
                        BROWSER_PAGE_OP_INSERT_WORKING_SET_MAX_BYTES,
                    );
                }
                const workerAvailable = canUseBrowserPageOpsWorker();
                if (
                    !workerAvailable
                    && size > BROWSER_PAGE_OP_DIRECT_FALLBACK_MAX_BYTES
                ) {
                    throw buildBrowserPageOpLimitError(
                        'Inserting pages',
                        BROWSER_PAGE_OP_DIRECT_FALLBACK_MAX_BYTES,
                    );
                }
                const destinationData = await readWorkingCopyBytes(workingCopyPath);
                const insertionData = await readInsertionBytes(sourcePaths, requestId);

                let result: IBrowserPageOpsWorkerResultMap['insertPages'];
                if (workerAvailable) {
                    try {
                        result = await runBrowserPageOpsWorkerRequest('insertPages', {
                            data: destinationData,
                            insertionData,
                            afterPage,
                        });
                    } catch (error) {
                        if (!(error instanceof BrowserPageOpsWorkerUnavailableError)) {
                            throw error;
                        }
                        if (size > BROWSER_PAGE_OP_DIRECT_FALLBACK_MAX_BYTES) {
                            throw buildBrowserPageOpLimitError(
                                'Inserting pages',
                                BROWSER_PAGE_OP_DIRECT_FALLBACK_MAX_BYTES,
                            );
                        }
                        const directDestinationData = await readWorkingCopyBytes(workingCopyPath);
                        const directInsertionData = await readInsertionBytes(sourcePaths, requestId);
                        result = await runDirectPdfOperation(async () => {
                            const { insertPdfPages } = await loadBrowserPageOpsCore();
                            return insertPdfPages(
                                directDestinationData,
                                directInsertionData,
                                afterPage,
                            );
                        });
                    }
                } else {
                    result = await runDirectPdfOperation(async () => {
                        const { insertPdfPages } = await loadBrowserPageOpsCore();
                        return insertPdfPages(
                            destinationData,
                            insertionData,
                            afterPage,
                        );
                    });
                }
                return writePageMutationResult(
                    workingCopyPath,
                    result.data,
                    result.pageCount,
                    mutationOptions,
                );
            });
        },
        async rotate(workingCopyPath, pages, _totalPages, angle, mutationOptions) {
            const selectedPages = materializePageSelection(pages, _totalPages, 'Rotating pages');
            return serializeWorkingCopyMutation(workingCopyPath, mutationOptions, async () => {
                const result = await runWorkerBackedPdfOperation({
                    path: workingCopyPath,
                    label: 'Rotating pages',
                    maxBytes: BROWSER_PAGE_OP_IN_PLACE_MUTATION_MAX_BYTES,
                    type: 'rotate',
                    createPayload: (data) => ({
                        data,
                        pages: selectedPages,
                        angle,
                    }),
                    runDirect: async (data) => {
                        const { rotatePdfBytes } = await loadBrowserPageOpsCore();
                        return rotatePdfBytes(data, selectedPages, angle);
                    },
                });
                return writePageMutationResult(
                    workingCopyPath,
                    result.data,
                    result.pageCount,
                    mutationOptions,
                );
            });
        },
        async crop(workingCopyPath, pages, _totalPages, margins, mutationOptions) {
            const selectedPages = materializePageSelection(pages, _totalPages, 'Cropping pages');
            const normalizedMargins = normalizeCropMargins(margins);
            return serializeWorkingCopyMutation(workingCopyPath, mutationOptions, async () => {
                const result = await runWorkerBackedPdfOperation({
                    path: workingCopyPath,
                    label: 'Cropping pages',
                    maxBytes: BROWSER_PAGE_OP_IN_PLACE_MUTATION_MAX_BYTES,
                    type: 'crop',
                    createPayload: (data) => ({
                        data,
                        pages: selectedPages,
                        margins: normalizedMargins,
                    }),
                    runDirect: async (data) => {
                        const { cropPdfBytes } = await loadBrowserPageOpsCore();
                        return cropPdfBytes(data, selectedPages, normalizedMargins);
                    },
                });
                return writePageMutationResult(
                    workingCopyPath,
                    result.data,
                    result.pageCount,
                    mutationOptions,
                );
            });
        },
        async removeCrop(workingCopyPath, pages, _totalPages, mutationOptions) {
            const selectedPages = materializePageSelection(pages, _totalPages, 'Removing crop');
            return serializeWorkingCopyMutation(workingCopyPath, mutationOptions, async () => {
                const result = await runWorkerBackedPdfOperation({
                    path: workingCopyPath,
                    label: 'Removing crop',
                    maxBytes: BROWSER_PAGE_OP_IN_PLACE_MUTATION_MAX_BYTES,
                    type: 'removeCrop',
                    createPayload: (data) => ({
                        data,
                        pages: selectedPages,
                    }),
                    runDirect: async (data) => {
                        const { removeCropPdfBytes } = await loadBrowserPageOpsCore();
                        return removeCropPdfBytes(data, selectedPages);
                    },
                });
                return writePageMutationResult(
                    workingCopyPath,
                    result.data,
                    result.pageCount,
                    mutationOptions,
                );
            });
        },
        async getPageGeometry(workingCopyPath, pageNumber): Promise<IPageGeometry> {
            return runWorkerBackedPdfOperation({
                path: workingCopyPath,
                label: 'Inspecting page geometry',
                maxBytes: BROWSER_PAGE_OP_GEOMETRY_MAX_BYTES,
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
    } satisfies TFeatureBrowserBindings<typeof PAGE_OPS_PLATFORM_FEATURE>;

    return pageOps;
}
