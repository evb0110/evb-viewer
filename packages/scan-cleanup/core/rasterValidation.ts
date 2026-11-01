import type {
    IScanCleanupRasterRenderLimits,
    TScanCleanupLog,
    TScanCleanupRenderPage,
} from '@evb/scan-cleanup/core/types';
import {
    readPpmDimensions,
    type TScanCleanupOpenFile,
} from '@evb/scan-cleanup/core/rasterLayerDimensions';
import {SCAN_CLEANUP_RASTER_MAX_PIXELS} from '@evb/scan-cleanup/core/policy/scanCleanupRasterPolicy';

export {
    resolveScanCleanupRasterRenderLimits,
    SCAN_CLEANUP_RASTER_MAX_PIXELS,
} from '@evb/scan-cleanup/core/policy/scanCleanupRasterPolicy';


interface IScanCleanupRasterRenderDependencies {
    fileSystem: {open: TScanCleanupOpenFile};
    getPdftoppmBinary: () => string;
    renderPage: TScanCleanupRenderPage;
    renderPagePpm: TScanCleanupRenderPage;
}


export function readScanCleanupPngDimensions(
    bytes: Uint8Array,
    maxPixels = SCAN_CLEANUP_RASTER_MAX_PIXELS,
    errorContext = 'raster',
) {
    const signature = [
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
    ];
    const hasIhdr = bytes[12] === 0x49
        && bytes[13] === 0x48
        && bytes[14] === 0x44
        && bytes[15] === 0x52;
    if (bytes.byteLength < 24 || !signature.every((value, index) => bytes[index] === value) || !hasIhdr) {
        throw new Error(`Scan cleanup ${errorContext} produced an invalid PNG`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (width < 1 || height < 1 || width * height > maxPixels) {
        throw new Error(`Scan cleanup ${errorContext} PNG dimensions ${width}x${height} exceed limits`);
    }
    return {
        width,
        height,
    };
}

function assertRasterDimensionsWithinLimits(
    dimensions: {
        width: number;
        height: number;
    },
    maxPixels: number | undefined,
    limits: IScanCleanupRasterRenderLimits | undefined,
    errorContext: string,
) {
    if (
        (maxPixels !== undefined && dimensions.width * dimensions.height > maxPixels)
        || (
            limits !== undefined
            && (
                dimensions.width > limits.maxDimensionPx
                || dimensions.height > limits.maxDimensionPx
                || dimensions.width * dimensions.height > limits.maxPixels
            )
        )
    ) {
        throw new Error(
            `Scan cleanup ${errorContext} dimensions ${dimensions.width}x${dimensions.height} exceed limits`,
        );
    }
    return dimensions;
}

export async function renderScanCleanupRasterToDisk(
    sourcePdfPath: string,
    pageNumber: number,
    outputPath: string,
    signal: AbortSignal,
    dependencies: IScanCleanupRasterRenderDependencies,
    log: TScanCleanupLog,
    renderDpi: number,
    maxPixels?: number,
    crop?: {
        x: number;
        y: number;
        width: number;
        height: number;
    },
    format: 'png' | 'ppm' = 'png',
    limits?: IScanCleanupRasterRenderLimits,
    errorContext = 'raster',
    pngErrorContext = 'raster',
    renderBox: Parameters<TScanCleanupRenderPage>[10] = 'cropbox',
) {
    await (format === 'ppm' ? dependencies.renderPagePpm : dependencies.renderPage)(
        {pdftoppmBinary: dependencies.getPdftoppmBinary()},
        log,
        pageNumber,
        sourcePdfPath,
        outputPath,
        renderDpi,
        undefined,
        signal,
        crop,
        limits,
        renderBox,
        'exclude',
    );
    if (format === 'ppm') {
        const dimensions = await readPpmDimensions(outputPath, dependencies.fileSystem.open);
        return assertRasterDimensionsWithinLimits(dimensions, maxPixels, limits, errorContext);
    }
    const handle = await dependencies.fileSystem.open(outputPath, 'r');
    try {
        const header = Buffer.alloc(24);
        const {bytesRead} = await handle.read(header, 0, header.byteLength, 0);
        if (bytesRead !== header.byteLength) {
            throw new Error(`Scan cleanup ${errorContext} produced a truncated PNG`);
        }
        const dimensions = readScanCleanupPngDimensions(
            header,
            Math.min(maxPixels ?? SCAN_CLEANUP_RASTER_MAX_PIXELS, limits?.maxPixels ?? SCAN_CLEANUP_RASTER_MAX_PIXELS),
            pngErrorContext,
        );
        return assertRasterDimensionsWithinLimits(dimensions, maxPixels, limits, errorContext);
    } finally {
        await handle.close();
    }
}
