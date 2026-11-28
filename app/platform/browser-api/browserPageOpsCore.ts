import type {IPageGeometry, TPdfViewMode, TPrintOrientation} from '@contracts/shared';
import type {
    IBrowserPageOpsWorkerResultMap,
    IBrowserPdfCombineCatalog,
    IBrowserPdfConformanceFacts,
    IPageMutationWorkerResult,
} from '@contracts/browserPageOpsWorker';
import type {
    IOverlayTextInstructions,
    IRecompressImagesInstructions,
    IReplacePageImagesInstructions,
    ISplitPagesInstructions,
} from '@contracts/browserPageOpsWriters';
import {isBrowserPageOpsWasmFailure, tryRunBrowserPageOpsWithWasm} from '@app/platform/browser-api/tryRunBrowserPageOpsWithWasm';
import {
    runBrowserPageOpsWorkerRequest,
    type IRunBrowserPageOpsWorkerRequestOptions,
} from '@app/platform/browser-api/browserPageOpsWorkerClient';
import {PdfPageOpsCapabilityError} from '@contracts/pageOpsErrors';

async function requireBrowserPageOpsWasmResult<T>(operation: string, run: () => Promise<unknown>): Promise<T> {
    const result = await run();
    if (!isBrowserPageOpsWasmFailure(result)) {
        return result as T;
    }
    throw new PdfPageOpsCapabilityError(result.error.code === 'too-large' ? 'too-large' : 'native-failure', result.error.message, {
        operation,
    });
}

export function parsePdfAnnotations(source: Blob) {
    return requireBrowserPageOpsWasmResult<{data: Uint8Array}>('annotation parsing', () =>
        tryRunBrowserPageOpsWithWasm('parseAnnotations', {source}),
    );
}

export function getPageGeometryFromPdfBytes(source: Uint8Array | Blob, pageNumber: number): Promise<IPageGeometry> {
    const blob = source instanceof Blob ? source : new Blob([source as BlobPart]);
    return requireBrowserPageOpsWasmResult('page geometry', () =>
        tryRunBrowserPageOpsWithWasm('getPageGeometry', {
            source: blob,
            pageNumber,
        }),
    );
}

export function readPdfCatalog(source: Blob): Promise<IBrowserPdfCombineCatalog> {
    return requireBrowserPageOpsWasmResult('catalog inspection', () => tryRunBrowserPageOpsWithWasm('readCatalog', {source}));
}

export function readPdfConformance(source: Blob): Promise<IBrowserPdfConformanceFacts> {
    return requireBrowserPageOpsWasmResult('conformance inspection', () => tryRunBrowserPageOpsWithWasm('conformance', {source}));
}

export function layoutPdfForPrint(
    data: Uint8Array,
    options: {
        pageNumbers?: number[] | undefined;
        viewMode: TPdfViewMode;
        orientation: TPrintOrientation;
        signal?: AbortSignal;
    },
): Promise<IPageMutationWorkerResult> {
    return requireBrowserPageOpsWasmResult('print layout', () =>
        runBrowserPageOpsWorkerRequest(
            'printLayout',
            {
                data,
                pageNumbers: options.pageNumbers ?? [],
                viewMode: options.viewMode,
                orientation: options.orientation,
            },
            options.signal ? {signal: options.signal} : {},
        ),
    );
}

type TWriterResult<K extends 'splitPages' | 'overlayText' | 'recompressImages' | 'replacePageImages'> = Exclude<
    IBrowserPageOpsWorkerResultMap[K],
    {status: 'failed'}
>;

/**
 * Desktop's `split-pages`: the source rewritten to the instructed page tree.
 * `report.accessibilityTagsRemoved` says the source's structure tree was dropped.
 */
export function splitPdfPages(
    data: Uint8Array,
    instructions: ISplitPagesInstructions,
    options: Pick<
        IRunBrowserPageOpsWorkerRequestOptions,
        'signal' | 'requireWorker' | 'onEngineIdentity' | 'transferInput' | 'admissionPriority'
    > = {},
): Promise<TWriterResult<'splitPages'>> {
    return requireBrowserPageOpsWasmResult('page split', () =>
        runBrowserPageOpsWorkerRequest(
            'splitPages',
            {
                data,
                instructions,
            },
            options,
        ),
    );
}

