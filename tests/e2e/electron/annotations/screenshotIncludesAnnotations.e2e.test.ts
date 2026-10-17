import {createHash} from 'node:crypto';
import {
    copyFile, mkdir, mkdtemp, readFile, rm, writeFile,
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
    PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFHexString,
} from 'pdf-lib';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {E2E_CONTENT_SIZE} from '@tests/e2e/electron/helpers/userEnvironment';
import {
    createMultiPageTextFixturePdf, createCanonicalAnnotationSurfaceFixturePdf,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    clickAnnotationTool, createTextMarkupWithPointer, setAnnotationColor,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    clickVisibleToolbarButton, openPdfInApp, saveViaVisibleToolbar, saveViaWindowHandle, waitForPdfLoaded, waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    clickAsUser, revealForPointer,
} from '@tests/e2e/electron/helpers/userInput';

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
        onTestFinished(() => rm(directory, {
            recursive: true,
            force: true,
        }));
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
        onTestFinished(() => rm(evidenceDirectory, {
            recursive: true,
            force: true,
        }));
        const generated = await createMultiPageTextFixturePdf(`screenshot-annotation-${Date.now()}.pdf`, 1);
        const path = join(evidenceDirectory, `annotated-source-${Date.now()}.pdf`);
        await copyFile(generated, path);
        let session = sessions.getSession();
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

        session = await sessions.restart({
            hard: true,
            sessionName: `e2e-screenshot-annotation-reopen-${Date.now()}`,
            clean: true,
            // Chromium's lazy ClipboardItem rejects getType() once the clipboard
            // sequence number moves after read(). On X11 this Chromium bumps it
            // again when the echo of its own write arrives, so a read right
            // after the copy can fail with "Clipboard data has changed". Eager
            // reads take the bytes during read() and check the same PNG.
            extraEnv: {EVB_AUTOMATION_EXTRA_CHROMIUM_SWITCHES: '--disable-blink-features=ReadClipboardDataOnClipboardItemGetType'},
        });
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
        await clickAsUser(page, '[data-capture-confirm]');
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
    it('copies the composed multilingual view without saving accepted edits or changing Undo', async () => {
        async function retainEvidence(files: Record<string, Uint8Array | string>) {
            const evidenceDirectory = process.env.EVB_R3_EVIDENCE_DIR;
            if (!evidenceDirectory) return;
            await mkdir(evidenceDirectory, {recursive: true});
            await Promise.all(Object.entries(files).map(([
                name,
                bytes,
            ]) => writeFile(join(evidenceDirectory, name), bytes)));
        }

        const directory = await mkdtemp(join(tmpdir(), 'evb-composed-screenshot-'));
        onTestFinished(() => rm(directory, {
            recursive: true,
            force: true,
        }));
        const generated = await createCanonicalAnnotationSurfaceFixturePdf(`composed-screenshot-${Date.now()}.pdf`);
        const pdf = await PDFDocument.load(await readFile(generated));
        const sheet = pdf.getPage(0);
        const annotations = sheet.node.lookup(PDFName.of('Annots'), PDFArray);
        annotations.lookup(0, PDFDict).set(PDFName.of('Contents'), PDFHexString.fromText('Fresh Ελληνικά Ж مرحبا'));
        const font = sheet.node.Resources()!.lookup(PDFName.of('Font'), PDFDict).entries()[0]![1];
        const appearance = pdf.context.register(pdf.context.flateStream(
            'q 0 0 1 RG 2 w [3 2] 0 d 1 1 158 33 re S BT /F1 12 Tf 0 0 0 rg 8 12 Td (Foreign AP unique glyphs) Tj ET Q',
            {
                Type: 'XObject',
                Subtype: 'Form',
                BBox: [
                    0,
                    0,
                    160,
                    35,
                ],
                Resources: {Font: {F1: font}},
            },
        ));
        annotations.push(pdf.context.register(pdf.context.obj({
            Type: 'Annot',
            Subtype: 'FreeText',
            Rect: [
                72,
                420,
                232,
                455,
            ],
            NM: PDFHexString.fromText('foreign-dashed-ap'),
            Contents: PDFHexString.fromText('Foreign AP unique glyphs'),
            DA: '/Helvetica 12 Tf 1 0 0 rg',
            BS: {
                S: 'D',
                W: 2,
                D: [
                    3,
                    2,
                ],
            },
            AP: {N: appearance},
            F: 4,
        })));
        const path = join(directory, 'composed-source.pdf');
        const original = Buffer.from(await pdf.save({useObjectStreams: false}));
        await writeFile(path, original);
        const session = await sessions.restart({
            hard: true,
            extraEnv: {EVB_AUTOMATION_EXTRA_CHROMIUM_SWITCHES: '--disable-blink-features=ReadClipboardDataOnClipboardItemGetType'},
        });
        const {page} = session;
        await openPdfInApp(page, path);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await page.waitForSelector('.editor-pane.is-active [data-annotation-kind="text-box"]');
        await page.evaluate(() => document.fonts.ready);
        await clickAnnotationTool(page, 'Draw');
        await setAnnotationColor(page, '#ef4444');
        const pageBox = await page.$eval('.editor-pane.is-active .page_container[data-page="1"]', element => {
            const box = element.getBoundingClientRect();
            const viewport = document.querySelector('.editor-pane.is-active #pdf-viewer')!.getBoundingClientRect();
            return {
                x: Math.ceil(Math.max(box.left, viewport.left) + 2),
                y: Math.ceil(Math.max(box.top, viewport.top) + 2),
                right: Math.floor(Math.min(box.right, viewport.right) - 2),
                bottom: Math.floor(Math.min(box.bottom, viewport.bottom) - 2),
            };
        });
        const x = pageBox.x + (pageBox.right - pageBox.x) * 0.48;
        const y = pageBox.y + (pageBox.bottom - pageBox.y) * 0.44;
        const shapesBefore = await page.$$eval('.editor-pane.is-active .pdf-annotation-editor-layer g[data-annotation-kind="shape"]', elements => elements.length);
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 65, y + 20, {steps: 8});
        await page.mouse.move(x + 105, y - 10, {steps: 8});
        await page.mouse.up();
        await page.waitForFunction(count => document.querySelectorAll('.editor-pane.is-active .pdf-annotation-editor-layer g[data-annotation-kind="shape"]').length === count + 1, {}, shapesBefore);
        await clickAnnotationTool(page, 'Select');
        await clickVisibleToolbarButton(page, 'Screenshot');
        await page.waitForSelector('.snip-overlay.is-active');
        const entryBytes = await readFile(path);
        await retainEvidence({
            'original.pdf': original,
            'entry-actual.pdf': entryBytes,
            'entry-bytes.json': JSON.stringify({
                originalBytes: original.byteLength,
                entryBytes: entryBytes.byteLength,
                originalSha256: createHash('sha256').update(original).digest('hex'),
                entrySha256: createHash('sha256').update(entryBytes).digest('hex'),
                equal: original.equals(entryBytes),
                checkpoint: 'after trusted Screenshot entry and existing overlay, before confirmation lookup',
            }, null, 2),
        });
        expect(await readFile(path), 'Screenshot entry leaves original bytes unchanged').toEqual(original);
        await page.keyboard.press('Escape');
        await page.waitForSelector('.snip-overlay.is-active', {hidden: true});
        await clickVisibleToolbarButton(page, 'Screenshot');
        await page.waitForSelector('.snip-overlay.is-active');
        await page.mouse.move(pageBox.x, pageBox.y);
        await page.mouse.down();
        await page.mouse.move(pageBox.right, pageBox.bottom, {steps: 10});
        await page.mouse.up();
        await page.waitForSelector('[data-capture-confirm]');
        const clip = await page.$eval('.snip-selection', element => {
            const box = element.getBoundingClientRect();
            return {
                x: box.left,
                y: box.top,
                width: box.width,
                height: box.height,
            };
        });
        const hostSelector = '.editor-pane.is-active [data-pdf-viewer-host]';
        const reference = await page.evaluateHandle(selector => {
            const host = document.querySelector<HTMLElement>(selector);
            const overlay = host?.querySelector<HTMLElement>('.snip-overlay');
            const viewer = host?.closest<HTMLElement>('[data-document-viewer-chassis-viewport]');
            const selection = overlay?.querySelector<HTMLElement>('.snip-selection');
            if (!host || !overlay || !viewer || !selection) throw new Error('The initiating reference capture view is unavailable');
            const clean = host.classList.contains('is-capture-clean');
            const overlayClean = overlay.classList.contains('is-clean');
            const visibility = overlay.style.visibility;
            const assertCurrent = () => {
                if (!host.isConnected || !overlay.isConnected || !selection.isConnected
                    || document.querySelector(selector) !== host
                    || host.querySelector('.snip-overlay') !== overlay
                    || overlay.querySelector('.snip-selection') !== selection) {
                    throw new Error('Reference capture removed or replaced the initiating Screenshot selection');
                }
            };
            host.classList.add('is-capture-clean');
            overlay.classList.add('is-clean');
            return {
                read: () => {
                    assertCurrent();
                    return {
                        width: innerWidth,
                        height: innerHeight,
                        dpr: devicePixelRatio,
                        viewport: visualViewport ? {
                            width: visualViewport.width,
                            height: visualViewport.height,
                            offsetLeft: visualViewport.offsetLeft,
                            offsetTop: visualViewport.offsetTop,
                        } : null,
                    };
                },
                restore: () => {
                    try {assertCurrent();} finally {
                        try {host.classList.toggle('is-capture-clean', clean);} finally {
                            try {overlay.classList.toggle('is-clean', overlayClean);} finally {overlay.style.visibility = visibility;}
                        }
                    }
                },
            };
        }, hostSelector);
        const decode = async (bytes: Uint8Array) => {
            const image = await loadImage(Buffer.from(bytes));
            const canvas = createCanvas(image.width, image.height);
            const context = canvas.getContext('2d');
            context.drawImage(image, 0, 0);
            return {
                width: image.width,
                height: image.height,
                pixels: Buffer.from(context.getImageData(0, 0, image.width, image.height).data),
            };
        };
        let expected!: Awaited<ReturnType<typeof decode>>;
        let screen!: Uint8Array;
        const referenceFailures: unknown[] = [];
        try {
            await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
            const cleanState = await reference.evaluate(value => value.read());
            const viewport = cleanState.viewport;
            const left = viewport?.offsetLeft ?? 0;
            const top = viewport?.offsetTop ?? 0;
            expect(clip.x).toBeGreaterThanOrEqual(left);
            expect(clip.y).toBeGreaterThanOrEqual(top);
            expect(clip.x + clip.width).toBeLessThanOrEqual(left + (viewport?.width ?? cleanState.width));
            expect(clip.y + clip.height).toBeLessThanOrEqual(top + (viewport?.height ?? cleanState.height));
            const fullScreen = await page.screenshot({captureBeyondViewport: false});
            await retainEvidence({'clean-screen-full.png': fullScreen});
            const full = await decode(fullScreen);
            expect([
                full.width,
                full.height,
                cleanState.dpr,
            ]).toEqual([
                E2E_CONTENT_SIZE.width,
                E2E_CONTENT_SIZE.height,
                1,
            ]);
            expect(Object.values(clip).every(Number.isInteger)).toBe(true);
            // The product decodes its capture in Chromium, so the reference is
            // decoded there too; Node canvas rounds ICC conversion differently.
            const browserReference = await page.evaluate(async ({
                bytes,
                rect,
            }) => {
                const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], {type: 'image/png'}));
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = bitmap.width;
                    canvas.height = bitmap.height;
                    const context = canvas.getContext('2d')!;
                    context.drawImage(bitmap, 0, 0);
                    const region = context.getImageData(rect.x, rect.y, rect.width, rect.height);
                    const crop = document.createElement('canvas');
                    crop.width = rect.width;
                    crop.height = rect.height;
                    crop.getContext('2d')!.putImageData(region, 0, 0);
                    const png = await new Promise<Blob>(resolve => crop.toBlob(value => resolve(value!), 'image/png'));
                    return {
                        png: Array.from(new Uint8Array(await png.arrayBuffer())),
                        rgba: Array.from(region.data),
                    };
                } finally {
                    bitmap.close();
                }
            }, {
                bytes: Array.from(fullScreen),
                rect: clip,
            });
            screen = Buffer.from(browserReference.png);
            await retainEvidence({'clean-screen.png': screen});
            expected = await decode(screen);
            const fullCrop = Buffer.from(browserReference.rgba);
            await retainEvidence({'reference-crop.json': JSON.stringify({
                full: {
                    width: full.width,
                    height: full.height,
                    sha256: createHash('sha256').update(fullScreen).digest('hex'),
                },
                sourceRect: clip,
                destinationRect: {
                    x: 0,
                    y: 0,
                    width: clip.width,
                    height: clip.height,
                },
                dpr: cleanState.dpr,
                croppedSha256: createHash('sha256').update(screen).digest('hex'),
                fullRegionRgbaSha256: createHash('sha256').update(fullCrop).digest('hex'),
                croppedRgbaSha256: createHash('sha256').update(expected.pixels).digest('hex'),
                exactIntegerCrop: expected.pixels.equals(fullCrop),
            }, null, 2)});
            expect(expected.pixels.equals(fullCrop), 'integer crop preserves every reference RGBA byte without resizing').toBe(true);
            expect({
                width: expected.width,
                height: expected.height,
            }, 'reference retains the exact frozen clip at physical density').toEqual({
                width: clip.width * cleanState.dpr,
                height: clip.height * cleanState.dpr,
            });
        } catch (error) {
            referenceFailures.push(error);
        } finally {
            try {await reference.evaluate(value => value.restore());} catch (error) {referenceFailures.push(error);}
            try {await reference.dispose();} catch (error) {referenceFailures.push(error);}
        }
        for (const failure of referenceFailures.slice(1)) onTestFinished(() => {throw failure;});
        if (referenceFailures.length) throw referenceFailures[0];
        await clickAsUser(page, '[data-capture-confirm]');
        await page.waitForSelector('.snip-overlay.is-active', {
            hidden: true,
            timeout: 10000,
        });
        const clipboard = Buffer.from(await page.evaluate(async () => {
            const item = (await navigator.clipboard.read()).find(value => value.types.includes('image/png'));
            if (!item) throw new Error('Clipboard PNG is missing');
            return Array.from(new Uint8Array(await (await item.getType('image/png')).arrayBuffer()));
        }));
        const actual = await decode(clipboard);
        await writeFile(join(directory, 'screen.png'), screen);
        await writeFile(join(directory, 'clipboard.png'), clipboard);
        console.log(`COMPOSED_SCREENSHOT ${JSON.stringify({
            clip,
            dpr: await page.evaluate(() => devicePixelRatio),
            width: actual.width,
            height: actual.height,
            pixelsEqual: actual.pixels.equals(expected.pixels),
        })}`);
        const copyBytes = await readFile(path);
        await retainEvidence({
            'clean-screen.png': screen,
            'clipboard.png': clipboard,
            'copy-actual.pdf': copyBytes,
            'decoded-metrics.json': JSON.stringify({
                clip,
                dpr: await page.evaluate(() => devicePixelRatio),
                expected: {
                    width: expected.width,
                    height: expected.height,
                    sha256: createHash('sha256').update(expected.pixels).digest('hex'),
                },
                actual: {
                    width: actual.width,
                    height: actual.height,
                    sha256: createHash('sha256').update(actual.pixels).digest('hex'),
                },
                pixelsEqual: actual.pixels.equals(expected.pixels),
                originalBytes: original.byteLength,
                copyBytes: copyBytes.byteLength,
                originalSha256: createHash('sha256').update(original).digest('hex'),
                copySha256: createHash('sha256').update(copyBytes).digest('hex'),
            }, null, 2),
        });
        expect({
            width: actual.width,
            height: actual.height,
        }).toEqual({
            width: expected.width,
            height: expected.height,
        });
        expect(actual.pixels.equals(expected.pixels), 'clipboard preserves full glyph silhouettes, note, Link border and foreign AP once').toBe(true);
        expect(await readFile(path), 'copy leaves original bytes unchanged').toEqual(original);
        expect(await page.$$eval('.editor-pane.is-active .pdf-annotation-editor-note', elements => elements.length)).toBe(1);
        expect(await page.$$eval('.editor-pane.is-active .linkAnnotation', elements => elements.length)).toBe(1);
        await clickVisibleToolbarButton(page, 'Undo');
        await page.waitForFunction(count => document.querySelectorAll('.editor-pane.is-active .pdf-annotation-editor-layer g[data-annotation-kind="shape"]').length === count, {}, shapesBefore);
        await clickVisibleToolbarButton(page, 'Redo');
        await page.waitForFunction(count => document.querySelectorAll('.editor-pane.is-active .pdf-annotation-editor-layer g[data-annotation-kind="shape"]').length === count + 1, {}, shapesBefore);
        expect(await readFile(path)).toEqual(original);
        const afterUndoRedo = await readFile(path);
        await retainEvidence({
            'after-undo-redo.pdf': afterUndoRedo,
            'undo-redo.json': JSON.stringify({
                originalSha256: createHash('sha256').update(original).digest('hex'),
                actualSha256: createHash('sha256').update(afterUndoRedo).digest('hex'),
                shapesBefore,
                shapesAfterRedo: await page.$$eval('.editor-pane.is-active .pdf-annotation-editor-layer g[data-annotation-kind="shape"]', elements => elements.length),
            }, null, 2),
        });
    }, 90000);

});
