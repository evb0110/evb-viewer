import {getErrorMessage} from '@contracts/getErrorMessage';
import type {
    IDetectedPageRaster,
    ISourceDpiDetectionResult,
    TScanCleanupRunCommand,
    IScanCleanupRunCommandOptions,
} from '@evb/scan-cleanup/core/types';

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
const PDFIMAGES_MAX_CONTIGUOUS_PROBE_SPAN = 1_024;
const PDFIMAGES_PROBE_CONCURRENCY = 4;

interface IPdfImagesProbe {
    args: string[];
    timeoutMs: number;
    label: string;
    contributesDocumentDpi: boolean;
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
        Math.ceil(pageUnits * PDFIMAGES_TIMEOUT_MS / PDFIMAGES_BASELINE_PROBE_SPAN),
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
            label: 'full-document',
            contributesDocumentDpi: true,
            pageUnits: 1,
        }];
    }

    return getBoundedPageProbeRanges(validPages).map(probeRange => ({
        args: buildPdfImagesListArgs(pdfPath, probeRange.firstPage, probeRange.lastPage),
        timeoutMs: resolvePdfImagesProbeTimeout(probeRange.lastPage - probeRange.firstPage + 1),
        label: probeRange.firstPage === probeRange.lastPage
            ? String(probeRange.firstPage)
            : `${probeRange.firstPage}-${probeRange.lastPage}`,
        contributesDocumentDpi: true,
        pageUnits: probeRange.lastPage - probeRange.firstPage + 1,
    }));
}

function createRecoverablePdfImagesLog(log: TSourceDpiLog): TSourceDpiLog {
    return (level, message) => {
        log(level === 'error' ? 'debug' : level, message);
    };
}

