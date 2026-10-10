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

const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-ocr-latin-ligatures-${Date.now()}`});
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

describe('Latin OCR ligatures', () => {
    it('writes printed æ and œ into the saved PDF without a long-s page', async () => {
        const session = sessionFixture.getSession();
        const {page} = session;
        const doc = await PDFDocument.create();
        const scan = await doc.embedJpg(await readFile(join(
            process.cwd(), 'tests/fixtures/electron/latin-ligatures/missale-1835-urbanus.jpg',
        )));
        const width = scan.width * 72 / 400;
        const height = scan.height * 72 / 400;
        doc.addPage([
            width,
            height,
        ]).drawImage(scan, {
            x: 0,
            y: 0,
            width,
            height,
        });
        const sourcePath = createFixturePath('latin-ligatures.pdf');
        await writeFile(sourcePath, await doc.save());
        await openPdfInApp(page, sourcePath, 90_000);
        await waitForViewerInteractive(page, 90_000);
        await session.command('windowResize', [
            1440,
            900,
        ]);
        await clickButton(page, '#editor-global-toolbar-host', 'OCR');
        await page.waitForSelector('[role="dialog"]', {visible: true});
        const latin = await page.waitForFunction(() => (
            Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] [data-slot="item"]')).find(item => (
                item.querySelector('.chip-code')?.textContent?.trim() === 'lat' && item.checkVisibility()
            ))
        ), {timeout: 30_000});
        await clickAsUser(page, latin.asElement() as ElementHandle<HTMLElement>);
        await waitForFunctionInPage(page, () => (
            Array.from(document.querySelectorAll('[role="dialog"] [data-slot="item"]')).some(item => (
                item.querySelector('.chip-code')?.textContent?.trim() === 'lat'
                && item.querySelector('[role="radio"]')?.getAttribute('aria-checked') === 'true'
            ))
        ), {timeout: 10_000});
        await clickButton(page, '[role="dialog"]', 'Start OCR');
        await waitForFunctionInPage(page, () => (
            document.querySelector('[role="dialog"]')?.textContent?.includes('OCR complete - PDF is now searchable') === true
        ), {timeout: 180_000});
        await clickButton(page, '[role="dialog"]', 'Close');
        await page.waitForSelector('[role="dialog"]', {hidden: true});
        await waitForFunctionInPage(page, (selector: string) => (
            (document.querySelector(selector)?.textContent?.length ?? 0) > 1000
        ), {timeout: 30_000}, TEXT_LAYER);
        const renderedText = await page.$eval(TEXT_LAYER, layer => layer.textContent ?? '');
        await saveViaVisibleToolbar(page, 90_000);
        const savedText = (await extractTextWithPdfjs(sourcePath)).map(result => result.text).join('\n');
        console.log('ocr-latin-rendered-text', JSON.stringify(renderedText));
        console.log('ocr-latin-saved-text', JSON.stringify(savedText));
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
});
