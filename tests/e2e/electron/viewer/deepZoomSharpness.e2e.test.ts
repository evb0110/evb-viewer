import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    mkdir,
    writeFile,
} from 'node:fs/promises';
import {
    join,
    resolve,
} from 'node:path';
import {decode as decodePng} from 'fast-png';
import {
    PDFDocument,
    rgb,
} from 'pdf-lib';
import type {Page} from 'puppeteer-core';
import {startConfiguredElectronE2ESession} from '@tests/e2e/electron/helpers/startConfiguredElectronE2ESession';
import type {IElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {createFixturePath} from '@tests/e2e/electron/helpers/fixtures';
import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
import {
    openPdfInApp,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';

const E2E_TIMEOUT_MS = 180_000;
const SETTLE_TIMEOUT_MS = 60_000;
const DETAIL_WAIT_MS = 3_000;
// A3: at 1000 % and output scale 1 the whole page asks for ~1.0e8 pixels, far
// over the low tier's 2^24 settled cap, so the page raster keeps ~0.41 of the
// linear resolution.
const PAGE_WIDTH_PT = 842;
const PAGE_HEIGHT_PT = 1191;
const GRATING_MARGIN_PT = 40;
const TARGET_ZOOM_PERCENT = 1000;
// One toolbar zoom step below the target and also far over the cap. The page
// width there is not a whole number of pixels.
const STEP_FROM_ZOOM_PERCENT = 975;

interface IMeasureRegion {
    left: number;
    top: number;
    width: number;
    height: number;
}

/**
 * Vertical bars two device pixels wide at the target zoom, across almost the
 * whole page, so the viewport shows the grating wherever the zoom anchor lands.
 */
async function createBarGratingPdf(devicePixelRatio: number) {
    const barWidthPt = 2 / (TARGET_ZOOM_PERCENT / 100) / devicePixelRatio;
    const document = await PDFDocument.create();
    const page = document.addPage([
        PAGE_WIDTH_PT,
        PAGE_HEIGHT_PT,
    ]);
    for (let x = GRATING_MARGIN_PT; x + barWidthPt <= PAGE_WIDTH_PT - GRATING_MARGIN_PT; x += 2 * barWidthPt) {
        page.drawRectangle({
            x,
            y: GRATING_MARGIN_PT,
            width: barWidthPt,
            height: PAGE_HEIGHT_PT - (2 * GRATING_MARGIN_PT),
            color: rgb(0, 0, 0),
        });
    }
    const path = createFixturePath(`deep-zoom-grating-${Date.now()}.pdf`);
    await writeFile(path, await document.save());
    return path;
}

async function zoomToPercentAsUser(page: Page, percent: number) {
    await clickAsUser(page, {
        find: () => Array.from(document.querySelectorAll<HTMLElement>('.zoom-controls-display'))
            .find(candidate => candidate.getBoundingClientRect().width > 0 && !(candidate as HTMLButtonElement).disabled),
        arg: null,
        description: 'visible zoom display',
    });
    await page.waitForSelector('.zoom-chip-custom-input', {visible: true});
    await clickAsUser(page, '.zoom-chip-custom-input');
    // Control+A moves the caret to the line start on macOS.
    const selectAllModifier = process.platform === 'darwin' ? 'MetaLeft' : 'ControlLeft';
    await page.keyboard.down(selectAllModifier);
    await page.keyboard.press('KeyA');
    await page.keyboard.up(selectAllModifier);
    await page.keyboard.type(String(percent));
    await page.keyboard.press('Enter');
    await page.waitForFunction(
        (expected: string) => document.querySelector('.zoom-controls-display-value')?.textContent?.trim() === expected,
        {timeout: SETTLE_TIMEOUT_MS},
        `${String(percent)}%`,
    );
}

async function zoomInOneStepAsUser(page: Page, expectedPercent: number) {
    await clickAsUser(page, {
        find: () => Array.from(document.querySelectorAll<HTMLButtonElement>('.zoom-controls-item--display + .zoom-controls-item button'))
            .find(candidate => candidate.getBoundingClientRect().width > 0 && !candidate.disabled),
        arg: null,
        description: 'visible zoom-in button',
    });
    await page.waitForFunction(
        (expected: string) => document.querySelector('.zoom-controls-display-value')?.textContent?.trim() === expected,
        {timeout: SETTLE_TIMEOUT_MS},
        `${String(expectedPercent)}%`,
    );
}

async function waitForSettledPage(page: Page, percent = TARGET_ZOOM_PERCENT) {
    await page.waitForFunction((cssWidth: number) => {
        const container = document.querySelector<HTMLElement>('.page_container[data-page="1"]');
        const surface = container?.querySelector<HTMLElement>('.page_canvas');
        return container?.classList.contains('page_container--rendered') === true
            && container.dataset.pageRaster === 'current'
            && Math.abs((surface?.getBoundingClientRect().width ?? 0) - cssWidth) < 1;
    }, {timeout: SETTLE_TIMEOUT_MS}, PAGE_WIDTH_PT * percent / 100);
}

/** The part of the grating inside the viewer, inset so no edge pixel counts. */
async function readGratingRegion(page: Page): Promise<IMeasureRegion & {baseDensity: number}> {
    return page.evaluate((geometry: {
        width: number;
        margin: number
    }) => {
        const surface = document.querySelector<HTMLElement>('.page_container[data-page="1"] .page_canvas');
        let viewer = surface?.parentElement ?? null;
        while (viewer && !/(auto|scroll)/u.test(getComputedStyle(viewer).overflowY)) viewer = viewer.parentElement;
        const canvas = surface?.querySelector<HTMLCanvasElement>('.page_canvas__render-layer > canvas');
        if (!surface || !viewer || !canvas) throw new Error('Page 1 surface was not found');
        const page = surface.getBoundingClientRect();
        const viewerRect = viewer.getBoundingClientRect();
        const cssPerPt = page.width / geometry.width;
        const left = Math.max(page.left + (geometry.margin * cssPerPt), viewerRect.left + viewer.clientLeft) + 8;
        const right = Math.min(page.right - (geometry.margin * cssPerPt), viewerRect.left + viewer.clientLeft + viewer.clientWidth) - 8;
        const top = Math.max(page.top + (geometry.margin * cssPerPt), viewerRect.top + viewer.clientTop) + 8;
        const bottom = Math.min(page.bottom - (geometry.margin * cssPerPt), viewerRect.top + viewer.clientTop + viewer.clientHeight) - 8;
        return {
            left: Math.ceil(left),
            top: Math.ceil(top),
            width: Math.floor(right - left),
            height: Math.floor(bottom - top),
            baseDensity: canvas.width / (page.width * window.devicePixelRatio),
        };
    }, {
        width: PAGE_WIDTH_PT,
        margin: GRATING_MARGIN_PT,
    });
}

async function waitForDetailCanvasCovering(page: Page, region: IMeasureRegion) {
    // Readiness tracks only the page raster, and the constrained policy holds
    // detail work for an input-idle window, so wait for the detail canvas
    // itself. Without one the wait ends and the pixels decide. A detail
    // stretched from an earlier zoom does not count.
    await page.waitForFunction((target: IMeasureRegion) => {
        const canvases = document.querySelectorAll<HTMLCanvasElement>('.page_container[data-page="1"] .page_canvas__detail-layer > canvas');
        const canvas = canvases[canvases.length - 1];
        const rect = canvas?.getBoundingClientRect();
        return Boolean(canvas?.isConnected && rect
            && Math.abs((canvas.width / (rect.width * window.devicePixelRatio)) - 1) < 0.01
            && rect.left <= target.left && rect.top <= target.top
            && rect.right >= target.left + target.width && rect.bottom >= target.top + target.height);
    }, {timeout: DETAIL_WAIT_MS}, region).catch(() => undefined);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** Share of device pixels dark enough to belong to a resolved bar. */
async function measureResolvedBarShare(page: Page, region: IMeasureRegion, evidencePath: string) {
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    const png = await page.screenshot({
        path: evidencePath,
        type: 'png',
    });
    const image = decodePng(png);
    const channels = image.channels;
    const x0 = Math.round(region.left * dpr);
    const y0 = Math.round(region.top * dpr);
    const width = Math.round(region.width * dpr);
    const height = Math.round(region.height * dpr);
    let dark = 0;
    let light = 0;
    let total = 0;
    for (let y = y0; y < y0 + height; y += 4) {
        for (let x = x0; x < x0 + width; x += 1) {
            const offset = ((y * image.width) + x) * channels;
            const luminance = ((0.2126 * image.data[offset]!) + (0.7152 * image.data[offset + 1]!) + (0.0722 * image.data[offset + 2]!)) / 255;
            if (luminance < 0.15) dark += 1;
            if (luminance > 0.85) light += 1;
            total += 1;
        }
    }
    return {
        darkShare: dark / total,
        lightShare: light / total,
    };
}

/**
 * The same shares read from the topmost detail raster's own pixels over the
 * region, with that raster's device pixels per CSS pixel over the output
 * scale: 1 for a detail painted at the current zoom, the zoom ratio for one
 * stretched from the previous step. A just-committed canvas can be missing
 * from the next captured frames while software compositing uploads it, so a
 * screenshot can show the earlier detail stretched by the zoom step.
 */
async function measureDetailRasterBarShare(page: Page, region: IMeasureRegion) {
    return page.evaluate((target: IMeasureRegion) => {
        const canvases = document.querySelectorAll<HTMLCanvasElement>('.page_container[data-page="1"] .page_canvas__detail-layer > canvas');
        const canvas = canvases[canvases.length - 1];
        const context = canvas?.getContext('2d');
        if (!canvas || !context) return {
            darkShare: 0,
            lightShare: 0,
            resolution: 0,
        };
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const x0 = Math.round((target.left - rect.left) * scaleX);
        const y0 = Math.round((target.top - rect.top) * scaleY);
        const width = Math.min(Math.round(target.width * scaleX), canvas.width - x0);
        const height = Math.min(Math.round(target.height * scaleY), canvas.height - y0);
        const data = context.getImageData(x0, y0, width, height).data;
        let dark = 0;
        let light = 0;
        let total = 0;
        for (let y = 0; y < height; y += 4) {
            for (let x = 0; x < width; x += 1) {
                const offset = ((y * width) + x) * 4;
                const luminance = ((0.2126 * data[offset]!) + (0.7152 * data[offset + 1]!) + (0.0722 * data[offset + 2]!)) / 255;
                if (luminance < 0.15) dark += 1;
                if (luminance > 0.85) light += 1;
                total += 1;
            }
        }
        return {
            darkShare: dark / total,
            lightShare: light / total,
            resolution: canvas.width / (rect.width * window.devicePixelRatio),
        };
    }, region);
}

describe('Electron E2E - deep zoom sharpness', () => {
    let session: IElectronE2ESession | null = null;

    afterEach(async () => {
        await session?.stop();
        session = null;
    });

    it('paints the visible part of a capped page at full resolution after a toolbar zoom', async () => {
        session = await startConfiguredElectronE2ESession(`e2e-deep-zoom-sharpness-${Date.now()}`, 'low');
        const {page} = session;
        const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
        await openPdfInApp(page, await createBarGratingPdf(devicePixelRatio));
        await waitForViewerInteractive(page);

        await zoomToPercentAsUser(page, TARGET_ZOOM_PERCENT);
        await waitForSettledPage(page);
        const region = await readGratingRegion(page);
        expect(region.width).toBeGreaterThan(100);
        expect(region.height).toBeGreaterThan(100);
        await waitForDetailCanvasCovering(page, region);

        const evidenceDir = resolve('.devkit/deep-zoom-sharpness', session.name);
        await mkdir(evidenceDir, {recursive: true});
        const evidencePath = join(evidenceDir, 'deep-zoom-1000.png');
        const shares = await measureResolvedBarShare(page, region, evidencePath);
        console.info(`[deep-zoom] dpr=${String(devicePixelRatio)} baseDensity=${region.baseDensity.toFixed(3)} darkShare=${shares.darkShare.toFixed(3)} lightShare=${shares.lightShare.toFixed(3)} evidence=${evidencePath}`);
        // Each bar spans two device pixels, so a resolved grating has at least
        // a quarter of its pixels near black and near white at any alignment.
        expect(region.baseDensity).toBeLessThan(0.6);
        expect(shares.darkShare).toBeGreaterThan(0.2);
        expect(shares.lightShare).toBeGreaterThan(0.2);
    }, E2E_TIMEOUT_MS);

    it('keeps the capped page raster across a zoom step and repaints only the detail', async () => {
        session = await startConfiguredElectronE2ESession(`e2e-deep-zoom-step-${Date.now()}`, 'low');
        const {page} = session;
        const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
        await openPdfInApp(page, await createBarGratingPdf(devicePixelRatio));
        await waitForViewerInteractive(page);
        await zoomToPercentAsUser(page, STEP_FROM_ZOOM_PERCENT);
        await waitForSettledPage(page, STEP_FROM_ZOOM_PERCENT);
        await waitForDetailCanvasCovering(page, await readGratingRegion(page));
        const pageCanvas = await page.evaluateHandle(() => {
            const canvas = document.querySelector<HTMLCanvasElement>('.page_container[data-page="1"] .page_canvas__render-layer > canvas');
            if (!canvas) throw new Error('Page 1 canvas was not found');
            return canvas;
        });
        const before = await pageCanvas.evaluate(canvas => `${String(canvas.width)}x${String(canvas.height)}`);

        await zoomInOneStepAsUser(page, TARGET_ZOOM_PERCENT);
        await waitForSettledPage(page);
        const region = await readGratingRegion(page);
        await waitForDetailCanvasCovering(page, region);
        const after = await pageCanvas.evaluate(canvas => ({
            kept: canvas === document.querySelector('.page_container[data-page="1"] .page_canvas__render-layer > canvas'),
            size: `${String(canvas.width)}x${String(canvas.height)}`,
        }));

        const evidenceDir = resolve('.devkit/deep-zoom-sharpness', session.name);
        await mkdir(evidenceDir, {recursive: true});
        const evidencePath = join(evidenceDir, 'deep-zoom-step-1000.png');
        await page.screenshot({
            path: evidencePath,
            type: 'png',
        });
        const shares = await measureDetailRasterBarShare(page, region);
        console.info(`[deep-zoom-step] before=${String(before)} after=${String(after.size)} kept=${String(after.kept)} resolution=${shares.resolution.toFixed(3)} darkShare=${shares.darkShare.toFixed(3)} lightShare=${shares.lightShare.toFixed(3)} evidence=${evidencePath}`);
        // Both zoom levels ask for far more than the cap, so a new page raster
        // would paint the same pixels at the same size.
        expect(region.baseDensity).toBeLessThan(0.6);
        expect(after.size).toBe(before);
        expect(after.kept).toBe(true);
        expect(shares.resolution).toBeGreaterThan(0.99);
        expect(shares.resolution).toBeLessThan(1.01);
        expect(shares.darkShare).toBeGreaterThan(0.2);
        expect(shares.lightShare).toBeGreaterThan(0.2);
    }, E2E_TIMEOUT_MS);
});
