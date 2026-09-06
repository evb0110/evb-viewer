import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { Page as ElectronPage } from 'puppeteer-core';
import {
    createCanvas,
    loadImage,
} from '@napi-rs/canvas';
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
import { callWorkspaceCommand } from '@tests/e2e/electron/helpers/workspaceExpose';

const MATCHED_DISPLAY_ZOOM = 2;
const ARTIFACT_DIR = resolve(process.cwd(), '.devkit', 'test', 'annotation-stroke-parity');
const ELECTRON_SCREENSHOT_PATH = resolve(ARTIFACT_DIR, 'electron.png');
const PLAYWRIGHT_SCREENSHOT_PATH = resolve(ARTIFACT_DIR, 'playwright.png');
const CHROMIUM_EXECUTABLE_PATH = process.env.EVB_E2E_CHROMIUM_EXECUTABLE_PATH?.trim();

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

async function waitForStrokeMetrics(
    readMetrics: () => Promise<IStrokePaintMetrics>,
    timeoutMs = 30_000,
) {
    const startedAt = Date.now();
    let metrics = await readMetrics();
    while (
        Date.now() - startedAt < timeoutMs
        && (metrics.managedShapeCount !== 1 || metrics.renderedStrokeWidth === null)
    ) {
        await delay(250);
        metrics = await readMetrics();
    }
    return metrics;
}

async function setElectronZoom(page: ElectronPage) {
    const result = await callWorkspaceCommand(page, 'setCustomZoomFromDisplay', [MATCHED_DISPLAY_ZOOM]);
    expect(result.called).toBe(true);
}

async function readBlueStrokePixelMetrics(
    path: string,
    pageOrigin: IPageSurfaceOrigin,
): Promise<IBlueStrokePixelMetrics> {
    const image = await loadImage(path);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
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
            const index = (y * image.width + x) * 4;
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

describe('Electron and Playwright annotation stroke parity', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        restartBeforeEach: false,
        sessionName: () => `e2e-annotation-stroke-parity-${Date.now()}`,
    });

    it('renders the same saved ink stroke identically in both runtimes', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }

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
            const electronUrl = new URL(session.page.url());
            const webUrl = `${electronUrl.origin}/`;
            await webPage.goto(webUrl, { waitUntil: 'domcontentloaded' });
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

            expect(electronMetrics.managedShapeCount).toBe(1);
            expect(webMetrics.managedShapeCount).toBe(1);
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
            // Electron and headless Chromium use different screenshot surfaces,
            // so thresholded antialiasing can change coverage by a few pixels.
            // Keep the content's location and extent strict while allowing the
            // two screenshot surfaces to round an edge to adjacent pixels.
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
            const maxCoverageDrift = Math.ceil(Math.max(
                electronBluePixels.count,
                playwrightBluePixels.count,
            ) * 0.005);
            expect(Math.abs(electronBluePixels.count - playwrightBluePixels.count)).toBeLessThanOrEqual(maxCoverageDrift);
        } finally {
            await browser.close();
        }
    }, 180_000);
});
