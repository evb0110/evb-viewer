import {
    mkdtemp,
    rename,
    rm,
} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {
    IScanCleanupDetectionRetention,
    IScanCleanupRetainedRaster,
} from '@evb/scan-cleanup/core/detection';
import type {IScanCleanupPageRasterSource} from '@evb/scan-cleanup/core/types';
import type {
    IPdfPageSizeStore,
    readPdfPageSizes,
} from '@evb/scan-cleanup/core/pdfPageSizes';

/** One CLI run's document: a directory of staged rasters and its source. */
export interface IScanCleanupCliDocument {
    directory: string;
    sourcePdfPath: string;
}

function cliStagedRasterPath(
    document: IScanCleanupCliDocument,
    pageNumber: number,
    dpi: number,
) {
    return join(document.directory, `page-${String(pageNumber)}-${String(dpi)}.png`);
}

export function createCliRetention(
    temporaryRoot: string,
    sourcePdfPath: string,
    getPageCount: (path: string, signal: AbortSignal) => Promise<number>,
    getPageSizes: (path: string, signal: AbortSignal) => Promise<Awaited<ReturnType<typeof readPdfPageSizes>>>,
    detectRasterPages: (path: string, signal: AbortSignal) => Promise<IScanCleanupPageRasterSource>,
    getPageSizeStore?: (path: string, signal: AbortSignal) => Promise<IPdfPageSizeStore>,
): IScanCleanupDetectionRetention<IScanCleanupCliDocument> {
    const pageSizeRetention: Pick<
        IScanCleanupDetectionRetention<IScanCleanupCliDocument>,
        'pageSizes' | 'pageSizeStore'
    > = {};
    if (getPageSizeStore === undefined) {
        pageSizeRetention.pageSizes = (_document, signal) => getPageSizes(sourcePdfPath, signal);
    } else {
        const openPageSizeStore = getPageSizeStore;
        pageSizeRetention.pageSizeStore = (_document, signal) => openPageSizeStore(sourcePdfPath, signal);
    }
    const retention: IScanCleanupDetectionRetention<IScanCleanupCliDocument> = {
        async openDocument() {
            return {
                // Analyze manifests are confined to the run's temporary root.
                // Retained replayable rasters must live below that same root,
                // not in a sibling directory created directly under os.tmpdir.
                directory: await mkdtemp(join(temporaryRoot, 'document-')),
                sourcePdfPath,
            };
        },
        async pageCount(_document, signal) {
            return getPageCount(sourcePdfPath, signal);
        },
        ...pageSizeRetention,
        async rasterPages(_document, signal) {
            return detectRasterPages(sourcePdfPath, signal);
        },
        retainedPaths() {
            return Promise.resolve(new Map<number, IScanCleanupRetainedRaster>());
        },
        // Private to one render. Detection's bounded window publishes over the
        // staged path only once the render finished, so the sidecar never sees
        // a half-written raster at an input path it is waiting for.
        rasterScratchPath(document, pageNumber, dpi) {
            return Promise.resolve(join(
                document.directory,
                `page-${String(pageNumber)}-${String(dpi)}.${randomUUID()}.part.png`,
            ));
        },
        stagedRasterPath(document, pageNumber, dpi) {
            return Promise.resolve(cliStagedRasterPath(document, pageNumber, dpi));
        },
        async retain(input) {
            const path = cliStagedRasterPath(input.document, input.pageNumber, input.dpi);
            await rename(input.scratchPath, path);
            return {
                dpi: input.dpi,
                height: input.height,
                pageNumber: input.pageNumber,
                path,
                sizeBytes: input.sizeBytes,
                width: input.width,
            } satisfies IScanCleanupRetainedRaster;
        },
        async releaseRaster(document, pageNumber, dpi) {
            await rm(cliStagedRasterPath(document, pageNumber, dpi), {force: true});
        },
        async release(document) {
            await rm(document.directory, {
                force: true,
                recursive: true,
            });
        },
    };
    return retention;
}
