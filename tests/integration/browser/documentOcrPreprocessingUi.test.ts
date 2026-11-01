import {
    mkdir, writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {
    describe, expect, it,
} from 'vitest';
import {
    lifecycle, openPdfFromChooser,
} from './documentLifecycleTestHelpers';

const DPI = 300;
const WIDTH_PX = 2100;
const HEIGHT_PX = 1200;
const FONT_PX = 58;
const SKEW_DEGREES = 2;
const LINES = [
    'The harbour lamps were lit before the fishing boats returned,',
    'and the keeper counted every vessel as it rounded the pier.',
    'Seven boats had left at dawn; only six were moored by evening.',
    'He walked the length of the quay twice, listening for oars,',
    'then climbed the narrow stair to the lantern room above.',
    'From there the whole bay opened like a map in silver ink.',
    'Near midnight a small light answered, faint and unsteady.',
];

interface IDrawnWord {
    text: string;
    line: number;
    x: number;
    y: number;
}

type TScanKind = 'negative' | 'faded';

/**
 * A tilted scan and each word's ink centre in raster pixels. `negative`: light
 * glyphs on a dark page with heavy grain and speckles, which Tesseract alone
 * reads as nothing and desktop's polarity pass makes readable. `faded`: faded
 * ink darkening across the page under JPEG, which a clean scan straightens,
 * so its words must be mapped back onto the tilted page.
 */
async function drawScan(kind: TScanKind) {
    const page = await lifecycle.browser.newPage();
    try {
        return await page.evaluate(async ({
            kind, lines, width, height, fontPx, skewDegrees,
        }) => {
            const canvas = new OffscreenCanvas(width, height);
            const context = canvas.getContext('2d', {willReadFrequently: true})!;
            context.fillStyle = '#fff';
            context.fillRect(0, 0, width, height);
            context.fillStyle = '#000';
            context.font = `${fontPx}px serif`;
            if (kind === 'faded') context.filter = 'blur(1px)';
            const angle = skewDegrees * Math.PI / 180;
            const centre = [
                width / 2,
                height / 2,
            ] as const;
            const rotate = (x: number, y: number) => [
                centre[0] + (x - centre[0]) * Math.cos(angle) - (y - centre[1]) * Math.sin(angle),
                centre[1] + (x - centre[0]) * Math.sin(angle) + (y - centre[1]) * Math.cos(angle),
            ] as const;
            context.translate(...centre);
            context.rotate(angle);
            context.translate(-centre[0], -centre[1]);
            const words: IDrawnWord[] = [];
            lines.forEach((line, index) => {
                const baseline = 230 + index * 125;
                context.fillText(line, 160, baseline);
                let x = 160;
                for (const text of line.split(' ')) {
                    const metrics = context.measureText(text);
                    const [
                        cx,
                        cy,
                    ] = rotate(x + metrics.width / 2, baseline - (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2);
                    words.push({
                        text,
                        line: index,
                        x: cx,
                        y: cy,
                    });
                    x += metrics.width + context.measureText(' ').width;
                }
            });
            const image = context.getImageData(0, 0, width, height);
            let seed = kind === 'negative' ? 7 : 11;
            const random = () => {
                seed = (seed + 0x6D2B79F5) | 0;
                let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
            const grain = () => Math.sqrt(-2 * Math.log(random() || 1e-12)) * Math.cos(2 * Math.PI * random());
            for (let offset = 0; offset < image.data.length; offset += 4) {
                let value: number;
                if (kind === 'negative') {
                    value = (255 - image.data[offset]! - 40) / 150 * 255 + grain() * 70;
                    const speckle = random();
                    if (speckle < 0.06) value = 0;
                    else if (speckle < 0.12) value = 255;
                } else {
                    value = (255 * 0.32 + image.data[offset]! * 0.68) * (1 - 0.25 * (offset / 4 % width) / width) + grain() * 4;
                }
                image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = Math.max(0, Math.min(255, Math.round(value)));
            }
            context.resetTransform();
            context.putImageData(image, 0, 0);
            const encoded = new Uint8Array(await (await canvas.convertToBlob(kind === 'negative'
                ? {type: 'image/png'}
                : {
                    type: 'image/jpeg',
                    quality: 0.5,
                })).arrayBuffer());
            let binary = '';
            for (let index = 0; index < encoded.length; index += 0x8000) binary += String.fromCharCode(...encoded.subarray(index, index + 0x8000));
            return {
                image: btoa(binary),
                words,
            };
        }, {
            kind,
            lines: LINES,
            width: WIDTH_PX,
            height: HEIGHT_PX,
            fontPx: FONT_PX,
            skewDegrees: SKEW_DEGREES,
        });
    } finally {
        await page.close();
    }
}

describe('browser OCR preprocessing', () => {
    it('preprocesses tilted scans as desktop does, placing every word over its glyphs', async () => {
        const evidence = process.env.EVB_OCR_PREPROCESSING_EVIDENCE_DIR;
        if (evidence) await mkdir(evidence, {recursive: true});
        // Off still normalizes polarity, as on desktop. Clean scan also
        // straightens the page, so the writer must map each word back through
        // the inverse transform onto the page as scanned.
        for (const [
            kind,
            mode,
        ] of [
                [
                    'negative',
                    'Off',
                ],
                [
                    'faded',
                    'Clean scan',
                ],
            ] as const) {
            const drawn = await drawScan(kind);
            const fixture = await PDFDocument.create();
            const bytes = Buffer.from(drawn.image, 'base64');
            const scan = kind === 'negative' ? await fixture.embedPng(bytes) : await fixture.embedJpg(bytes);
            fixture.addPage([
                WIDTH_PX / DPI * 72,
                HEIGHT_PX / DPI * 72,
            ]).drawImage(scan, {
                x: 0,
                y: 0,
                width: WIDTH_PX / DPI * 72,
                height: HEIGHT_PX / DPI * 72,
            });
            const pdf = Buffer.from(await fixture.save());
            if (evidence) {
                await writeFile(join(evidence, `${kind}-scan.pdf`), pdf);
                await writeFile(join(evidence, `${kind}-drawn-words.json`), JSON.stringify(drawn.words, null, 1));
            }
            // Words that occur once on the page, so each layer word has one drawn place.
            const unique = drawn.words.filter(word => drawn.words.filter(other => other.text === word.text).length === 1);
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1440,
                height: 900,
            }});
            try {
                await page.route('**/eng.traineddata', route => route.fulfill({path: join(process.cwd(), 'resources/tesseract/tessdata/eng.traineddata')}));
                await openPdfFromChooser(page, {
                    name: `${kind}-scan.pdf`,
                    mimeType: 'application/pdf',
                    buffer: pdf,
                });
                await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
                await page.getByRole('button', {
                    name: 'OCR',
                    exact: true,
                }).click();
                const dialog = page.getByRole('dialog');
                const preprocessing = dialog.getByRole('group', {name: /^Preprocessing/u});
                await preprocessing.getByText(mode, {exact: true}).click();
                await expect.poll(() => preprocessing.getByRole('radio', {name: mode}).isChecked()).toBe(true);
                await dialog.getByRole('button', {name: /^(Download and start OCR|Start OCR)$/u}).click();
                await page.waitForFunction(() => {
                    const element = document.querySelector('[role="dialog"]');
                    return element?.querySelector('[role="alert"]')
                        || element?.textContent?.includes('OCR complete - PDF is now searchable');
                }, undefined, {timeout: 150_000});
                const terminal = await dialog.innerText();
                if (evidence) await page.screenshot({path: join(evidence, `${kind}-complete.png`)});
                expect(terminal).toContain('OCR complete - PDF is now searchable');
                await dialog.getByRole('button', {
                    name: 'Close',
                    exact: true,
                }).last().click();
                await page.waitForFunction(() => document.querySelector('.page_container[data-page="1"] .textLayer')
                    ?.getAttribute('data-pdf-text-layer-ready') === 'true'
                    && (document.querySelector('.page_container[data-page="1"] .textLayer')?.textContent ?? '').includes('harbour'), undefined, {timeout: 30_000});
                // Each layer word's box on screen, in raster pixels of the page.
                // PDF.js may join neighbouring words into one span, so measure the words' characters.
                const layer = await page.evaluate(({
                    width, height,
                }) => {
                    const container = document.querySelector('.page_container[data-page="1"]')!;
                    const pageBox = container.querySelector('canvas')!.getBoundingClientRect();
                    const range = document.createRange();
                    return [...container.querySelectorAll<HTMLElement>('.textLayer span')].flatMap((span) => {
                        const node = span.firstChild;
                        if (node?.nodeType !== Node.TEXT_NODE) return [];
                        return [...(node.textContent ?? '').matchAll(/\S+/gu)].map((match) => {
                            range.setStart(node, match.index);
                            range.setEnd(node, match.index + match[0].length);
                            const box = range.getBoundingClientRect();
                            return {
                                text: match[0],
                                x: (box.left + box.width / 2 - pageBox.left) / pageBox.width * width,
                                y: (box.top + box.height / 2 - pageBox.top) / pageBox.height * height,
                            };
                        });
                    });
                }, {
                    width: WIDTH_PX,
                    height: HEIGHT_PX,
                });
                if (evidence) {
                    await page.screenshot({path: join(evidence, `${kind}-text-layer.png`)});
                    await writeFile(join(evidence, `${kind}-layer.json`), JSON.stringify(layer, null, 1));
                }
                const recognized = layer.map(word => word.text);
                const unread = [...recognized];
                const read = drawn.words.filter((word) => {
                    const index = unread.indexOf(word.text);
                    if (index >= 0) unread.splice(index, 1);
                    return index >= 0;
                });
                expect(read.length, `recognized: ${recognized.join(' ')}`).toBeGreaterThanOrEqual(drawn.words.length * 0.95);
                const placed = unique.flatMap((word) => {
                    const match = layer.find(candidate => candidate.text === word.text);
                    return match ? [{
                        word,
                        dx: match.x - word.x,
                        dy: match.y - word.y,
                        x: match.x,
                        y: match.y,
                    }] : [];
                });
                expect(placed.length).toBeGreaterThanOrEqual(unique.length * 0.9);
                // Every word sits on its glyphs: within a quarter of the type size.
                const offsets = placed.map(({
                    dx, dy,
                }) => Math.hypot(dx, dy)).sort((left, right) => left - right);
                expect(offsets[Math.floor(offsets.length / 2)], JSON.stringify(placed)).toBeLessThan(FONT_PX * 0.25);
                expect(offsets.at(-1), JSON.stringify(placed)).toBeLessThan(FONT_PX * 0.6);
                // Each line keeps the page's tilt; an unmapped deskewed layer lies flat.
                for (const line of new Set(placed.map(({word}) => word.line))) {
                    const words = placed.filter(({word}) => word.line === line);
                    if (words.length < 3) continue;
                    const meanX = words.reduce((sum, {x}) => sum + x, 0) / words.length;
                    const meanY = words.reduce((sum, {y}) => sum + y, 0) / words.length;
                    const slope = words.reduce((sum, {
                        x, y,
                    }) => sum + (x - meanX) * (y - meanY), 0) / words.reduce((sum, {x}) => sum + (x - meanX) ** 2, 0);
                    expect(Math.atan(slope) * 180 / Math.PI, `line ${line}`).toBeCloseTo(SKEW_DEGREES, 0);
                }
            } finally {
                await page.context().close();
            }
        }
    }, 360_000);
});
