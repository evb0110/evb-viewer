import type {
    ICropMargins,
    IPageGeometry,
} from '@contracts/shared';
import { normalizeCropMargins } from '@contracts/shared';
import type {
    IBrowserPdfCombineCatalog,
    IBrowserPdfConformanceFacts,
    IPageMutationWorkerResult,
} from '@app/platform/browser-api/browserPageOpsWorker.types';
import {
    isBrowserPageOpsWasmFailure,
    tryRunBrowserPageOpsWithWasm,
} from '@app/platform/browser-api/tryRunBrowserPageOpsWithWasm';
import { PdfPageOpsCapabilityError } from '@contracts/pageOpsErrors';

async function requireBrowserPageOpsWasmResult<T>(
    operation: string,
    run: () => Promise<unknown>,
): Promise<T> {
    const result = await run();
    if (result !== null && !isBrowserPageOpsWasmFailure(result)) {
        return result as T;
    }
    if (isBrowserPageOpsWasmFailure(result)) {
        throw new PdfPageOpsCapabilityError(
            result.error.code === 'too-large' ? 'too-large' : 'native-failure',
            result.error.message,
            {operation},
        );
    }
    throw new PdfPageOpsCapabilityError(
        'native-unavailable',
        `PDF ${operation} is unavailable because the browser WASM page tool could not be loaded`,
        {operation},
    );
}

export function deletePdfPages(
    data: Uint8Array,
    pages: number[],
): Promise<IPageMutationWorkerResult> {
    return requireBrowserPageOpsWasmResult('page deletion', () =>
        tryRunBrowserPageOpsWithWasm('deletePages', {
            data,
            pages,
        }),
    );
}

export function parsePdfAnnotations(data: Uint8Array) {
    return requireBrowserPageOpsWasmResult<{data: Uint8Array}>(
        'annotation parsing',
        () => tryRunBrowserPageOpsWithWasm('parseAnnotations', {data}),
    );
}

export function extractPdfPages(
    data: Uint8Array,
    pages: number[],
): Promise<IPageMutationWorkerResult> {
    return requireBrowserPageOpsWasmResult('page extraction', () =>
        tryRunBrowserPageOpsWithWasm('extractPages', {
            data,
            pages,
        }),
    );
}

export function reorderPdfPages(
    data: Uint8Array,
    newOrder: number[],
): Promise<IPageMutationWorkerResult> {
    return requireBrowserPageOpsWasmResult('page reordering', () =>
        tryRunBrowserPageOpsWithWasm('reorderPages', {
            data,
            newOrder,
        }),
    );
}

export function insertPdfPages(
    data: Uint8Array,
    insertionData: Uint8Array,
    afterPage: number,
): Promise<IPageMutationWorkerResult> {
    return requireBrowserPageOpsWasmResult('page insertion', () =>
        tryRunBrowserPageOpsWithWasm('insertPages', {
            data,
            insertionData,
            afterPage,
        }),
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
    data: Uint8Array,
): Promise<IBrowserPdfCombineCatalog> {
    return requireBrowserPageOpsWasmResult('catalog inspection', () =>
        tryRunBrowserPageOpsWithWasm('readCatalog', {data}),
    );
}

export function readPdfConformance(
    data: Uint8Array,
): Promise<IBrowserPdfConformanceFacts> {
    return requireBrowserPageOpsWasmResult('conformance inspection', () =>
        tryRunBrowserPageOpsWithWasm('conformance', {data}),
    );
}

export function mergePdfPages(
    documents: Uint8Array[],
): Promise<IPageMutationWorkerResult> {
    return requireBrowserPageOpsWasmResult('PDF merge', () =>
        tryRunBrowserPageOpsWithWasm('mergePages', {documents}),
    );
}
