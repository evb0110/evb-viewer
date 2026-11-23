/** The largest page a DjVu preview renders; larger pages are subsampled to it. */
export const DJVU_PREVIEW_MAX_PIXELS = 45_000_000;

// ddjvu, the PNG encoder and the read-back of its output, beyond the page's pixels.
const DJVU_PREVIEW_WORKING_BYTES = 64 * 1024 * 1024;

/**
 * Memory one preview holds at its peak: the encoder's decoded RGB page and its
 * PNG output, at most as large again and then read back whole, for the
 * largest page a preview renders, within the broker's memory.
 */
export function resolveDjvuPreviewResidentBytes(capacity: {estimatedResidentBytes: number}) {
    return Math.min(
        capacity.estimatedResidentBytes,
        2 * DJVU_PREVIEW_MAX_PIXELS * 3 + DJVU_PREVIEW_WORKING_BYTES,
    );
}
