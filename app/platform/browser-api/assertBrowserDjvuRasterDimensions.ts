import { SerializableError } from '@contracts/serializableError';

const BROWSER_DJVU_MAX_FULL_RESOLUTION_DECODE_PIXELS = 45_000_000;
const BROWSER_DJVU_MAX_FULL_RESOLUTION_EDGE = 32_768;

/**
 * Admits a DjVu page before its full-resolution raster is decoded. Malformed
 * geometry is an invalid DjVu; a valid page above the edge or pixel budget is a
 * resource limit, not damage. The message keeps the numbers for diagnostics.
 */
export function assertBrowserDjvuRasterDimensions(
    width: number,
    height: number,
    context = 'DjVu page',
) {
    if (
        !Number.isSafeInteger(width)
        || !Number.isSafeInteger(height)
        || width <= 0
        || height <= 0
    ) {
        throw new SerializableError({
            code: 'invalid-djvu',
            message: `${context} has invalid dimensions ${width}x${height}`,
        });
    }
    if (
        width > BROWSER_DJVU_MAX_FULL_RESOLUTION_EDGE
        || height > BROWSER_DJVU_MAX_FULL_RESOLUTION_EDGE
        || width > BROWSER_DJVU_MAX_FULL_RESOLUTION_DECODE_PIXELS / height
    ) {
        throw new SerializableError({
            code: 'djvu-raster-limit',
            message: `${context} (${width}x${height}) exceeds the browser full-resolution raster budget`
                + ` of ${BROWSER_DJVU_MAX_FULL_RESOLUTION_DECODE_PIXELS} pixels and ${BROWSER_DJVU_MAX_FULL_RESOLUTION_EDGE}px per edge`,
        });
    }
}