/**
 * Desktop's `overlay-text`: the source's text, annotations and navigation laid
 * over the staged output, returned as the whole output PDF.
 */
export function overlayPdfTextLayers(
    data: Uint8Array,
    sourceData: Uint8Array,
    instructions: IOverlayTextInstructions,
    options: Pick<
        IRunBrowserPageOpsWorkerRequestOptions,
        'signal' | 'requireWorker' | 'onEngineIdentity' | 'transferInput' | 'admissionPriority'
    > = {},
): Promise<TWriterResult<'overlayText'>> {
    return requireBrowserPageOpsWasmResult('text overlay', () =>
        runBrowserPageOpsWorkerRequest(
            'overlayText',
            {
                data,
                sourceData,
                instructions,
            },
            options,
        ),
    );
}

/**
 * Desktop's `recompress-images`. `data` is the revision to append to the input
 * document, empty when no image got smaller; `report` is the CLI's report.
 */
export function recompressPdfImages(
    data: Uint8Array,
    instructions: IRecompressImagesInstructions,
    options: Pick<IRunBrowserPageOpsWorkerRequestOptions, 'signal' | 'timeoutMs' | 'requireWorker'> = {},
): Promise<TWriterResult<'recompressImages'>> {
    return requireBrowserPageOpsWasmResult('image recompression', () =>
        runBrowserPageOpsWorkerRequest(
            'recompressImages',
            {
                data,
                instructions,
            },
            options,
        ),
    );
}

/**
 * Desktop's `replace-page-images`. Instructions name each replacement PDF by
 * its index in `replacementPdfs`. `data` is the revision to append to the
 * input document, empty when no page was replaced.
 */
export function replacePdfPageImages(
    data: Uint8Array,
    replacementPdfs: Uint8Array[],
    instructions: IReplacePageImagesInstructions,
    options: Pick<IRunBrowserPageOpsWorkerRequestOptions, 'signal' | 'timeoutMs' | 'requireWorker'> = {},
): Promise<TWriterResult<'replacePageImages'>> {
    return requireBrowserPageOpsWasmResult('page image replacement', () =>
        runBrowserPageOpsWorkerRequest(
            'replacePageImages',
            {
                data,
                replacementPdfs,
                instructions,
            },
            options,
        ),
    );
}

function toPdfBlob(bytes: Uint8Array) {
    return new Blob([bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes)], {
        type: 'application/pdf',
    });
}

/**
 * Output PDFs appended in document order, then joined once by the page-ops
 * merge desktop uses. `createError` names the job a failed merge belongs to,
 * and is told the engine's error code when the engine refused the merge.
 */
export function createOrderedPdfMerge(options: {
    signal: AbortSignal;
    onEngineIdentity?: (sha256: string) => void;
    admissionPriority?: IRunBrowserPageOpsWorkerRequestOptions['admissionPriority'];
    createError: (reason: string, code?: string) => Error;
}) {
    let firstPage: Uint8Array | null = null;
    let sources: Blob[] | null = null;
    let count = 0;
    return {
        append(pdf: Uint8Array) {
            if (count === 0) {
                firstPage = pdf;
            } else if (sources === null) {
                sources = [toPdfBlob(firstPage!), toPdfBlob(pdf)];
                firstPage = null;
            } else {
                sources.push(toPdfBlob(pdf));
            }
            count += 1;
            return count;
        },
        async merge() {
            if (count === 0) {
                return null;
            }
            if (sources === null) {
                const single = firstPage;
                firstPage = null;
                count = 0;
                return single;
            }
            const mergeSources = sources;
            sources = null;
            count = 0;
            const result = await runBrowserPageOpsWorkerRequest(
                'pageStructure',
                {
                    edit: {kind: 'merge'},
                    sources: mergeSources,
                    output: null,
                },
                {
                    signal: options.signal,
                    dedicated: true,
                    requireWorker: true,
                    ...(options.admissionPriority === undefined ? {} : {admissionPriority: options.admissionPriority}),
                    ...(options.onEngineIdentity === undefined ? {} : {onEngineIdentity: options.onEngineIdentity}),
                },
            );
            if (result.status !== 'written' || !result.data) {
                throw result.status === 'failed'
                    ? options.createError(result.error.message, result.error.code)
                    : options.createError("the browser's storage is full");
            }
            return result.data;
        },
    };
}
