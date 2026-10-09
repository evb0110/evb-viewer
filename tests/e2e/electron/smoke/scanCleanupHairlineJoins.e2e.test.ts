import {execFile} from 'node:child_process';
import {
    mkdtempSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {
    decode,
    encode,
} from 'fast-png';
import {
    PDFDict,
    PDFDocument,
    PDFName,
    PDFNumber,
    PDFRawStream,
} from 'pdf-lib';
import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    dismissScanCleanupFirstRunGuidance,
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    type IWorkspaceExposeProbeWindow,
    readWorkspaceStateValues,
} from '@tests/e2e/electron/helpers/workspaceExpose';

const execFileAsync = promisify(execFile);

// A high-contrast book face scanned at 300 DPI, like the owner's 1858
// Prym-Socin edition: every glyph is an `n` whose two stems join through a
// hairline shoulder narrower than a pixel. The scan records that hairline
// lighter than the paper/ink midpoint, which the global threshold cut, so each
// letter fell apart into two stems or, where a rescue re-added its gray halo,
// turned bold.
const SCAN_DPI = 300;
const PAGE_WIDTH = 1700;
const PAGE_HEIGHT = 2400;
const PAPER = 225;
const INK = 60;
const LINES = 24;
const GLYPHS_PER_LINE = 24;
const STEM_WIDTH = 6;
const STEM_HEIGHT = 36;
const COUNTER_WIDTH = 22;
const GLYPH_PITCH = 52;
const LINE_PITCH = 80;
const FIRST_LINE_TOP = 300;
const FIRST_GLYPH_LEFT = 200;
const HAIRLINE_COVERAGE = 0.525;
const MINIMUM_GLYPH_AREA = 50;

