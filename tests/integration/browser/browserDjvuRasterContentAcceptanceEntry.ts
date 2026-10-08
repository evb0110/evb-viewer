// fallow-ignore-file unused-file -- bundled by browserDjvuRasterContentAcceptance.test.ts for Chromium.

import {
    PDFDict,
    PDFDocument,
    PDFName,
    PDFRawStream,
} from 'pdf-lib';
import {browserDocumentStore} from '@app/platform/browserDocumentStore';
import {
    runBrowserDjvuConversion,
    withBrowserDjvuWorker,
} from '@app/platform/browser-api/browserDjvuConversionPipeline';
import {requireJobId} from '@contracts/shared';

function countInkPixels(pixels: Uint8ClampedArray) {
    let count = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset]! < 200 || pixels[offset + 1]! < 200 || pixels[offset + 2]! < 200) {
            count += 1;
        }
    }
    return count;
}

async function readSavedScanPixels(bytes: Uint8Array) {
    const pdf = await PDFDocument.load(bytes);
    const counts: number[] = [];
    for (const page of pdf.getPages()) {
        const images = page.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
        if (!images) {
            throw new Error('Exported scan page has no image');
        }
        const image = images.values()
            .map(value => pdf.context.lookup(value))
            .find(value => value instanceof PDFRawStream
                && value.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
        if (!(image instanceof PDFRawStream)
            || image.dict.get(PDFName.of('Filter')) !== PDFName.of('DCTDecode')) {
            throw new Error('Compact scan page has no decodable JPEG image');
        }
        const bitmap = await createImageBitmap(new Blob(
            [new Uint8Array(image.getContents()).buffer],
            {type: 'image/jpeg'},
        ));
        try {
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const context = canvas.getContext('2d');
            if (!context) {
                throw new Error('Scan pixel canvas is unavailable');
            }
            context.drawImage(bitmap, 0, 0);
            counts.push(countInkPixels(context.getImageData(0, 0, canvas.width, canvas.height).data));
            document.body.append(canvas);
        } finally {
            bitmap.close();
        }
    }
    return counts;
}

async function installBrowserDjvuRasterContentAcceptance() {
    const response = await fetch('/fixtures/bitonal-faint-pencil.djvu');
    if (!response.ok) {
        throw new Error(`DjVu fixture failed to load: ${response.status}`);
    }
    const fixture = new Uint8Array(await response.arrayBuffer());
    const source = await browserDocumentStore.createStoredDocument('scan.djvu', fixture, {
        kind: 'source',
        retention: 'transient',
        mimeType: 'image/vnd.djvu',
        saveKind: 'generic',
    });
    const output = await browserDocumentStore.createStoredDocument('scan.pdf', new Uint8Array(), {
        kind: 'working',
        retention: 'transient',
        mimeType: 'application/pdf',
        saveKind: 'pdf',
    });
    const sourceInkPixels = await withBrowserDjvuWorker(source, async (worker) => {
        const counts: number[] = [];
        for (const page of [
            1,
            2,
        ]) {
            const decoded = await worker.doc.getPage(page).getImageData().run();
            if (!(decoded instanceof ImageData)) {
                throw new Error('DjVu decoder did not return browser ImageData');
            }
            counts.push(countInkPixels(decoded.data));
        }
        return counts;
    }, 'convert');
    document.body.innerHTML = '<button>Export compact PDF</button>';
    document.querySelector('button')!.addEventListener('click', (event) => {
        if (!event.isTrusted) {
            throw new Error('Scan export requires trusted input');
        }
        void (async () => {
            try {
                const result = await runBrowserDjvuConversion(source, output, {
                    jobId: requireJobId('browser-djvu-raster-content'),
                    pdfStrategy: 'compact-djvu-aware',
                    preserveBookmarks: false,
                });
                if (!result.success || !result.pdfPath) {
                    throw new Error(`Compact export failed: ${result.error ?? 'no PDF'}`);
                }
                const outputInkPixels = await readSavedScanPixels(await browserDocumentStore.read(result.pdfPath));
                Reflect.set(globalThis, '__evbDjvuRasterContentResult', {
                    sourceInkPixels,
                    outputInkPixels,
                    success: result.success,
                });
            } catch (error) {
                Reflect.set(globalThis, '__evbDjvuRasterContentResult', {error: String(error)});
            } finally {
                await browserDocumentStore.remove(output);
                await browserDocumentStore.remove(source);
            }
        })();
    });
}

Reflect.set(globalThis, '__evbInstallDjvuRasterContentAcceptance', installBrowserDjvuRasterContentAcceptance);
