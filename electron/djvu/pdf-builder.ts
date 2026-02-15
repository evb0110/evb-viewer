import { readFile } from 'fs/promises';
import { deflateSync } from 'zlib';
import {
    PDFDocument,
    PDFName,
    type PDFContext,
    type PDFRef,
} from 'pdf-lib';
import {
    applyUpFilter,
    extractGrayscaleFromRgb,
    isRgbDataGrayscale,
    parseNetpbm,
} from '@electron/djvu/netpbm';

function createImageXObject(
    context: PDFContext,
    width: number,
    height: number,
    pixels: Uint8Array,
    isGrayscale: boolean,
): PDFRef {
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
