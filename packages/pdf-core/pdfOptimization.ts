import type {
    IPdfOptimizeProgress,
    TPdfOptimizePreset,
} from '@contracts/electronApiDocuments';

/**
 * Optimize PDF's policy, shared by desktop and the browser: what each raster
 * preset renders, how it re-encodes pages and images, when a re-encoding is
 * worth keeping, how long each step may take, and how far the bar has moved.
 */

/**
 * How a raster preset re-encodes a page. Pages are rendered as Netpbm so the
 * image combiner, not the renderer, chooses the stored encoding: JPEG pages
 * are written as one gray channel when the render is gray, and black-and-white
 * pages are binarized with scan cleanup's illumination normalization and
 * Sauvola threshold and stored as lossless 1-bit.
 */
export type TRasterPageEncoding =
    | {
        kind: 'jpeg';
        quality: number;
        grayscale: boolean;
    }
    | {kind: 'black-and-white';};

/**
 * How a preset recompresses the JPEG images that pages draw, such as the
 * photos of a typeset book: each is shrunk to `dpi` at the largest size a
 * page shows it and encoded again at `quality`. Text and drawings around
 * them are not touched.
 */
export interface IPdfImageRecompression {
    dpi: number;
    quality: number;
}

export interface IPdfRasterOptimizePreset {
    dpi: number;
    encoding: TRasterPageEncoding;
    images: IPdfImageRecompression;
}

export const RASTER_PRESETS: Readonly<Record<Exclude<TPdfOptimizePreset, 'lossless'>, IPdfRasterOptimizePreset>> = {
    balancedScanned: {
        dpi: 200,
        encoding: {
            kind: 'jpeg',
            quality: 82,
            grayscale: false,
        },
        images: {
            dpi: 200,
            quality: 82,
        },
    },
    smallScanned: {
        dpi: 150,
        encoding: {
            kind: 'jpeg',
            quality: 60,
            grayscale: true,
        },
        images: {
            dpi: 150,
            quality: 60,
        },
    },
    blackAndWhite: {
        dpi: 300,
        encoding: {kind: 'black-and-white'},
        images: {
            dpi: 150,
            quality: 60,
        },
    },
};

/**
 * A page or image is re-encoded only when that saves at least a tenth of its
 * bytes: a smaller gain is not worth replacing its own image with a lossy one.
 */
export const MAX_BYTE_RATIO = 0.9;

/** Desktop renders ten pages per pdftoppm run; the browser renders one page per step. */
export const PDF_OPTIMIZE_RENDER_TIMEOUT_MS = 15 * 60 * 1000;
/** One image-combine encode of rendered pages. */
export const PDF_OPTIMIZE_ENCODE_TIMEOUT_MS = 5 * 60 * 1000;
/** One page-replacement or image-recompression pass over the document. */
export const PDF_OPTIMIZE_PASS_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The bar's share for each stage. Rendering and assembling pages is most of
 * the work and advances per page; placing the pages, the structure pass and
 * the validity check that follow have no count, so the dialog shows their
 * elapsed time instead.
 */
const OPTIMIZE_PAGE_WORK_PERCENT = 80;
const OPTIMIZE_RENDER_WEIGHT = 3;
const OPTIMIZE_ASSEMBLE_WEIGHT = 1;
const OPTIMIZE_STAGE_PERCENT = {
    preparing: 0,
    compressingImages: OPTIMIZE_PAGE_WORK_PERCENT,
    optimizing: 85,
    validating: 90,
    complete: 100,
} as const;

/** Pages rendered and assembled so far; they only grow, so the bar only moves forward. */
export interface IPdfOptimizePageWork {
    total: number;
    rendered: number;
    assembled: number;
}

/** Percent of the whole optimization, not of the current stage. */
export function resolvePdfOptimizePercent(
    phase: IPdfOptimizeProgress['phase'],
    pages?: IPdfOptimizePageWork,
) {
    if (phase !== 'rendering' && phase !== 'assembling') {
        return OPTIMIZE_STAGE_PERCENT[phase];
    }
    if (pages === undefined || pages.total <= 0) {
        return OPTIMIZE_STAGE_PERCENT.preparing;
    }
    const work = OPTIMIZE_RENDER_WEIGHT * pages.rendered + OPTIMIZE_ASSEMBLE_WEIGHT * pages.assembled;
    const totalWork = (OPTIMIZE_RENDER_WEIGHT + OPTIMIZE_ASSEMBLE_WEIGHT) * pages.total;
    return Math.min(OPTIMIZE_PAGE_WORK_PERCENT, Math.floor(OPTIMIZE_PAGE_WORK_PERCENT * work / totalWork));
}
