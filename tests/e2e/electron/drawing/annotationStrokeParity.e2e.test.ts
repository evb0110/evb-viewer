import {
    mkdirSync,
    readFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { decode } from 'fast-png';
import { chromium } from 'playwright';
import type { Page as ElectronPage } from 'puppeteer-core';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    createManagedInkStrokeFixturePdf,
    readPdfAnnotationSummary,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    openPdfInApp,
    waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {requireWorkspaceCommand} from '@tests/e2e/electron/helpers/workspaceExpose';
import { serveBuiltWebApp } from '@tests/e2e/electron/helpers/serveBuiltWebApp';

const MATCHED_DISPLAY_ZOOM = 2;
const ARTIFACT_DIR = resolve(process.cwd(), '.devkit', 'test', 'annotation-stroke-parity');
const ELECTRON_SCREENSHOT_PATH = resolve(ARTIFACT_DIR, 'electron.png');
const PLAYWRIGHT_SCREENSHOT_PATH = resolve(ARTIFACT_DIR, 'playwright.png');
const PLAYWRIGHT_WRONG_OPACITY_SCREENSHOT_PATH = resolve(ARTIFACT_DIR, 'playwright-wrong-opacity.png');
const CHROMIUM_EXECUTABLE_PATH = process.env.EVB_E2E_CHROMIUM_EXECUTABLE_PATH?.trim();
const INTERIOR_PIXEL_MISMATCH_RATIO = 0.005;
const ICC_CHANNEL_DELTA = 10;

interface IStrokePaintMetrics {
    canvasInkPixelCount: number;
    devicePixelRatio: number;
    managedShapeCount: number;
    overlayPresent: boolean;
    renderedStrokeWidth: number | null;
    scaleFactor: number | null;
    strokeWidthAttribute: string | null;
    totalScaleFactor: number | null;
    userUnit: number | null;
    viewportWidth: number;
}

interface IBlueStrokePixelMetrics {
    bounds: {
        bottom: number;
        left: number;
        right: number;
        top: number;
    } | null;
    count: number;
}

interface IPageSurfaceOrigin {
    devicePixelRatio: number;
    left: number;
    top: number;
}

interface IInteriorSamplePoint {
    kind: 'fill' | 'stroke';
    x: number;
    y: number;
}

interface IInteriorPixel {
    alpha: number;
    blue: number;
    green: number;
    red: number;
}

function readStrokePaintMetrics(): IStrokePaintMetrics {
    const pageContainer = document.querySelector<HTMLElement>(
        '.editor-pane.is-active .page_container[data-page="1"]',
    );
    const shapes = pageContainer?.querySelectorAll<SVGGElement>(
        '.pdf-annotation-editor-layer g[data-annotation-kind="shape"][data-annotation-id]',
    ) ?? [];
    const visual = pageContainer?.querySelector<SVGGeometryElement>([
        '.pdf-annotation-editor-layer g[data-annotation-kind="shape"][data-annotation-id] polyline',
        '.pdf-annotation-editor-layer g[data-annotation-kind="shape"][data-annotation-id] path',
        '.pdf-annotation-editor-layer g[data-annotation-kind="shape"][data-annotation-id] line',
    ].join(',')) ?? null;
    const pageStyle = pageContainer ? window.getComputedStyle(pageContainer) : null;
    const parseStyleNumber = (property: string) => {
        const value = pageStyle?.getPropertyValue(property) ?? '';
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : null;
    };
    const renderedStrokeWidth = visual
        ? Number.parseFloat(window.getComputedStyle(visual).strokeWidth)
        : Number.NaN;
    const scaleFactor = parseStyleNumber('--scale-factor');
    const userUnit = parseStyleNumber('--user-unit');
    const canvas = pageContainer?.querySelector<HTMLCanvasElement>('.page_canvas canvas') ?? null;
    let canvasInkPixelCount = 0;
    if (canvas && canvas.width > 0 && canvas.height > 0) {
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const centerX = Math.round(canvas.width * 0.35);
        const centerY = Math.round(canvas.height * 0.34);
        const radius = 16;
        const startX = Math.max(0, centerX - radius);
        const startY = Math.max(0, centerY - radius);
        const width = Math.min(canvas.width - startX, radius * 2 + 1);
        const height = Math.min(canvas.height - startY, radius * 2 + 1);
        const pixels = context?.getImageData(startX, startY, width, height).data ?? [];
        for (let index = 0; index < pixels.length; index += 4) {
            const red = pixels[index] ?? 255;
            const green = pixels[index + 1] ?? 255;
            const blue = pixels[index + 2] ?? 255;
            const alpha = pixels[index + 3] ?? 0;
            if (alpha > 0 && (red < 240 || green < 240 || blue < 240)) {
                canvasInkPixelCount += 1;
            }
        }
    }

    return {
        canvasInkPixelCount,
        devicePixelRatio: window.devicePixelRatio,
        managedShapeCount: shapes.length,
        overlayPresent: Boolean(pageContainer?.querySelector('.pdf-shape-overlay')),
        renderedStrokeWidth: Number.isFinite(renderedStrokeWidth) ? renderedStrokeWidth : null,
        scaleFactor,
        strokeWidthAttribute: visual?.getAttribute('stroke-width') ?? null,
        totalScaleFactor: scaleFactor !== null && userUnit !== null
            ? scaleFactor * userUnit
            : null,
        userUnit,
        viewportWidth: window.innerWidth,
    };
}

function readPageSurfaceOrigin(): IPageSurfaceOrigin {
    const pageContainer = document.querySelector<HTMLElement>(
        '.editor-pane.is-active .page_container[data-page="1"]',
    );
    if (!pageContainer) {
        throw new Error('Stroke parity page container is not mounted');
    }
    const rect = pageContainer.getBoundingClientRect();
    return {
        devicePixelRatio: window.devicePixelRatio,
        left: rect.left,
        top: rect.top,
    };
}

function readInteriorSamplePoints(): IInteriorSamplePoint[] {
    const pageContainer = document.querySelector<HTMLElement>(
        '.editor-pane.is-active .page_container[data-page="1"]',
    );
    const pageOrigin = pageContainer?.getBoundingClientRect();
    if (!pageOrigin) {
        throw new Error('Interior parity page container is not mounted');
    }
    const visualShapes = Array.from(document.querySelectorAll<SVGGElement>(
        '.editor-pane.is-active .page_container[data-page="1"] '
        + '.pdf-annotation-editor-shape[data-annotation-id] [data-annotation-visual]',
    ));
    const samples: IInteriorSamplePoint[] = [];
    const devicePixelInset = 1 / Math.max(window.devicePixelRatio, 1);
    for (const visualShape of visualShapes) {
        const geometry = visualShape.firstElementChild;
        if (!(geometry instanceof SVGGeometryElement)) {
            continue;
        }
        if (geometry instanceof SVGRectElement) {
            const rect = geometry.getBoundingClientRect();
            const inset = devicePixelInset + 2;
            for (let row = 1; row <= 5; row += 1) {
                for (let column = 1; column <= 5; column += 1) {
                    samples.push({
                        kind: 'fill',
                        x: rect.left - pageOrigin.left + inset + (rect.width - inset * 2) * column / 6,
                        y: rect.top - pageOrigin.top + inset + (rect.height - inset * 2) * row / 6,
                    });
                }
            }
            continue;
        }
        const path = geometry;
        const totalLength = path.getTotalLength();
        for (let index = 1; index <= 24; index += 1) {
            const point = path.getPointAtLength(totalLength * index / 25);
            const screenPoint = new DOMPoint(point.x, point.y).matrixTransform(
                path.getScreenCTM() ?? new DOMMatrix(),
            );
            samples.push({
                kind: 'stroke',
                x: screenPoint.x - pageOrigin.left,
                y: screenPoint.y - pageOrigin.top,
            });
        }
    }
    return samples;
}

async function waitForStrokeMetrics(
    readMetrics: () => Promise<IStrokePaintMetrics>,
    timeoutMs = 30_000,
) {
    const startedAt = Date.now();
    let metrics = await readMetrics();
    while (
        Date.now() - startedAt < timeoutMs
        && (metrics.managedShapeCount !== 2 || metrics.renderedStrokeWidth === null)
    ) {
        await delay(250);
        metrics = await readMetrics();
    }
    return metrics;
}

async function setElectronZoom(page: ElectronPage) {
    await requireWorkspaceCommand(page, 'setCustomZoomFromDisplay', [MATCHED_DISPLAY_ZOOM]);
}

async function readBlueStrokePixelMetrics(
    path: string,
    pageOrigin: IPageSurfaceOrigin,
): Promise<IBlueStrokePixelMetrics> {
    const image = decode(readFileSync(path));
    const pixels = image.data;
    const channels = pixels.length / (image.width * image.height);
    if (!Number.isInteger(channels) || channels < 3 || channels > 4) {
        throw new Error(`Unsupported screenshot channel count: ${channels}`);
    }
    const startX = Math.floor(image.width * 0.15);
    const endX = Math.ceil(image.width * 0.85);
    const startY = Math.floor(image.height * 0.4);
    const endY = Math.ceil(image.height * 0.9);
    let count = 0;
    let left = image.width;
    let top = image.height;
    let right = -1;
    let bottom = -1;
    for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
            const index = (y * image.width + x) * channels;
            const red = pixels[index] ?? 0;
            const green = pixels[index + 1] ?? 0;
            const blue = pixels[index + 2] ?? 0;
            if (blue > 165 && blue - red > 38 && blue - green > 8) {
                count += 1;
                left = Math.min(left, x);
                top = Math.min(top, y);
                right = Math.max(right, x);
                bottom = Math.max(bottom, y);
            }
        }
    }
    const ratio = pageOrigin.devicePixelRatio > 0 ? pageOrigin.devicePixelRatio : 1;
    return {
        bounds: count > 0 ? {
            bottom: bottom / ratio - pageOrigin.top,
            left: left / ratio - pageOrigin.left,
            right: right / ratio - pageOrigin.left,
            top: top / ratio - pageOrigin.top,
        } : null,
        count,
    };
}

