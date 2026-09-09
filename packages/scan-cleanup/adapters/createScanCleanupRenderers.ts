import {rm} from 'node:fs/promises';
import type {
    IScanCleanupRasterRenderLimits,
    TScanCleanupLog,
    TScanCleanupRenderPage,
    TScanCleanupRunCommand,
} from '@evb/scan-cleanup/core/types';
import {
    parsePdfInfoPageGeometry,
    shouldUseMediaBoxForSuspiciousCrop,
} from '@evb/scan-cleanup/core/pdfPageSizes';
import {getErrorMessage} from '@contracts/getErrorMessage';
import {readPngDimensions} from '@evb/scan-cleanup/core/rasterLayerDimensions';
import {
    SCAN_CLEANUP_MAX_BILEVEL_PIXELS,
    SCAN_CLEANUP_MAX_DIMENSION_PX,
} from '@evb/scan-cleanup/core/policy/effectiveOptions';

const PDFTOPPM_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_RASTER_LIMITS = {
    maxDimensionPx: SCAN_CLEANUP_MAX_DIMENSION_PX,
    maxPixels: SCAN_CLEANUP_MAX_BILEVEL_PIXELS,
};
const PDFINFO_TIMEOUT_MS = 60 * 1000;
const PDFINFO_OVERVIEW_MAX_STDOUT_BYTES = 256 * 1024;

interface IScanCleanupRendererOptions {pdfinfoBinary?: string;}

interface IRenderDocumentGeometry {fallbackToMediaBoxPages: ReadonlySet<number>;}

function pageCountFromPdfInfo(output: string) {
    const match = /^Pages:\s+(\d+)\s*$/mu.exec(output);
    const pageCount = Number.parseInt(match?.[1] ?? '', 10);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new Error('pdfinfo returned no page count for CropBox recovery');
    }
    return pageCount;
}

function validateRenderLimits(limits: IScanCleanupRasterRenderLimits | undefined) {
    if (limits === undefined) {
        return;
    }
    for (const [
        label,
        value,
    ] of Object.entries(limits)) {
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new TypeError(`Poppler raster ${label} must be a positive safe integer`);
        }
    }
    if (
        limits.expectedWidthPx > limits.maxDimensionPx
        || limits.expectedHeightPx > limits.maxDimensionPx
        || limits.expectedWidthPx * limits.expectedHeightPx > limits.maxPixels
    ) {
        throw new RangeError(
            `Poppler raster ${String(limits.expectedWidthPx)}x${String(limits.expectedHeightPx)} exceeds limits`,
        );
    }
}

function validateCrop(crop: Parameters<TScanCleanupRenderPage>[8]) {
    if (crop === undefined) {
        return;
    }
    for (const field of [
        'x',
        'y',
        'width',
        'height',
    ] as const) {
        const value = crop[field];
        const minimum = field === 'x' || field === 'y' ? 0 : 1;
        if (!Number.isSafeInteger(value) || value < minimum) {
            throw new TypeError(
                `Poppler pixel crop ${field} must be a ${minimum === 0 ? 'non-negative' : 'positive'} safe integer`,
            );
        }
    }
}

