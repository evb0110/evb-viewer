import {
    existsSync,
    mkdtempSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    GlobalFonts,
    createCanvas,
} from '@napi-rs/canvas';
import {PDFDocument} from 'pdf-lib';
import type {
    ElementHandle,
    Page,
} from 'puppeteer-core';
import {
    afterAll,
    describe,
    expect,
    it,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    activateMenuItemAsUser,
    clickAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    openPdfInApp,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';

GlobalFonts.registerFromPath(
    join(process.cwd(), 'scripts/fixtures/ocr-language-fonts/NotoSerif-Regular.ttf'),
    'EvbOcrColumnsSerif',
);

const OCR_TIMEOUT_MS = 240_000;
// A photographed book leaf: the page is laid out in raster pixels at 72 ppi,
// as Internet Archive and camera scans are, and the leaf is turned by 2.2°.
const PAGE_WIDTH = 1900;
const PAGE_HEIGHT = 2600;
const SKEW_DEGREES = 2.2;
const COLUMN_WORDS = [
    'harbor',
    'lantern',
    'signal',
    'morning',
    'river',
    'garden',
    'winter',
    'candle',
    'meadow',
    'silver',
    'forest',
    'window',
    'bridge',
    'thunder',
    'orchard',
    'pebble',
];

function columnLine(column: number, line: number) {
    const words = Array.from({length: 4}, (_, index) => COLUMN_WORDS[(line * 3 + index + column * 5) % COLUMN_WORDS.length]);
    return `${words.join(' ')} ${column === 0 ? 'left' : 'right'} ${line + 1}`;
}

const LINES_PER_COLUMN = 24;

const tempRoot = mkdtempSync(join(tmpdir(), 'evb-e2e-ocr-columns-docx-'));
const docxPath = join(tempRoot, 'columns.docx');

afterAll(() => rm(tempRoot, {
    recursive: true,
    force: true,
}));

const sessionFixture = createElectronE2ESessionFixture({
    sessionName: () => `e2e-ocr-columns-docx-${Date.now()}`,
    extraEnv: {EVB_E2E_SAVE_DIALOG_PATH: docxPath},
});

async function createSkewedTwoColumnScanPdf(path: string) {
    const canvas = createCanvas(PAGE_WIDTH, PAGE_HEIGHT);
    const context = canvas.getContext('2d');
    context.fillStyle = '#f4efe2';
    context.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
    context.translate(PAGE_WIDTH / 2, PAGE_HEIGHT / 2);
    context.rotate(SKEW_DEGREES * Math.PI / 180);
    context.translate(-PAGE_WIDTH / 2, -PAGE_HEIGHT / 2);
    context.fillStyle = '#1d1a16';
    context.font = '38px EvbOcrColumnsSerif';
    for (let column = 0; column < 2; column += 1) {
        for (let line = 0; line < LINES_PER_COLUMN; line += 1) {
            context.fillText(columnLine(column, line), 160 + column * 830, 300 + line * 82);
        }
    }
    const doc = await PDFDocument.create();
    const image = await doc.embedPng(canvas.toBuffer('image/png'));
    doc.addPage([
        PAGE_WIDTH,
        PAGE_HEIGHT,
    ]).drawImage(image, {
        x: 0,
        y: 0,
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
    });
    writeFileSync(path, await doc.save());
}

/** The body of the uncompressed DOCX EVB Viewer writes. */
function readDocxDocument(path: string) {
    return readFileSync(path).toString('utf8');
}

/** Paragraph texts of a DOCX body. */
function docxParagraphs(xml: string) {
    return Array.from(xml.matchAll(/<w:p>(.*?)<\/w:p>/gsu), paragraph => Array.from(
        paragraph[1]!.matchAll(/<w:t[^>]*>(.*?)<\/w:t>/gsu),
        run => run[1],
    ).join('').trim()).filter(text => text.length > 0);
}

async function clickVisibleButton(page: Page, scope: string, name: string, timeoutMs = 30_000) {
    const handle = await page.waitForFunction((selector: string, label: string) => (
        Array.from(document.querySelectorAll<HTMLButtonElement>(`${selector} button`)).find(button => (
            (button.getAttribute('aria-label') ?? button.textContent ?? '').trim() === label
            && !button.disabled
            && button.checkVisibility()
        ))
    ), {timeout: timeoutMs}, scope, name);
    await clickAsUser(page, handle.asElement() as ElementHandle<HTMLButtonElement>);
}

describe('DOCX export of an OCR layer on a skewed two-column scan', () => {
    it('sets the two columns side by side in DOCX, every recognized line whole and in column order', async () => {
        const session = sessionFixture.getSession();
        const {page} = session;
        const sourcePath = join(tempRoot, 'skewed-two-column-scan.pdf');
        await createSkewedTwoColumnScanPdf(sourcePath);
        await openPdfInApp(page, sourcePath, 90_000);
        await waitForViewerInteractive(page, 90_000);
        await session.command('windowResize', [
            1440,
            900,
        ]);

        // English is the preselected recognition language.
        await clickVisibleButton(page, '#editor-global-toolbar-host', 'OCR');
        await page.waitForSelector('[role="dialog"]', {visible: true});
        await clickVisibleButton(page, '[role="dialog"]', 'Start OCR');
        await waitForFunctionInPage(page, () => (
            document.querySelector('[role="dialog"]')?.textContent?.includes('OCR complete - PDF is now searchable') === true
        ), {timeout: OCR_TIMEOUT_MS});
        await clickVisibleButton(page, '[role="dialog"]', 'Close');
        await page.waitForSelector('[role="dialog"]', {hidden: true});

        // The document reopens with its new text layer after OCR; Export DOCX
        // stays disabled until it is interactive again.
        await waitForViewerInteractive(page, 90_000);
        await waitForFunctionInPage(page, () => {
            const toolbar = (window as Window & {__evbTestApi?: {getActiveToolbarSnapshot?: () => {
                canExportDocx: boolean;
                isAnySaving: boolean;
                isHistoryBusy: boolean;
            } | null}}).__evbTestApi?.getActiveToolbarSnapshot?.();
            return toolbar?.canExportDocx === true && !toolbar.isAnySaving && !toolbar.isHistoryBusy;
        }, {timeout: 60_000});
        await activateMenuItemAsUser(page, {accelerator: 'CmdOrCtrl+Shift+E'});
        await waitForFunctionInPage(page, () => document.body.innerText.includes('DOCX saved'), {timeout: 60_000});
        expect(existsSync(docxPath)).toBe(true);

        const xml = readDocxDocument(docxPath);
        console.log('ocr-columns-docx-paragraphs', JSON.stringify(docxParagraphs(xml)));
        // The page's columns sit side by side, a table cell each.
        expect(xml.match(/<w:tbl>/gu)).toHaveLength(1);
        const cells = Array.from(xml.matchAll(/<w:tc>(.*?)<\/w:tc>/gsu), cell => (
            ` ${docxParagraphs(cell[1]!).map(paragraph => paragraph.toLowerCase().split(/\s+/u).join(' ')).join(' ')} `
        ));
        expect(cells).toHaveLength(2);
        // Paragraphs join a column's lines. Each printed line reads whole in
        // its own column's cell, in order; recognition may misread a word,
        // but not break, reorder or move lines.
        [
            0,
            1,
        ].forEach((column) => {
            const lineIndexes = Array.from({length: LINES_PER_COLUMN}, (_, line) => cells[column]!.indexOf(` ${columnLine(column, line)} `));
            const recovered = lineIndexes.filter(index => index >= 0);
            expect(recovered.length).toBeGreaterThanOrEqual(LINES_PER_COLUMN * 0.8);
            expect(recovered).toEqual([...recovered].sort((left, right) => left - right));
            const otherCell = cells[1 - column]!;
            expect(Array.from({length: LINES_PER_COLUMN}, (_, line) => columnLine(column, line))
                .filter(line => otherCell.includes(` ${line} `))).toEqual([]);
        });
    }, 420_000);
});
