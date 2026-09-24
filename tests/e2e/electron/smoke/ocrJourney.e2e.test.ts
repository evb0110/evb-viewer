import {join} from 'node:path';
import {GlobalFonts} from '@napi-rs/canvas';
import type {
    ElementHandle,
    Page,
} from 'puppeteer-core';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {createScannedTextFixturePdf} from '@tests/e2e/electron/helpers/fixtures';
import {assertOcrPdfSemanticOutput} from '@tests/e2e/electron/helpers/electronApiHelpers';
import {
    clickToolbarButtonWhenEnabled,
    openDocumentSidebarTab,
    openPdfInApp,
    saveViaVisibleToolbar,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';

GlobalFonts.registerFromPath(
    join(process.cwd(), 'scripts/fixtures/ocr-language-fonts/NotoSans-Regular.ttf'),
    'EvbOcrJourneySans',
);

const SCANNED_TEXT = 'Harbor lantern signal';
const SEARCHED_WORD = 'lantern';
const OCR_TIMEOUT_MS = 180_000;
const ACTIVE_HOST = '.workspace-host[data-workspace-active="true"]';

const sessionFixture = createElectronE2ESessionFixture({
    sessionName: () => `e2e-ocr-journey-${Date.now()}`,
    restartBeforeEach: false,
});

/** Clicks, with real pointer input, the visible enabled button whose label or text is `name`. */
async function clickVisibleButton(page: Page, scope: string, name: string, timeoutMs = 30_000) {
    const handle = await page.waitForFunction((selector: string, label: string) => (
        Array.from(document.querySelectorAll<HTMLButtonElement>(`${selector} button`)).find(button => (
            (button.getAttribute('aria-label') ?? button.textContent ?? '').trim() === label
            && !button.disabled
            && button.checkVisibility()
        ))
    ), {timeout: timeoutMs}, scope, name);
    await (handle.asElement() as ElementHandle<HTMLButtonElement>).click();
}

async function waitForTextLayerWord(page: Page) {
    await waitForFunctionInPage(page, (host: string, word: string) => (
        document.querySelector(`${host} .page_container[data-page="1"] .text-layer[data-pdf-text-layer-ready="true"]`)
            ?.textContent?.toLocaleLowerCase().includes(word) === true
    ), {timeout: 30_000}, ACTIVE_HOST, SEARCHED_WORD);
}

describe('Electron E2E - OCR journey', () => {
    it('makes a scanned page searchable, saves it, and finds a recognized word after reopening', async () => {
        const {page} = sessionFixture.getSession();
        const sourcePath = await createScannedTextFixturePdf(
            'ocr-journey-scan.pdf',
            SCANNED_TEXT,
            '60px EvbOcrJourneySans',
        );
        await openPdfInApp(page, sourcePath, 90_000);
        await waitForViewerInteractive(page, 90_000);

        // English is the preselected recognition language.
        await clickToolbarButtonWhenEnabled(page, 'OCR');
        await clickVisibleButton(page, '[role="dialog"]', 'Start OCR');
        await waitForFunctionInPage(page, () => (
            document.querySelector('[role="dialog"]')?.textContent?.includes('OCR complete - PDF is now searchable') === true
        ), {timeout: OCR_TIMEOUT_MS});
        await clickVisibleButton(page, '[role="dialog"]', 'Close');
        await page.waitForSelector('[role="dialog"]', {hidden: true});
        await waitForTextLayerWord(page);

        await saveViaVisibleToolbar(page, 90_000);
        expect(await assertOcrPdfSemanticOutput(sourcePath, SCANNED_TEXT)).toContain(SEARCHED_WORD);

        await clickVisibleButton(page, 'body', 'Close Tab');
        await page.waitForSelector(`${ACTIVE_HOST} .page_container`, {hidden: true});
        await openPdfInApp(page, sourcePath, 90_000);
        await waitForViewerInteractive(page, 90_000);

        await openDocumentSidebarTab(page, 'Search');
        await page.click(`${ACTIVE_HOST} .document-search-bar input`);
        await page.keyboard.type(SEARCHED_WORD);
        await page.keyboard.press('Enter');
        await waitForFunctionInPage(page, (host: string, word: string) => (
            Array.from(document.querySelectorAll(`${host} .document-search-result`))
                .some(result => result.textContent?.toLocaleLowerCase().includes(word))
        ), {timeout: 30_000}, ACTIVE_HOST, SEARCHED_WORD);
        await page.click(`${ACTIVE_HOST} .document-search-result`);
        await page.waitForSelector(`${ACTIVE_HOST} .pdf-search-highlight--current`, {visible: true});
    }, 300_000);
});
