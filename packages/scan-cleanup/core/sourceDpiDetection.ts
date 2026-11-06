import type {
    IDetectedPageRaster,
    ISourceDpiDetectionResult,
    IScanCleanupPageRasterSource,
    TScanCleanupDetectSourceDpi,
    TScanCleanupLog,
    TScanCleanupRunCommand,
    IScanCleanupRunCommandOptions,
} from '@evb/scan-cleanup/core/types';
import {getErrorMessage} from '@contracts/getErrorMessage';
import {isScanCleanupCompactLayeredRaster} from '@evb/scan-cleanup/core/types';
import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@evb/scan-cleanup/core/pageBatches';
import {
    reduceScanCleanupRasterRows,
    toScanCleanupPageRasterSource,
    type IPageRasterDetectionResult,
} from '@evb/scan-cleanup/core/sourceRasterFacts';

export type TSourceDpiLog = (level: 'debug' | 'warn' | 'error', message: string) => void;
export type {
    IDetectedPageRaster, ISourceDpiDetectionResult,
} from '@evb/scan-cleanup/core/types';
export {
    detectSourceDpiFromPageSizes,
    resolveSourceDpi,
} from '@evb/scan-cleanup/core/types';

const PDFIMAGES_TIMEOUT_MS = 30 * 1000;
// The previous 30-second probe covered at most 48 contiguous pages. Keep that
// per-page allowance for smaller probes, but never exceed the process ceiling.
const PDFIMAGES_BASELINE_PROBE_SPAN = 48;
// Starting pdfimages and opening the document cost the same for one page as
// for 48: a one-page probe of a 300 MB scan whose cross-reference table must
// be rebuilt takes a second, past a 625 ms per-page share.
const PDFIMAGES_PROBE_START_MS = 5 * 1000;
const PDFIMAGES_MAX_CONTIGUOUS_PROBE_SPAN = 1_024;
const PDFIMAGES_PROBE_CONCURRENCY = 4;

interface IPdfImagesProbe {
    args: string[];
    timeoutMs: number;
    pageUnits: number;
}


function getUniqueValidPages(pages: readonly number[] | undefined) {
    return Array.from(new Set((pages ?? []).filter(pageNumber =>
        Number.isSafeInteger(pageNumber) && pageNumber > 0,
    ))).sort((a, b) => a - b);
}

function getBoundedPageProbeRanges(pages: readonly number[]) {
    const ranges: Array<{
        firstPage: number;
        lastPage: number
    }> = [];
    let firstPage = pages[0];
    let lastPage = firstPage;
    if (firstPage === undefined) {
        return ranges;
    }
    for (const page of pages.slice(1)) {
        if (
            page === lastPage! + 1
            && page - firstPage + 1 <= PDFIMAGES_MAX_CONTIGUOUS_PROBE_SPAN
        ) {
            lastPage = page;
            continue;
        }
        ranges.push({
            firstPage,
            lastPage: lastPage!,
        });
        firstPage = page;
        lastPage = page;
    }
    ranges.push({
        firstPage,
        lastPage: lastPage!,
    });
    return ranges;
}

function buildPdfImagesListArgs(pdfPath: string, firstPage: number, lastPage: number) {
    return [
        '-f',
        String(firstPage),
        '-l',
        String(lastPage),
        '-list',
        pdfPath,
    ];
}

function resolvePdfImagesProbeTimeout(pageUnits: number) {
    return Math.min(
        PDFIMAGES_TIMEOUT_MS,
        PDFIMAGES_PROBE_START_MS + Math.ceil(pageUnits * PDFIMAGES_TIMEOUT_MS / PDFIMAGES_BASELINE_PROBE_SPAN),
    );
}

function buildPdfImagesProbes(pdfPath: string, pages: readonly number[] | undefined): IPdfImagesProbe[] {
    const validPages = getUniqueValidPages(pages);
    if (validPages.length === 0) {
        return [{
            args: [
                '-list',
                pdfPath,
            ],
            timeoutMs: PDFIMAGES_TIMEOUT_MS,
            pageUnits: 1,
        }];
    }

    return getBoundedPageProbeRanges(validPages).map(probeRange => ({
        args: buildPdfImagesListArgs(pdfPath, probeRange.firstPage, probeRange.lastPage),
        timeoutMs: resolvePdfImagesProbeTimeout(probeRange.lastPage - probeRange.firstPage + 1),
        pageUnits: probeRange.lastPage - probeRange.firstPage + 1,
    }));
}