function parsePdfImagesListOutput(output: string): ISourceDpiDetectionResult {
    const pageRasterByNumber = new Map<number, IDetectedPageRaster>();
    const bilevelPages = new Set<number>();
    const largestBilevelRasterByPage = new Map<number, {
        dpi: number;
        height: number;
        width: number
    }>();
    const maskObjectIdsByPage = new Map<number, Set<number>>();
    const continuousImagesByPage = new Map<number, Array<{
        dpi: number;
        height: number;
        objectId: number;
        width: number
    }>>();
    const lines = output.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);

    for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length < 14) {
            continue;
        }
        const pageNumber = parseInt(parts[0] ?? '', 10);
        const type = parts[2];
        const width = parseInt(parts[3] ?? '', 10);
        const height = parseInt(parts[4] ?? '', 10);
        const bitsPerComponent = parseInt(parts[7] ?? '', 10);
        const objectId = parseInt(parts[10] ?? '', 10);
        const xPpi = parseInt(parts[12] ?? '', 10);
        const yPpi = parseInt(parts[13] ?? '', 10);
        const dpi = Math.max(
            Number.isFinite(xPpi) ? xPpi : 0,
            Number.isFinite(yPpi) ? yPpi : 0,
        );
        const pixelArea = width * height;
        if (!Number.isFinite(pageNumber) || pageNumber <= 0) {
            continue;
        }
        if (
            bitsPerComponent === 1
            && (type === 'image' || type === 'mask' || type === 'smask' || type === 'stencil')
        ) {
            bilevelPages.add(pageNumber);
            if (Number.isSafeInteger(pixelArea) && pixelArea > 0 && dpi > 0) {
                const previous = largestBilevelRasterByPage.get(pageNumber);
                const previousArea = previous === undefined ? 0 : previous.width * previous.height;
                if (pixelArea > previousArea || (pixelArea === previousArea && dpi > (previous?.dpi ?? 0))) {
                    largestBilevelRasterByPage.set(pageNumber, {
                        dpi,
                        height,
                        width,
                    });
                }
            }
            if (Number.isSafeInteger(objectId) && objectId > 0) {
                const ids = maskObjectIdsByPage.get(pageNumber) ?? new Set<number>();
                ids.add(objectId);
                maskObjectIdsByPage.set(pageNumber, ids);
            }
        }
        if (
            type === 'image'
            && bitsPerComponent > 1
            && Number.isSafeInteger(objectId)
            && objectId > 0
            && Number.isSafeInteger(pixelArea)
            && pixelArea > 0
            && dpi > 0
        ) {
            const images = continuousImagesByPage.get(pageNumber) ?? [];
            images.push({
                dpi,
                height,
                objectId,
                width,
            });
            continuousImagesByPage.set(pageNumber, images);
        }
        if (
            type !== 'image'
            || pageNumber <= 0
            || !Number.isSafeInteger(pixelArea)
            || pixelArea <= 0
            || dpi <= 0
        ) {
            continue;
        }

        const dominant = pageRasterByNumber.get(pageNumber);
        const dominantArea = dominant === undefined ? 0 : dominant.width * dominant.height;
        if (pixelArea > dominantArea || (pixelArea === dominantArea && dpi > dominant!.dpi)) {
            pageRasterByNumber.set(pageNumber, {
                dpi,
                width,
                height,
            });
        }
    }
    for (const pageNumber of bilevelPages) {
        const raster = pageRasterByNumber.get(pageNumber);
        if (!raster) continue;
        raster.hasBilevelLayer = true;
        const dominantArea = raster.width * raster.height;
        const largestBilevelRaster = largestBilevelRasterByPage.get(pageNumber);
        const largestBilevelArea = largestBilevelRaster === undefined
            ? 0
            : largestBilevelRaster.width * largestBilevelRaster.height;
        if (largestBilevelRaster !== undefined && largestBilevelArea >= dominantArea * 0.95) {
            raster.hasDominantBilevelLayer = true;
            // A PDF mask can be finer than the lower-DPI tonal image it selects.
            // Retaining the binary source grid must retain that finer grid, not
            // accidentally adopt the background's resolution merely because
            // pdfimages spells the mask as mask/smask/stencil instead of image.
            if (largestBilevelRaster.dpi > raster.dpi) {
                raster.dpi = largestBilevelRaster.dpi;
                raster.width = largestBilevelRaster.width;
                raster.height = largestBilevelRaster.height;
            }
        }
        const maskedObjectIds = maskObjectIdsByPage.get(pageNumber) ?? new Set<number>();
        const background = (continuousImagesByPage.get(pageNumber) ?? [])
            .filter(image => !maskedObjectIds.has(image.objectId))
            .sort((left, right) =>
                right.width * right.height - left.width * left.height
                || right.dpi - left.dpi,
            )[0];
        if (background) raster.backgroundDpi = background.dpi;
    }

    return withDerivedPageDpi({
        documentDpi: null,
        pageRasterByNumber,
    });
}

function withDerivedPageDpi(
    result: Omit<ISourceDpiDetectionResult, 'pageDpiByNumber'>,
): ISourceDpiDetectionResult {
    const pageDpiByNumber = new Map<number, number>();
    let documentDpi = 0;
    for (const [
        pageNumber,
        raster,
    ] of result.pageRasterByNumber) {
        pageDpiByNumber.set(pageNumber, raster.dpi);
        documentDpi = Math.max(documentDpi, raster.dpi);
    }
    return {
        documentDpi: documentDpi > 0 ? documentDpi : result.documentDpi,
        pageDpiByNumber,
        pageRasterByNumber: result.pageRasterByNumber,
    };
}

/**
 * Derive raster resolution from the page metadata pass when every page is a
 * full-page scan. `evb-pdf-page-ops` only exposes these image fields after
 * proving from the PDF content matrix that the image covers the page view, so
 * this is equivalent to pdfimages' dominant-raster answer without decoding or
 * walking every image stream in a second process. A mixed/vector document
 * returns null and keeps the conservative pdfimages fallback.
 */
