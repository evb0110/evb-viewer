import { readFile } from 'fs/promises';
import { deflateSync } from 'zlib';
import {
    PDFDocument,
    PDFName,
} from 'pdf-lib';

interface INetpbmData {
    width: number;
    height: number;
    channels: number;
    pixels: Uint8Array;
}

/**
 * Parse Netpbm binary formats: PGM (P5, grayscale) and PPM (P6, color).
 * Both formats share the same header structure; only pixel data layout differs.
 */
function parseNetpbm(data: Buffer): INetpbmData {
    const magic = (data[0]! << 8) | data[1]!;
    let channels: number;

    if (magic === 0x5035) {
        channels = 1; // P5 = PGM (grayscale)
    } else if (magic === 0x5036) {
        channels = 3; // P6 = PPM (RGB color)
    } else {
        throw new Error(`Unsupported Netpbm format (magic: 0x${magic.toString(16)})`);
    }

    let offset = 2;

    function skipWhitespaceAndComments() {
        while (offset < data.length) {
            const byte = data[offset]!;
            if (byte === 0x23) {
                while (offset < data.length && data[offset] !== 0x0A) offset++;
                offset++;
            } else if (byte === 0x20 || byte === 0x09 || byte === 0x0A || byte === 0x0D) {
                offset++;
            } else {
                break;
            }
        }
    }

    function readNumber() {
        skipWhitespaceAndComments();
        let numStr = '';
        while (offset < data.length) {
            const byte = data[offset]!;
            if (byte >= 0x30 && byte <= 0x39) {
                numStr += String.fromCharCode(byte);
                offset++;
            } else {
                break;
            }
        }
        return parseInt(numStr, 10);
    }

    const width = readNumber();
    const height = readNumber();
    const maxval = readNumber();

    // Skip exactly one whitespace byte after maxval (per Netpbm spec)
    offset++;

    if (maxval > 255) {
        throw new Error(`Unsupported maxval ${maxval} (only 8-bit supported)`);
    }

    const dataSize = width * height * channels;
    const pixels = new Uint8Array(data.buffer, data.byteOffset + offset, dataSize);

    return {
        width,
        height,
        channels,
        pixels, 
    };
}

/**
 * Check if RGB pixel data is actually grayscale (R==G==B for all sampled pixels).
 * Samples ~10,000 evenly-spaced pixels for fast detection.
 */
function isRgbDataGrayscale(pixels: Uint8Array, totalPixels: number) {
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
 * Only valid when R==G==B for all pixels (checked by isRgbDataGrayscale).
 */
function extractGrayscaleFromRgb(pixels: Uint8Array, totalPixels: number) {
    const gray = new Uint8Array(totalPixels);
    for (let i = 0; i < totalPixels; i++) {
        gray[i] = pixels[i * 3]!;
    }
    return gray;
}

/**
 * Apply PNG "Up" row filter: each byte = current - above (mod 256).
 * Prepends filter type byte (2) to each row.
 * Works on raw byte rows regardless of color depth.
 */
function applyUpFilter(pixels: Uint8Array, bytesPerRow: number, height: number) {
    const rowSize = 1 + bytesPerRow;
    const filtered = Buffer.alloc(height * rowSize);

    for (let y = 0; y < height; y++) {
        const outRow = y * rowSize;
        filtered[outRow] = 2; // Up filter type

        const srcRow = y * bytesPerRow;
        const prevRow = (y - 1) * bytesPerRow;

        for (let b = 0; b < bytesPerRow; b++) {
            const current = pixels[srcRow + b]!;
            const above = y > 0 ? pixels[prevRow + b]! : 0;
            filtered[outRow + 1 + b] = (current - above) & 0xFF;
        }
    }

    return filtered;
}

function createImageXObject(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    context: any,
    width: number,
    height: number,
    pixels: Uint8Array,
    isGrayscale: boolean,
) {
    const bytesPerRow = isGrayscale ? width : width * 3;
    const colors = isGrayscale ? 1 : 3;

    const filtered = applyUpFilter(pixels, bytesPerRow, height);
    const compressed = deflateSync(filtered);

    return context.register(
        context.stream(compressed, {
            Type: 'XObject',
            Subtype: 'Image',
            Width: width,
            Height: height,
            ColorSpace: isGrayscale ? 'DeviceGray' : 'DeviceRGB',
            BitsPerComponent: 8,
            Filter: 'FlateDecode',
            DecodeParms: {
                Predictor: 12,
                Colors: colors,
                BitsPerComponent: 8,
                Columns: width,
            },
        }),
    );
}

/**
 * Build an optimized PDF from Netpbm image files (PGM or PPM).
 *
 * - PGM input → DeviceGray (1 byte/pixel)
 * - PPM input where R==G==B → DeviceGray (auto-detected, 1 byte/pixel)
 * - PPM input with actual color → DeviceRGB (3 bytes/pixel, color preserved)
 */
export async function buildOptimizedPdf(
    imagePaths: string[],
    dpi: number,
    onPageProcessed?: (pageNum: number, totalPages: number) => void,
) {
    const doc = await PDFDocument.create();
    const context = doc.context;

    for (let i = 0; i < imagePaths.length; i++) {
        const fileData = await readFile(imagePaths[i]!);
        const {
            width,
            height,
            channels,
            pixels,
        } = parseNetpbm(fileData);

        const totalPixels = width * height;
        let isGrayscale: boolean;
        let imagePixels: Uint8Array;

        if (channels === 1) {
            // PGM: already grayscale
            isGrayscale = true;
            imagePixels = pixels;
        } else if (isRgbDataGrayscale(pixels, totalPixels)) {
            // PPM but actually grayscale — extract single channel
            isGrayscale = true;
            imagePixels = extractGrayscaleFromRgb(pixels, totalPixels);
        } else {
            // PPM with real color content
            isGrayscale = false;
            imagePixels = pixels;
        }

        const pageWidth = (width / dpi) * 72;
        const pageHeight = (height / dpi) * 72;

        const imageRef = createImageXObject(context, width, height, imagePixels, isGrayscale);
        const page = doc.addPage([
            pageWidth,
            pageHeight,
        ]);
        const imageName = page.node.newXObject('Img', imageRef);

        const ops = `q ${pageWidth.toFixed(4)} 0 0 ${pageHeight.toFixed(4)} 0 0 cm ${imageName} Do Q\n`;
        const contentRef = context.register(context.flateStream(ops));
        page.node.set(PDFName.of('Contents'), contentRef);

        onPageProcessed?.(i + 1, imagePaths.length);
    }

    return new Uint8Array(await doc.save());
}
