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
    PDFBool,
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

// Both fixtures are 300 DPI scans of book pages.
const SCAN_DPI = 300;
const PAGE_WIDTH = 1700;
const PAGE_HEIGHT = 2400;
const MINIMUM_GLYPH_AREA = 50;

// A high-contrast book face, like the owner's 1858 Prym-Socin edition: every
// glyph is an `n` whose two stems join through a hairline shoulder narrower
// than a pixel. The scan records that hairline lighter than the paper/ink
// midpoint, which the global threshold cut, so each letter fell apart into two
// stems or, where a rescue re-added its gray halo, turned bold.
const HAIRLINE_PAPER = 225;
const HAIRLINE_INK = 60;
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
const SHARP_SCAN_KERNEL = [
    1,
    6,
    1,
];

// A soft scan of a title page and a contents page, like the owner's 1915
// Bergsträsser edition. The title page's large letters sit on gray paper next
// to the dark scanner bed; the adaptive threshold Auto used to pick there cut
// near the paper and printed every letter far bolder than the book. The
// contents page has a few lines of type beside a gutter shadow that covers
// more of the page than the ink, which Auto used to keep in grayscale.
const SOFT_PAPER = 222;
const TITLE_INK = 40;
const SCANNER_BED = 70;
const SCANNER_BED_WIDTH = 70;
const TITLE_STEM = 10;
const TITLE_HEIGHT = 90;
const TITLE_COUNTER = 40;
const TITLE_PITCH = 110;
const TITLE_LINES: ReadonlyArray<readonly [number, number]> = [
    [
        900,
        9,
    ],
    [
        1200,
        7,
    ],
    [
        1500,
        9,
    ],
];
const CONTENTS_INK = 100;
const GUTTER_WIDTH = 150;
const GUTTER_DARKEST = 180;
const SOFT_SCAN_KERNEL = [
    1,
    4,
    6,
    4,
    1,
];

