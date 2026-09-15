export function resolveBoundedRasterDimensions(options: {
    width: number;
    height: number;
    maxPixels: number;
    maxDimension: number;
}) {
    const requestedWidth = Math.max(1, Math.round(options.width));
    const requestedHeight = Math.max(1, Math.round(options.height));
    const scale = Math.min(
        1,
        Math.sqrt(options.maxPixels / (requestedWidth * requestedHeight)),
        options.maxDimension / requestedWidth,
        options.maxDimension / requestedHeight,
    );
    return {
        width: Math.max(1, Math.floor(requestedWidth * scale)),
        height: Math.max(1, Math.floor(requestedHeight * scale)),
        scale,
    };
}
