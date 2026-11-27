import {
    DJVU_COMPACT_FOREGROUND_SUBSAMPLE,
    DJVU_COMPACT_REAL_MASK_MIN_BYTES,
    getDjvuCompactFidelity,
    hasDjvuCompactForegroundColor,
    isDjvuCompactFlatBackground,
    measureDjvuCompactRasterStats,
    type TDjvuCompactFidelityPreset,
} from '@contracts/djvuConversionPolicy';
import type {IBrowserPdfCombineWasmPageSpec} from '@contracts/browserPdfCombineWorker';
import {encodePpmP6} from '@djvu-core/djvuPnm';
import type {IDjvuWorker} from '@app/platform/browser-api/browserDjvuWorkerClient';
import {toBrowserDjvuDecodeError} from '@app/platform/browser-api/assertBrowserDjvuRasterDimensions';
import {renderDjvuPageAsPpm, throwIfDjvuCanceled, type IDjvuPageMetrics} from '@app/platform/browser-api/browserDjvuRasterizer';

export type TBrowserDjvuCompactRoute = 'mask' | 'layered' | 'photo';

export interface IBrowserDjvuCompactPage {
    route: TBrowserDjvuCompactRoute;
    spec: IBrowserPdfCombineWasmPageSpec;
}

function pointsFromPixels(pixels: number, dpi: number) {
    return Math.max(1, (pixels / Math.max(1, dpi)) * 72);
}

function pageFileName(pageNumber: number, layer: string, extension: string) {
    return `page-${String(pageNumber).padStart(5, '0')}-${layer}.${extension}`;
}

/**
 * Builds one page of a compact DjVu export from its layers, by the routes
 * desktop's compact export takes (buildCompactDjvuAwarePdfFromDjvu):
 *
 * - no real JB2 mask, or a colored foreground a black mask would lose: the
 *   rendered page as a photo at the preset's resolution and quality;
 * - a mask with no background, or a flat one: the mask alone;
 * - otherwise the background at its own resolution under the mask.
 *
 * Mask and layered pages carry no rotation in the WASM page spec, so a
 * rotated page is kept as a photo, which is rendered upright.
 */
export async function buildBrowserDjvuCompactPage(
    worker: IDjvuWorker,
    pageNumber: number,
    pageMetrics: IDjvuPageMetrics,
    preset: TDjvuCompactFidelityPreset,
    signal?: AbortSignal,
): Promise<IBrowserDjvuCompactPage> {
    throwIfDjvuCanceled(signal);
    const fidelity = getDjvuCompactFidelity(preset);
    const width = pageMetrics.width ?? 0;
    const height = pageMetrics.height ?? 0;
    const context = `DjVu page ${pageNumber}`;
    let layers;
    try {
        layers = await worker.getPageLayerSummary(pageNumber, DJVU_COMPACT_FOREGROUND_SUBSAMPLE);
    } catch (error) {
        throw toBrowserDjvuDecodeError(error, width, height, context);
    }
    throwIfDjvuCanceled(signal);
    const photo = async (): Promise<IBrowserDjvuCompactPage> => {
        const rendered = await renderDjvuPageAsPpm(worker, pageNumber, pageMetrics, fidelity.ppiCap, signal);
        return {
            route: 'photo',
            spec: {
                kind: 'image',
                pageSize: rendered.pageSize,
                jpegQuality: fidelity.photoQuality,
                ppiCap: fidelity.ppiCap,
                image: rendered.input,
            },
        };
    };
    if (
        !layers ||
        layers.rotation !== 0 ||
        layers.maskChunkBytes === null ||
        layers.maskChunkBytes < DJVU_COMPACT_REAL_MASK_MIN_BYTES ||
        (layers.foreground && hasDjvuCompactForegroundColor(layers.foreground))
    ) {
        return photo();
    }

    const pageSize = {
        widthPoints: pointsFromPixels(layers.width, layers.dpi),
        heightPoints: pointsFromPixels(layers.height, layers.dpi),
    };
    const maskBytes = await worker.renderMaskPbm(pageNumber);
    throwIfDjvuCanceled(signal);
    if (!maskBytes) {
        return photo();
    }
    const mask = {
        fileName: pageFileName(pageNumber, 'mask', 'pbm'),
        data: maskBytes,
    };
    const background = layers.hasBackground ? await worker.renderBackgroundRgb(pageNumber) : null;
    throwIfDjvuCanceled(signal);
    if (!background || isDjvuCompactFlatBackground(measureDjvuCompactRasterStats(background.rgb, background.width, background.height, 3))) {
        return {
            route: 'mask',
            spec: {
                kind: 'mask',
                pageSize,
                mask,
            },
        };
    }
    return {
        route: 'layered',
        spec: {
            kind: 'layered',
            pageSize,
            jpegQuality: fidelity.backgroundQuality,
            background: {
                fileName: pageFileName(pageNumber, 'background', 'ppm'),
                data: encodePpmP6(background.width, background.height, background.rgb),
            },
            mask,
        },
    };
}
