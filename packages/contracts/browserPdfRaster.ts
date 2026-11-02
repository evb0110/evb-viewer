import * as v from 'valibot';

/**
 * A PDF page raster painted on the UI thread and assembled in a worker: tiles
 * of at most this many pixels a side, in row-major order. A large page is
 * painted in tiles because one canvas of its size can exceed the browser's
 * canvas limits; the worker reads the tiles back into one raster.
 */
export const BROWSER_PDF_RENDER_TILE_PX = 4096;

export interface IBrowserPdfRasterTiles {
    width: number;
    height: number;
    tiles: ImageBitmap[];
}

/** Painted tiles of a raster within the receiving engine's pixel limits. */
export function createBrowserPdfRasterTilesSchema(maxPixels: number, maxDimensionPx: number) {
    return v.pipe(v.object({
        width: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(maxDimensionPx)),
        height: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(maxDimensionPx)),
        tiles: v.array(v.custom<ImageBitmap>(value => typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap)),
    }), v.check(({
        width, height, tiles,
    }) => {
        const columns = Math.ceil(width / BROWSER_PDF_RENDER_TILE_PX);
        return width * height <= maxPixels
            && tiles.length === columns * Math.ceil(height / BROWSER_PDF_RENDER_TILE_PX)
            && tiles.every((tile, index) => tile.width === Math.min(BROWSER_PDF_RENDER_TILE_PX, width - index % columns * BROWSER_PDF_RENDER_TILE_PX)
                && tile.height === Math.min(BROWSER_PDF_RENDER_TILE_PX, height - Math.floor(index / columns) * BROWSER_PDF_RENDER_TILE_PX));
    })) satisfies v.GenericSchema<unknown, IBrowserPdfRasterTiles>;
}
