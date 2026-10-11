import {
    PDFDocument, degrees,
} from 'pdf-lib';
import {
    copyFile, mkdtemp, readFile, realpath, writeFile,
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
    clickAsUser, clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {
    startElectronE2ESession, type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {readToolbarPageIndicator} from '@tests/e2e/electron/helpers/toolbarPageIndicator';
import {waitForViewportQuiet} from '@tests/e2e/electron/helpers/viewportPageObservation';
import type {Page} from 'puppeteer-core';

describe('Electron E2E - bookmark destination round trip', () => {
    const sessions = createElectronE2ESessionFixture({sessionName: () => `e2e-bookmark-rename-${Date.now()}`});

    it('saves a rotated-page bookmark in displayed crop coordinates and reopens at its top', async () => {
        const fixture = await createOutlinePageLabelFixturePdf(`rotated-bookmark-${Date.now()}.pdf`, []);
        const pdf = await PDFDocument.load(await readFile(fixture));
        const first = pdf.getPages()[0]!;
        first.setMediaBox(40, 60, 500, 700);
        first.setCropBox(60, 80, 400, 600);
        first.setRotation(degrees(270));
        await writeFile(fixture, await pdf.save());
        const {page} = sessions.getSession();
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        await openDocumentSidebarTab(page, 'Bookmarks');
        await clickAsUser(page, '.document-bookmarks-toolbar__actions button');
        await clickFoundAsUser(page, (title: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
            .find(button => button.textContent?.trim() === title), 'Add first bookmark', {description: 'Add first bookmark'});
        await page.waitForSelector('.pdf-bookmark-item-input', {visible: true});
        await page.keyboard.type('Rotated crop top');
        await page.keyboard.press('Enter');
        await findBookmarkRow(page, 'Rotated crop top');
        await saveViaWindowHandle(page);
        const dest = (await readPdfMetadataWithQpdf(fixture)).outlines[0]?.dest;
        expect(dest?.[2]).toBeCloseTo(460, 0);
        expect(dest?.[3]).toBeCloseTo(680, 0);
        await clickAsUser(page, 'button[aria-label="Close Tab"]');
        await page.waitForSelector('.page_container', {hidden: true});
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        await openDocumentSidebarTab(page, 'Bookmarks');
        await goToPageViaToolbar(page, 2);
        await activateBookmark(page, 'Rotated crop top');
        await waitForToolbarCurrentPage(page, 1);
        await waitForViewportQuiet(page);
    }, 90_000);

    it('keeps imported destinations when one bookmark title is renamed and saved', async () => {
        const evidenceDirectory = await mkdtemp(join(tmpdir(), 'evb-e2e-bookmark-rename-'));
        const generated = await createOutlinePageLabelFixturePdf(`bookmark-rename-${Date.now()}.pdf`, [
            fixtureBookmark('First', 0),
            {
                ...fixtureBookmark('Middle', 2),
                pageYRatio: 0.25,
            },
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
        await clickAsUser(page, editToggle!);
        await waitForFunctionInPage(page, () => document.querySelector('.pdf-bookmarks-tree') !== null);
        const middleRow = await findBookmarkRow(page, 'Middle');
        await clickAsUser(page, middleRow, {button: 'right'});
        await page.waitForSelector('.bookmarks-context-menu .pdf-context-menu__action', {visible: true});
        await clickAsUser(page, '.bookmarks-context-menu .pdf-context-menu__action');
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
        // The fixture puts Middle at a quarter of the page's height from its top.
        const middleDestinationTop = outline.find(item => item.title === 'Middle renamed')?.dest?.[3];
        expect(middleDestinationTop).toBeCloseTo(594, 0);
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
    await clickAsUser(page, row);
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