function readInteriorPixels(
    path: string,
    samples: IInteriorSamplePoint[],
    pageOrigin: IPageSurfaceOrigin,
): IInteriorPixel[] {
    const image = decode(readFileSync(path));
    const channels = image.data.length / (image.width * image.height);
    return samples.map(({
        x,
        y,
    }) => {
        const pixelX = Math.max(0, Math.min(
            image.width - 1,
            Math.round((x + pageOrigin.left) * pageOrigin.devicePixelRatio),
        ));
        const pixelY = Math.max(0, Math.min(
            image.height - 1,
            Math.round((y + pageOrigin.top) * pageOrigin.devicePixelRatio),
        ));
        const index = (pixelY * image.width + pixelX) * channels;
        return {
            alpha: channels === 4 ? image.data[index + 3] ?? 255 : 255,
            blue: image.data[index + 2] ?? 0,
            green: image.data[index + 1] ?? 0,
            red: image.data[index] ?? 0,
        };
    });
}

function countInteriorMismatches(expected: IInteriorPixel[], actual: IInteriorPixel[]) {
    return expected.reduce((count, pixel, index) => {
        const candidate = actual[index];
        if (!candidate) {
            return count + 1;
        }
        const channelDelta = Math.max(
            Math.abs(pixel.alpha - candidate.alpha),
            Math.abs(pixel.blue - candidate.blue),
            Math.abs(pixel.green - candidate.green),
            Math.abs(pixel.red - candidate.red),
        );
        return count + (channelDelta > ICC_CHANNEL_DELTA ? 1 : 0);
    }, 0);
}

