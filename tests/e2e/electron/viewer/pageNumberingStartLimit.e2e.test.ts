import {
    describe, expect, it,
} from 'vitest';
import {readFileSync} from 'node:fs';
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFName,
    PDFNumber,
} from 'pdf-lib';
import {
    createMultiPageTextFixturePdf,
    createPageLabelRangesFixturePdf,
} from '@tests/e2e/electron/helpers/fixtures';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    clickAsUser, clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {
    goToPageViaToolbar, openDocumentSidebarTab, openPdfInApp, saveViaVisibleToolbar, waitForPdfLoaded,
    waitForToolbarCurrentPage,
} from '@tests/e2e/electron/helpers/viewerCore';
import {readToolbarPageIndicator} from '@tests/e2e/electron/helpers/toolbarPageIndicator';
import {getPageLabelStartNumberMax} from '@app/modules/document-viewer/pageLabels';
import type {Page} from 'puppeteer-core';

const PAGES_PANEL = '.workspace-host[data-workspace-active="true"]';

describe('Electron E2E - page numbering start limit', () => {
    const sessions = createElectronE2ESessionFixture({sessionName: () => `e2e-page-start-limit-${Date.now()}`});

    it('corrects a letter-style start value too large to print and keeps the document usable', async () => {
        const {page} = sessions.getSession();
        const fixture = await createMultiPageTextFixturePdf(`page-start-limit-${Date.now()}.pdf`, 3);
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        await openPagesPanel(page);
        await clickAsUser(page, '#page-label-style-input');
        await clickFoundAsUser(page, (label: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
            .find(option => option.textContent?.trim() === label), 'Letters (A, B)', {description: 'Letters numbering style'});
        await clickAsUser(page, '#page-label-start-input', {count: 3});
        await page.keyboard.type('20000000000');
        await page.keyboard.press('Tab');
        await clickAsUser(page, `${PAGES_PANEL} .pdf-sidebar-pages-primary-button`);
        // The field settles on the largest start the page-numbering contract admits for letter style.
        const bound = String(getPageLabelStartNumberMax('A'));
        await page.waitForFunction((expected: string) => {
            const field = document.querySelector('#page-label-start-input');
            const input = field instanceof HTMLInputElement ? field : field?.querySelector('input');
            return (input?.value ?? '').replace(/\D/g, '') === expected;
        }, {timeout: 15_000}, bound);
        await goToPageViaToolbar(page, 2);
        await waitForToolbarCurrentPage(page, 2);
    }, 90_000);

    it('keeps the label of a page the edit did not touch when one page is renumbered and saved', async () => {
        const {page} = sessions.getSession();
        const fixture = await createPageLabelRangesFixturePdf(`page-label-untouched-${Date.now()}.pdf`, 150, [{
            startPage: 1,
            style: 'A',
            startNumber: 1,
        }]);
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        await openPagesPanel(page);
        // Page 110 is "FFFFF" and page 111 "GGGGG" before the edit; only page 110 gets a decimal label.
        await clickAsUser(page, '#page-label-style-input');
        await clickFoundAsUser(page, (label: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
            .find(option => option.textContent?.trim() === label), 'Decimal', {description: 'Decimal numbering style'});
        await clickAsUser(page, '#page-label-range-input');
        await page.keyboard.type('110');
        await expect.poll(() => page.$eval(`${PAGES_PANEL} .pdf-sidebar-pages-primary-button`, button => (button as HTMLButtonElement).disabled), {timeout: 15_000}).toBe(false);
        // Setup only: the typed range can push Apply below the sidebar's fold; the click itself is still a trusted click.
        await page.$eval(`${PAGES_PANEL} .pdf-sidebar-pages-primary-button`, button => button.scrollIntoView({block: 'center'}));
        await clickAsUser(page, `${PAGES_PANEL} .pdf-sidebar-pages-primary-button`);
        await goToPageViaToolbar(page, 111);
        await waitForToolbarCurrentPage(page, 111);
        await expect.poll(async () => (await readToolbarPageIndicator(page)).primaryText, {timeout: 15_000}).toBe('GGGGG');
        const saved = await saveViaVisibleToolbar(page, 30_000, fixture);
        expect(saved.detail.path).toBeTruthy();
        const ranges = await readSavedPageLabelRanges(fixture);
        expect(ranges.find(range => range.startPage === 111)).toEqual({
            startPage: 111,
            style: '/A',
            startNumber: 111,
        });
    }, 90_000);

    it('opens a document whose imported letter start is too large to print and keeps its labels readable', async () => {
        const {page} = sessions.getSession();
        const fixture = await createPageLabelRangesFixturePdf(`page-label-huge-import-${Date.now()}.pdf`, 3, [{
            startPage: 1,
            style: 'A',
            startNumber: 1_000_000_000,
        }]);
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        // 1,000,000,000 is "L" repeated 38,461,539 times; the toolbar shows its bounded head with a visible ellipsis.
        await expect.poll(async () => (await readToolbarPageIndicator(page)).primaryText, {timeout: 15_000}).toMatch(/^L+…$/u);
        await goToPageViaToolbar(page, 2);
        await waitForToolbarCurrentPage(page, 2);
        await expect.poll(async () => (await readToolbarPageIndicator(page)).primaryText, {timeout: 15_000}).toMatch(/^M+…$/u);
    }, 90_000);
});

async function openPagesPanel(page: Page) {
    await openDocumentSidebarTab(page, 'Pages');
    const disclosure = `${PAGES_PANEL} .pdf-sidebar-pages-disclosure`;
    if (await page.$eval(disclosure, button => button.getAttribute('aria-expanded')) !== 'true') {
        await clickAsUser(page, disclosure);
    }
}

/** The saved /PageLabels number tree as (page, style, start) ranges, read back from the written file. */
async function readSavedPageLabelRanges(filePath: string) {
    const doc = await PDFDocument.load(readFileSync(filePath));
    const pageLabels = doc.catalog.lookup(PDFName.of('PageLabels'), PDFDict);
    const nums = pageLabels.lookup(PDFName.of('Nums'), PDFArray);
    const ranges: Array<{
        startPage: number;
        style: string | null;
        startNumber: number;
    }> = [];
    for (let index = 0; index + 1 < nums.size(); index += 2) {
        const range = nums.lookup(index + 1, PDFDict);
        ranges.push({
            startPage: nums.lookup(index, PDFNumber).asNumber() + 1,
            style: range.lookupMaybe(PDFName.of('S'), PDFName)?.toString() ?? null,
            startNumber: range.lookupMaybe(PDFName.of('St'), PDFNumber)?.asNumber() ?? 1,
        });
    }
    return ranges;
}
