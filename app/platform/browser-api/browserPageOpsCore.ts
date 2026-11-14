import type {
    ICropMargins,
    IPageGeometry,
    TPdfViewMode,
    TPrintOrientation,
} from '@contracts/shared';
import { normalizeCropMargins } from '@contracts/shared';
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
import {
    isBrowserPageOpsWasmFailure,
    tryRunBrowserPageOpsWithWasm,
} from '@app/platform/browser-api/tryRunBrowserPageOpsWithWasm';
import {
    runBrowserPageOpsWorkerRequest,
    type IRunBrowserPageOpsWorkerRequestOptions,
} from '@app/platform/browser-api/browserPageOpsWorkerClient';
import { PdfPageOpsCapabilityError } from '@contracts/pageOpsErrors';

async function requireBrowserPageOpsWasmResult<T>(
    operation: string,
    run: () => Promise<unknown>,
): Promise<T> {
    const result = await run();
    if (!isBrowserPageOpsWasmFailure(result)) {
        return result as T;
    }
    throw new PdfPageOpsCapabilityError(
        result.error.code === 'too-large' ? 'too-large' : 'native-failure',
        result.error.message,
        {operation},
    );
}

export function parsePdfAnnotations(source: Blob) {
    return requireBrowserPageOpsWasmResult<{data: Uint8Array}>(
        'annotation parsing',
        () => tryRunBrowserPageOpsWithWasm('parseAnnotations', {source}),
    );
}

export function rotatePdfBytes(
    data: Uint8Array,
    pages: number[],
    angle: 90 | 180 | 270,
): Promise<IPageMutationWorkerResult> {
    return requireBrowserPageOpsWasmResult('page rotation', () =>
        tryRunBrowserPageOpsWithWasm('rotate', {
            data,
            pages,
            angle,
        }),
    );
}

export function cropPdfBytes(
    data: Uint8Array,
    pages: number[],
    margins: ICropMargins,
): Promise<IPageMutationWorkerResult> {
    const normalizedMargins = normalizeCropMargins(margins);
    return requireBrowserPageOpsWasmResult('page cropping', () =>
        tryRunBrowserPageOpsWithWasm('crop', {
            data,
            pages,
            margins: normalizedMargins,
        }),
    );
}

export function removeCropPdfBytes(
    data: Uint8Array,
    pages: number[],
): Promise<IPageMutationWorkerResult> {
    return requireBrowserPageOpsWasmResult('crop removal', () =>
        tryRunBrowserPageOpsWithWasm('removeCrop', {
            data,
            pages,
        }),
    );
}

export function getPageGeometryFromPdfBytes(
    data: Uint8Array,
    pageNumber: number,
): Promise<IPageGeometry> {
    return requireBrowserPageOpsWasmResult('page geometry', () =>
        tryRunBrowserPageOpsWithWasm('getPageGeometry', {
            data,
            pageNumber,
        }),
    );
}

export function readPdfCatalog(
    source: Blob,
): Promise<IBrowserPdfCombineCatalog> {
    return requireBrowserPageOpsWasmResult('catalog inspection', () =>
        tryRunBrowserPageOpsWithWasm('readCatalog', {source}),
    );
}

export function readPdfConformance(
    source: Blob,
): Promise<IBrowserPdfConformanceFacts> {
    return requireBrowserPageOpsWasmResult('conformance inspection', () =>
        tryRunBrowserPageOpsWithWasm('conformance', {source}),
    );
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
    return requireBrowserPageOpsWasmResult('print layout', () => runBrowserPageOpsWorkerRequest('printLayout', {
        data,
        pageNumbers: options.pageNumbers ?? [],
        viewMode: options.viewMode,
        orientation: options.orientation,
    }, options.signal ? {signal: options.signal} : {}));
}

type TWriterResult<K extends 'splitPages' | 'overlayText' | 'recompressImages' | 'replacePageImages'> =
    Exclude<IBrowserPageOpsWorkerResultMap[K], {status: 'failed'}>;

/**
 * Desktop's `split-pages`: the source rewritten to the instructed page tree.
 * `report.accessibilityTagsRemoved` says the source's structure tree was dropped.
 */
export function splitPdfPages(
    data: Uint8Array,
    instructions: ISplitPagesInstructions,
    options: Pick<IRunBrowserPageOpsWorkerRequestOptions, 'signal' | 'requireWorker' | 'onEngineIdentity'> = {},
): Promise<TWriterResult<'splitPages'>> {
    return requireBrowserPageOpsWasmResult('page split', () => runBrowserPageOpsWorkerRequest(
        'splitPages',
        {
            data,
            instructions,
        },
        options,
    ));
}

/**
 * Desktop's `overlay-text`: the source's text, annotations and navigation laid
 * over the staged output, returned as the whole output PDF.
 */
export function overlayPdfTextLayers(
    data: Uint8Array,
    sourceData: Uint8Array,
    instructions: IOverlayTextInstructions,
    options: Pick<IRunBrowserPageOpsWorkerRequestOptions, 'signal' | 'requireWorker' | 'onEngineIdentity'> = {},
): Promise<TWriterResult<'overlayText'>> {
    return requireBrowserPageOpsWasmResult('text overlay', () => runBrowserPageOpsWorkerRequest(
        'overlayText',
        {
            data,
            sourceData,
            instructions,
        },
        options,
    ));
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
    return requireBrowserPageOpsWasmResult('image recompression', () => runBrowserPageOpsWorkerRequest(
        'recompressImages',
        {
            data,
            instructions,
        },
        options,
    ));
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
    return requireBrowserPageOpsWasmResult('page image replacement', () => runBrowserPageOpsWorkerRequest(
        'replacePageImages',
        {
            data,
            replacementPdfs,
            instructions,
        },
        options,
    ));
}
