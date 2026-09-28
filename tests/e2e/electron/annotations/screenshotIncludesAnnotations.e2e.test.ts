import {
    copyFile, mkdtemp, writeFile,
} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
    createCanvas, loadImage,
} from '@napi-rs/canvas';
import {
    describe, expect, it, onTestFinished,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {createMultiPageTextFixturePdf} from '@tests/e2e/electron/helpers/fixtures';
import {
    clickAnnotationTool, createTextMarkupWithPointer, setAnnotationColor,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    clickVisibleToolbarButton, openPdfInApp, saveViaWindowHandle, waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    startElectronE2ESession, type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';

async function countAnnotationColourPixels(imagePath: string) {
    const image = await loadImage(imagePath);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let count = 0;
    let darkPixels = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
        const red = pixels[offset]!;
        const green = pixels[offset + 1]!;
        const blue = pixels[offset + 2]!;
        if (red > 110 && red > green * 1.4 && red > blue * 1.3) count += 1;
        if (red < 100 && green < 100 && blue < 100) darkPixels += 1;
    }
    return {
        count,
        darkPixels,
        width: image.width,
        height: image.height,
    };
}

describe('Electron E2E - screenshot annotation output', () => {
    const sessions = createElectronE2ESessionFixture({sessionName: () => `e2e-screenshot-annotation-${Date.now()}`});

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
        await saveViaWindowHandle(page);

        await session.stop();
        session = await startElectronE2ESession(`e2e-screenshot-annotation-reopen-${Date.now()}`, {clean: true});
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
        const screenPixels = await countAnnotationColourPixels(screenPath);
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
        await page.mouse.up();
        await page.waitForSelector('.snip-overlay.is-active', {
            hidden: true,
            timeout: 10_000,
        });

        const pngPath = join(evidenceDirectory, `clipboard-${Date.now()}.png`);
        const clipboardPng = execFileSync('xclip', [
            '-selection',
            'clipboard',
            '-t',
            'image/png',
            '-o',
        ], {maxBuffer: 16 * 1024 * 1024});
        await writeFile(pngPath, clipboardPng);
        const clipboardPixels = await countAnnotationColourPixels(pngPath);
        console.log(`SCREENSHOT_CLIPBOARD ${JSON.stringify({
            ...clipboardPixels,
            pngPath,
        })}`);
        expect(clipboardPixels.darkPixels, 'copied image still contains the page text').toBeGreaterThan(10);
        expect(clipboardPixels.count, 'copied image contains the visible red highlight').toBeGreaterThan(10);
    }, 90_000);
});