const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-scan-cleanup-hairline-${Date.now()}`});

/** An ink coverage plane on which glyph rectangles can be painted. */
function createCoverage() {
    const coverage = new Float32Array(PAGE_WIDTH * PAGE_HEIGHT);
    const fill = (left: number, top: number, width: number, height: number, value = 1) => {
        for (let y = top; y < top + height; y += 1) {
            coverage.fill(value, y * PAGE_WIDTH + left, y * PAGE_WIDTH + left + width);
        }
    };
    return {
        coverage,
        fill,
    };
}

/** Blurs a plane with a separable kernel, as a scanner's optics do. */
function blur(source: Float32Array, kernel: readonly number[]) {
    const weight = kernel.reduce((total, value) => total + value, 0);
    const radius = (kernel.length - 1) / 2;
    const pass = (input: Float32Array, stepX: number, stepY: number) => {
        const output = new Float32Array(input.length);
        for (let y = 0; y < PAGE_HEIGHT; y += 1) {
            for (let x = 0; x < PAGE_WIDTH; x += 1) {
                let total = 0;
                for (let tap = 0; tap < kernel.length; tap += 1) {
                    const sx = x + (tap - radius) * stepX;
                    const sy = y + (tap - radius) * stepY;
                    if (sx >= 0 && sx < PAGE_WIDTH && sy >= 0 && sy < PAGE_HEIGHT) {
                        total += kernel[tap]! * input[sy * PAGE_WIDTH + sx]!;
                    }
                }
                output[y * PAGE_WIDTH + x] = total / weight;
            }
        }
        return output;
    };
    return pass(pass(source, 1, 0), 0, 1);
}

function coverageArea(coverage: Float32Array) {
    return coverage.reduce((total, value) => total + value, 0);
}

/** Writes one page per gray raster, its pixels placed at `dpi`. */
async function writeScanPdf(path: string, pages: Uint8Array[], dpi = SCAN_DPI) {
    const doc = await PDFDocument.create();
    const width = PAGE_WIDTH / dpi * 72;
    const height = PAGE_HEIGHT / dpi * 72;
    for (const data of pages) {
        const image = await doc.embedPng(encode({
            width: PAGE_WIDTH,
            height: PAGE_HEIGHT,
            channels: 1,
            data,
        }));
        doc.addPage([
            width,
            height,
        ]).drawImage(image, {
            x: 0,
            y: 0,
            width,
            height,
        });
    }
    writeFileSync(path, await doc.save());
}

/** The hairline face; returns its sharp ink area. */
async function createHairlineFacePdf(path: string) {
    const {
        coverage, fill,
    } = createCoverage();
    for (let line = 0; line < LINES; line += 1) {
        const top = FIRST_LINE_TOP + line * LINE_PITCH;
        for (let glyph = 0; glyph < GLYPHS_PER_LINE; glyph += 1) {
            const left = FIRST_GLYPH_LEFT + glyph * GLYPH_PITCH;
            fill(left, top, STEM_WIDTH, STEM_HEIGHT);
            fill(left + STEM_WIDTH + COUNTER_WIDTH, top, STEM_WIDTH, STEM_HEIGHT);
            fill(left + STEM_WIDTH, top + 4, COUNTER_WIDTH, 1, HAIRLINE_COVERAGE);
        }
    }
    const scanned = blur(coverage, SHARP_SCAN_KERNEL);
    const pixels = new Uint8Array(scanned.length);
    for (let index = 0; index < pixels.length; index += 1) {
        pixels[index] = Math.round(HAIRLINE_PAPER - scanned[index]! * (HAIRLINE_PAPER - HAIRLINE_INK));
    }
    await writeScanPdf(path, [pixels]);
    return coverageArea(coverage);
}

/** The soft title and contents pages; returns the title's sharp ink area. */
async function createSoftScanPdf(path: string) {
    const title = createCoverage();
    for (const [
        top,
        count,
    ] of TITLE_LINES) {
        const start = Math.floor((PAGE_WIDTH - count * TITLE_PITCH) / 2);
        for (let glyph = 0; glyph < count; glyph += 1) {
            const left = start + glyph * TITLE_PITCH;
            title.fill(left, top, TITLE_STEM, TITLE_HEIGHT);
            title.fill(left + TITLE_STEM + TITLE_COUNTER, top, TITLE_STEM, TITLE_HEIGHT);
            title.fill(left, top, 2 * TITLE_STEM + TITLE_COUNTER, TITLE_STEM / 2);
        }
    }
    const titleScan = blur(blur(title.coverage, SOFT_SCAN_KERNEL), SOFT_SCAN_KERNEL);
    const titlePixels = new Uint8Array(titleScan.length);
    for (let y = 0; y < PAGE_HEIGHT; y += 1) {
        for (let x = 0; x < PAGE_WIDTH; x += 1) {
            const index = y * PAGE_WIDTH + x;
            titlePixels[index] = x < SCANNER_BED_WIDTH || y < SCANNER_BED_WIDTH
                ? SCANNER_BED
                : Math.round(SOFT_PAPER - titleScan[index]! * (SOFT_PAPER - TITLE_INK));
        }
    }

    await writeScanPdf(path, [
        titlePixels,
        createContentsPixels(7, 6, GUTTER_WIDTH),
    ]);
    return coverageArea(title.coverage);
}

/** Short lines of soft contents type, beside a gutter shadow `gutter` pixels wide. */
function createContentsPixels(lines: number, glyphsPerLine: number, gutter: number) {
    const contents = createCoverage();
    for (let line = 0; line < lines; line += 1) {
        const top = 820 + line * 76;
        for (let glyph = 0; glyph < glyphsPerLine; glyph += 1) {
            const left = 380 + glyph * 60;
            contents.fill(left, top, 5, 38);
            contents.fill(left, top, 32, 5);
            contents.fill(left, top + 33, 32, 5);
        }
    }
    const scan = blur(contents.coverage, SOFT_SCAN_KERNEL);
    const pixels = new Uint8Array(scan.length);
    for (let y = 0; y < PAGE_HEIGHT; y += 1) {
        for (let x = 0; x < PAGE_WIDTH; x += 1) {
            const index = y * PAGE_WIDTH + x;
            const paper = x < gutter
                ? GUTTER_DARKEST + x * (SOFT_PAPER - GUTTER_DARKEST) / gutter
                : SOFT_PAPER;
            pixels[index] = Math.round(paper - scan[index]! * (SOFT_PAPER - CONTENTS_INK));
        }
    }
    return pixels;
}

/**
 * The widest image on a page sets its pixel density; the page is 1-bit only
 * when every image on it is, so a layered page with a gray background is not.
 */
async function readPageImage(path: string, pageIndex: number) {
    const doc = await PDFDocument.load(readFileSync(path));
    const page = doc.getPage(pageIndex);
    const xObjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    let widest = 0;
    let bilevel = true;
    for (const [
        , reference,
    ] of xObjects?.entries() ?? []) {
        const stream = doc.context.lookup(reference);
        if (!(stream instanceof PDFRawStream) || stream.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
        const width = stream.dict.lookupMaybe(PDFName.of('Width'), PDFNumber)?.asNumber() ?? 0;
        if (width <= 0) continue;
        widest = Math.max(widest, width);
        bilevel &&= stream.dict.lookupMaybe(PDFName.of('ImageMask'), PDFBool)?.asBoolean() === true
            || stream.dict.lookupMaybe(PDFName.of('BitsPerComponent'), PDFNumber)?.asNumber() === 1;
    }
    expect(widest).toBeGreaterThan(0);
    return {
        dpi: widest / page.getWidth() * 72,
        bilevel,
        width: page.getWidth(),
        height: page.getHeight(),
    };
}

interface IInkRaster {
    ink: Uint8Array;
    width: number;
    height: number;
}

/** A rendered page as ink (true) and paper (false), one pixel per image pixel. */
async function renderPageInk(pdfPath: string, directory: string, pageNumber: number): Promise<IInkRaster> {
    const prefix = join(directory, `cleaned-page-${pageNumber}`);
    const {dpi} = await readPageImage(pdfPath, pageNumber - 1);
    await execFileAsync(getPdfNativeToolPaths().pdftoppm, [
        '-png',
        '-gray',
        '-singlefile',
        '-aa',
        'no',
        '-aaVector',
        'no',
        '-r',
        String(dpi),
        '-f',
        String(pageNumber),
        '-l',
        String(pageNumber),
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

/** Opens a scan, runs scan cleanup as a user would, and returns the cleaned path. */
async function cleanScan(sourcePath: string, options: {blackAndWhite: boolean}) {
    const session = sessionFixture.getSession();
    await session.command('windowResize', [
        1280,
        900,
    ]);
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
    await waitForFunctionInPage(session.page, () => (
        document.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status') === 'completed'
    ), {timeout: 120_000});
    if (options.blackAndWhite) {
        const blackAndWhite = '[role="radiogroup"][aria-label="Output"] [role="radio"][aria-label="Black and white"]';
        await clickAsUser(session.page, blackAndWhite);
        await waitForFunctionInPage(session.page, (selector: string) => (
            document.querySelector(selector)?.getAttribute('aria-checked') === 'true'
        ), {timeout: 5_000}, blackAndWhite);
    }
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
    return outputPath as string;
}

function createScratchDirectory(prefix: string) {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    onTestFinished(() => rm(directory, {
        recursive: true,
        force: true,
    }));
    return directory;
}

describe('scan cleanup of a high-contrast book face', () => {
    it('keeps each letter whole when its hairline is lighter than the threshold', async () => {
        const directory = createScratchDirectory('evb-e2e-cleanup-hairline-');
        const sourcePath = join(directory, 'hairline-face-scan.pdf');
        const sharpInk = await createHairlineFacePdf(sourcePath);
        // Choose black and white as a user would; this test is about the cut.
        const outputPath = await cleanScan(sourcePath, {blackAndWhite: true});

        const glyphs = inkShapeAreas(await renderPageInk(outputPath, directory, 1))
            .filter(area => area >= MINIMUM_GLYPH_AREA);
        const inkArea = glyphs.reduce((total, area) => total + area, 0);
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

describe('automatic scan cleanup of a soft book scan', () => {
    it('prints the title at its own weight and keeps a shaded contents page black and white', async () => {
        const directory = createScratchDirectory('evb-e2e-cleanup-soft-scan-');
        const sourcePath = join(directory, 'soft-book-scan.pdf');
        const sharpInk = await createSoftScanPdf(sourcePath);
        const outputPath = await cleanScan(sourcePath, {blackAndWhite: false});

        const title = await readPageImage(outputPath, 0);
        const contents = await readPageImage(outputPath, 1);
        const glyphs = inkShapeAreas(await renderPageInk(outputPath, directory, 1))
            .filter(area => area >= MINIMUM_GLYPH_AREA);
        const inkArea = glyphs.reduce((total, area) => total + area, 0);
        console.log('scan-cleanup-soft-scan', JSON.stringify({
            titleBilevel: title.bilevel,
            contentsBilevel: contents.bilevel,
            shapes: glyphs.length,
            inkArea,
            sharpInk,
        }));
        expect(title.bilevel).toBe(true);
        expect(glyphs).toHaveLength(TITLE_LINES.reduce((total, line) => total + line[1], 0));
        // The printed weight: an adaptive cut near the paper made these
        // letters about two fifths heavier.
        expect(inkArea).toBeGreaterThan(sharpInk * 0.85);
        expect(inkArea).toBeLessThan(sharpInk * 1.15);
        // Black type beside a gutter shadow is still a black-and-white page.
        expect(contents.bilevel).toBe(true);
    }, 300_000);
});

describe('automatic scan cleanup of a scan placed at one pixel per point', () => {
    it('cleans a sparse page to black and white and keeps its page size', async () => {
        const directory = createScratchDirectory('evb-e2e-cleanup-placeholder-dpi-');
        const sourcePath = join(directory, 'placeholder-dpi-scan.pdf');
        // A 300 dpi page whose PDF declares 72 dpi, which makes it 85 cm tall.
        await writeScanPdf(sourcePath, [createContentsPixels(2, 3, 0)], 72);
        const outputPath = await cleanScan(sourcePath, {blackAndWhite: false});

        const page = await readPageImage(outputPath, 0);
        const glyphs = inkShapeAreas(await renderPageInk(outputPath, directory, 1))
            .filter(area => area >= MINIMUM_GLYPH_AREA);
        console.log('scan-cleanup-placeholder-dpi', JSON.stringify(page), glyphs.length);
        expect(page.bilevel).toBe(true);
        // The source's page, its pixels still placed at one per point.
        expect(page.width).toBeCloseTo(PAGE_WIDTH, 3);
        expect(page.height).toBeCloseTo(PAGE_HEIGHT, 3);
        expect(page.dpi).toBeCloseTo(72, 3);
        expect(glyphs).toHaveLength(6);
    }, 300_000);
});