async function readSuspiciousCropGeometry(
    runCommand: TScanCleanupRunCommand,
    pdfinfoBinary: string,
    sourcePdfPath: string,
    signal: AbortSignal | undefined,
    log: TScanCleanupLog,
): Promise<IRenderDocumentGeometry | null> {
    try {
        const commandOptions = {
            timeoutMs: PDFINFO_TIMEOUT_MS,
            ...(signal === undefined ? {} : {signal}),
            log,
        };
        const overview = await runCommand(pdfinfoBinary, [sourcePdfPath], {
            ...commandOptions,
            commandLabel: 'pdfinfo(cropbox-recovery-overview)',
            maxStdoutBytes: PDFINFO_OVERVIEW_MAX_STDOUT_BYTES,
        });
        const pageCount = pageCountFromPdfInfo(overview.stdout);
        const detailed = await runCommand(pdfinfoBinary, [
            '-f',
            '1',
            '-l',
            String(pageCount),
            '-box',
            sourcePdfPath,
        ], {
            ...commandOptions,
            commandLabel: 'pdfinfo(cropbox-recovery-boxes)',
            maxStdoutBytes: PDFINFO_OVERVIEW_MAX_STDOUT_BYTES + pageCount * 1024,
            rejectOnStdoutTruncation: true,
        });
        const pageSizes = parsePdfInfoPageGeometry(detailed.stdout);
        return {fallbackToMediaBoxPages: new Set(
            pageSizes
                .filter(page => shouldUseMediaBoxForSuspiciousCrop(page, pageSizes))
                .map(page => page.pageNumber),
        )};
    } catch (error) {
        if (signal?.aborted) throw error;
        log(
            'warn',
            `CropBox recovery metadata could not be read; retaining Poppler's CropBox rendering: ${getErrorMessage(error)}`,
        );
        return null;
    }
}

async function renderPage(
    runCommand: TScanCleanupRunCommand,
    format: 'png' | 'ppm',
    paths: Parameters<TScanCleanupRenderPage>[0],
    log: TScanCleanupLog,
    pageNumber: number,
    sourcePdfPath: string,
    outputPath: string,
    dpi: number,
    popplerEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
    crop?: Parameters<TScanCleanupRenderPage>[8],
    limits?: Parameters<TScanCleanupRenderPage>[9],
    useMediaBox = false,
) {
    validateCrop(crop);
    validateRenderLimits(limits);
    const commandArgs = [
        ...(format === 'png' ? ['-png'] : []),
        ...(useMediaBox ? [] : ['-cropbox']),
        ...(limits?.scaleToFitPx === undefined ? [] : [
            '-scale-to',
            String(limits.scaleToFitPx),
        ]),
        '-r',
        String(dpi),
        '-f',
        String(pageNumber),
        '-l',
        String(pageNumber),
        '-singlefile',
    ];
    if (crop !== undefined) {
        commandArgs.push(
            '-x',
            String(crop.x),
            '-y',
            String(crop.y),
            '-W',
            String(crop.width),
            '-H',
            String(crop.height),
        );
    }
    commandArgs.push(
        sourcePdfPath,
        outputPath.replace(format === 'png' ? /\.png$/u : /\.ppm$/u, ''),
    );
    await runCommand(paths.pdftoppmBinary, commandArgs, {
        commandLabel: `pdftoppm(page=${String(pageNumber)},dpi=${String(dpi)})`,
        timeoutMs: PDFTOPPM_TIMEOUT_MS,
        ...(popplerEnv === undefined ? {} : {env: popplerEnv}),
        ...(signal === undefined ? {} : {signal}),
        log,
    });
}

