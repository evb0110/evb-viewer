import {
    copyFile, mkdtemp, readFile, writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
    createCanvas, loadImage,
} from '@napi-rs/canvas';
import {
    describe, expect, it, onTestFinished,
} from 'vitest';
import {
    PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber,
} from 'pdf-lib';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {createMultiPageTextFixturePdf} from '@tests/e2e/electron/helpers/fixtures';
import {
    clickAnnotationTool, createTextMarkupWithPointer, setAnnotationColor,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    clickVisibleToolbarButton, openPdfInApp, saveViaVisibleToolbar, saveViaWindowHandle, waitForPdfLoaded, waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    clickAsUser, revealForPointer,
} from '@tests/e2e/electron/helpers/userInput';
import {
    startElectronE2ESession, type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';

async function countAnnotationColourPixels(
    imagePath: string,
    redReference?: {
        blue: number;
        green: number;
        red: number;
    },
) {
    const image = await loadImage(imagePath);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let count = 0;
    let darkPixels = 0;
    let bluePixels = 0;
    const matchedRed: Array<{
        blue: number;
        green: number;
        red: number;
    }> = [];
    for (let offset = 0; offset < pixels.length; offset += 4) {
        const red = pixels[offset]!;
        const green = pixels[offset + 1]!;
        const blue = pixels[offset + 2]!;
        const redMatch = redReference
            ? Math.hypot(red - redReference.red, green - redReference.green, blue - redReference.blue) <= 55
            : red > 110 && red > green * 1.4 && red > blue * 1.3;
        if (redMatch) {
            count += 1;
            matchedRed.push({
                blue,
                green,
                red,
            });
        }
        if (red < 100 && green < 100 && blue < 100) darkPixels += 1;
        if (blue > 100 && blue > red * 1.4 && blue > green * 1.15) bluePixels += 1;
    }
    matchedRed.sort((left, right) => left.green - right.green);
    const medianRed = matchedRed[Math.floor(matchedRed.length / 2)];
    return {
        count,
        darkPixels,
        bluePixels,
        redReference: medianRed ? {
            red: medianRed.red,
            green: medianRed.green,
            blue: medianRed.blue,
        } : undefined,
        width: image.width,
        height: image.height,
    };
}

describe('Electron E2E - screenshot annotation output', () => {
    const sessions = createElectronE2ESessionFixture({sessionName: () => `e2e-screenshot-annotation-${Date.now()}`});

    it('keeps text readable under an opaque imported Highlight after recolour and reopen', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-opaque-highlight-'));
        const path = join(directory, 'imported.pdf');
        const pdf = await PDFDocument.create();
        const sheet = pdf.addPage([
            612,
            792,
        ]);
        sheet.drawText('Hydration review selectable highlighted text', {
            x: 40,
            y: 740,
            size: 16,
            font: await pdf.embedFont('Helvetica'),
        });
        sheet.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Highlight',
            Rect: [
                40,
                736,
                354,
                758,
            ],
            QuadPoints: [
                40,
                758,
                354,
                758,
                40,
                736,
                354,
                736,
            ],
            C: [
                1,
                1,
                0,
            ],
            CA: 1,
            F: 4,
        }))]));
        await writeFile(path, await pdf.save());
        let {page} = sessions.getSession();
        await openPdfInApp(page, path);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await clickAnnotationTool(page, 'Select');
        await clickAsUser(page, '.editor-pane.is-active [data-markup-subtype="Highlight"] [data-annotation-hit-target]');
        await clickAsUser(page, '[data-annotation-inspector][data-target="selection"] .swatch[aria-label="#ef4444"]');
        await saveViaVisibleToolbar(page, 30_000, path);
        const saved = await PDFDocument.load(await readFile(path));
        const annotation = saved.context.lookup(
            saved.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).get(0), PDFDict,
        );
        expect(annotation.lookup(PDFName.of('CA'), PDFNumber).asNumber()).toBe(1);
        const colour = annotation.lookup(PDFName.of('C'), PDFArray);
        for (const [
            index,
            value,
        ] of [
                239 / 255,
                68 / 255,
                68 / 255,
            ].entries()) {
            expect(colour.lookup(index, PDFNumber).asNumber()).toBeCloseTo(value, 5);
        }
        ({page} = await sessions.restart({hard: true}));
        await openPdfInApp(page, path);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await clickAnnotationTool(page, 'Select');
        await revealForPointer(page, '.editor-pane.is-active [data-markup-subtype="Highlight"] [data-annotation-hit-target]');
        const clip = await page.$eval('.editor-pane.is-active [data-markup-subtype="Highlight"] [data-annotation-hit-target]', element => {
            const rect = element.getBoundingClientRect();
            return {
                x: Math.ceil(rect.x + 2),
                y: Math.ceil(rect.y + 2),
                width: Math.floor(rect.width - 4),
                height: Math.floor(rect.height - 4),
            };
        });
        const underlyingGlyphs = await page.$eval('.editor-pane.is-active .page_container[data-page="1"] canvas', (element, region) => {
            if (!(element instanceof HTMLCanvasElement)) throw new Error('Page canvas is missing');
            const canvas = element;
            const rect = canvas.getBoundingClientRect();
            const pixels = canvas.getContext('2d')!.getImageData(
                (region.x - rect.x) * canvas.width / rect.width,
                (region.y - rect.y) * canvas.height / rect.height,
                region.width * canvas.width / rect.width,
                region.height * canvas.height / rect.height,
            ).data;
            let count = 0;
            for (let offset = 0; offset < pixels.length; offset += 4) {
                if (pixels[offset]! < 100 && pixels[offset + 1]! < 100 && pixels[offset + 2]! < 100) count += 1;
            }
            return count * rect.width / canvas.width * rect.height / canvas.height;
        }, clip);
        const screenPath = join(directory, 'reopened.png');
        await page.screenshot({
            path: screenPath,
            clip,
        });
        const visible = await countAnnotationColourPixels(screenPath);
        console.log(`OPAQUE_HIGHLIGHT_PIXELS ${JSON.stringify({
            underlyingGlyphs,
            ...visible,
            screenPath,
        })}`);
        expect(underlyingGlyphs, 'the covered region contains actual rendered text').toBeGreaterThan(100);
        expect(visible.count, 'the imported red fill is still visible').toBeGreaterThan(100);
        expect(visible.darkPixels, 'the fill preserves the underlying dark glyphs').toBeGreaterThan(underlyingGlyphs * 0.9);
    }, 90_000);

    it('copies the visible annotation colour into the screenshot clipboard image', async () => {
        const evidenceDirectory = await mkdtemp(join(tmpdir(), 'evb-screenshot-annotations-'));
        const generated = await createMultiPageTextFixturePdf(`screenshot-annotation-${Date.now()}.pdf`, 1);
        const path = join(evidenceDirectory, `annotated-source-${Date.now()}.pdf`);
        await copyFile(generated, path);
        let session: IElectronE2ESession = sessions.getSession();
        let {page} = session;
        await openPdfInApp(page, path);
        await waitForPdfLoaded(page);
        await clickAnnotationTool(page, 'Highlight');
        await setAnnotationColor(page, '#ef4444');
        await createTextMarkupWithPointer(page, 'Highlight');
        await page.waitForSelector('.pdf-annotation-editor-layer g[data-annotation-kind="text-markup"]');
        await clickAnnotationTool(page, 'Rectangle');
        await setAnnotationColor(page, '#3b82f6');
        const markupBounds = await page.$eval('.pdf-annotation-editor-layer g[data-annotation-kind="text-markup"]', element => {
            const rect = element.getBoundingClientRect();
            return {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
            };
        });
        await page.mouse.move(markupBounds.left - 8, markupBounds.top - 8);
        await page.mouse.down();
        await page.mouse.move(markupBounds.right + 8, markupBounds.bottom + 8, {steps: 8});
        await page.mouse.up();
        await page.waitForSelector('.pdf-annotation-editor-layer g[data-annotation-kind="shape"]');
        await saveViaWindowHandle(page);

        await session.stop();
        session = await startElectronE2ESession(`e2e-screenshot-annotation-reopen-${Date.now()}`, {
            clean: true,
            // Chromium's lazy ClipboardItem rejects getType() once the clipboard
            // sequence number moves after read(). On X11 this Chromium bumps it
            // again when the echo of its own write arrives, so a read right
            // after the copy can fail with "Clipboard data has changed". Eager
            // reads take the bytes during read() and check the same PNG.
            extraEnv: {EVB_AUTOMATION_EXTRA_CHROMIUM_SWITCHES: '--disable-blink-features=ReadClipboardDataOnClipboardItemGetType'},
        });
        onTestFinished(async () => { await session.stop(); });
        page = session.page;
        await openPdfInApp(page, path);
        await waitForPdfLoaded(page);
        await page.waitForSelector('.pdf-annotation-editor-layer g[data-annotation-kind="text-markup"]');
        const annotationBox = await page.$eval('.pdf-annotation-editor-layer g[data-annotation-kind="text-markup"]', element => {
            const rect = element.getBoundingClientRect();
            return {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
            };
        });
        expect(annotationBox.right - annotationBox.left).toBeGreaterThan(40);
        const screenPath = join(evidenceDirectory, `visible-annotation-${Date.now()}.png`);
        await writeFile(screenPath, await page.screenshot({clip: {
            x: Math.max(0, Math.floor(annotationBox.left)),
            y: Math.max(0, Math.floor(annotationBox.top)),
            width: Math.ceil(annotationBox.right - annotationBox.left),
            height: Math.ceil(annotationBox.bottom - annotationBox.top),
        }}));
        const opacity = await page.$eval('.pdf-annotation-editor-layer g[data-annotation-kind="text-markup"]', element =>
            Number(getComputedStyle(element).getPropertyValue('--annotation-opacity')));
        expect(opacity).toBeGreaterThan(0);
        // The fixture page is white. Count its actual fill colour instead of
        // the red glyph-edge tint produced by ordinary alpha compositing.
        const screenPixels = await countAnnotationColourPixels(screenPath, {
            red: 255 + (239 - 255) * opacity,
            green: 255 + (68 - 255) * opacity,
            blue: 255 + (68 - 255) * opacity,
        });
        console.log(`ANNOTATION_SCREEN ${JSON.stringify({
            ...screenPixels,
            screenPath,
        })}`);
        expect(screenPixels.count, 'the same region on screen visibly contains the red annotation').toBeGreaterThan(10);
        await clickVisibleToolbarButton(page, 'Screenshot');
        await page.waitForSelector('.snip-overlay.is-active', {visible: true});
        const start = {
            x: annotationBox.left - 20,
            y: annotationBox.top - 20,
        };
        const end = {
            x: annotationBox.right + 20,
            y: annotationBox.bottom + 20,
        };
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(end.x, end.y, {steps: 10});
        const selection = await page.$eval('.snip-selection', element => {
            const rect = element.getBoundingClientRect();
            return {
                width: rect.width,
                height: rect.height,
            };
        });
        expect(selection.width).toBeGreaterThan(40);
        expect(selection.height).toBeGreaterThan(10);
        const captureStartedAt = performance.now();
        await page.mouse.up();
        await page.waitForSelector('.snip-overlay.is-active', {
            hidden: true,
            timeout: 10_000,
        });

        const pngPath = join(evidenceDirectory, `clipboard-${Date.now()}.png`);
        const clipboardPng = Buffer.from(await page.evaluate(async () => {
            const item = (await navigator.clipboard.read()).find(candidate => candidate.types.includes('image/png'));
            if (!item) throw new Error('The clipboard holds no PNG image');
            return Array.from(new Uint8Array(await (await item.getType('image/png')).arrayBuffer()));
        }));
        console.log(`SCREENSHOT_CAPTURE_LATENCY_MS ${Math.round(performance.now() - captureStartedAt)}`);
        await writeFile(pngPath, clipboardPng);
        const clipboardPixels = await countAnnotationColourPixels(pngPath, screenPixels.redReference);
        console.log(`SCREENSHOT_CLIPBOARD ${JSON.stringify({
            ...clipboardPixels,
            pngPath,
        })}`);
        expect(clipboardPixels.darkPixels, 'copied image still contains the page text').toBeGreaterThan(10);
        expect(clipboardPixels.count, 'copied image contains the visible red highlight').toBeGreaterThan(10);
        expect(clipboardPixels.bluePixels, 'copied image contains the saved rectangle appearance').toBeGreaterThan(10);
    }, 90_000);
});
