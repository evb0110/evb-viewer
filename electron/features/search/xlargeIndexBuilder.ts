import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import {
    COMPACT_SEARCH_INDEX_SOURCE_KIND_GENERIC,
    openCompactSearchIndexWriter,
    type ICompactSearchIndexPage,
    type ICompactSearchIndexStreamingOptions,
} from '@electron/features/search/searchIndexSidecar';
import {resolveDocumentTextCatalogWindow} from '@electron/features/ocr/public/documentTextCatalog';
import {assertWorkingCopyRevisionSidecarCurrent} from '@electron/file-access/documentRevisionSidecar';
import {abortErrorFromSignal} from '@electron/utils/abort';
import type {IDocumentTextCatalogPage} from '@contracts/documentTextCatalog';

const XLARGE_SEARCH_INDEX_PAGE_WINDOW = 64;
const MAX_SEARCH_INDEX_PAGE_COUNT = 0xFFFFFFFF;

export interface IXlargeSearchIndexBuildProgress {
    complete: boolean;
    documentRevision: TDocumentRevisionToken;
    pageCount: number;
    pagesScanned: number;
    pagesWritten: number;
    textBytes: number;
    truncated: boolean;
}

export interface IXlargeSearchIndexBuildOptions {
    documentRevision: TDocumentRevisionToken;
    maxPageTextBytes?: number;
    maxTotalTextBytes?: number;
    onProgress?: (progress: IXlargeSearchIndexBuildProgress) => void | Promise<void>;
    pageCount: number;
    pageWindow?: number;
    pdfPath: string;
    signal?: AbortSignal;
    sourcePdfPath?: string;
}

export interface IXlargeSearchIndexBuildResult extends IXlargeSearchIndexBuildProgress { indexPath: string; }

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

function assertPositiveSafeInteger(value: number, label: string) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${label} must be a positive safe integer`);
    }
}

function assertNonNegativeSafeInteger(value: number, label: string) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${label} must be a non-negative safe integer`);
    }
}

function assertBuildOptions(options: IXlargeSearchIndexBuildOptions) {
    if (options.pdfPath.length === 0) {
        throw new TypeError('pdfPath is required');
    }
    if (!options.documentRevision) {
        throw new TypeError('documentRevision is required');
    }
    assertPositiveSafeInteger(options.pageCount, 'pageCount');
    if (options.pageCount > MAX_SEARCH_INDEX_PAGE_COUNT) {
        throw new RangeError(`pageCount must be at most ${MAX_SEARCH_INDEX_PAGE_COUNT}`);
    }
    if (
        options.pageWindow !== undefined
        && (
            !Number.isSafeInteger(options.pageWindow)
            || options.pageWindow < 1
            || options.pageWindow > XLARGE_SEARCH_INDEX_PAGE_WINDOW
        )
    ) {
        throw new RangeError(
            `pageWindow must be between 1 and ${XLARGE_SEARCH_INDEX_PAGE_WINDOW}`,
        );
    }
    if (options.maxPageTextBytes !== undefined) {
        assertNonNegativeSafeInteger(options.maxPageTextBytes, 'maxPageTextBytes');
    }
    if (options.maxTotalTextBytes !== undefined) {
        assertNonNegativeSafeInteger(options.maxTotalTextBytes, 'maxTotalTextBytes');
    }
}

function toScalar(value: bigint, label: string) {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError(`${label} exceeds the safe scalar range`);
    }
    return Number(value);
}

function pageToIndexPage(page: IDocumentTextCatalogPage): ICompactSearchIndexPage {
    return {
        pageNumber: page.pageNumber,
        text: page.text,
    };
}

function createProgress(
    options: IXlargeSearchIndexBuildOptions,
    state: {
        complete: boolean;
        pagesScanned: number;
        pagesWritten: number;
        textBytes: bigint;
        truncated: boolean;
    },
): IXlargeSearchIndexBuildProgress {
    return {
        complete: state.complete,
        documentRevision: options.documentRevision,
        pageCount: options.pageCount,
        pagesScanned: state.pagesScanned,
        pagesWritten: state.pagesWritten,
        textBytes: toScalar(state.textBytes, 'textBytes'),
        truncated: state.truncated,
    };
}

async function emitProgress(
    options: IXlargeSearchIndexBuildOptions,
    state: Parameters<typeof createProgress>[1],
) {
    if (options.onProgress) {
        await options.onProgress(createProgress(options, state));
    }
}

