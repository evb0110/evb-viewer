import {afterEach, describe, expect, it} from 'vitest';
import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {decode as decodePng} from 'fast-png';
import {PDFDocument, rgb} from 'pdf-lib';
import type {Page} from 'puppeteer-core';
import type {IE2EWindow} from '@tests/e2e/electron/helpers/e2EWindow';
import {startConfiguredElectronE2ESession} from '@tests/e2e/electron/helpers/startConfiguredElectronE2ESession';
import type {IElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {createFixturePath} from '@tests/e2e/electron/helpers/fixtures';
import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
import {openDjvuInApp, openPdfInApp, waitForViewerInteractive} from '@tests/e2e/electron/helpers/viewerCore';

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
    const page = document.addPage([PAGE_WIDTH_PT, PAGE_HEIGHT_PT]);
    for (let x = GRATING_MARGIN_PT; x + barWidthPt <= PAGE_WIDTH_PT - GRATING_MARGIN_PT; x += 2 * barWidthPt) {
        page.drawRectangle({
            x,
            y: GRATING_MARGIN_PT,
            width: barWidthPt,
            height: PAGE_HEIGHT_PT - 2 * GRATING_MARGIN_PT,
            color: rgb(0, 0, 0),
        });
    }
    const path = createFixturePath(`deep-zoom-grating-${Date.now()}.pdf`);
    await writeFile(path, await document.save());
    return path;
}

