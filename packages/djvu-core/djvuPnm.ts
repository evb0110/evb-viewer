import {
    DJVU_COMPACT_FOREGROUND_DOMINANT_NON_WHITE_MAX,
    type IDjvuCompactForegroundColor,
} from '@contracts/djvuConversionPolicy';

const asciiEncoder = new TextEncoder();

/** Wraps packed 1-bit MSB-first scanlines in a binary Netpbm PBM (`P4`) envelope. */
export function encodePbmP4(width: number, height: number, packedBits: Uint8Array): Uint8Array {
    const header = asciiEncoder.encode(`P4\n${width} ${height}\n`);
    const output = new Uint8Array(header.byteLength + packedBits.byteLength);
    output.set(header, 0);
    output.set(packedBits, header.byteLength);
    return output;
}

/** Wraps interleaved RGB24 scanlines in a binary Netpbm PPM (`P6`) envelope. */
export function encodePpmP6(width: number, height: number, rgbBytes: Uint8Array): Uint8Array {
    const header = asciiEncoder.encode(`P6\n${width} ${height}\n255\n`);
    const output = new Uint8Array(header.byteLength + rgbBytes.byteLength);
    output.set(header, 0);
    output.set(rgbBytes, header.byteLength);
    return output;
}

/**
 * Analyzes an interleaved RGB24 (or RGBA32) foreground raster rendered on white
 * to determine whether the foreground carries color that a black mask would lose.
 */
export function analyzeForegroundColorRaster(
    pixels: Uint8Array,
    width: number,
    height: number,
    channels: 3 | 4 = 3,
): IDjvuCompactForegroundColor | null {
    const totalPixels = width * height;
    if (totalPixels <= 0) {
        return null;
    }
    let nonWhitePixels = 0;
    let coloredPixels = 0;
    let weightSum = 0;
    let redSum = 0;
    let greenSum = 0;
    let blueSum = 0;

    for (let index = 0; index < totalPixels; index += 1) {
        const offset = index * channels;
        const red = pixels[offset] ?? 255;
        const green = pixels[offset + 1] ?? 255;
        const blue = pixels[offset + 2] ?? 255;
        const min = Math.min(red, green, blue);
        const max = Math.max(red, green, blue);
        if (red < 245 || green < 245 || blue < 245) {
            nonWhitePixels += 1;
            if (max - min > 12) {
                coloredPixels += 1;
            }
            if (max < DJVU_COMPACT_FOREGROUND_DOMINANT_NON_WHITE_MAX) {
                const weight = 255 - max;
                weightSum += weight;
                redSum += red * weight;
                greenSum += green * weight;
                blueSum += blue * weight;
            }
        }
    }

    const dominantColor: [number, number, number] = weightSum > 0
        ? [
            Math.round(redSum / weightSum),
            Math.round(greenSum / weightSum),
            Math.round(blueSum / weightSum),
        ]
        : [
            0,
            0,
            0,
        ];

    return {
        dominantColor,
        colorRatio: coloredPixels / Math.max(1, nonWhitePixels),
    };
}