describe('Electron and Playwright annotation opacity parity', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        restartBeforeEach: false,
        sessionName: () => `e2e-annotation-stroke-parity-${Date.now()}`,
    });

    it('renders canonical stroke and fill opacity identically in both runtimes', async () => {
        const session = sessionFixture.getSession();

        mkdirSync(ARTIFACT_DIR, { recursive: true });
        await session.page.setViewport({
            deviceScaleFactor: 2,
            height: 900,
            width: 1_440,
        });
        const fixturePath = await createManagedInkStrokeFixturePdf(`annotation-stroke-parity-${Date.now()}.pdf`);
        expect((await readPdfAnnotationSummary(fixturePath)).bySubtype.Ink).toBe(1);
        console.info('STROKE_PARITY_STEP electron-open:start');
        await openPdfInApp(session.page, fixturePath);
        await waitForPdfLoaded(session.page);
        console.info('STROKE_PARITY_STEP electron-open:complete');

        console.info('STROKE_PARITY_STEP electron-measure:start');
        await setElectronZoom(session.page);
        console.info('STROKE_PARITY_STEP electron-zoom:complete');
        const electronMetrics = await waitForStrokeMetrics(
            () => session.page.evaluate(readStrokePaintMetrics),
        );
        await session.page.setViewport({
            deviceScaleFactor: 2,
            height: 700,
            width: 1_000,
        });
        const resizedElectronMetrics = await session.page.evaluate(readStrokePaintMetrics);
        expect(resizedElectronMetrics.viewportWidth).toBe(1_000);
        expect(resizedElectronMetrics.renderedStrokeWidth).toBe(electronMetrics.renderedStrokeWidth);
        await session.page.setViewport({
            deviceScaleFactor: 2,
            height: 900,
            width: 1_440,
        });
        const electronPageOrigin = await session.page.evaluate(readPageSurfaceOrigin);
        console.info(`STROKE_PARITY_STEP electron-metrics:complete ${JSON.stringify(electronMetrics)}`);
        await session.page.screenshot({
            path: ELECTRON_SCREENSHOT_PATH,
            type: 'png',
        });
        console.info(`STROKE_PARITY_STEP electron-measure:complete ${JSON.stringify(electronMetrics)}`);

        const webApp = await serveBuiltWebApp();
        const browser = await chromium.launch({
            headless: true,
            ...(CHROMIUM_EXECUTABLE_PATH ? {executablePath: CHROMIUM_EXECUTABLE_PATH} : {}),
        });
        try {
            console.info('STROKE_PARITY_STEP playwright-open:start');
            const context = await browser.newContext({
                deviceScaleFactor: 2,
                viewport: {
                    width: 1440,
                    height: 900,
                },
            });
            const webPage = await context.newPage();
            await webPage.goto(`${webApp.origin}/`, { waitUntil: 'domcontentloaded' });
            await webPage.evaluate(() => {
                window.sessionStorage.setItem(
                    'evb-viewer:browser:open-picker-mode',
                    'input',
                );
            });

            const fileChooserPromise = webPage.waitForEvent('filechooser');
            await webPage.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            const fileChooser = await fileChooserPromise;
            await fileChooser.setFiles(fixturePath);
            await webPage.locator('.page_container--rendered canvas').first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            console.info('STROKE_PARITY_STEP playwright-open:complete');
            await webPage.locator('.zoom-controls-display:visible').click();
            const customZoomInput = webPage.locator('.zoom-chip-custom-input:visible');
            await customZoomInput.fill(String(MATCHED_DISPLAY_ZOOM * 100));
            await customZoomInput.press('Enter');
            await expect.poll(async () => (
                webPage.locator('.zoom-controls-display-value:visible').textContent()
            )).toContain(`${String(MATCHED_DISPLAY_ZOOM * 100)}%`);

            const webMetrics = await waitForStrokeMetrics(
                () => webPage.evaluate(readStrokePaintMetrics),
            );
            await webPage.setViewportSize({
                height: 700,
                width: 1_000,
            });
            const resizedWebMetrics = await webPage.evaluate(readStrokePaintMetrics);
            expect(resizedWebMetrics.viewportWidth).toBe(1_000);
            expect(resizedWebMetrics.renderedStrokeWidth).toBe(webMetrics.renderedStrokeWidth);
            await webPage.setViewportSize({
                height: 900,
                width: 1_440,
            });
            const playwrightPageOrigin = await webPage.evaluate(readPageSurfaceOrigin);
            await webPage.screenshot({path: PLAYWRIGHT_SCREENSHOT_PATH});
            console.info(`STROKE_PARITY_STEP playwright-measure:complete ${JSON.stringify(webMetrics)}`);

            console.info(`ANNOTATION_STROKE_PARITY ${JSON.stringify({
                electron: electronMetrics,
                playwright: webMetrics,
            })}`);

            expect(electronMetrics.managedShapeCount).toBe(2);
            expect(webMetrics.managedShapeCount).toBe(2);
            expect(electronMetrics.strokeWidthAttribute).toBe(webMetrics.strokeWidthAttribute);
            expect(electronMetrics.scaleFactor).toBeCloseTo(webMetrics.scaleFactor ?? 0, 5);
            expect(electronMetrics.userUnit).toBeCloseTo(webMetrics.userUnit ?? 0, 5);
            expect(electronMetrics.renderedStrokeWidth).toBeCloseTo(
                webMetrics.renderedStrokeWidth ?? 0,
                5,
            );
            const electronBluePixels = await readBlueStrokePixelMetrics(
                ELECTRON_SCREENSHOT_PATH,
                electronPageOrigin,
            );
            const playwrightBluePixels = await readBlueStrokePixelMetrics(
                PLAYWRIGHT_SCREENSHOT_PATH,
                playwrightPageOrigin,
            );
            expect(electronBluePixels.count).toBeGreaterThan(0);
            expect(playwrightBluePixels.count).toBeGreaterThan(0);
            // Keep the content's location and extent strict while allowing
            // the two screenshot surfaces to round an edge to adjacent pixels.
            const electronBounds = electronBluePixels.bounds;
            const playwrightBounds = playwrightBluePixels.bounds;
            expect(electronBounds).not.toBeNull();
            expect(playwrightBounds).not.toBeNull();
            for (const edge of [
                'bottom',
                'left',
                'right',
                'top',
            ] as const) {
                expect(
                    Math.abs(electronBounds![edge] - playwrightBounds![edge]),
                    `${edge}: ${JSON.stringify({
                        electronBounds,
                        playwrightBounds,
                    })}`,
                ).toBeLessThanOrEqual(1);
            }
            console.info(`ANNOTATION_EDGE_DIAGNOSTIC ${JSON.stringify({
                electron: electronBluePixels,
                playwright: playwrightBluePixels,
            })}`);

            const electronInteriorSamples = await session.page.evaluate(readInteriorSamplePoints);
            const playwrightInteriorSamples = await webPage.evaluate(readInteriorSamplePoints);
            expect(electronInteriorSamples.filter(sample => sample.kind === 'fill')).toHaveLength(25);
            expect(electronInteriorSamples.filter(sample => sample.kind === 'stroke')).toHaveLength(24);
            expect(playwrightInteriorSamples).toHaveLength(electronInteriorSamples.length);
            const electronInteriorPixels = readInteriorPixels(
                ELECTRON_SCREENSHOT_PATH,
                electronInteriorSamples,
                electronPageOrigin,
            );
            const playwrightInteriorPixels = readInteriorPixels(
                PLAYWRIGHT_SCREENSHOT_PATH,
                playwrightInteriorSamples,
                playwrightPageOrigin,
            );
            const interiorMismatchLimit = Math.ceil(
                electronInteriorPixels.length * INTERIOR_PIXEL_MISMATCH_RATIO,
            );
            const interiorMismatchCount = countInteriorMismatches(
                electronInteriorPixels,
                playwrightInteriorPixels,
            );
            console.info(`ANNOTATION_INTERIOR_PARITY ${JSON.stringify({
                mismatchCount: interiorMismatchCount,
                mismatchLimit: interiorMismatchLimit,
                sampleCount: electronInteriorPixels.length,
            })}`);
            // Compare only shape interiors. One device pixel is excluded at each
            // boundary, where the two screenshot surfaces legitimately antialias.
            // The measured ICC conversion differs by at most 10 channels in the
            // interior; the mismatch-count threshold remains the existing 0.5%.
            expect(interiorMismatchCount).toBeLessThanOrEqual(interiorMismatchLimit);

            await webPage.evaluate(() => {
                const visual = document.querySelector<SVGGElement>(
                    '.editor-pane.is-active .page_container[data-page="1"] '
                    + '.pdf-annotation-editor-shape[data-annotation-id] [data-annotation-visual]',
                );
                if (!visual) {
                    throw new Error('Missing fill visual for opacity negative control');
                }
                visual.parentElement?.style.setProperty('opacity', '0.2');
            });
            await webPage.screenshot({
                path: PLAYWRIGHT_WRONG_OPACITY_SCREENSHOT_PATH,
                type: 'png',
            });
            const wrongOpacityPixels = readInteriorPixels(
                PLAYWRIGHT_WRONG_OPACITY_SCREENSHOT_PATH,
                playwrightInteriorSamples,
                playwrightPageOrigin,
            );
            const wrongOpacityMismatchCount = countInteriorMismatches(
                electronInteriorPixels,
                wrongOpacityPixels,
            );
            console.info(`ANNOTATION_INTERIOR_NEGATIVE_CONTROL ${JSON.stringify({
                mismatchCount: wrongOpacityMismatchCount,
                mismatchLimit: interiorMismatchLimit,
            })}`);
            expect(wrongOpacityMismatchCount).toBeGreaterThan(interiorMismatchLimit);
        } finally {
            await browser.close();
            await webApp.close();
        }
    }, 180_000);
});