/**
 * Builds the path-backed search sidecar one Poppler/OCR window at a time.
 * The catalog resolver owns per-window source precedence. This function keeps
 * only the current window and the writer's bounded page buffers in memory.
 */
export async function buildXlargeSearchIndex(
    options: IXlargeSearchIndexBuildOptions,
): Promise<IXlargeSearchIndexBuildResult> {
    assertBuildOptions(options);
    throwIfAborted(options.signal);
    await assertWorkingCopyRevisionSidecarCurrent(
        options.pdfPath,
        options.documentRevision,
    );

    const streamingOptions: ICompactSearchIndexStreamingOptions = {
        documentRevision: options.documentRevision,
        pageCount: options.pageCount,
        textSource: {
            kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_GENERIC,
            version: 0,
        },
        ...(options.signal === undefined ? {} : {signal: options.signal}),
    };
    const writer = await openCompactSearchIndexWriter(
        options.pdfPath,
        streamingOptions,
    );
    const state = {
        complete: false,
        pagesScanned: 0,
        pagesWritten: 0,
        textBytes: 0n,
        truncated: false,
    };
    const pageWindow = options.pageWindow ?? XLARGE_SEARCH_INDEX_PAGE_WINDOW;

    try {
        for (
            let firstPage = 1;
            firstPage <= options.pageCount;
            firstPage += pageWindow
        ) {
            throwIfAborted(options.signal);
            await assertWorkingCopyRevisionSidecarCurrent(
                options.pdfPath,
                options.documentRevision,
            );
            const lastPage = Math.min(
                options.pageCount,
                firstPage + pageWindow - 1,
            );
            const window = await resolveDocumentTextCatalogWindow(
                options.pdfPath,
                options.documentRevision,
                firstPage,
                lastPage,
                options.pageCount,
                {
                    pageWindow,
                    ...(options.signal === undefined ? {} : {signal: options.signal}),
                    ...(options.sourcePdfPath === undefined
                        ? {}
                        : {sourcePdfPath: options.sourcePdfPath}),
                },
            );
            await assertWorkingCopyRevisionSidecarCurrent(
                options.pdfPath,
                options.documentRevision,
            );
            if (
                window.documentRevision !== options.documentRevision
                || window.pageCount !== options.pageCount
                || window.firstPage !== firstPage
                || window.lastPage !== lastPage
            ) {
                throw new Error('Document text catalog window does not match the build revision');
            }

            // Extraction covered every page in this window, including pages
            // with no text record. Keep that fact separate from records written.
            state.pagesScanned = firstPage - 1;
            for (const page of window.pages) {
                throwIfAborted(options.signal);
                if (page.pageNumber < firstPage || page.pageNumber > lastPage) {
                    throw new Error(`Document text catalog returned page ${page.pageNumber} outside its window`);
                }
                state.pagesScanned = page.pageNumber;
                const textBytes = BigInt(Buffer.byteLength(page.text, 'utf8'));
                if (
                    options.maxPageTextBytes !== undefined
                    && textBytes > BigInt(options.maxPageTextBytes)
                ) {
                    state.truncated = true;
                    break;
                }
                if (
                    options.maxTotalTextBytes !== undefined
                    && state.textBytes + textBytes > BigInt(options.maxTotalTextBytes)
                ) {
                    state.truncated = true;
                    break;
                }
                if (textBytes === 0n) {
                    continue;
                }
                await writer.writePage(pageToIndexPage(page));
                state.pagesWritten += 1;
                state.textBytes += textBytes;
            }
            if (!state.truncated) {
                state.pagesScanned = lastPage;
            }

            await emitProgress(options, state);
            if (state.truncated) {
                break;
            }
        }

        const finalCoverage = await writer.finalize({
            pagesScanned: state.pagesScanned,
            truncatedCoverage: state.truncated,
            beforePublish: async () => {
                throwIfAborted(options.signal);
                await assertWorkingCopyRevisionSidecarCurrent(
                    options.pdfPath,
                    options.documentRevision,
                );
            },
        });
        state.complete = !state.truncated && state.pagesScanned === options.pageCount;
        const result: IXlargeSearchIndexBuildResult = {
            ...createProgress(options, state),
            complete: state.complete,
            indexPath: finalCoverage.indexPath || writer.indexPath,
        };
        await emitProgress(options, state);
        return result;
    } catch (error) {
        await writer.abort();
        throw error;
    }
}
