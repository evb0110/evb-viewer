import {
    mkdtempSync,
    writeFileSync,
} from 'node:fs';
import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {PDFDocument} from 'pdf-lib';
import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    dismissScanCleanupFirstRunGuidance,
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';

// Some scanners store each image pixel as one PDF point. This page's 2912x4368
// scan therefore declares a sheet over a metre tall, and a fixed 150-DPI
// analysis render of it is 6067x9100 pixels: over the raster cap that preview
// applies, so preview reported "Preview isn't available" instead of the page.
const SCAN_WIDTH = 2912;
const SCAN_HEIGHT = 4368;
const CLEANED_IMAGE = '.preview-result-layer img.cleaned-image.preview-pixel:not(.is-outgoing):not(.is-incoming)';
const PREVIEW_ERROR = '.preview-refresh-error, .preview-message.is-error, .preview-error-detail';

const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-scan-cleanup-low-dpi-${Date.now()}`});

async function createOnePixelPerPointScanPdf(path: string) {
    const canvas = createCanvas(SCAN_WIDTH, SCAN_HEIGHT);
    const context = canvas.getContext('2d');
    const paper = context.createLinearGradient(0, 0, SCAN_WIDTH, SCAN_HEIGHT);
    paper.addColorStop(0, '#f4ecd8');
    paper.addColorStop(1, '#e6d8bb');
    context.fillStyle = paper;
    context.fillRect(0, 0, SCAN_WIDTH, SCAN_HEIGHT);
    context.fillStyle = '#2b2620';
    context.font = '64px serif';
    for (let line = 0; line < 40; line += 1) {
        context.fillText(`A page scanned at one pixel per point, line ${String(line + 1)}`, 260, 420 + (line * 88));
    }
    const doc = await PDFDocument.create();
    const image = await doc.embedJpg(canvas.toBuffer('image/jpeg', 80));
    doc.addPage([
        SCAN_WIDTH,
        SCAN_HEIGHT,
    ]).drawImage(image, {
        x: 0,
        y: 0,
        width: SCAN_WIDTH,
        height: SCAN_HEIGHT,
    });
    writeFileSync(path, await doc.save());
}

describe('scan cleanup of a scan stored at one pixel per point', () => {
    it('previews the cleaned page instead of reporting it unavailable', async () => {
        const session = sessionFixture.getSession();
        await session.command('windowResize', [
            1280,
            900,
        ]);
        const sourceDirectory = mkdtempSync(join(tmpdir(), 'evb-e2e-cleanup-low-dpi-'));
        onTestFinished(() => rm(sourceDirectory, {
            recursive: true,
            force: true,
        }));
        const sourcePath = join(sourceDirectory, 'one-pixel-per-point-scan.pdf');
        await createOnePixelPerPointScanPdf(sourcePath);
        await openPdfInApp(session.page, sourcePath, 90_000);
        await waitForPdfLoaded(session.page, 90_000);
        await waitForViewerInteractive(session.page, 90_000);
        for (const toast of await session.page.$$('button[aria-label="Dismiss"]')) {
            if (await toast.isVisible()) await clickAsUser(session.page, toast);
        }

        await clickAsUser(session.page, 'button[aria-label="Scan cleanup"]');
        await session.page.waitForSelector('.scan-cleanup-surface', {
            visible: true,
            timeout: 20_000,
        });
        await dismissScanCleanupFirstRunGuidance(session.page);

        // Settled means detection finished and the preview, read after that,
        // shows either the cleaned page or its error. The error is the defect.
        await waitForFunctionInPage(session.page, (cleanedSelector: string, errorSelector: string) => {
            const detection = document.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status');
            const image = document.querySelector<HTMLImageElement>(cleanedSelector);
            const painted = Boolean(image?.complete && image.naturalWidth > 0);
            return detection === 'completed' && (painted || document.querySelector(errorSelector) !== null);
        }, {timeout: 120_000}, CLEANED_IMAGE, PREVIEW_ERROR);

        const preview = await evaluateInPage(session.page, (cleanedSelector: string, errorSelector: string) => {
            const image = document.querySelector<HTMLImageElement>(cleanedSelector);
            const error = document.querySelector(errorSelector)?.textContent?.replace(/\s+/gu, ' ').trim() ?? null;
            if (!image) {
                return {
                    error,
                    painted: null,
                };
            }
            const rect = image.getBoundingClientRect();
            const probe = document.createElement('canvas');
            probe.width = Math.min(256, image.naturalWidth);
            probe.height = Math.min(256, image.naturalHeight);
            const context = probe.getContext('2d')!;
            context.drawImage(image, 0, 0, probe.width, probe.height);
            const pixels = context.getImageData(0, 0, probe.width, probe.height).data;
            let darkest = 255;
            let lightest = 0;
            for (let index = 0; index < pixels.length; index += 4) {
                const luma = (pixels[index]! * 77 + pixels[index + 1]! * 150 + pixels[index + 2]! * 29) >> 8;
                darkest = Math.min(darkest, luma);
                lightest = Math.max(lightest, luma);
            }
            return {
                error,
                painted: {
                    naturalWidth: image.naturalWidth,
                    naturalHeight: image.naturalHeight,
                    visibleWidth: rect.width,
                    visibleHeight: rect.height,
                    contrast: lightest - darkest,
                },
            };
        }, CLEANED_IMAGE, PREVIEW_ERROR);

        expect(preview.error).toBeNull();
        expect(preview.painted).not.toBeNull();
        expect(preview.painted!.naturalWidth).toBeGreaterThan(0);
        expect(preview.painted!.visibleWidth).toBeGreaterThan(100);
        expect(preview.painted!.visibleHeight).toBeGreaterThan(100);
        // Text on paper, not a blank or skeleton frame.
        expect(preview.painted!.contrast).toBeGreaterThan(64);
    }, 300_000);
});
