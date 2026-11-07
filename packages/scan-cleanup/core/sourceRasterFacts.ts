/**
 * The source raster facts desktop and browser share, one row per painted
 * image as `pdfimages -list` reports it. Mask rows carry their parent image's
 * object number.
 */
import {
    isScanCleanupCompactLayeredRaster,
    type IDetectedPageRaster,
    type ISourceDpiDetectionResult,
} from '@evb/scan-cleanup/core/types';

export interface IScanCleanupRasterRow {
    pageNumber: number;
    type: string;
    width: number;
    height: number;
    bitsPerComponent: number;
    objectId: number;
    xPpi: number;
    yPpi: number;
}

export interface IPageRasterDetectionResult {
    documentDpi: number | null;
    rasterByPage: Map<number, IDetectedPageRaster>;
}

export function reduceScanCleanupRasterRows(rows: Iterable<IScanCleanupRasterRow>): IPageRasterDetectionResult {
    const rasterByPage = new Map<number, IDetectedPageRaster>();
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
    for (const {
        pageNumber, type, width, height, bitsPerComponent, objectId, xPpi, yPpi,
    } of rows) {
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

        const dominant = rasterByPage.get(pageNumber);
        const dominantArea = dominant === undefined ? 0 : dominant.width * dominant.height;
        if (pixelArea > dominantArea || (pixelArea === dominantArea && dpi > dominant!.dpi)) {
            rasterByPage.set(pageNumber, {
                dpi,
                width,
                height,
            });
        }
    }
    for (const pageNumber of bilevelPages) {
        const raster = rasterByPage.get(pageNumber);
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
        rasterByPage,
    });
}

function withDerivedPageDpi(
    result: IPageRasterDetectionResult,
): IPageRasterDetectionResult {
    let documentDpi = 0;
    for (const [
        , raster,
    ] of result.rasterByPage) {
        documentDpi = Math.max(documentDpi, raster.dpi);
    }
    return {
        documentDpi: documentDpi > 0 ? documentDpi : result.documentDpi,
        rasterByPage: result.rasterByPage,
    };
}


export function toScanCleanupPageRasterSource(
    result: IPageRasterDetectionResult,
    compactLayeredPageCountComplete: boolean,
): ISourceDpiDetectionResult {
    let compactLayeredPageCount = 0;
    for (const raster of result.rasterByPage.values()) {
        if (isScanCleanupCompactLayeredRaster(raster)) compactLayeredPageCount += 1;
    }
    return {
        detected: result.rasterByPage.size > 0,
        documentDpi: result.documentDpi,
        compactLayeredPageCount,
        compactLayeredPageCountComplete,
        getPageRaster: pageNumber => result.rasterByPage.get(pageNumber),
    };
}