const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-scan-cleanup-hairline-${Date.now()}`});

/** Sharp ink coverage of the glyph grid, before the scan blurs it. */
function paintGlyphCoverage() {
    const coverage = new Float32Array(PAGE_WIDTH * PAGE_HEIGHT);
    const fill = (left: number, top: number, width: number, height: number, value = 1) => {
        for (let y = top; y < top + height; y += 1) {
            coverage.fill(value, y * PAGE_WIDTH + left, y * PAGE_WIDTH + left + width);
        }
    };
    for (let line = 0; line < LINES; line += 1) {
        const top = FIRST_LINE_TOP + line * LINE_PITCH;
        for (let glyph = 0; glyph < GLYPHS_PER_LINE; glyph += 1) {
            const left = FIRST_GLYPH_LEFT + glyph * GLYPH_PITCH;
            fill(left, top, STEM_WIDTH, STEM_HEIGHT);
            fill(left + STEM_WIDTH + COUNTER_WIDTH, top, STEM_WIDTH, STEM_HEIGHT);
            fill(left + STEM_WIDTH, top + 4, COUNTER_WIDTH, 1, HAIRLINE_COVERAGE);
        }
    }
    return coverage;
}

/** Scans the coverage through the narrow separable blur of a sharp 300 DPI scan. */
function scanCoverage(coverage: Float32Array) {
    const kernel = [
        1,
        6,
        1,
    ];
    const blur = (source: Float32Array, stepX: number, stepY: number) => {
        const output = new Float32Array(source.length);
        for (let y = 0; y < PAGE_HEIGHT; y += 1) {
            for (let x = 0; x < PAGE_WIDTH; x += 1) {
                let sum = 0;
                for (let tap = 0; tap < kernel.length; tap += 1) {
                    const sx = x + (tap - 1) * stepX;
                    const sy = y + (tap - 1) * stepY;
                    if (sx >= 0 && sx < PAGE_WIDTH && sy >= 0 && sy < PAGE_HEIGHT) {
                        sum += kernel[tap]! * source[sy * PAGE_WIDTH + sx]!;
                    }
                }
                output[y * PAGE_WIDTH + x] = sum / 8;
            }
        }
        return output;
    };
    const blurred = blur(blur(coverage, 1, 0), 0, 1);
    const pixels = new Uint8Array(PAGE_WIDTH * PAGE_HEIGHT);
    for (let index = 0; index < pixels.length; index += 1) {
        pixels[index] = Math.round(PAPER - blurred[index]! * (PAPER - INK));
    }
    return pixels;
}

async function createHairlineFacePdf(path: string) {
    const coverage = paintGlyphCoverage();
    const doc = await PDFDocument.create();
    const image = await doc.embedPng(encode({
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        channels: 1,
        data: scanCoverage(coverage),
    }));
    const width = PAGE_WIDTH / SCAN_DPI * 72;
    const height = PAGE_HEIGHT / SCAN_DPI * 72;
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
    return coverage.reduce((sum, value) => sum + value, 0);
}

/** The pixel density of the first page's image, so a render maps it 1:1. */
async function readFirstPageImageDpi(path: string) {
    const doc = await PDFDocument.load(readFileSync(path));
    const page = doc.getPage(0);
    const xObjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    let widest = 0;
    for (const [
        , reference,
    ] of xObjects?.entries() ?? []) {
        const stream = doc.context.lookup(reference);
        if (!(stream instanceof PDFRawStream) || stream.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
        widest = Math.max(widest, stream.dict.lookupMaybe(PDFName.of('Width'), PDFNumber)?.asNumber() ?? 0);
    }
    expect(widest).toBeGreaterThan(0);
    return widest / page.getWidth() * 72;
}

interface IInkRaster {
    ink: Uint8Array;
    width: number;
    height: number;
}

/** The rendered first page as ink (true) and paper (false). */
async function renderFirstPageInk(pdfPath: string, directory: string): Promise<IInkRaster> {
    const prefix = join(directory, 'cleaned-page');
    await execFileAsync(getPdfNativeToolPaths().pdftoppm, [
        '-png',
        '-gray',
        '-singlefile',
        '-aa',
        'no',
        '-aaVector',
        'no',
        '-r',
        String(await readFirstPageImageDpi(pdfPath)),
        '-f',
        '1',
        '-l',
        '1',
        pdfPath,
        prefix,
    ], {timeout: 60_000});
    const image = decode(readFileSync(`${prefix}.png`));
    const channels = image.data.length / (image.width * image.height);
    const ink = new Uint8Array(image.width * image.height);
    for (let index = 0; index < ink.length; index += 1) {
        ink[index] = image.data[index * channels]! < 128 ? 1 : 0;
    }
    return {
        ink,
        width: image.width,
        height: image.height,
    };
}

/** Areas of the 8-connected ink shapes. */
function inkShapeAreas({
    ink, width, height,
}: IInkRaster) {
    const label = new Int32Array(ink.length).fill(-1);
    const areas: number[] = [];
    const stack: number[] = [];
    for (let start = 0; start < ink.length; start += 1) {
        if (!ink[start] || label[start] !== -1) continue;
        const shape = areas.length;
        let area = 0;
        label[start] = shape;
        stack.push(start);
        while (stack.length > 0) {
            const index = stack.pop()!;
            area += 1;
            const x = index % width;
            const y = (index - x) / width;
            for (let dy = -1; dy <= 1; dy += 1) {
                for (let dx = -1; dx <= 1; dx += 1) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                    const neighbor = ny * width + nx;
                    if (ink[neighbor] && label[neighbor] === -1) {
                        label[neighbor] = shape;
                        stack.push(neighbor);
                    }
                }
            }
        }
        areas.push(area);
    }
    return areas;
}

describe('scan cleanup of a high-contrast book face', () => {
    it('keeps each letter whole when its hairline is lighter than the threshold', async () => {
        const session = sessionFixture.getSession();
        await session.command('windowResize', [
            1280,
            900,
        ]);
        const directory = mkdtempSync(join(tmpdir(), 'evb-e2e-cleanup-hairline-'));
        onTestFinished(() => rm(directory, {
            recursive: true,
            force: true,
        }));
        const sourcePath = join(directory, 'hairline-face-scan.pdf');
        const sharpInk = await createHairlineFacePdf(sourcePath);
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
        // Auto keeps a page this regular in grayscale; the owner's text pages
        // were written in black and white, so choose it as a user would.
        await waitForFunctionInPage(session.page, () => (
            document.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status') === 'completed'
        ), {timeout: 120_000});
        const blackAndWhite = '[role="radiogroup"][aria-label="Output"] [role="radio"][aria-label="Black and white"]';
        await clickAsUser(session.page, blackAndWhite);
        await waitForFunctionInPage(session.page, (selector: string) => (
            document.querySelector(selector)?.getAttribute('aria-checked') === 'true'
        ), {timeout: 5_000}, blackAndWhite);
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
        const {originalPath: outputPath} = await readWorkspaceStateValues(session.page, ['originalPath']);
        expect(typeof outputPath).toBe('string');

        const rendered = await renderFirstPageInk(outputPath as string, directory);
        const glyphs = inkShapeAreas(rendered).filter(area => area >= MINIMUM_GLYPH_AREA);
        const inkArea = glyphs.reduce((sum, area) => sum + area, 0);
        console.log('scan-cleanup-hairline-joins', JSON.stringify({
            shapes: glyphs.length,
            inkArea,
            sharpInk,
        }));
        // One shape per letter: the shoulder still joins both stems.
        expect(glyphs).toHaveLength(LINES * GLYPHS_PER_LINE);
        // Whole letters, not bolder ones: the cleaned ink stays within a tenth
        // of the printed area. One pixel of halo around every stem adds a third.
        expect(inkArea).toBeLessThan(sharpInk * 1.1);
    }, 300_000);
});
