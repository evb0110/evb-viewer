import {
    readFile, writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import type {
    ElementHandle, Page,
} from 'puppeteer-core';
import {
    describe, expect, it,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {createFixturePath} from '@tests/e2e/electron/helpers/fixtures';
import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    openPdfInApp,
    saveViaVisibleToolbar,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {extractTextWithPdfjs} from '@electron/features/search/pdfjsPageTexts';

const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-ocr-language-models-${Date.now()}`});
const TEXT_LAYER = '.workspace-host[data-workspace-active="true"] .page_container[data-page="1"] .text-layer[data-pdf-text-layer-ready="true"]';

async function clickButton(page: Page, scope: string, label: string) {
    const button = await page.waitForFunction((selector: string, text: string) => (
        Array.from(document.querySelectorAll<HTMLButtonElement>(`${selector} button`)).find(candidate => (
            (candidate.getAttribute('aria-label') ?? candidate.textContent ?? '').trim() === text
            && !candidate.disabled && candidate.checkVisibility()
        ))
    ), {timeout: 30_000}, scope, label);
    await clickAsUser(page, button.asElement() as ElementHandle<HTMLButtonElement>);
}

/** OCRs a one-page scan with one language in the app, then reads the text layer and the saved PDF. */
async function recognizeScan(scanPath: string, ppi: number, languageCode: string, minTextLength: number) {
    const session = sessionFixture.getSession();
    const {page} = session;
    const doc = await PDFDocument.create();
    const bytes = await readFile(join(process.cwd(), scanPath));
    const scan = scanPath.endsWith('.png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const width = scan.width * 72 / ppi;
    const height = scan.height * 72 / ppi;
    doc.addPage([
        width,
        height,
    ]).drawImage(scan, {
        x: 0,
        y: 0,
        width,
        height,
    });
    const sourcePath = createFixturePath(`ocr-${languageCode}.pdf`);
    await writeFile(sourcePath, await doc.save());
    await openPdfInApp(page, sourcePath, 90_000);
    await waitForViewerInteractive(page, 90_000);
    await session.command('windowResize', [
        1440,
        900,
    ]);
    await clickButton(page, '#editor-global-toolbar-host', 'OCR');
    await page.waitForSelector('[role="dialog"]', {visible: true});
    const language = await page.waitForFunction((code: string) => (
        Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] [data-slot="item"]')).find(item => (
            item.querySelector('.chip-code')?.textContent?.trim() === code && item.checkVisibility()
        ))
    ), {timeout: 30_000}, languageCode);
    await clickAsUser(page, language.asElement() as ElementHandle<HTMLElement>);
    await waitForFunctionInPage(page, (code: string) => (
        Array.from(document.querySelectorAll('[role="dialog"] [data-slot="item"]')).some(item => (
            item.querySelector('.chip-code')?.textContent?.trim() === code
            && item.querySelector('[role="radio"]')?.getAttribute('aria-checked') === 'true'
        ))
    ), {timeout: 10_000}, languageCode);
    await clickButton(page, '[role="dialog"]', 'Start OCR');
    await waitForFunctionInPage(page, () => (
        document.querySelector('[role="dialog"]')?.textContent?.includes('OCR complete - PDF is now searchable') === true
    ), {timeout: 180_000});
    await clickButton(page, '[role="dialog"]', 'Close');
    await page.waitForSelector('[role="dialog"]', {hidden: true});
    await waitForFunctionInPage(page, (selector: string, length: number) => (
        (document.querySelector(selector)?.textContent?.length ?? 0) > length
    ), {timeout: 30_000}, TEXT_LAYER, minTextLength);
    const renderedText = await page.$eval(TEXT_LAYER, layer => layer.textContent ?? '');
    await saveViaVisibleToolbar(page, 90_000);
    const savedText = (await extractTextWithPdfjs(sourcePath)).map(result => result.text).join('\n');
    console.log(`ocr-${languageCode}-rendered-text`, JSON.stringify(renderedText));
    console.log(`ocr-${languageCode}-saved-text`, JSON.stringify(savedText));
    return {
        renderedText,
        savedText,
    };
}

describe('OCR language models', () => {
    it('writes printed Latin æ and œ into the saved PDF without a long-s page', async () => {
        const {
            renderedText, savedText,
        } = await recognizeScan('tests/fixtures/electron/latin-ligatures/missale-1835-urbanus.jpg', 400, 'lat', 1000);
        for (const word of [
            'Missæ',
            'cœlum',
            'cœli',
            'negligentiæ',
            'æmuli',
        ]) {
            expect(renderedText).toContain(word);
            expect(savedText).toContain(word);
        }
    }, 300_000);

    // Modern Greek reads with the Ancient Greek model its own config loads.
    it('reads modern Greek with the sub-language its model loads', async () => {
        const {
            renderedText, savedText,
        } = await recognizeScan('tests/fixtures/electron/greek-sublanguage/ell-registry-200ppi.png', 200, 'ell', 400);
        for (const text of [
            renderedText,
            savedText,
        ]) {
            expect(text).toContain('περιγράφει');
            expect(text).not.toMatch(/περιφράφει|καὶ/u);
        }
    }, 300_000);
});
