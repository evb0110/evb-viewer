import { SerializableError } from '@contracts/serializableError';
import { canAllocateDjvuCanvas } from '@app/platform/browser-api/browserDjvuCanvas';

function djvuRasterLimit(message: string) {
    return new SerializableError({
        code: 'djvu-raster-limit',
        message,
    });
}

/**
 * Admits a DjVu page to the browser decoder. Malformed geometry is an invalid
 * DjVu. Any valid page decodes: memory bounds it, and a page that does not fit
 * fails its allocation, which the caller reports as the page's limit.
 */
export function assertBrowserDjvuDecodableDimensions(
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
}

/**
 * Admits a page whose full-resolution raster passes through one canvas, as an
 * exported page image does. The canvas limit is the browser's own, measured
 * by allocating a canvas of that size.
 */
export function assertBrowserDjvuRasterDimensions(
    width: number,
    height: number,
    context = 'DjVu page',
) {
    assertBrowserDjvuDecodableDimensions(width, height, context);
    if (!canAllocateDjvuCanvas(width, height)) {
        throw djvuRasterLimit(`${context} (${width}x${height}) is larger than the largest canvas this browser can allocate`);
    }
}

/**
 * Reports a decode that ran out of memory as the page's raster limit, keeping
 * the decoder's message for diagnostics. DjVu.js rejects with plain objects
 * from its worker, so the message is read structurally.
 */
export function toBrowserDjvuDecodeError(error: unknown, width: number, height: number, context: string) {
    const message = typeof error === 'object' && error !== null && typeof Reflect.get(error, 'message') === 'string'
        ? String(Reflect.get(error, 'message'))
        : String(error);
    if (error instanceof RangeError || /out of memory|allocation failed|invalid array length|invalid typed array length/iu.test(message)) {
        return djvuRasterLimit(`${context} (${width}x${height}) did not fit in browser memory: ${message}`);
    }
    return error;
}
