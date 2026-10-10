import {
    rm,
    stat,
} from 'node:fs/promises';
import type {
    IScanCleanupRasterRenderLimits,
    IScanCleanupRunCommandOptions,
    TScanCleanupRenderPage,
    TScanCleanupRunCommand,
} from '@evb/scan-cleanup/core/types';
import {
    readPngDimensions,
    readPpmDimensions,
    writePngFromPpm,
} from '@evb/scan-cleanup/core/rasterLayerDimensions';
import {
    SCAN_CLEANUP_MAX_BILEVEL_PIXELS,
    SCAN_CLEANUP_MAX_DIMENSION_PX,
} from '@evb/scan-cleanup/core/policy/effectiveOptions';

interface IRenderCommandOptions extends IScanCleanupRunCommandOptions {onTerminationProof?: (proof: Promise<boolean>) => void;}

type TRenderCommand = (
    command: string,
    args: string[],
    options?: IRenderCommandOptions,
) => ReturnType<TScanCleanupRunCommand>;

const PDFTOPPM_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_RASTER_LIMITS = {
    maxDimensionPx: SCAN_CLEANUP_MAX_DIMENSION_PX,
    maxPixels: SCAN_CLEANUP_MAX_BILEVEL_PIXELS,
};

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

/** Where Poppler writes the PPM a PNG render is encoded from. */
function popplerPpmPath(pngPath: string) {
    return `${pngPath.replace(/\.png$/u, '')}.ppm`;
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

async function renderPage(
    runCommand: TRenderCommand,
    format: 'png' | 'ppm',
    [
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
        annotations,
    ]: Parameters<TScanCleanupRenderPage
    >,
    onTerminationProof?: (proof: Promise<boolean>) => void,
) {
    validateCrop(crop);
    validateRenderLimits(limits);
    // Poppler always writes PPM. Its PNG writer is fixed at maximum zlib
    // compression, which turns a smooth scanned page into tens of seconds of
    // deflate; a PNG caller gets the same pixels encoded at the fastest level.
    const commandArgs = [
        ...(annotations === 'exclude' ? ['-hide-annotations'] : []),
        ...(renderBox === 'mediabox' ? [] : ['-cropbox']),
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
        ...(onTerminationProof === undefined ? {} : {onTerminationProof}),
    });
    if (format === 'png') {
        // A failed render or encode leaves this file to the renderer's own
        // failure policy, which retains or removes it with the PNG.
        await writePngFromPpm(popplerPpmPath(outputPath), outputPath, {
            maxPixels: limits?.maxPixels ?? DEFAULT_RASTER_LIMITS.maxPixels,
            maxDimensionPx: limits?.maxDimensionPx ?? DEFAULT_RASTER_LIMITS.maxDimensionPx,
            ...(signal === undefined ? {} : {signal}),
        });
        await rm(popplerPpmPath(outputPath), {force: true}).catch(() => undefined);
    }
}

export function createScanCleanupRenderers(
    runCommand: TRenderCommand,
    fallbackLimits: Pick<IScanCleanupRasterRenderLimits, 'maxDimensionPx' | 'maxPixels'> = DEFAULT_RASTER_LIMITS,
    // The platform that observes termination supplies its existing error policy.
    // Shared renderers do not know Electron's native-termination marker.
    retainOutputOnFailure: (error: unknown) => boolean = () => false,
) {
    const validateRenderedDimensions = async (
        format: 'png' | 'ppm',
        outputPath: string,
        limits: IScanCleanupRasterRenderLimits | undefined,
    ) => {
        if (format === 'ppm' && !(await stat(outputPath)).isFile()) {
            return;
        }
        const dimensions = format === 'png'
            ? await readPngDimensions(outputPath)
            : await readPpmDimensions(outputPath);
        const maxDimensionPx = limits?.maxDimensionPx ?? fallbackLimits.maxDimensionPx;
        const maxPixels = limits?.maxPixels ?? fallbackLimits.maxPixels;
        if (
            dimensions.width > maxDimensionPx
            || dimensions.height > maxDimensionPx
            || dimensions.width * dimensions.height > maxPixels
        ) {
            throw new RangeError(
                `${format.toUpperCase()} raster ${String(dimensions.width)}x${String(dimensions.height)} exceeds limits`,
            );
        }
    };
    const createRenderer = (format: 'png' | 'ppm'): TScanCleanupRenderPage => async (...args) => {
        const outputPath = args[4];
        const signal = args[7];
        let terminationProof: Promise<boolean> | undefined;
        const cleanup = () => Promise.all([
            outputPath,
            ...(format === 'png' ? [popplerPpmPath(outputPath)] : []),
        ].map(path => rm(path, {force: true}).catch(() => undefined)));
        try {
            await renderPage(runCommand, format, args, proof => { terminationProof = proof; });
            signal?.throwIfAborted();
            await validateRenderedDimensions(format, outputPath, args[9]);
            signal?.throwIfAborted();
        } catch (error) {
            if (retainOutputOnFailure(error)) {
                // A bounded rejection does not prove the producer stopped. Use
                // the runner's proof, never a second timer or close-event guess.
                void terminationProof?.then(proven => (proven ? cleanup() : undefined)).catch(() => undefined);
            } else {
                // Best-effort removal must preserve the useful renderer error.
                await cleanup();
            }

            throw error;
        }
    };
    return {
        renderPage: createRenderer('png'),
        renderPagePpm: createRenderer('ppm'),
    };
}
