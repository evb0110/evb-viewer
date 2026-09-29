import {
    copyFile, mkdtemp, realpath,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    describe, expect, it, onTestFinished,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    goToPageViaToolbar, openDocumentSidebarTab, openPdfInApp, saveViaWindowHandle, waitForPdfLoaded, waitForToolbarCurrentPage,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    createOutlinePageLabelFixturePdf, fixtureBookmark, readPdfMetadataWithQpdf,
} from '@tests/e2e/electron/helpers/fixtures';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    startElectronE2ESession, type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {readToolbarPageIndicator} from '@tests/e2e/electron/helpers/toolbarPageIndicator';
import {waitForViewportQuiet} from '@tests/e2e/electron/helpers/viewportPageObservation';
import type {Page} from 'puppeteer-core';

describe('Electron E2E - bookmark destination round trip', () => {
    const sessions = createElectronE2ESessionFixture({sessionName: () => `e2e-bookmark-rename-${Date.now()}`});

    it('keeps imported destinations when one bookmark title is renamed and saved', async () => {
        const evidenceDirectory = await mkdtemp(join(tmpdir(), 'evb-e2e-bookmark-rename-'));
        const generated = await createOutlinePageLabelFixturePdf(`bookmark-rename-${Date.now()}.pdf`, [
            fixtureBookmark('First', 0),
            fixtureBookmark('Middle', 2),
            fixtureBookmark('Last', 3),
        ]);
        const source = join(evidenceDirectory, `imported-outline-${Date.now()}.pdf`);
        await copyFile(generated, source);
        const saved = source;
        await sessions.stop();
        let session: IElectronE2ESession | null = await startElectronE2ESession(`e2e-bookmark-rename-${Date.now()}`, {clean: true});
        onTestFinished(async () => { await session?.stop(); });
        let {page} = session;
        await openPdfInApp(page, source);
        await waitForPdfLoaded(page);
        await openDocumentSidebarTab(page, 'Bookmarks');

        await activateBookmark(page, 'Middle');
        await waitForToolbarCurrentPage(page, 3);
        expect(await page.$eval('.page_container[data-page="3"]', node => node.textContent)).toContain('Metadata matrix page 3');

        const editToggle = await page.$('.document-bookmarks-toolbar__actions button');
        expect(editToggle, 'bookmark editing control is visible').not.toBeNull();
        await editToggle!.click();
        await waitForFunctionInPage(page, () => document.querySelector('.pdf-bookmarks-tree') !== null);
        const middleRow = await findBookmarkRow(page, 'Middle');
        await middleRow.click({button: 'right'});
        await page.waitForSelector('.bookmarks-context-menu .pdf-context-menu__action', {visible: true});
        await page.click('.bookmarks-context-menu .pdf-context-menu__action');
        await page.waitForSelector('.pdf-bookmark-item-input', {visible: true});
        await page.keyboard.down('Control');
        await page.keyboard.press('A');
        await page.keyboard.up('Control');
        await page.keyboard.type('Middle renamed');
        await page.keyboard.press('Enter');
        await waitForFunctionInPage(page, () => Array.from(document.querySelectorAll('.pdf-bookmark-item-row')).some(row => row.textContent?.trim() === 'Middle renamed'));

        const saveCommit = await saveViaWindowHandle(page);
        expect(await realpath(String(saveCommit.detail.path))).toBe(await realpath(saved));
        const outline = (await readPdfMetadataWithQpdf(saved)).outlines;
        const savedDestinations = outline.map(item => item.destpageposfrom1 ?? null);
        const savedTitles = outline.map(item => item.title);

        await session.stop();
        session = await startElectronE2ESession(`e2e-bookmark-rename-reopen-${Date.now()}`, {clean: true});
        page = session.page;
        await openPdfInApp(page, saved);
        await waitForPdfLoaded(page);
        await openDocumentSidebarTab(page, 'Bookmarks');
        const navigatedPages: number[] = [];
        const renderedText: boolean[] = [];
        for (const [
            title,
            pageNumber,
        ] of [
                [
                    'First',
                    1,
                ],
                [
                    'Middle renamed',
                    3,
                ],
                [
                    'Last',
                    4,
                ],
            ] as const) {
            await goToPageViaToolbar(page, 2);
            await waitForToolbarCurrentPage(page, 2);
            await activateBookmark(page, title);
            await waitForViewportQuiet(page);
            const indicator = await readToolbarPageIndicator(page);
            if (indicator.renderedPage === null) throw new Error('Page number was not rendered after bookmark activation');
            navigatedPages.push(indicator.renderedPage);
            const visibleText = await page.$eval(`.page_container[data-page="${indicator.renderedPage}"]`, node => node.textContent ?? '');
            renderedText.push(visibleText.includes(`Metadata matrix page ${pageNumber}`));
        }
        console.log(`BOOKMARK_ROUND_TRIP ${JSON.stringify({
            savedTitles,
            savedDestinations,
            navigatedPages,
            renderedText,
        })}`);
        expect(savedTitles).toEqual([
            'First',
            'Middle renamed',
            'Last',
        ]);
        expect(savedDestinations).toEqual([
            1,
            3,
            4,
        ]);
        expect(navigatedPages).toEqual([
            1,
            3,
            4,
        ]);
        expect(renderedText).toEqual([
            true,
            true,
            true,
        ]);
    }, 90_000);
});

async function activateBookmark(page: Page, title: string) {
    const row = await findBookmarkRow(page, title);
    await row.click();
}

async function findBookmarkRow(page: Page, title: string) {
    await waitForFunctionInPage(page, (expected: string) => Array.from(document.querySelectorAll('.pdf-bookmark-item-row, .document-bookmark-item__row'))
        .some(row => row.textContent?.trim() === expected), {}, title);
    const rows = await page.$$('.pdf-bookmark-item-row, .document-bookmark-item__row');
    for (const row of rows) {
        if (await row.evaluate(element => element.textContent?.trim()) === title) {
            return row;
        }
    }
    throw new Error(`Bookmark is not rendered: ${title}`);
}
