import {
    PDFDocument, PDFName, PDFString, PDFHexString, PDFArray, PDFDict, PDFNumber, PDFNull, degrees, type PDFPage,
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
    goToPageViaToolbar, openDocumentSidebarTab, openPdfInApp, saveViaVisibleToolbar, saveViaWindowHandle, waitForPdfLoaded, waitForToolbarCurrentPage,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    createOutlinePageLabelFixturePdf, fixtureBookmark, readPdfMetadataWithQpdf,
} from '@tests/e2e/electron/helpers/fixtures';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    activateMenuItemAsUser, clickAsUser, clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {
    startElectronE2ESession, type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {readToolbarPageIndicator} from '@tests/e2e/electron/helpers/toolbarPageIndicator';
import {waitForViewportQuiet} from '@tests/e2e/electron/helpers/viewportPageObservation';
import type {Page} from 'puppeteer-core';
import {callWorkspaceCommand} from '@tests/e2e/electron/helpers/workspaceExpose';

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

    it('saves an explicit named replacement at its new page after an accepted page target', async () => {
        const fixture = await createOutlinePageLabelFixturePdf(`named-replacement-${Date.now()}.pdf`, [fixtureBookmark('Imported', 0)]);
        const pdf = await PDFDocument.load(await readFile(fixture));
        const importedOutline = pdf.catalog.lookup(PDFName.of('Outlines'), PDFDict);
        importedOutline.lookup(PDFName.of('First'), PDFDict).set(PDFName.of('Dest'), pdf.context.obj([
            pdf.getPages()[0]!.ref,
            PDFName.of('FitH'),
            null,
        ]));
        pdf.catalog.set(PDFName.of('Dests'), pdf.context.obj({'chapter-two': [
            pdf.getPages()[2]!.ref,
            PDFName.of('FitH'),
            null,
        ]}));
        await writeFile(fixture, await pdf.save());
        const {page} = sessions.getSession();
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        await openDocumentSidebarTab(page, 'Bookmarks');
        await activateBookmark(page, 'Imported');
        await waitForToolbarCurrentPage(page, 1);
        const previousTarget = await callWorkspaceCommand<{bookmarks: Array<{pageIndex: number | null}>}>(page, 'runAgentAction', [
            'bookmarks.update',
            {
                path: [0],
                page: 1,
            },
        ]);
        expect(previousTarget.value?.bookmarks[0]?.pageIndex).toBe(0);
        const result = await callWorkspaceCommand<{ok: boolean}>(page, 'runAgentAction', [
            'bookmarks.update',
            {
                path: [0],
                namedDest: 'chapter-two',
            },
        ]);
        expect(result.value?.ok).toBe(true);
        await saveViaVisibleToolbar(page, 90_000, fixture);
        const saved = await PDFDocument.load(await readFile(fixture));
        const outline = saved.catalog.lookup(PDFName.of('Outlines'), PDFDict);
        const entry = outline.lookup(PDFName.of('First'), PDFDict);
        const evidence = await mkdtemp(join(tmpdir(), 'evb-named-replacement-'));
        await copyFile(fixture, join(evidence, 'saved.pdf'));
        console.info(`Named replacement saved destination: ${entry.lookup(PDFName.of('Dest'))?.toString()}`);
        console.info(`Named replacement evidence: ${evidence}`);
        expect(entry.lookup(PDFName.of('Dest'), PDFString).decodeText()).toBe('chapter-two');
        await clickAsUser(page, 'button[aria-label="Close Tab"]');
        await page.waitForSelector('.page_container', {hidden: true});
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        await openDocumentSidebarTab(page, 'Bookmarks');
        await activateBookmark(page, 'Imported');
        await waitForToolbarCurrentPage(page, 3);
        expect(await page.$eval('.page_container[data-page="3"]', node => node.textContent)).toContain('Metadata matrix page 3');
        await page.screenshot({path: join(evidence, 'reopened.png')});
    }, 90_000);

    it('review-b6yh removes an accepted named destination when its page is deleted', async () => {
        const fixture = await createOutlinePageLabelFixturePdf(`named-replacement-${Date.now()}.pdf`, [fixtureBookmark('Imported', 0)]);
        const pdf = await PDFDocument.load(await readFile(fixture));
        const importedOutline = pdf.catalog.lookup(PDFName.of('Outlines'), PDFDict);
        importedOutline.lookup(PDFName.of('First'), PDFDict).set(PDFName.of('Dest'), pdf.context.obj([
            pdf.getPages()[0]!.ref,
            PDFName.of('FitH'),
            null,
        ]));
        pdf.catalog.set(PDFName.of('Dests'), pdf.context.obj({'chapter-two': [
            pdf.getPages()[2]!.ref,
            PDFName.of('FitH'),
            null,
        ]}));
        await writeFile(fixture, await pdf.save());
        const {page} = sessions.getSession();
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        await openDocumentSidebarTab(page, 'Bookmarks');
        await activateBookmark(page, 'Imported');
        await waitForToolbarCurrentPage(page, 1);
        const previousTarget = await callWorkspaceCommand<{bookmarks: Array<{pageIndex: number | null}>}>(page, 'runAgentAction', [
            'bookmarks.update',
            {
                path: [0],
                page: 1,
            },
        ]);
        expect(previousTarget.value?.bookmarks[0]?.pageIndex).toBe(0);
        const result = await callWorkspaceCommand<{ok: boolean}>(page, 'runAgentAction', [
            'bookmarks.update',
            {
                path: [0],
                namedDest: 'chapter-two',
            },
        ]);
        expect(result.value?.ok).toBe(true);
        await openDocumentSidebarTab(page, 'Pages');
        await clickAsUser(page, '[data-thumbnail-page="3"]', {button: 'right'});
        await clickFoundAsUser(page, () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
            .find(item => item.textContent?.trim() === 'Delete Pages'), null, {description: 'Delete named bookmark target'});
        await waitForFunctionInPage(page, () => document.querySelector('[data-thumbnail-page="3"]') === null, {timeout: 30_000});
        await waitForPdfLoaded(page);
        await saveViaVisibleToolbar(page, 90_000, fixture);
        const saved = await PDFDocument.load(await readFile(fixture));
        const catalog = await readPdfMetadataWithQpdf(fixture);
        const pageRefs=saved.getPages().map(page=>page.ref.toString());
        const dests=saved.catalog.lookupMaybe(PDFName.of('Dests'),PDFDict);
        const named=dests?.lookupMaybe(PDFName.of('chapter-two'),PDFArray);
        const target=named?.get(0)?.toString();
        console.info('REVIEW_NAMED_DELETE '+JSON.stringify({
            outlines:catalog.outlines,
            pageRefs,
            target,
        }));
        const evidence=await mkdtemp(join(tmpdir(),'evb-named-delete-'));
        await copyFile(fixture,join(evidence,'saved.pdf'));
        await page.screenshot({path:join(evidence,'after-delete.png')});
        console.info('Named deletion evidence: '+evidence);
        expect(catalog.outlines.some(item=>item.title==='Imported') && (!target || !pageRefs.includes(target)), 'No saved bookmark should name a removed page').toBe(false);
    }, 90_000);

    it('keeps untouched remote, launch, URI and named targets when another bookmark is renamed', async () => {
        const fixture = await createOutlinePageLabelFixturePdf(`source-intent-${Date.now()}.pdf`, []);
        await writeOutlineFixture(fixture, (pdf, pages) => {
            const definitions = [
                {
                    Title: PDFString.of('Chapter'),
                    Dest: [
                        pages[1]!.ref,
                        PDFName.of('XYZ'),
                        null,
                        600,
                        null,
                    ],
                },
                {
                    Title: PDFString.of('Named'),
                    Dest: PDFString.of('chapter-three'),
                },
                {
                    Title: PDFString.of('Remote'),
                    A: {
                        S: PDFName.of('GoToR'),
                        F: PDFString.of('other.pdf'),
                        D: PDFString.of('remote-chapter'),
                        NewWindow: true,
                    },
                },
                {
                    Title: PDFString.of('Launch'),
                    A: {
                        S: PDFName.of('Launch'),
                        F: PDFString.of('tool.exe'),
                        Win: {
                            F: PDFString.of('tool.exe'),
                            P: PDFString.of('-x 1.5'),
                        },
                    },
                },
                {
                    Title: PDFString.of('Site'),
                    A: pdf.context.register(pdf.context.obj({
                        S: PDFName.of('URI'),
                        URI: PDFHexString.fromText('https://example.org/a?b=1'),
                    })),
                },
            ];
            // A local name equal to the remote destination must not capture it.
            pdf.catalog.set(PDFName.of('Dests'), pdf.context.obj({
                'chapter-three': [
                    pages[2]!.ref,
                    PDFName.of('FitH'),
                    null,
                ],
                'remote-chapter': [
                    pages[3]!.ref,
                    PDFName.of('Fit'),
                ],
            }));
            return definitions;
        });
        const source = await readOutlineTargets(fixture);
        const {page} = sessions.getSession();
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        await openDocumentSidebarTab(page, 'Bookmarks');
        await renameBookmarkAsUser(page, 'Chapter', 'Chapter renamed');
        await saveViaVisibleToolbar(page, 90_000, fixture);
        const saved = await readOutlineTargets(fixture);
        const evidence = await mkdtemp(join(tmpdir(), 'evb-source-intent-'));
        await copyFile(fixture, join(evidence, 'saved.pdf'));
        console.info('SOURCE_INTENT_SAVE ' + JSON.stringify({
            source,
            saved,
            evidence,
        }));
        expect(saved).toEqual(source.map(target => target.title === 'Chapter' ? {
            ...target,
            title: 'Chapter renamed',
        } : target));
        await clickAsUser(page, 'button[aria-label="Close Tab"]');
        await page.waitForSelector('.page_container', {hidden: true});
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        await openDocumentSidebarTab(page, 'Bookmarks');
        for (const title of [
            'Remote',
            'Launch',
            'Site',
        ]) await findBookmarkRow(page, title);
        await activateBookmark(page, 'Chapter renamed');
        await waitForToolbarCurrentPage(page, 2);
        await activateBookmark(page, 'Named');
        await waitForToolbarCurrentPage(page, 3);
        await page.screenshot({path: join(evidence, 'reopened.png')});
    }, 90_000);

    it('keeps destination kinds and null coordinates when renaming a large outline', async () => {
        const fixture = await createOutlinePageLabelFixturePdf(`destination-fidelity-${Date.now()}.pdf`, []);
        const pdf = await PDFDocument.load(await readFile(fixture));
        const definitions = [
            {
                title: 'XYZ unspecified',
                page: 0,
                kind: 'XYZ',
                coordinates: [
                    null,
                    null,
                    null,
                ],
            },
            {
                title: 'FitH unspecified',
                page: 1,
                kind: 'FitH',
                coordinates: [null],
            },
            {
                title: 'Fit rectangle',
                page: 2,
                kind: 'FitR',
                coordinates: [
                    100,
                    200,
                    500,
                    600,
                ],
            },
            {
                title: 'Fit page',
                page: 3,
                kind: 'Fit',
                coordinates: [],
            },
        ];
        definitions.push(
            {
                title: 'Fit vertical',
                page: 0,
                kind: 'FitV',
                coordinates: [100],
            },
            {
                title: 'Fit bounding',
                page: 1,
                kind: 'FitB',
                coordinates: [],
            },
            {
                title: 'Fit bounding horizontal',
                page: 2,
                kind: 'FitBH',
                coordinates: [null],
            },
            {
                title: 'Fit bounding vertical',
                page: 3,
                kind: 'FitBV',
                coordinates: [null],
            },
        );
        const outlines = pdf.context.obj({Type: PDFName.of('Outlines')});
        const outlinesRef = pdf.context.register(outlines);
        const entries = Array.from({length: 10_000}, (_, index) => {
            const definition = definitions[index] ?? {
                title: `Section ${index + 1}`,
                page: index % 4,
                kind: 'FitH',
                coordinates: [null],
            };
            const entry = pdf.context.obj({
                Title: PDFString.of(definition.title),
                Parent: outlinesRef,
                Dest: [
                    pdf.getPages()[definition.page]!.ref,
                    PDFName.of(definition.kind),
                    ...definition.coordinates,
                ],
            });
            return {
                entry,
                ref: pdf.context.register(entry),
            };
        });
        entries.forEach(({entry}, index) => {
            if (index > 0) entry.set(PDFName.of('Prev'), entries[index - 1]!.ref);
            if (index + 1 < entries.length) entry.set(PDFName.of('Next'), entries[index + 1]!.ref);
        });
        outlines.set(PDFName.of('First'), entries[0]!.ref);
        outlines.set(PDFName.of('Last'), entries.at(-1)!.ref);
        outlines.set(PDFName.of('Count'), pdf.context.obj(entries.length));
        pdf.catalog.set(PDFName.of('Outlines'), outlinesRef);
        await writeFile(fixture, await pdf.save());
        const expectedDestinations = await readOriginalDestinationSamples(fixture);
        const {page} = sessions.getSession();
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        await openDocumentSidebarTab(page, 'Bookmarks');
        for (const definition of definitions) {
            await goToPageViaToolbar(page, definition.page === 3 ? 1 : 4);
            await scrollBookmarkListToTop(page);
            await activateBookmark(page, definition.title);
            await waitForToolbarCurrentPage(page, definition.page + 1);
        }
        await clickAsUser(page, '.document-bookmarks-toolbar__actions button');
        const row = await findBookmarkRow(page, 'XYZ unspecified');
        await clickAsUser(page, row, {button: 'right'});
        await page.waitForSelector('.bookmarks-context-menu .pdf-context-menu__action', {visible: true});
        await clickAsUser(page, '.bookmarks-context-menu .pdf-context-menu__action');
        await page.waitForSelector('.pdf-bookmark-item-input', {visible: true});
        await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
        await page.keyboard.type('XYZ renamed'); await page.keyboard.press('Enter');
        await findBookmarkRow(page, 'XYZ renamed');
        const memoryLoaded = await page.metrics();
        const saveStart = performance.now();
        await saveViaVisibleToolbar(page, 90_000, fixture);
        const saveMs = performance.now() - saveStart;
        const memorySaved = await page.metrics();
        const saved = await PDFDocument.load(await readFile(fixture));
        expect(saved.catalog.lookup(PDFName.of('Outlines'), PDFDict).lookup(PDFName.of('Count'), PDFNumber).asNumber()).toBe(10_000);
        console.info('CORE3_LARGE_OUTLINE ' + JSON.stringify({
            count: 10_000,
            saveMs,
            heapLoaded: memoryLoaded.JSHeapUsedSize,
            heapSaved: memorySaved.JSHeapUsedSize,
        }));
        expect(await readOriginalDestinationSamples(fixture)).toEqual(expectedDestinations);
        await clickAsUser(page, 'button[aria-label="Close Tab"]');
        await page.waitForSelector('.page_container', {hidden: true});
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        await openDocumentSidebarTab(page, 'Bookmarks');
        for (const [
            index,
            title,
        ] of [
                'XYZ renamed',
                'FitH unspecified',
                'Fit rectangle',
                'Fit page',
            ].entries()) {
            await goToPageViaToolbar(page, index === 3 ? 1 : 4);
            await scrollBookmarkListToTop(page);
            await activateBookmark(page, title);
            await waitForToolbarCurrentPage(page, index + 1);
        }
        const evidence = await mkdtemp(join(tmpdir(), 'evb-destination-fidelity-'));
        await writeFile(join(evidence, 'metrics.json'), JSON.stringify({
            count: 10_000,
            saveMs,
            heapLoaded: memoryLoaded.JSHeapUsedSize,
            heapSaved: memorySaved.JSHeapUsedSize,
        }, null, 2));
        await copyFile(fixture, join(evidence, 'saved.pdf'));
        await scrollBookmarkListToTop(page);
        await page.screenshot({path: join(evidence, 'reopened.png')});
        console.info(`Bookmark fidelity evidence: ${evidence}`);
    }, 300_000);

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

async function scrollBookmarkListToTop(page: Page) {
    const scroller = await page.$eval('.document-bookmark-tree__list', (element) => {
        const box = element.getBoundingClientRect();
        return {
            x: box.x + box.width / 2,
            y: box.y + box.height / 2,
            distance: element.scrollHeight,
        };
    });
    await page.mouse.move(scroller.x, scroller.y);
    await page.mouse.wheel({deltaY: -scroller.distance});
    await waitForFunctionInPage(page, () => document.querySelector('.document-bookmark-tree__list')?.scrollTop === 0);
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

async function readOriginalDestinationSamples(path: string) {
    const pdf = await PDFDocument.load(await readFile(path));
    const outlines = pdf.catalog.lookup(PDFName.of('Outlines'), PDFDict);
    let entry = outlines.lookup(PDFName.of('First'), PDFDict);
    const samples = [];
    for (let index = 0; index < 8; index += 1) {
        const destination = entry.lookup(PDFName.of('Dest'), PDFArray).asArray();
        samples.push({
            pageIndex: pdf.getPages().findIndex(page => page.ref.toString() === destination[0]!.toString()),
            kind: destination[1]!.toString(),
            coordinates: destination.slice(2).map(value => {
                if (value === PDFNull) return null;
                if (!(value instanceof PDFNumber)) throw new Error('Saved bookmark coordinate must be numeric or null');
                return value.asNumber();
            }),
        });
        if (index < 7) entry = entry.lookup(PDFName.of('Next'), PDFDict);
    }
    return samples;
}

/**
 * Gives the fixture an outline built from `describe`, linked in order. The
 * callback may also add catalog entries the outline refers to.
 */
async function writeOutlineFixture(
    fixture: string,
    describe: (pdf: PDFDocument, pages: PDFPage[]) => Array<Record<string, unknown>>,
) {
    const pdf = await PDFDocument.load(await readFile(fixture));
    const definitions = describe(pdf, pdf.getPages());
    const outlinesRef = pdf.context.nextRef();
    const refs = definitions.map(() => pdf.context.nextRef());
    definitions.forEach((definition, index) => pdf.context.assign(refs[index]!, pdf.context.obj({
        ...definition,
        Parent: outlinesRef,
        ...(index > 0 ? {Prev: refs[index - 1]} : {}),
        ...(index + 1 < refs.length ? {Next: refs[index + 1]} : {}),
    })));
    pdf.context.assign(outlinesRef, pdf.context.obj({
        Type: PDFName.of('Outlines'),
        First: refs[0],
        Last: refs.at(-1),
        Count: refs.length,
    }));
    pdf.catalog.set(PDFName.of('Outlines'), outlinesRef);
    await writeFile(fixture, await pdf.save());
}

/** Each top-level outline item's title and its saved /A and /Dest, as written. */
async function readOutlineTargets(fixture: string) {
    const document = await PDFDocument.load(await readFile(fixture));
    let node: PDFDict | undefined = document.catalog.lookup(PDFName.of('Outlines'), PDFDict).lookup(PDFName.of('First'), PDFDict);
    const targets = [];
    while (node) {
        targets.push({
            title: node.lookup(PDFName.of('Title'), PDFString, PDFHexString).decodeText(),
            action: node.lookup(PDFName.of('A'))?.toString() ?? null,
            dest: node.lookup(PDFName.of('Dest'))?.toString() ?? null,
        });
        node = node.lookupMaybe(PDFName.of('Next'), PDFDict);
    }
    return targets;
}

async function renameBookmarkAsUser(page: Page, title: string, nextTitle: string) {
    await clickAsUser(page, '.document-bookmarks-toolbar__actions button');
    await clickAsUser(page, await findBookmarkRow(page, title), {button: 'right'});
    await page.waitForSelector('.bookmarks-context-menu .pdf-context-menu__action', {visible: true});
    await clickAsUser(page, '.bookmarks-context-menu .pdf-context-menu__action');
    await page.waitForSelector('.pdf-bookmark-item-input', {visible: true});
    await activateMenuItemAsUser(page, {accelerator: 'CmdOrCtrl+A'});
    // The menu command runs after the accelerator returns; typing before the
    // selection lands would keep the old title's first character.
    await waitForFunctionInPage(page, () => {
        const input = document.activeElement;
        return input instanceof HTMLInputElement && input.selectionStart === 0 && input.selectionEnd === input.value.length;
    });
    await page.keyboard.type(nextTitle);
    await page.keyboard.press('Enter');
    await findBookmarkRow(page, nextTitle);
}
