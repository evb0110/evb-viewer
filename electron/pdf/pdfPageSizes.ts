import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {
    createPdfPageSizeStore as createCorePdfPageSizeStore,
    readPdfPageSizeChunks as readCorePdfPageSizeChunks,
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

export interface IReadPdfPageSizesOptions extends Omit<ICoreReadPdfPageSizesOptions, 'log' | 'runCommand'> {
    log?: ICoreReadPdfPageSizesOptions['log'];
    runCommand?: typeof runNativeToolCommand;
}

/**
 * Read the complete native geometry snapshot in one bounded sidecar pass. Every
 * page must carry the direct-page UserUnit required to seed PDF.js dimensions.
 */
export async function readPdfNativePageGeometry(
    pdfPath: string,
    options: IReadPdfPageSizesOptions,
): Promise<IPdfPageSize[]> {
    const pages: IPdfPageSize[] = [];
    for await (const chunk of readCorePdfPageSizeChunks(pdfPath, {
        ...options,
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
