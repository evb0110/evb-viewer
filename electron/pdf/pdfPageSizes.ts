import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {
    createPdfPageSizeStore as createCorePdfPageSizeStore,
    parsePdfInfoPageGeometry,
    parsePdfPageSizesPayload,
    readPdfPageSizeChunks as readCorePdfPageSizeChunks,
    readPdfPageSizes as readCorePdfPageSizes,
    type IPdfPageSize,
    type IPdfPageSizeChunk,
    type IPdfPageSizeStore,
} from '@evb/scan-cleanup/core/pdfPageSizes';
import type {IReadPdfPageSizesOptions as ICoreReadPdfPageSizesOptions} from '@evb/scan-cleanup/core/types';

export type {
    IPdfPageSize,
    IPdfPageSizeChunk,
    IPdfPageSizeStore,
};
export {
    parsePdfInfoPageGeometry, parsePdfPageSizesPayload,
};

export interface IReadPdfPageSizesOptions extends Omit<ICoreReadPdfPageSizesOptions, 'log' | 'runCommand'> {
    log?: ICoreReadPdfPageSizesOptions['log'];
    runCommand?: typeof runNativeToolCommand;
}

export async function readPdfPageSizes(
    pdfPath: string,
    options: IReadPdfPageSizesOptions,
) {
    return readCorePdfPageSizes(pdfPath, {
        ...options,
        log: options.log ?? (() => undefined),
        runCommand: options.runCommand ?? runNativeToolCommand,
    });
}

/**
 * Read the complete native geometry snapshot in one bounded sidecar pass.
 * Exact mode deliberately has no Poppler fallback: a fallback result cannot
 * carry the direct-page UserUnit required to seed PDF.js dimensions.
 */
export async function readPdfNativePageGeometry(
    pdfPath: string,
    options: IReadPdfPageSizesOptions,
): Promise<IPdfPageSize[]> {
    if (options.pdfPageOpsBinary === undefined) {
        throw new Error('Native page operations are required for exact PDF geometry');
    }
    const {
        pdfinfoBinary: _pdfinfoBinary,
        ...nativeOptions
    } = options;
    const pages: IPdfPageSize[] = [];
    for await (const chunk of readCorePdfPageSizeChunks(pdfPath, {
        ...nativeOptions,
        nativeMetadataOnly: true,
        log: options.log ?? (() => undefined),
        runCommand: options.runCommand ?? runNativeToolCommand,
    })) {
        pages.push(...chunk.pages);
    }
    for (const page of pages) {
        if (page.userUnit === undefined || !Number.isFinite(page.userUnit) || page.userUnit <= 0) {
            throw new Error(`Native exact geometry is missing UserUnit for page ${String(page.pageNumber)}`);
        }
    }
    return pages;
}

/** Open the bounded native page-geometry reader used by long-document jobs. */
export function createPdfPageSizeStore(
    pdfPath: string,
    options: IReadPdfPageSizesOptions,
) {
    return createCorePdfPageSizeStore(pdfPath, {
        ...options,
        log: options.log ?? (() => undefined),
        runCommand: options.runCommand ?? runNativeToolCommand,
    });
}