export function createScanCleanupRenderers(
    runCommand: TScanCleanupRunCommand,
    fallbackLimits: Pick<IScanCleanupRasterRenderLimits, 'maxDimensionPx' | 'maxPixels'> = DEFAULT_RASTER_LIMITS,
    rendererOptions: IScanCleanupRendererOptions = {},
) {
    const geometryBySourcePdf = new Map<string, Promise<IRenderDocumentGeometry | null>>();
    const awaitWithSignal = async <T>(pending: Promise<T>, signal: AbortSignal | undefined) => {
        if (signal === undefined) {
            return pending;
        }
        signal.throwIfAborted();
        return new Promise<T>((resolve, reject) => {
            const aborted = () => reject(signal.reason ?? new Error('Scan cleanup render aborted'));
            signal.addEventListener('abort', aborted, {once: true});
            pending.then(
                value => {
                    signal.removeEventListener('abort', aborted);
                    resolve(value);
                },
                error => {
                    signal.removeEventListener('abort', aborted);
                    reject(error);
                },
            );
        });
    };
    const getDocumentGeometry = async (
        sourcePdfPath: string,
        signal: AbortSignal | undefined,
        log: TScanCleanupLog,
    ) => {
        if (rendererOptions.pdfinfoBinary === undefined) {
            return Promise.resolve(null);
        }
        const cached = geometryBySourcePdf.get(sourcePdfPath);
        if (cached !== undefined) {
            return awaitWithSignal(cached, signal);
        }
        const pending = readSuspiciousCropGeometry(
            runCommand,
            rendererOptions.pdfinfoBinary,
            sourcePdfPath,
            undefined,
            log,
        ).catch(error => {
            geometryBySourcePdf.delete(sourcePdfPath);
            throw error;
        });
        geometryBySourcePdf.set(sourcePdfPath, pending);
        if (geometryBySourcePdf.size > 32) {
            const oldestSourcePdf = geometryBySourcePdf.keys().next().value;
            if (oldestSourcePdf !== undefined) {
                geometryBySourcePdf.delete(oldestSourcePdf);
            }
        }
        return awaitWithSignal(pending, signal);
    };
    const renderPageWithResolvedBox = async (
        format: 'png' | 'ppm',
        ...[
            paths,
            log,
            pageNumber,
            sourcePdfPath,
            outputPath,
            dpi,
            popplerEnv,
            signal,
            crop,
            limits,
            renderBox,
        ]: Parameters<TScanCleanupRenderPage>
    ) => {
        const geometry = crop === undefined && renderBox !== 'cropbox' && renderBox !== 'mediabox'
            ? await getDocumentGeometry(sourcePdfPath, signal, log)
            : null;
        await renderPage(
            runCommand,
            format,
            paths,
            log,
            pageNumber,
            sourcePdfPath,
            outputPath,
            dpi,
            popplerEnv,
            signal,
            crop,
            limits,
            renderBox === 'mediabox'
                || (renderBox !== 'cropbox' && geometry?.fallbackToMediaBoxPages.has(pageNumber) === true),
        );
    };
    const renderPageToPng: TScanCleanupRenderPage = async (
        paths,
        log,
        pageNumber,
        sourcePdfPath,
        outputPngPath,
        dpi,
        popplerEnv,
        signal,
        crop,
        limits,
        renderBox,
    ) => {
        try {
            await renderPageWithResolvedBox(
                'png',
                paths,
                log,
                pageNumber,
                sourcePdfPath,
                outputPngPath,
                dpi,
                popplerEnv,
                signal,
                crop,
                limits,
                renderBox,
            );
            signal?.throwIfAborted();
            const dimensions = await readPngDimensions(outputPngPath);
            const maxDimensionPx = limits?.maxDimensionPx ?? fallbackLimits.maxDimensionPx;
            const maxPixels = limits?.maxPixels ?? fallbackLimits.maxPixels;
            if (
                dimensions.width > maxDimensionPx
                || dimensions.height > maxDimensionPx
                || dimensions.width * dimensions.height > maxPixels
            ) {
                throw new RangeError(
                    `PNG raster ${String(dimensions.width)}x${String(dimensions.height)} exceeds limits`,
                );
            }
            signal?.throwIfAborted();
        } catch (error) {
            // The renderer error is the useful failure. A best-effort cleanup
            // must not replace it when the output path cannot be removed.
            await rm(outputPngPath, {force: true}).catch(() => undefined);
            throw error;
        }
    };
    const renderPageToPpm: TScanCleanupRenderPage = async (
        paths,
        log,
        pageNumber,
        sourcePdfPath,
        outputPpmPath,
        dpi,
        popplerEnv,
        signal,
        crop,
        limits,
        renderBox,
    ) => {
        await renderPageWithResolvedBox(
            'ppm',
            paths,
            log,
            pageNumber,
            sourcePdfPath,
            outputPpmPath,
            dpi,
            popplerEnv,
            signal,
            crop,
            limits,
            renderBox,
        );
    };
    return {
        renderPage: renderPageToPng,
        renderPagePpm: renderPageToPpm,
    };
}