function parsePdfImagesListOutput(output: string): IPageRasterDetectionResult {
    const lines = output.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    return reduceScanCleanupRasterRows(lines.flatMap(line => {
        const parts = line.split(/\s+/);
        return parts.length < 14 ? [] : [{
            pageNumber: parseInt(parts[0] ?? '', 10),
            type: parts[2] ?? '',
            width: parseInt(parts[3] ?? '', 10),
            height: parseInt(parts[4] ?? '', 10),
            bitsPerComponent: parseInt(parts[7] ?? '', 10),
            objectId: parseInt(parts[10] ?? '', 10),
            xPpi: parseInt(parts[12] ?? '', 10),
            yPpi: parseInt(parts[13] ?? '', 10),
        }];
    }));
}

/** Shared bounded raster facts for detection and conversion. */
export function createScanCleanupPageRasterSource({
    pdfPath,
    pdfimagesBinary,
    detectSourceDpi,
    log,
    signal,
    documentPageCount,
}: {
    pdfPath: string;
    pdfimagesBinary: string | undefined;
    detectSourceDpi: TScanCleanupDetectSourceDpi;
    log: TScanCleanupLog;
    signal: AbortSignal;
    documentPageCount: number;
}): IScanCleanupPageRasterSource {
    const cache = new Map<number, Promise<IDetectedPageRaster | undefined>>();
    let compactLayeredPageCount = 0;
    let nextExpectedPageNumber = 1;
    let rasterProbeFailed = false;
    let documentDpi: number | null = null;
    const recordPageRaster = (pageNumber: number, raster: IDetectedPageRaster | undefined) => {
        // Full conversion probes pages in document order. A later child repeats
        // the same pages after the parent's canvas pass, so a scalar high-water
        // mark counts each page once without a document-sized Set or Map. Any
        // other order is refused rather than turning the budget into an
        // unverified partial count.
        if (pageNumber < nextExpectedPageNumber) return raster;
        if (pageNumber !== nextExpectedPageNumber) {
            rasterProbeFailed = true;
            return raster;
        }
        nextExpectedPageNumber += 1;
        if (isScanCleanupCompactLayeredRaster(raster)) compactLayeredPageCount += 1;
        return raster;
    };
    // A miss probes the window of pages that follows it in one process:
    // conversion visits pages in document order, often twice, and one
    // pdfimages run per page made that two process launches per page.
    const probeFrom = (firstPageNumber: number) => {
        const pageNumbers = [firstPageNumber];
        for (
            let pageNumber = firstPageNumber + 1;
            pageNumber <= documentPageCount && pageNumbers.length < SCAN_CLEANUP_STREAMING_BATCH_PAGES;
            pageNumber += 1
        ) {
            pageNumbers.push(pageNumber);
        }
        const probed = (async () => {
            signal.throwIfAborted();
            const rasters = new Map<number, IDetectedPageRaster | undefined>();
            if (pdfimagesBinary === undefined) {
                rasterProbeFailed = true;
            } else {
                const result = await detectSourceDpi(
                    pdfPath,
                    pdfimagesBinary,
                    log,
                    undefined,
                    signal,
                    pageNumbers,
                );
                documentDpi = Math.max(documentDpi ?? 0, result.documentDpi ?? 0) || null;
                for (const pageNumber of pageNumbers) {
                    rasters.set(pageNumber, await result.getPageRaster(pageNumber));
                }
            }
            for (const pageNumber of pageNumbers) recordPageRaster(pageNumber, rasters.get(pageNumber));
            return rasters;
        })();
        // Re-inserting moves the window to the recent end, so the bound evicts
        // pages the traversal has passed rather than the ones it reads next.
        for (const pageNumber of pageNumbers) {
            cache.delete(pageNumber);
            const pageRaster = probed.then(rasters => rasters.get(pageNumber));
            // A cancel rejects every page of the window; callers await only
            // the pages they read, so the rest must not go unhandled.
            pageRaster.catch(() => undefined);
            cache.set(pageNumber, pageRaster);
        }
        while (cache.size > SCAN_CLEANUP_STREAMING_BATCH_PAGES) {
            cache.delete(cache.keys().next().value!);
        }
    };
    const getPageRaster = (pageNumber: number) => {
        if (!cache.has(pageNumber)) probeFrom(pageNumber);
        return cache.get(pageNumber)!;
    };
    return {
        get detected() {
            return pdfimagesBinary !== undefined;
        },
        get documentDpi() {
            return documentDpi;
        },
        get compactLayeredPageCount() {
            return compactLayeredPageCount;
        },
        get compactLayeredPageCountComplete() {
            return !rasterProbeFailed
                && nextExpectedPageNumber > documentPageCount;
        },
        recordPageRaster,
        getPageRaster,
    };
}

