import {encode} from 'fast-png';
import {
    copyFileSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    join, resolve,
} from 'node:path';
import {
    PDFDict,
    PDFDocument,
    PDFName,
    PDFNumber,
    PDFRawStream,
    StandardFonts,
    setTextRenderingMode,
    TextRenderingMode,
} from 'pdf-lib';
import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {readPdfPageSnapshots} from '@tests/e2e/electron/helpers/fixtures';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    clickAsUser, clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    type IWorkspaceExposeProbeWindow,
    readWorkspaceStateValues,
} from '@tests/e2e/electron/helpers/workspaceExpose';

const FIXTURE_PNG = 'native/scan-cleanup/tests/fixtures/leaf-edge/prym-p00063-fore-edge-150dpi.png';
const FIXTURE_DPI = 150;

const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-scan-cleanup-leaf-edge-${Date.now()}`});

/** A scanned book page whose recto carries the brown fore-edge strip along its right border. */
async function createForeEdgeBookPagePdf(path: string) {
    const doc = await PDFDocument.create();
    const image = await doc.embedPng(readFileSync(resolve(process.cwd(), FIXTURE_PNG)));
    const width = image.width / FIXTURE_DPI * 72;
    const height = image.height / FIXTURE_DPI * 72;
    doc.addPage([
        width,
        height,
    ]).drawImage(image, {
        x: 0,
        y: 0,
        width,
        height,
    });
    writeFileSync(path, await doc.save());
}

interface IPageImage {
    bitsPerComponent: number | null;
    colorSpace: string | null;
    filter: string | null;
    imageMask: boolean;
}

async function readFirstPageImages(path: string): Promise<IPageImage[]> {
    const doc = await PDFDocument.load(readFileSync(path));
    const resources = doc.getPage(0).node.Resources();
    const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const images: IPageImage[] = [];
    for (const [
        , reference,
    ] of xObjects?.entries() ?? []) {
        const stream = doc.context.lookup(reference);
        if (!(stream instanceof PDFRawStream) || stream.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
        const bits = stream.dict.lookupMaybe(PDFName.of('BitsPerComponent'), PDFNumber);
        images.push({
            bitsPerComponent: bits?.asNumber() ?? null,
            colorSpace: stream.dict.get(PDFName.of('ColorSpace'))?.toString() ?? null,
            filter: stream.dict.get(PDFName.of('Filter'))?.toString() ?? null,
            imageMask: stream.dict.get(PDFName.of('ImageMask'))?.toString() === 'true',
        });
    }
    return images;
}


/** Exact curled_harness_page raster from native auto_dewarp.rs at 200 DPI.
 * Synthetic controlled rasters: curved text, curved raster-only, and the tracked affine book control.
 */
async function createPositionedTextControlsPdf(path: string) {
    const doc = await PDFDocument.create();
    doc.setCreationDate(new Date('2000-01-01T00:00:00Z'));
    doc.setModificationDate(new Date('2000-01-01T00:00:00Z'));
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const [
        pageIndex,
        amplitude,
    ] of [
            34,
            34,
        ].entries()) {
        const pixels = new Uint8Array(720 * 960).fill(241);
        for (const [
            line,
            baseline,
        ] of [
                190,
                260,
                330,
                400,
                470,
                540,
                610,
                680,
            ].entries()) {
            for (let column = 0; column < 18; column += 1) {
                const left = 105 + column * 29;
                const normalized = (left - 360) / 360;
                const top = Math.round(baseline + amplitude * normalized * normalized);
                const ink = line % 2 === 0 ? 65 : 73;
                for (const [
                    startY,
                    endY,
                    width,
                ] of [
                        [
                            top,
                            top + 15,
                            3,
                        ],
                        [
                            top,
                            top + 3,
                            10,
                        ],
                        [
                            top + 7,
                            top + 9,
                            8,
                        ],
                    ]) {
                    for (let y = startY!; y < endY!; y += 1) {
                        for (let x = left; x < left + width!; x += 1) pixels[y * 720 + x] = ink;
                    }
                }
            }
        }
        const image = await doc.embedPng(encode({
            width:720,
            height:960,
            channels:1,
            data:pixels,
        }));
        const width = 720 / 200 * 72;
        const height = 960 / 200 * 72;
        const page = doc.addPage([
            width,
            height,
        ]);
        page.drawImage(image, {
            x:0,
            y:0,
            width,
            height,
        });
        if (pageIndex !== 1) {
            page.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
            page.drawText(`POSITIONED SOURCE TEXT PAGE ${String(pageIndex + 1)}`, {
                x:40,
                y:height - 85,
                size:10,
                font,
            });
        }
    }
    const affineImage = await doc.embedPng(readFileSync(resolve(process.cwd(), FIXTURE_PNG)));
    const affineWidth = affineImage.width / FIXTURE_DPI * 72;
    const affineHeight = affineImage.height / FIXTURE_DPI * 72;
    const affinePage = doc.addPage([
        affineWidth,
        affineHeight,
    ]);
    affinePage.drawImage(affineImage, {
        x:0,
        y:0,
        width:affineWidth,
        height:affineHeight,
    });
    affinePage.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
    affinePage.drawText('POSITIONED SOURCE TEXT PAGE 3', {
        x:40,
        y:affineHeight - 85,
        size:10,
        font,
    });
    writeFileSync(path, await doc.save());

}

describe('scan cleanup of a photographed book page', () => {
    it('writes a text page with a tinted fore-edge strip as black-and-white text', async () => {
        const session = sessionFixture.getSession();
        await session.command('windowResize', [
            1280,
            900,
        ]);
        const sourceDirectory = mkdtempSync(join(tmpdir(), 'evb-e2e-cleanup-leaf-edge-'));
        onTestFinished(() => rm(sourceDirectory, {
            recursive: true,
            force: true,
        }));
        const sourcePath = join(sourceDirectory, 'fore-edge-book-page.pdf');
        await createForeEdgeBookPagePdf(sourcePath);
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
        await waitForFunctionInPage(session.page, () => {
            const action = document.querySelector<HTMLButtonElement>('.scan-cleanup-toolbar-primary-action');
            if (!action || action.disabled || action.getAttribute('aria-disabled') === 'true') return false;
            const rect = action.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return (hit === action || action.contains(hit))
                && document.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status') === 'completed'
                && !/Building cleanup preview|Preview updating|Updating preview|Reading page images/i.test(document.body.innerText);
        }, {timeout: 120_000});
        await clickAsUser(session.page, '.scan-cleanup-toolbar-primary-action');

        await waitForFunctionInPage(session.page, (source: string) => {
            const active = (window as IWorkspaceExposeProbeWindow)
                .__evbTestApi
                ?.readActiveWorkspaceStateValues?.(['originalPath']);
            return typeof active?.originalPath === 'string'
                && active.originalPath !== source
                && active.originalPath.endsWith('— cleaned.pdf');
        }, {timeout: 180_000}, sourcePath);
        const outputState = await readWorkspaceStateValues(session.page, ['originalPath']);
        const outputPath = outputState.originalPath;
        expect(typeof outputPath).toBe('string');

        const images = await readFirstPageImages(outputPath as string);
        console.log('scan-cleanup-leaf-edge-images', JSON.stringify(images));
        expect(images.length).toBeGreaterThan(0);
        expect(images.filter(image => image.bitsPerComponent !== 1 && !image.imageMask)).toEqual([]);
    }, 300_000);
    it('names only text-bearing non-affine source pages in the completion notice', async () => {
        const session = sessionFixture.getSession();
        await session.command('windowResize', [
            1280,
            900,
        ]);
        const sourceDirectory = mkdtempSync(join(tmpdir(), 'evb-e2e-cleanup-leaf-edge-'));
        onTestFinished(() => rm(sourceDirectory, {
            recursive: true,
            force: true,
        }));
        const sourcePath = join(sourceDirectory, 'fore-edge-book-page.pdf');
        await createPositionedTextControlsPdf(sourcePath);
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
        await clickAsUser(session.page, '.scan-cleanup-advanced-toggle');
        await clickFoundAsUser(session.page, (text: string) => Array.from(document.querySelectorAll('label')).find(label => label.textContent?.trim() === text), 'Automatically correct page curvature (experimental)', {description:'automatic dewarp checkbox'});
        await waitForFunctionInPage(session.page, () => {
            const action = document.querySelector<HTMLButtonElement>('.scan-cleanup-toolbar-primary-action');
            if (!action || action.disabled || action.getAttribute('aria-disabled') === 'true') return false;
            const rect = action.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return (hit === action || action.contains(hit))
                && document.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status') === 'completed'
                && !/Building cleanup preview|Preview updating|Updating preview|Reading page images/i.test(document.body.innerText);
        }, {timeout: 120_000});
        await clickAsUser(session.page, '.scan-cleanup-toolbar-primary-action');

        await waitForFunctionInPage(session.page, (source: string) => {
            const active = (window as IWorkspaceExposeProbeWindow)
                .__evbTestApi
                ?.readActiveWorkspaceStateValues?.(['originalPath']);
            return typeof active?.originalPath === 'string'
                && active.originalPath !== source
                && active.originalPath.endsWith('— cleaned.pdf');
        }, {timeout: 180_000}, sourcePath);
        const outputState = await readWorkspaceStateValues(session.page, ['originalPath']);
        const outputPath = outputState.originalPath;
        expect(typeof outputPath).toBe('string');

        await waitForFunctionInPage(session.page, () => document.body.innerText.includes('source pages became'), {timeout: 20_000});
        const renderedText = await session.page.evaluate(() => document.body.innerText);
        const evidenceDirectory = process.env.EVB_SCAN_CLEANUP_EVIDENCE_DIR;
        if (evidenceDirectory) {
            mkdirSync(evidenceDirectory, {recursive: true});
            copyFileSync(sourcePath, join(evidenceDirectory, 'source.pdf'));
            copyFileSync(outputPath as string, join(evidenceDirectory, 'output.pdf'));
            await session.page.screenshot({path: join(evidenceDirectory, 'completion.png')});
            writeFileSync(join(evidenceDirectory, 'rendered-text.txt'), renderedText);
            writeFileSync(join(evidenceDirectory, 'app-session.json'), JSON.stringify({
                name: session.name,
                outputPath,
            }, null, 2));
        }
        const sourcePages = await readPdfPageSnapshots(sourcePath);
        const outputPages = await readPdfPageSnapshots(outputPath as string);
        expect(sourcePages.map(page => page.textSnippet)).toEqual([
            'POSITIONED SOURCE TEXT PAGE 1',
            '',
            'POSITIONED SOURCE TEXT PAGE 3',
        ]);
        expect(outputPages.map(page => page.textSnippet)).toEqual([
            '',
            '',
            'POSITIONED SOURCE TEXT PAGE 3',
        ]);
        expect(renderedText).toContain('Source text was omitted from outputs of 1 source page(s): 1. Search and copy are unavailable on the affected output pages.');
    }, 300_000);
});