function mergeDpiDetectionResults(
    target: ISourceDpiDetectionResult,
    source: ISourceDpiDetectionResult,
) {
    target.documentDpi = Math.max(target.documentDpi ?? 0, source.documentDpi ?? 0) || null;
    for (const [
        pageNumber,
        raster,
    ] of source.pageRasterByNumber) {
        const existing = target.pageRasterByNumber.get(pageNumber);
        const existingArea = existing === undefined ? 0 : existing.width * existing.height;
        const incomingArea = raster.width * raster.height;
        if (incomingArea > existingArea || (incomingArea === existingArea && raster.dpi > (existing?.dpi ?? 0))) {
            const backgroundDpi = raster.backgroundDpi ?? existing?.backgroundDpi;
            const hasBilevelLayer = raster.hasBilevelLayer === true || existing?.hasBilevelLayer === true;
            const hasDominantBilevelLayer = raster.hasDominantBilevelLayer === true
                || existing?.hasDominantBilevelLayer === true;
            target.pageRasterByNumber.set(pageNumber, {
                dpi: raster.dpi,
                width: raster.width,
                height: raster.height,
                ...(hasBilevelLayer ? {hasBilevelLayer: true} : {}),
                ...(hasDominantBilevelLayer ? {hasDominantBilevelLayer: true} : {}),
                ...(backgroundDpi === undefined ? {} : {backgroundDpi}),
            });
        } else if (existing) {
            if (raster.hasBilevelLayer && !existing.hasBilevelLayer) {
                existing.hasBilevelLayer = true;
            }
            if (raster.hasDominantBilevelLayer && !existing.hasDominantBilevelLayer) {
                existing.hasDominantBilevelLayer = true;
            }
            if (existing.backgroundDpi === undefined && raster.backgroundDpi !== undefined) {
                existing.backgroundDpi = raster.backgroundDpi;
            }
        }
        target.pageDpiByNumber.set(pageNumber, Math.max(target.pageDpiByNumber.get(pageNumber) ?? 0, raster.dpi));
    }
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
        return {
            documentDpi: null,
            pageDpiByNumber: new Map(),
            pageRasterByNumber: new Map(),
        };
    }
    if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('PDF DPI detection aborted');
    }
    if (runCommand === undefined) throw new Error('PDF DPI detection requires a command runner');

    try {
        const combinedResult: ISourceDpiDetectionResult = {
            documentDpi: null,
            pageDpiByNumber: new Map(),
            pageRasterByNumber: new Map(),
        };
        const probes = buildPdfImagesProbes(pdfPath, pages);
        const totalPages = probes.reduce((total, probe) => total + probe.pageUnits, 0);
        let nextProbeIndex = 0;
        let completedPages = 0;
        const runProbe = async (probe: IPdfImagesProbe) => {
            const commandOptions: IScanCleanupRunCommandOptions = {
                commandLabel: 'pdfimages(-list)',
                timeoutMs: probe.timeoutMs,
                log: createRecoverablePdfImagesLog(log),
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
                if (!probe.contributesDocumentDpi) {
                    probeResult.documentDpi = null;
                }
                mergeDpiDetectionResults(combinedResult, probeResult);
            } catch (err) {
                if (signal?.aborted) {
                    throw signal.reason instanceof Error ? signal.reason : err;
                }
                log('debug', `pdfimages detection failed for pages ${probe.label}: ${getErrorMessage(err)}`);
            } finally {
                completedPages += probe.pageUnits;
                onProgress?.(completedPages, totalPages);
            }
        };
        await Promise.all(Array.from(
            {length: Math.min(PDFIMAGES_PROBE_CONCURRENCY, probes.length)},
            async () => {
                while (nextProbeIndex < probes.length) {
                    const probeIndex = nextProbeIndex;
                    nextProbeIndex += 1;
                    await runProbe(probes[probeIndex]!);
                }
            },
        ));
        return combinedResult;
    } catch (err) {
        if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : err;
        }
        log('debug', `pdfimages detection failed: ${getErrorMessage(err)}`);
    }

    return {
        documentDpi: null,
        pageDpiByNumber: new Map(),
        pageRasterByNumber: new Map(),
    };
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
