import {
    BROWSER_PDF_RENDER_TILE_PX,
    type IBrowserPdfRasterTiles,
} from '@contracts/browserPdfRaster';
import {
    createPpmRaster, writePpmTile,
} from '@ocr-core/ppmRaster';

/**
 * Reads painted tiles back into one RGB-on-white binary PPM, in the worker
 * that consumes the raster, and closes them. Engines read PPM without image
 * codecs, as desktop's engines read Poppler's PPM output.
 */
export function assembleBrowserPdfRasterPpm(image: IBrowserPdfRasterTiles) {
    const ppm = createPpmRaster(image.width, image.height);
    const canvas = new OffscreenCanvas(1, 1);
    const columns = Math.ceil(image.width / BROWSER_PDF_RENDER_TILE_PX);
    try {
        image.tiles.forEach((tile, index) => {
            canvas.width = tile.width;
            canvas.height = tile.height;
            const context = canvas.getContext('2d', {willReadFrequently: true});
            if (!context) throw new Error('Raster canvas context is unavailable');
            context.drawImage(tile, 0, 0);
            writePpmTile(ppm, image.width, context.getImageData(0, 0, tile.width, tile.height).data,
                index % columns * BROWSER_PDF_RENDER_TILE_PX, Math.floor(index / columns) * BROWSER_PDF_RENDER_TILE_PX, tile.width, tile.height);
            tile.close();
        });
        return ppm.image;
    } finally {
        image.tiles.forEach(tile => tile.close());
        canvas.width = canvas.height = 0;
    }
}
