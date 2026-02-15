interface INetpbmData {
    width: number;
    height: number;
    channels: 1 | 3;
    pixels: Uint8Array;
}

function isWhitespaceByte(byte: number) {
    return byte === 0x20 || byte === 0x09 || byte === 0x0A || byte === 0x0D;
}

/**
 * Parse Netpbm binary formats: PGM (P5, grayscale) and PPM (P6, color).
 */
export function parseNetpbm(data: Buffer): INetpbmData {
    if (data.length < 4) {
        throw new Error('Netpbm payload is too short');
    }

    const magic = data.toString('ascii', 0, 2);
    let channels: 1 | 3;
    if (magic === 'P5') {
        channels = 1;
    } else if (magic === 'P6') {
        channels = 3;
    } else {
        throw new Error(`Unsupported Netpbm format: ${magic}`);
    }

    let offset = 2;

    function skipWhitespaceAndComments() {
        while (offset < data.length) {
            const byte = data[offset]!;
            if (byte === 0x23) {
                while (offset < data.length && data[offset] !== 0x0A) {
                    offset += 1;
                }
                offset += 1;
                continue;
            }
            if (isWhitespaceByte(byte)) {
                offset += 1;
                continue;
            }
            return;
        }
    }

    function readNumber(label: string) {
        skipWhitespaceAndComments();
        if (offset >= data.length) {
            throw new Error(`Missing ${label} in Netpbm header`);
        }

        let numStr = '';
        while (offset < data.length) {
            const byte = data[offset]!;
            if (byte >= 0x30 && byte <= 0x39) {
                numStr += String.fromCharCode(byte);
                offset += 1;
                continue;
            }
            break;
        }

        if (numStr.length === 0) {
            throw new Error(`Invalid ${label} in Netpbm header`);
        }

        const value = Number.parseInt(numStr, 10);
        if (!Number.isFinite(value)) {
            throw new Error(`Invalid ${label} in Netpbm header`);
        }
        return value;
    }

    const width = readNumber('width');
    const height = readNumber('height');
    const maxval = readNumber('maxval');

    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
        throw new Error(`Invalid Netpbm dimensions: ${width}x${height}`);
    }
    if (!Number.isInteger(maxval) || maxval <= 0 || maxval > 255) {
        throw new Error(`Unsupported maxval ${maxval} (only 8-bit supported)`);
    }

    if (offset >= data.length || !isWhitespaceByte(data[offset]!)) {
        throw new Error('Invalid Netpbm header terminator');
    }
    offset += 1;

    const dataSize = width * height * channels;
    if (!Number.isSafeInteger(dataSize) || dataSize <= 0) {
        throw new Error('Invalid Netpbm payload size');
    }
    if (offset + dataSize > data.length) {
        throw new Error(`Truncated Netpbm payload (expected ${dataSize} bytes)`);
    }

    return {
        width,
        height,
        channels,
        pixels: new Uint8Array(data.buffer, data.byteOffset + offset, dataSize),
    };
}

/**
 * Check if RGB pixel data is actually grayscale (R==G==B for sampled pixels).
 */
export function isRgbDataGrayscale(pixels: Uint8Array, totalPixels: number) {
    const step = Math.max(1, Math.floor(totalPixels / 10000));

    for (let i = 0; i < totalPixels; i += step) {
        const off = i * 3;
        if (pixels[off] !== pixels[off + 1] || pixels[off] !== pixels[off + 2]) {
            return false;
        }
    }

    return true;
}

/**
 * Extract the red channel from RGB data as grayscale.
 */
export function extractGrayscaleFromRgb(pixels: Uint8Array, totalPixels: number) {
    const gray = new Uint8Array(totalPixels);
    for (let i = 0; i < totalPixels; i += 1) {
        gray[i] = pixels[i * 3]!;
    }
    return gray;
}

/**
 * Apply PNG "Up" row filter and prepend filter byte per row.
 */
export function applyUpFilter(pixels: Uint8Array, bytesPerRow: number, height: number) {
    const rowSize = 1 + bytesPerRow;
    const filtered = Buffer.alloc(height * rowSize);

    for (let y = 0; y < height; y += 1) {
        const outRow = y * rowSize;
        filtered[outRow] = 2;

        const srcRow = y * bytesPerRow;
        const prevRow = (y - 1) * bytesPerRow;

        for (let b = 0; b < bytesPerRow; b += 1) {
            const current = pixels[srcRow + b]!;
            const above = y > 0 ? pixels[prevRow + b]! : 0;
            filtered[outRow + 1 + b] = (current - above) & 0xFF;
        }
    }

    return filtered;
}
