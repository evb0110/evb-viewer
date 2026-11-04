const DEFAULT_MAX_RASTER_DIMENSION = 16_384;

export function resolveBoundedRasterDimensions(options: {
    width: number;
    height: number;
    maxPixels: number;
    maxDimension?: number;
}) {
    const maxDimension = options.maxDimension ?? DEFAULT_MAX_RASTER_DIMENSION;
    // Bound the unrounded shape so capped dimensions stay equal across zooms.
    const scale = Math.min(
        1,
        Math.sqrt(options.maxPixels / (options.width * options.height)),
        maxDimension / options.width,
        maxDimension / options.height,
    );
    let width = Math.max(1, Math.min(maxDimension, Math.round(options.width * scale)));
    let height = Math.max(1, Math.min(maxDimension, Math.round(options.height * scale)));
    // Correct rounding on the longer axis to retain the strict area budget.
    if (width * height > options.maxPixels) {
        if (height >= width) height = Math.max(1, Math.floor(options.maxPixels / width));
        else width = Math.max(1, Math.floor(options.maxPixels / height));
    }
    return {
        width,
        height,
        scale,
    };
}