async function zoomToPercentAsUser(page: Page, percent: number) {
    await clickAsUser(page, {
        find: () =>
            Array.from(document.querySelectorAll<HTMLElement>('.zoom-controls-display')).find(
                (candidate) => candidate.getBoundingClientRect().width > 0 && !(candidate as HTMLButtonElement).disabled,
            ),
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
        find: () =>
            Array.from(document.querySelectorAll<HTMLButtonElement>('.zoom-controls-item--display + .zoom-controls-item button')).find(
                (candidate) => candidate.getBoundingClientRect().width > 0 && !candidate.disabled,
            ),
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
    await page.waitForFunction(
        (cssWidth: number) => {
            const container = document.querySelector<HTMLElement>('.page_container[data-page="1"]');
            const surface = container?.querySelector<HTMLElement>('.page_canvas');
            return (
                container?.classList.contains('page_container--rendered') === true &&
                container.dataset.pageRaster === 'current' &&
                Math.abs((surface?.getBoundingClientRect().width ?? 0) - cssWidth) < 1
            );
        },
        {timeout: SETTLE_TIMEOUT_MS},
        (PAGE_WIDTH_PT * percent) / 100,
    );
}

/** The part of the grating inside the viewer, inset so no edge pixel counts. */
async function readGratingRegion(page: Page): Promise<IMeasureRegion & {baseDensity: number}> {
    return page.evaluate(
        (geometry: {width: number; margin: number}) => {
            const surface = document.querySelector<HTMLElement>('.page_container[data-page="1"] .page_canvas');
            let viewer = surface?.parentElement ?? null;
            while (viewer && !/(auto|scroll)/u.test(getComputedStyle(viewer).overflowY)) {
                viewer = viewer.parentElement;
            }
            const canvas = surface?.querySelector<HTMLCanvasElement>('.page_canvas__render-layer > canvas');
            if (!surface || !viewer || !canvas) {
                throw new Error('Page 1 surface was not found');
            }
            const page = surface.getBoundingClientRect();
            const viewerRect = viewer.getBoundingClientRect();
            const cssPerPt = page.width / geometry.width;
            const left = Math.max(page.left + geometry.margin * cssPerPt, viewerRect.left + viewer.clientLeft) + 8;
            const right = Math.min(page.right - geometry.margin * cssPerPt, viewerRect.left + viewer.clientLeft + viewer.clientWidth) - 8;
            const top = Math.max(page.top + geometry.margin * cssPerPt, viewerRect.top + viewer.clientTop) + 8;
            const bottom = Math.min(page.bottom - geometry.margin * cssPerPt, viewerRect.top + viewer.clientTop + viewer.clientHeight) - 8;
            return {
                left: Math.ceil(left),
                top: Math.ceil(top),
                width: Math.floor(right - left),
                height: Math.floor(bottom - top),
                baseDensity: canvas.width / (page.width * window.devicePixelRatio),
            };
        },
        {
            width: PAGE_WIDTH_PT,
            margin: GRATING_MARGIN_PT,
        },
    );
}

async function waitForDetailCanvasCovering(page: Page, region: IMeasureRegion) {
    // Readiness tracks only the page raster, and the constrained policy holds
    // detail work for an input-idle window, so wait for the detail canvas
    // itself. Without one the wait ends and the pixels decide. A detail
    // stretched from an earlier zoom does not count.
    await page
        .waitForFunction(
            (target: IMeasureRegion) => {
                const canvases = document.querySelectorAll<HTMLCanvasElement>(
                    '.page_container[data-page="1"] .page_canvas__detail-layer > canvas',
                );
                const canvas = canvases[canvases.length - 1];
                const rect = canvas?.getBoundingClientRect();
                return Boolean(
                    canvas?.isConnected &&
                    rect &&
                    Math.abs(canvas.width / (rect.width * window.devicePixelRatio) - 1) < 0.01 &&
                    rect.left <= target.left &&
                    rect.top <= target.top &&
                    rect.right >= target.left + target.width &&
                    rect.bottom >= target.top + target.height,
                );
            },
            {timeout: DETAIL_WAIT_MS},
            region,
        )
        .catch(() => undefined);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
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
            const offset = (y * image.width + x) * channels;
            const luminance = (0.2126 * image.data[offset]! + 0.7152 * image.data[offset + 1]! + 0.0722 * image.data[offset + 2]!) / 255;
            if (luminance < 0.15) {
                dark += 1;
            }
            if (luminance > 0.85) {
                light += 1;
            }
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
        if (!canvas || !context) {
            return {
                darkShare: 0,
                lightShare: 0,
                resolution: 0,
            };
        }
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
                const offset = (y * width + x) * 4;
                const luminance = (0.2126 * data[offset]! + 0.7152 * data[offset + 1]! + 0.0722 * data[offset + 2]!) / 255;
                if (luminance < 0.15) {
                    dark += 1;
                }
                if (luminance > 0.85) {
                    light += 1;
                }
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

    it.each([
        {
            widthPoints: 72,
            cssWidth: 180,
            canvasWidth: 82,
        },
        {
            widthPoints: 36,
            cssWidth: 90,
            canvasWidth: 41,
        },
    ])(
        'paints a long page whose requested area fits but whose long axis does not (width=$widthPoints pt)',
        async ({widthPoints, cssWidth, canvasWidth}) => {
            session = await startConfiguredElectronE2ESession(`e2e-long-axis-${Date.now()}`, 'medium', {
                EVB_AUTOMATION_DEVICE_SCALE_FACTOR: '2',
            });
            const {page} = session;
            // Setup only: monitor density is the precondition; zoom uses real input.
            expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
            const pdf = await PDFDocument.create();
            const pdfPage = pdf.addPage([widthPoints, 14_400]);
            pdfPage.drawRectangle({
                x: 0,
                y: 0,
                width: widthPoints,
                height: 14_400,
                color: rgb(0, 0, 0),
            });
            const fixturePath = createFixturePath(`long-axis-${Date.now()}.pdf`);
            await writeFile(fixturePath, await pdf.save());
            await openPdfInApp(page, fixturePath);
            await waitForViewerInteractive(page);
            await zoomToPercentAsUser(page, 250);
            await page.waitForFunction(
                (expectedWidth: number) => {
                    const container = document.querySelector<HTMLElement>('.page_container[data-page="1"]');
                    const surface = container?.querySelector<HTMLElement>('.page_canvas');
                    return (
                        container?.dataset.pageRaster === 'current' &&
                        Math.abs((surface?.getBoundingClientRect().width ?? 0) - expectedWidth) < 1
                    );
                },
                {timeout: SETTLE_TIMEOUT_MS},
                cssWidth,
            );
            const raster = await page.evaluate(() => {
                const canvas = document.querySelector<HTMLCanvasElement>(
                    '.page_container[data-page="1"] .page_canvas__render-layer > canvas',
                )!;
                return {
                    size: [canvas.width, canvas.height],
                    pixel: [
                        ...canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data,
                    ],
                    encoding: canvas.toDataURL().slice(0, 22),
                    hostResourceProfile: (window as IE2EWindow).electronAPI?.host.getResourceProfile(),
                };
            });
            const evidenceDir = resolve('.devkit/checks/deep-zoom-sharpness', session.name);
            await mkdir(evidenceDir, {recursive: true});
            await writeFile(join(evidenceDir, 'long-axis-raster.json'), JSON.stringify(raster, null, 2));
            await page.screenshot({
                path: join(evidenceDir, 'long-axis-base-250.png'),
                type: 'png',
            });
            expect(raster.size).toEqual([canvasWidth, 16_384]);
            expect(raster.pixel).toEqual([0, 0, 0, 255]);
            expect(raster.encoding).toBe('data:image/png;base64,');
            // Axis reduction must set wasClamped, admitting the existing detail path.
            await page.waitForFunction(
                () => {
                    const canvas = document.querySelector<HTMLCanvasElement>(
                        '.page_container[data-page="1"] .page_canvas__detail-layer > canvas',
                    );
                    const rect = canvas?.getBoundingClientRect();
                    return Boolean(
                        canvas &&
                        rect &&
                        rect.width > 0 &&
                        canvas.width > 0 &&
                        canvas.height > 0 &&
                        canvas.width <= 16_384 &&
                        canvas.height <= 16_384 &&
                        Math.abs(canvas.width / rect.width - 2) < 0.02,
                    );
                },
                {timeout: SETTLE_TIMEOUT_MS},
            );
            await page.screenshot({
                path: join(evidenceDir, 'long-axis-250.png'),
                type: 'png',
            });
        },
        E2E_TIMEOUT_MS,
    );

    it(
        'replaces decoded DjVu pixels after a density-only display change',
        async () => {
            session = await startConfiguredElectronE2ESession(`e2e-djvu-density-${Date.now()}`, 'medium');
            const {page} = session;
            await openDjvuInApp(page, resolve('tests/fixtures/djvu/sources/color-text-stamps-maps.djvu'));
            await zoomToPercentAsUser(page, 100);
            await page.waitForFunction(
                () => {
                    const image = document.querySelector<HTMLImageElement>(
                        '[data-testid="document-page-source-page"][data-page-number="1"] > [data-testid="document-page-source-image"]',
                    );
                    return (
                        image?.complete &&
                        image.naturalWidth === Math.round(Number.parseFloat(getComputedStyle(image).width)) &&
                        image.dataset.documentPageVisual === 'committed'
                    );
                },
                {timeout: SETTLE_TIMEOUT_MS},
            );
            const readRaster = () =>
                page.evaluate(() => {
                    const image = document.querySelector<HTMLImageElement>(
                        '[data-testid="document-page-source-page"][data-page-number="1"] > [data-testid="document-page-source-image"]',
                    )!;
                    const rect = image.getBoundingClientRect();
                    const viewport = image.closest<HTMLElement>('[data-document-viewer-chassis-viewport]')!;
                    return {
                        dpr: devicePixelRatio,
                        width: image.naturalWidth,
                        height: image.naturalHeight,
                        cssWidth: Number.parseFloat(getComputedStyle(image).width),
                        rect: {
                            x: rect.x,
                            y: rect.y,
                            width: rect.width,
                            height: rect.height,
                        },
                        scrollTop: viewport.scrollTop,
                        scrollLeft: viewport.scrollLeft,
                        viewportWidth: innerWidth,
                        viewportHeight: innerHeight,
                    };
                });
            const before = await readRaster();
            expect(before.dpr).toBe(1);
            // The fixture is 640 px at 200 DPI. CSS rounds its 230.4 pt width
            // before layout, while raster demand rounds after multiplying by DPR.
            const pageWidthPoints = (640 * 72) / 200;
            expect(before.width).toBe(Math.round(pageWidthPoints));
            const targetWidth = Math.round(pageWidthPoints * 2);
            const evidenceDir = resolve('.devkit/checks/djvu-density', session.name);
            await mkdir(evidenceDir, {recursive: true});
            await page.screenshot({
                path: join(evidenceDir, 'density-1.png'),
                type: 'png',
            });
            const cdp = await page.createCDPSession();
            try {
                // Emulate moving to a denser display without changing the CSS viewport.
                await cdp.send('Emulation.setDeviceMetricsOverride', {
                    width: before.viewportWidth,
                    height: before.viewportHeight,
                    deviceScaleFactor: 2,
                    mobile: false,
                });
                try {
                    await page.waitForFunction(
                        (width: number) => {
                            const image = document.querySelector<HTMLImageElement>(
                                '[data-testid="document-page-source-page"][data-page-number="1"] > [data-testid="document-page-source-image"]',
                            );
                            return image?.complete && image.naturalWidth === width && image.dataset.documentPageVisual === 'committed';
                        },
                        {timeout: SETTLE_TIMEOUT_MS},
                        targetWidth,
                    );
                } finally {
                    await writeFile(
                        join(evidenceDir, 'density.json'),
                        JSON.stringify(
                            {
                                before,
                                after: await readRaster(),
                            },
                            null,
                            2,
                        ),
                    );
                    await page.screenshot({
                        path: join(evidenceDir, 'density-2.png'),
                        type: 'png',
                    });
                }
                const after = await readRaster();
                expect(after.dpr).toBe(2);
                expect(after.width).toBe(targetWidth);
                expect(after.rect).toEqual(before.rect);
                expect(after.scrollTop).toBe(before.scrollTop);
                expect(after.scrollLeft).toBe(before.scrollLeft);
            } finally {
                await cdp.detach();
            }
        },
        E2E_TIMEOUT_MS,
    );

    it(
        'paints the visible part of a capped page at full resolution after a toolbar zoom',
        async () => {
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

            const evidenceDir = resolve('.devkit/checks/deep-zoom-sharpness', session.name);
            await mkdir(evidenceDir, {recursive: true});
            const evidencePath = join(evidenceDir, 'deep-zoom-1000.png');
            const shares = await measureResolvedBarShare(page, region, evidencePath);
            console.info(
                `[deep-zoom] dpr=${String(devicePixelRatio)} baseDensity=${region.baseDensity.toFixed(3)} darkShare=${shares.darkShare.toFixed(3)} lightShare=${shares.lightShare.toFixed(3)} evidence=${evidencePath}`,
            );
            // Each bar spans two device pixels, so a resolved grating has at least
            // a quarter of its pixels near black and near white at any alignment.
            expect(region.baseDensity).toBeLessThan(0.6);
            expect(shares.darkShare).toBeGreaterThan(0.2);
            expect(shares.lightShare).toBeGreaterThan(0.2);
        },
        E2E_TIMEOUT_MS,
    );

    it(
        'keeps the capped page raster across a zoom step and repaints only the detail',
        async () => {
            session = await startConfiguredElectronE2ESession(`e2e-deep-zoom-step-${Date.now()}`, 'low');
            const {page} = session;
            const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
            await openPdfInApp(page, await createBarGratingPdf(devicePixelRatio));
            await waitForViewerInteractive(page);
            await zoomToPercentAsUser(page, STEP_FROM_ZOOM_PERCENT);
            await waitForSettledPage(page, STEP_FROM_ZOOM_PERCENT);
            await waitForDetailCanvasCovering(page, await readGratingRegion(page));
            const pageCanvas = await page.evaluateHandle(() => {
                const canvas = document.querySelector<HTMLCanvasElement>(
                    '.page_container[data-page="1"] .page_canvas__render-layer > canvas',
                );
                if (!canvas) {
                    throw new Error('Page 1 canvas was not found');
                }
                return canvas;
            });
            const before = await pageCanvas.evaluate((canvas) => `${String(canvas.width)}x${String(canvas.height)}`);

            await zoomInOneStepAsUser(page, TARGET_ZOOM_PERCENT);
            await waitForSettledPage(page);
            const region = await readGratingRegion(page);
            await waitForDetailCanvasCovering(page, region);
            const after = await pageCanvas.evaluate((canvas) => ({
                kept: canvas === document.querySelector('.page_container[data-page="1"] .page_canvas__render-layer > canvas'),
                size: `${String(canvas.width)}x${String(canvas.height)}`,
            }));

            const evidenceDir = resolve('.devkit/checks/deep-zoom-sharpness', session.name);
            await mkdir(evidenceDir, {recursive: true});
            const evidencePath = join(evidenceDir, 'deep-zoom-step-1000.png');
            await page.screenshot({
                path: evidencePath,
                type: 'png',
            });
            const shares = await measureDetailRasterBarShare(page, region);
            console.info(
                `[deep-zoom-step] before=${String(before)} after=${String(after.size)} kept=${String(after.kept)} resolution=${shares.resolution.toFixed(3)} darkShare=${shares.darkShare.toFixed(3)} lightShare=${shares.lightShare.toFixed(3)} evidence=${evidencePath}`,
            );
            // Both zoom levels ask for far more than the cap, so a new page raster
            // would paint the same pixels at the same size.
            expect(region.baseDensity).toBeLessThan(0.6);
            expect(after.size).toBe(before);
            expect(after.kept).toBe(true);
            expect(shares.resolution).toBeGreaterThan(0.99);
            expect(shares.resolution).toBeLessThan(1.01);
            expect(shares.darkShare).toBeGreaterThan(0.2);
            expect(shares.lightShare).toBeGreaterThan(0.2);
        },
        E2E_TIMEOUT_MS,
    );

    it(
        'stretches the shown raster across a >180ms wheel zoom gesture, reconciles once on settle, paints L6 sharp detail, and honors follow-up navigation',
        async () => {
            session = await startConfiguredElectronE2ESession(`e2e-deep-zoom-gesture-${Date.now()}`, 'low');
            const {page} = session;
            const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
            const barWidthPt = 2 / (TARGET_ZOOM_PERCENT / 100) / devicePixelRatio;
            const doc = await PDFDocument.create();
            const page1 = doc.addPage([PAGE_WIDTH_PT, PAGE_HEIGHT_PT]);
            for (let x = GRATING_MARGIN_PT; x + barWidthPt <= PAGE_WIDTH_PT - GRATING_MARGIN_PT; x += 2 * barWidthPt) {
                page1.drawRectangle({
                    x,
                    y: GRATING_MARGIN_PT,
                    width: barWidthPt,
                    height: PAGE_HEIGHT_PT - 2 * GRATING_MARGIN_PT,
                    color: rgb(0, 0, 0),
                });
            }
            doc.addPage([PAGE_WIDTH_PT, PAGE_HEIGHT_PT]);
            const fixturePath = createFixturePath(`deep-zoom-gesture-${Date.now()}.pdf`);
            await writeFile(fixturePath, await doc.save());
            await openPdfInApp(page, fixturePath);
            await waitForViewerInteractive(page);

            // Part 1: Uncapped zoom (100% -> ~180%) proves stretch-and-settle suppresses intermediate
            // canvas replacements during a sustained >180ms wheel gesture and replaces once on settle.
            await zoomToPercentAsUser(page, 100);
            await waitForSettledPage(page, 100);

            const uncappedSetup = await page.evaluate(() => {
                const viewer = document.querySelector<HTMLElement>('.editor-pane.is-active #pdf-viewer')!;
                const rect = viewer.getBoundingClientRect();
                const layer = document.querySelector<HTMLElement>('.page_container[data-page="1"] .page_canvas__render-layer')!;
                const initialCanvas = layer.querySelector<HTMLCanvasElement>('canvas');
                const probe = {
                    gestureEndedAt: Number.POSITIVE_INFINITY,
                    duringGesture: 0,
                    afterGesture: 0,
                };
                (window as unknown as {__zoomGestureProbe?: typeof probe}).__zoomGestureProbe = probe;
                const observer = new MutationObserver((records) => {
                    for (const record of records) {
                        for (const node of record.addedNodes) {
                            if (node instanceof HTMLCanvasElement) {
                                if (performance.now() <= probe.gestureEndedAt) {
                                    probe.duringGesture += 1;
                                } else {
                                    probe.afterGesture += 1;
                                }
                            }
                        }
                    }
                });
                observer.observe(layer, {childList: true});
                return {
                    initialCanvasWidth: initialCanvas?.width ?? 0,
                    x: Math.round(rect.left + rect.width / 2),
                    y: Math.round(rect.top + rect.height / 2),
                };
            });

            const waitTwoFrames = () =>
                page.evaluate(
                    () =>
                        new Promise<void>((resolve) => {
                            window.requestAnimationFrame(() => {
                                window.requestAnimationFrame(() => resolve());
                            });
                        }),
                );

            const zoomModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
            await page.mouse.move(uncappedSetup.x, uncappedSetup.y);
            await page.keyboard.down(zoomModifier);
            try {
                // Sustained >180ms wheel zoom gesture paced across compositor frames.
                for (let step = 0; step < 16; step += 1) {
                    await page.mouse.wheel({deltaY: -18});
                    await waitTwoFrames();
                }
                await page.evaluate(() => {
                    const probe = (window as unknown as {__zoomGestureProbe?: {gestureEndedAt: number}}).__zoomGestureProbe;
                    if (probe) {
                        probe.gestureEndedAt = performance.now();
                    }
                });
            } finally {
                await page.keyboard.up(zoomModifier);
            }

            await page.waitForFunction(
                (initialWidth: number) => {
                    const container = document.querySelector<HTMLElement>('.page_container[data-page="1"]');
                    const canvas = container?.querySelector<HTMLCanvasElement>('.page_canvas__render-layer canvas');
                    return (
                        container?.classList.contains('page_container--rendered') === true &&
                        container.dataset.pageRaster === 'current' &&
                        (canvas?.width ?? 0) > initialWidth
                    );
                },
                {timeout: SETTLE_TIMEOUT_MS},
                uncappedSetup.initialCanvasWidth,
            );
            const uncappedResult = await page.evaluate(() => {
                const probe = (window as unknown as {__zoomGestureProbe?: {duringGesture: number; afterGesture: number}})
                    .__zoomGestureProbe;
                const canvas = document.querySelector<HTMLCanvasElement>(
                    '.page_container[data-page="1"] .page_canvas__render-layer canvas',
                );
                const zoomText = document.querySelector('.zoom-controls-display-value')?.textContent?.trim() ?? '';
                return {
                    zoomText,
                    canvasWidth: canvas?.width ?? 0,
                    duringGesture: probe?.duringGesture ?? -1,
                    afterGesture: probe?.afterGesture ?? -1,
                };
            });
            expect(uncappedResult.zoomText).not.toBe('100%');
            expect(uncappedResult.duringGesture).toBe(0);
            expect(uncappedResult.afterGesture).toBeGreaterThanOrEqual(1);
            expect(uncappedResult.canvasWidth).toBeGreaterThan(uncappedSetup.initialCanvasWidth);

            // Part 2: Sustained wheel gesture into L6 clamped detail territory (~1000%) resolves the
            // grating bars crisply at 1:1 physical pixel density and honors follow-up navigation.
            await zoomToPercentAsUser(page, 600);
            await waitForSettledPage(page, 600);
            await page.mouse.move(uncappedSetup.x, uncappedSetup.y);
            await page.keyboard.down(zoomModifier);
            try {
                for (let step = 0; step < 18; step += 1) {
                    await page.mouse.wheel({deltaY: -18});
                    await waitTwoFrames();
                }
            } finally {
                await page.keyboard.up(zoomModifier);
            }
            await page.waitForFunction(
                () => {
                    const container = document.querySelector<HTMLElement>('.page_container[data-page="1"]');
                    return container?.classList.contains('page_container--rendered') === true && container.dataset.pageRaster === 'current';
                },
                {timeout: SETTLE_TIMEOUT_MS},
            );
            const region = await readGratingRegion(page);
            await waitForDetailCanvasCovering(page, region);
            const detailShares = await measureDetailRasterBarShare(page, region);
            expect(region.baseDensity).toBeLessThan(0.6);
            expect(detailShares.resolution).toBeGreaterThan(0.99);
            expect(detailShares.resolution).toBeLessThan(1.01);
            expect(detailShares.darkShare).toBeGreaterThan(0.2);
            expect(detailShares.lightShare).toBeGreaterThan(0.2);

            // Follow-up navigation lands cleanly on page 2.
            await clickAsUser(page, '.page-controls-current-primary');
            await page.waitForSelector('.page-controls-inline-input', {visible: true});
            await clickAsUser(page, '.page-controls-inline-input');
            const selectAllModifier = process.platform === 'darwin' ? 'MetaLeft' : 'ControlLeft';
            await page.keyboard.down(selectAllModifier);
            await page.keyboard.press('KeyA');
            await page.keyboard.up(selectAllModifier);
            await page.keyboard.type('2');
            await page.keyboard.press('Enter');
            await page.waitForFunction(
                () => {
                    const primary = document.querySelector('.page-controls-current-primary')?.textContent?.trim();
                    const page2 = document.querySelector<HTMLElement>('.page_container[data-page="2"]');
                    return primary === '2' && page2?.dataset.pageRaster === 'current';
                },
                {timeout: SETTLE_TIMEOUT_MS},
            );
        },
        E2E_TIMEOUT_MS,
    );
});