export async function detectSourceDpiDetails(
    pdfPath: string,
    pdfimagesBinary: string | undefined,
    log: TSourceDpiLog,
    commandEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
    pages?: readonly number[],
    onProgress?: (completedPages: number, totalPages: number) => void,
    runCommand?: TScanCleanupRunCommand,
): Promise<ISourceDpiDetectionResult> {
    if (!pdfimagesBinary) {
        return toScanCleanupPageRasterSource({
            documentDpi: null,
            rasterByPage: new Map(),
        }, false);
    }
    if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('PDF DPI detection aborted');
    }
    if (runCommand === undefined) throw new Error('PDF DPI detection requires a command runner');

    const combinedResult: IPageRasterDetectionResult = {
        documentDpi: null,
        rasterByPage: new Map(),
    };
    const probes = buildPdfImagesProbes(pdfPath, pages);
    const totalPages = probes.reduce((total, probe) => total + probe.pageUnits, 0);
    let nextProbeIndex = 0;
    let completedPages = 0;
    const runProbe = async (probe: IPdfImagesProbe) => {
        const commandOptions: IScanCleanupRunCommandOptions = {
            commandLabel: 'pdfimages(-list)',
            timeoutMs: probe.timeoutMs,
            log,
        };
        if (commandEnv !== undefined) {
            commandOptions.env = commandEnv;
        }
        if (signal !== undefined) {
            commandOptions.signal = signal;
        }

        try {
            const result = await runCommand(
                pdfimagesBinary,
                probe.args,
                commandOptions,
            );
            const probeResult = parsePdfImagesListOutput(result.stdout);
            // Probes cover disjoint page ranges, so each page has one raster.
            combinedResult.documentDpi = Math.max(combinedResult.documentDpi ?? 0, probeResult.documentDpi ?? 0) || null;
            for (const [
                pageNumber,
                raster,
            ] of probeResult.rasterByPage) {
                combinedResult.rasterByPage.set(pageNumber, raster);
            }
        } finally {
            completedPages += probe.pageUnits;
            onProgress?.(completedPages, totalPages);
        }
    };
    const outcomes = await Promise.allSettled(Array.from(
        {length: Math.min(PDFIMAGES_PROBE_CONCURRENCY, probes.length)},
        async () => {
            while (nextProbeIndex < probes.length) {
                const probeIndex = nextProbeIndex;
                nextProbeIndex += 1;
                await runProbe(probes[probeIndex]!);
            }
        },
    ));
    // Lanes a cancel stopped share the signal's reason. Distinct failures
    // travel together, so none whose process may still run is dropped.
    const failures = [...new Set(outcomes.flatMap(outcome => (outcome.status === 'rejected' ? [outcome.reason] : [])))];
    if (failures.length > 1) {
        throw new AggregateError(failures, `PDF DPI probes failed: ${failures.map(getErrorMessage).join('; ')}`);
    }
    if (failures.length === 1) {
        throw failures[0];
    }
    return toScanCleanupPageRasterSource(combinedResult, pages === undefined);
}

export async function detectSourceDpi(
    pdfPath: string,
    pdfimagesBinary: string | undefined,
    log: TSourceDpiLog,
    commandEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
    pages?: readonly number[],
    runCommand?: TScanCleanupRunCommand,
) {
    return (await detectSourceDpiDetails(
        pdfPath,
        pdfimagesBinary,
        log,
        commandEnv,
        signal,
        pages,
        undefined,
        runCommand,
    )).documentDpi;
}
