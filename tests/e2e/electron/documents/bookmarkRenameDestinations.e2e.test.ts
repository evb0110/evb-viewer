import {
    PDFDocument, PDFName, PDFString, PDFHexString, PDFArray, PDFDict, PDFNumber, PDFNull, PDFRef, degrees, type PDFPage,
} from 'pdf-lib';
import {
    copyFile, mkdtemp, open, readFile, realpath, stat, writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {electronFileLogDir} from '@scripts/electron-run/electronRunSessionPaths';
import {join} from 'node:path';
import {
    describe, expect, it, onTestFinished,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    goToPageViaToolbar, openDocumentSidebarTab, openPdfInApp, saveViaVisibleToolbar, saveViaWindowHandle, waitForPdfLoaded, waitForToolbarCurrentPage,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    createOutlinePageLabelFixturePdf, fixtureBookmark, readPdfMetadataWithQpdf, resolveNativeLargePdfFixtureAvailability,
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
import {
    readNativePdfCatalog, resolveNativePageOpsPath,
} from '@electron/features/page-ops/public/nativePageOpsPath';

describe('Electron E2E - bookmark destination round trip', () => {
    const sessions = createElectronE2ESessionFixture({sessionName: () => `e2e-bookmark-rename-${Date.now()}`});

    // The same catalog must be visible below and above the native eager-load
    // ceiling. Reuse the large-file lane's sparse size rather than a 2 GB book.
    it.each([
        'small',
        'large',
    ])('reads labels and named outline targets from a %s catalog', async (size) => {
        const fixture = await createOutlinePageLabelFixturePdf(`catalog-${size}-${Date.now()}.pdf`, []);
        await writeOutlineFixture(fixture, (pdf, pages) => {
            pdf.catalog.set(PDFName.of('Dests'), pdf.context.obj({'chapter-three': [
                pages[2]!.ref,
                PDFName.of('FitH'),
                null,
            ]}));
            return [
                {
                    Title: PDFString.of('First'),
                    Dest: [
                        pages[0]!.ref,
                        PDFName.of('Fit'),
                    ],
                },
                {
                    Title: PDFString.of('Named chapter'),
                    Dest: PDFString.of('chapter-three'),
                },
            ];
        });
        if (size === 'large') {
            const oversized = resolveNativeLargePdfFixtureAvailability(4);
            if (!oversized.path) throw new Error(oversized.reason);
            const targetBytes = (await stat(oversized.path)).size;
            const source = await readFile(fixture);
            const startXref = [...source.toString('latin1').matchAll(/startxref\s+(\d+)\s+%%EOF/gu)].at(-1)?.[1];
            if (startXref === undefined) throw new Error('Catalog fixture has no cross-reference trailer');
            const trailer = Buffer.from(`\nstartxref\n${startXref}\n%%EOF\n`, 'ascii');
            if (process.platform === 'win32') {
                execFileSync('fsutil.exe', [
                    'sparse',
                    'setflag',
                    fixture,
                ]);
            }
            const handle = await open(fixture, 'r+');
            try {
                await handle.truncate(targetBytes);
                await handle.write(trailer, 0, trailer.length, targetBytes - trailer.length);
            } finally {
                await handle.close();
            }
            expect((await stat(fixture)).size).toBeGreaterThan(512 * 1024 * 1024);
        }
        const session = sessions.getSession();
        const {page} = session;
        const logPath = join(electronFileLogDir(session.name), 'app.ndjson');
        const initialLog = (await readFile(logPath, 'utf8')).length;
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        await expect.poll(async () => (await readToolbarPageIndicator(page)).primaryText, {timeout: 30_000}).toBe('front-i');
        await openDocumentSidebarTab(page, 'Bookmarks');
        await findBookmarkRow(page, 'First');
        await activateBookmark(page, 'Named chapter');
        await waitForToolbarCurrentPage(page, 3);
        await expect.poll(async () => (await readToolbarPageIndicator(page)).primaryText).toBe('chapter-1');
        expect(await page.$eval('.page_container[data-page="3"]', node => node.textContent)).toContain('Metadata matrix page 3');
        await activateBookmark(page, 'First');
        await waitForToolbarCurrentPage(page, 1);
        await expect.poll(async () => (await readToolbarPageIndicator(page)).primaryText).toBe('front-i');
        const log = (await readFile(logPath, 'utf8')).slice(initialLog);
        expect(log).not.toContain('Large incremental PDF input requires');
        expect(log.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry =>
            entry.msg === 'IPC handler rejected' && (entry.data?.channel === 'pdf:pageLabels:read' || entry.data?.channel === 'page-ops:read-outline')))
            .toEqual([]);
        const nativePath = resolveNativePageOpsPath();
        if (!nativePath) throw new Error('Native catalog reader is unavailable');
        expect(await readNativePdfCatalog(nativePath, fixture, {commandLabel: 'E2E combine catalog read'})).toMatchObject({
            pageLabels: [
                {
                    pageIndex: 0,
                    style: 'r',
                    prefix: 'front-',
                },
                {
                    pageIndex: 2,
                    style: 'D',
                    prefix: 'chapter-',
                },
            ],
            bookmarks: [
                {
                    title: 'First',
                    pageIndex: 0,
                },
                {
                    title: 'Named chapter',
                    pageIndex: 2,
                },
            ],
        });
        console.info('CATALOG_READ ' + JSON.stringify({
            size,
            indicator: await readToolbarPageIndicator(page),
        }));
    }, 180_000);

    // I1/R2: finishing an edit must not consume the next deliberate click.
    it.each([
        [
            120,
            1,
        ],
        [
            120,
            2,
        ],
        [
            120,
            3,
        ],
        [
            4_000,
            1,
        ],
        [
            10_000,
            1,
        ],
    ])('outlinetree keeps a visible bookmark click after offscreen rename blur (%i bookmarks, run %i)', async count => {
        const fixture = await createBookmarkTreeFixturePdf(`blur-click-${Date.now()}.pdf`, [
            ...Array.from({length: count - 1}, (_, index) => fixtureBookmark(`Filler ${index + 1}`, index % 4)),
            fixtureBookmark('Rename source', 0),
        ]);
        const {page} = sessions.getSession();
        await openBookmarkEditor(page, fixture);
        await wheelBookmarkList(page, 1_000_000);
        await waitForFunctionInPage(page, () => {
            const list = document.querySelector('.document-bookmark-tree__list')!;
            return list.scrollTop > list.scrollHeight - list.clientHeight - 50;
        });
        await clickAsUser(page, await findBookmarkRow(page, 'Rename source'), {button: 'right'});
        await clickAsUser(page, '.bookmarks-context-menu .pdf-context-menu__action');
        await page.waitForSelector('input.pdf-bookmark-item-input', {visible: true});
        await page.keyboard.type('Rename committed');
        const beforeWheel = await page.$eval('.document-bookmark-tree__list', list => list.scrollTop);
        await wheelBookmarkList(page, -3_500);
        await waitForFunctionInPage(page, (before: number) => document.querySelector('.document-bookmark-tree__list')!.scrollTop < before - 3_000, {}, beforeWheel);
        const target = await page.evaluate(() => {
            const bounds = document.querySelector('.document-bookmark-tree__list')!.getBoundingClientRect();
            return Array.from(document.querySelectorAll<HTMLElement>('.document-bookmark-item__row')).find(row => {
                const rect = row.getBoundingClientRect();
                const title = row.textContent?.trim() ?? '';
                return rect.top > bounds.top + 90 && rect.bottom < bounds.bottom - 90
                    && /^Filler \d+$/.test(title) && (Number(title.split(' ')[1]) - 1) % 4 === 2;
            })?.textContent?.trim() ?? '';
        });
        expect(target).toMatch(/^Filler /);
        await clickFoundAsUser(page, (title: string) => Array.from(document.querySelectorAll<HTMLElement>('.document-bookmark-item__row'))
            .find(row => row.textContent?.trim() === title), target, {
            description: 'Activate visible bookmark after rename blur',
            delay: 100,
        });
        await expect.poll(() => page.$$eval('.document-bookmark-item__row.is-active', rows => rows.map(row => row.textContent?.trim())), {timeout: 6_000}).toEqual([target]);
        await expectBookmarkFocus(page, target);
        await waitForToolbarCurrentPage(page, 3);
        await wheelBookmarkList(page, 1_000_000);
        await findBookmarkRow(page, 'Rename committed');
    }, 120_000);

    // I1/R2: completing a retained offscreen input returns visible row focus.
    it.each([
        [
            120,
            'Enter',
        ],
        [
            4_000,
            'Enter',
        ],
        [
            10_000,
            'Enter',
        ],
        [
            120,
            'Escape',
        ],
        [
            4_000,
            'Escape',
        ],
        [
            10_000,
            'Escape',
        ],
    ] as const)('outlinetree reveals offscreen rename completion (%i bookmarks, %s)', async (count, key) => {
        const fixture = await createBookmarkTreeFixturePdf(`rename-offscreen-${count}-${key}-${Date.now()}.pdf`, [
            ...Array.from({length: count - 1}, (_, index) => fixtureBookmark(`Filler ${index + 1}`, index % 4)),
            fixtureBookmark('Rename source', 0),
        ]);
        const {page} = sessions.getSession();
        await openBookmarkEditor(page, fixture);
        await wheelBookmarkList(page, 1_000_000);
        await waitForFunctionInPage(page, () => {
            const list = document.querySelector('.document-bookmark-tree__list')!;
            return list.scrollTop > list.scrollHeight - list.clientHeight - 50;
        });
        await clickAsUser(page, await findBookmarkRow(page, 'Rename source'), {button: 'right'});
        await clickAsUser(page, '.bookmarks-context-menu .pdf-context-menu__action');
        await page.waitForSelector('input.pdf-bookmark-item-input', {visible: true});
        await page.keyboard.type('Key committed');
        const beforeWheel = await page.$eval('.document-bookmark-tree__list', list => list.scrollTop);
        await wheelBookmarkList(page, -3_500);
        await waitForFunctionInPage(page, (before: number) => document.querySelector('.document-bookmark-tree__list')!.scrollTop < before - 3_000, {}, beforeWheel);
        expect(await page.evaluate(() => document.activeElement?.matches('input.pdf-bookmark-item-input'))).toBe(true);
        await page.keyboard.press(key);
        await expectBookmarkFocus(page, key === 'Enter' ? 'Key committed' : 'Rename source');
    }, 120_000);

    it('outlinetree keeps visible rename Enter and Escape focused in place', async () => {
        const fixture = await createOutlinePageLabelFixturePdf(`rename-keys-${Date.now()}.pdf`, [fixtureBookmark('Rename source', 0)]);
        const {page} = sessions.getSession();
        await openBookmarkEditor(page, fixture);
        await clickAsUser(page, await findBookmarkRow(page, 'Rename source'), {button: 'right'});
        await clickAsUser(page, '.bookmarks-context-menu .pdf-context-menu__action');
        await page.waitForSelector('input.pdf-bookmark-item-input', {visible: true});
        await page.keyboard.type('Rename committed');
        await page.keyboard.press('Enter');
        await expectBookmarkFocus(page, 'Rename committed');
        await clickAsUser(page, await findBookmarkRow(page, 'Rename committed'), {button: 'right'});
        await clickAsUser(page, '.bookmarks-context-menu .pdf-context-menu__action');
        await page.waitForSelector('input.pdf-bookmark-item-input', {visible: true});
        await page.keyboard.type('Discarded');
        await page.keyboard.press('Escape');
        await expectBookmarkFocus(page, 'Rename committed');
    }, 120_000);

    // Focus is distinct from activation/selection; removal and Undo keep a
    // usable rendered row, including when virtual rows or their ids change.
    it.each([
        8,
        120,
        4_000,
        10_000,
    ])('outlinetree restores focus after single and multi delete and Undo (%i bookmarks)', async count => {
        const fixture = await createBookmarkTreeFixturePdf(`delete-focus-${count}-${Date.now()}.pdf`, [
            ...Array.from({length: count - 6}, (_, index) => fixtureBookmark(`Filler ${index + 1}`, index % 4)),
            fixtureBookmark('Before', 0),
            fixtureBookmark('Delete me', 1),
            fixtureBookmark('After', 2),
            fixtureBookmark('Parent', 3, [fixtureBookmark('Only child', 3)]),
            fixtureBookmark('Last', 3),
        ]);
        const {page} = sessions.getSession();
        await openBookmarkEditor(page, fixture);
        await clickAsUser(page, 'button[aria-label="Top level only"]');
        await wheelBookmarkList(page, 1_000_000);
        await clickAsUser(page, await findBookmarkRow(page, 'After'));
        await page.keyboard.press('ArrowUp');
        await expectBookmarkFocus(page, 'Delete me');
        await clickAsUser(page, await findBookmarkRow(page, 'Delete me'), {button: 'right'});
        await clickAsUser(page, '.bookmarks-context-menu .pdf-context-menu__action--danger');
        await expectBookmarkFocus(page, 'After');
        // Keyboard focus can be far from the active destination. Undo must
        // retain that focus without the passive page selection revealing it.
        await page.keyboard.press('Home');
        await expectBookmarkFocus(page, 'Filler 1');
        await activateMenuItemAsUser(page, {accelerator: 'CmdOrCtrl+Z'});
        await expectBookmarkFocus(page, 'Filler 1');
        await page.keyboard.press('End');
        await findBookmarkRow(page, 'Delete me');

        await clickAsUser(page, await findBookmarkRow(page, 'Delete me'));
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.down(modifier);
        await clickAsUser(page, await findBookmarkRow(page, 'After'));
        await page.keyboard.up(modifier);
        await clickAsUser(page, 'button[aria-label="Remove 2 selected bookmarks"]');
        await expectBookmarkFocus(page, 'Parent');
        await activateMenuItemAsUser(page, {accelerator: 'CmdOrCtrl+Z'});
        await expectBookmarkFocus(page, 'Parent');
        await findBookmarkRow(page, 'Delete me');
        await findBookmarkRow(page, 'After');

        await clickAsUser(page, await findBookmarkRow(page, 'Last'));
        await clickAsUser(page, await findBookmarkRow(page, 'Last'), {button: 'right'});
        await clickAsUser(page, '.bookmarks-context-menu .pdf-context-menu__action--danger');
        // Parent is collapsed: a hidden child cannot be the focus successor.
        await expectBookmarkFocus(page, 'Parent');
        await clickAsUser(page, (await (await findBookmarkRow(page, 'Parent')).$('.document-bookmark-item__toggle'))!);
        await clickAsUser(page, await findBookmarkRow(page, 'Only child'));
        await clickAsUser(page, await findBookmarkRow(page, 'Only child'), {button: 'right'});
        await clickAsUser(page, '.bookmarks-context-menu .pdf-context-menu__action--danger');
        await expectBookmarkFocus(page, 'Parent');
        await activateMenuItemAsUser(page, {accelerator: 'CmdOrCtrl+Z'});
        await expectBookmarkFocus(page, 'Parent');
        await activateMenuItemAsUser(page, {accelerator: 'CmdOrCtrl+Z'});
        await expectBookmarkFocus(page, 'Parent');
        await findBookmarkRow(page, 'Last');
    }, 180_000);

    // WAI-ARIA treeview keyboard contract, including offscreen focus targets.
    it.each([
        8,
        120,
        4_000,
        10_000,
    ])('outlinetree traverses and expands with Left and Right (%i bookmarks)', async count => {
        const childCount = count === 8 ? 3 : Math.min(120, count - 4);
        const fixture = await createBookmarkTreeFixturePdf(`tree-keys-${count}-${Date.now()}.pdf`, [
            ...Array.from({length: count - childCount - 3}, (_, index) => fixtureBookmark(`Filler ${index + 1}`, index % 4)),
            fixtureBookmark('Parent', 3, Array.from({length: childCount}, (_, index) => fixtureBookmark(`Child ${index + 1}`, 3))),
            fixtureBookmark('Tail A', 3),
            fixtureBookmark('Tail B', 3),
        ]);
        const {page} = sessions.getSession();
        await openBookmarkEditor(page, fixture);
        await clickAsUser(page, 'button[aria-label="Top level only"]');
        await wheelBookmarkList(page, 1_000_000);
        await clickAsUser(page, await findBookmarkRow(page, 'Tail B'));
        await page.keyboard.press('ArrowUp');
        await expectBookmarkFocus(page, 'Tail A');
        await page.keyboard.press('ArrowUp');
        await expectBookmarkFocus(page, 'Parent');
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => page.$eval('[data-bookmark-id]:focus .document-bookmark-item__toggle', button => button.getAttribute('aria-expanded'))).toBe('true');
        await expectBookmarkFocus(page, 'Parent');
        if (count > 8) {
            await wheelBookmarkList(page, 5_000);
            await waitForFunctionInPage(page, () => {
                const row = document.activeElement!.getBoundingClientRect();
                const list = document.querySelector('.document-bookmark-tree__list')!.getBoundingClientRect();
                return row.bottom < list.top;
            });
        }
        await page.keyboard.press('ArrowRight');
        await expectBookmarkFocus(page, 'Child 1');
        await page.keyboard.press('End');
        await expectBookmarkFocus(page, 'Tail B');
        await page.keyboard.press('ArrowUp');
        await page.keyboard.press('ArrowUp');
        await expectBookmarkFocus(page, `Child ${childCount}`);
        await page.keyboard.press('ArrowLeft');
        await expectBookmarkFocus(page, 'Parent');
        await page.keyboard.press('ArrowLeft');
        await expect.poll(() => page.$eval('[data-bookmark-id]:focus .document-bookmark-item__toggle', button => button.getAttribute('aria-expanded'))).toBe('false');
        await expectBookmarkFocus(page, 'Parent');
        await page.keyboard.press('ArrowDown');
        await expectBookmarkFocus(page, 'Tail A');
        await page.keyboard.press('ArrowRight');
        await expectBookmarkFocus(page, 'Tail A');
        await page.keyboard.press('Home');
        await expectBookmarkFocus(page, 'Filler 1');
        await page.keyboard.press('ArrowLeft');
        await expectBookmarkFocus(page, 'Filler 1');
        await page.keyboard.press('End');
        await expectBookmarkFocus(page, 'Tail B');
    }, 180_000);

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

    it('review-b6yr shows valid siblings when one imported destination is dangling', async () => {
        const fixture = await createOutlinePageLabelFixturePdf(`dangling-destination-${Date.now()}.pdf`, []);
        await writeOutlineFixture(fixture, (_pdf, pages) => [
            {
                Title: PDFString.of('Valid first'),
                Dest: [
                    pages[0]!.ref,
                    PDFName.of('Fit'),
                ],
            },
            {
                Title: PDFString.of('Target under review'),
                Dest: PDFRef.of(9999),
            },
            {
                Title: PDFString.of('Valid last'),
                Dest: [
                    pages[2]!.ref,
                    PDFName.of('FitH'),
                    null,
                ],
            },
        ]);
        const {page} = sessions.getSession();
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        await openDocumentSidebarTab(page, 'Bookmarks');
        const titles = () => page.$$eval('.pdf-bookmark-item-row, .document-bookmark-item__row', rows => rows.map(row => row.textContent?.trim()));
        try {
            await expect.poll(titles, {timeout: 15_000}).toEqual([
                'Valid first',
                'Target under review',
                'Valid last',
            ]);
        } finally {
            await page.screenshot({path: join(await mkdtemp(join(tmpdir(), 'evb-dangling-destination-')), 'bookmarks.png')});
        }
        await activateBookmark(page, 'Valid last');
        await waitForToolbarCurrentPage(page, 3);
    }, 90_000);

    it('review-b6yr keeps a Unicode named destination after another bookmark is renamed', async () => {
        const fixture = await createOutlinePageLabelFixturePdf(`unicode-name-${Date.now()}.pdf`, []);
        await writeOutlineFixture(fixture, (pdf, pages) => {
            pdf.catalog.set(PDFName.of('Names'), pdf.context.obj({Dests: {Names: [
                PDFHexString.fromText('caf\u00e9'),
                [
                    pages[2]!.ref,
                    PDFName.of('FitH'),
                    null,
                ],
            ]}}));
            return [
                {
                    Title: PDFString.of('Chapter'),
                    Dest: [
                        pages[1]!.ref,
                        PDFName.of('Fit'),
                    ],
                },
                {
                    Title: PDFString.of('Named'),
                    Dest: PDFHexString.fromText('caf\u00e9'),
                },
            ];
        });
        const source = await readOutlineTargets(fixture);
        const {page} = sessions.getSession();
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        await openDocumentSidebarTab(page, 'Bookmarks');
        await renameBookmarkAsUser(page, 'Chapter', 'Chapter renamed');
        await saveViaVisibleToolbar(page, 90_000, fixture);
        const saved = await readOutlineTargets(fixture);
        console.info('UNICODE_NAME_SAVE ' + JSON.stringify({
            source,
            saved,
        }));
        expect(saved).toEqual([
            {
                ...source[0]!,
                title: 'Chapter renamed',
            },
            source[1],
        ]);
        await clickAsUser(page, 'button[aria-label="Close Tab"]');
        await page.waitForSelector('.page_container', {hidden: true});
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        await openDocumentSidebarTab(page, 'Bookmarks');
        await activateBookmark(page, 'Named');
        await waitForToolbarCurrentPage(page, 3);
    }, 90_000);

    it('review-b6yr keeps an untouched GoToR with an indirect file specification', async () => {
        const fixture = await createOutlinePageLabelFixturePdf(`indirect-filespec-${Date.now()}.pdf`, []);
        await writeOutlineFixture(fixture, (pdf, pages) => [
            {
                Title: PDFString.of('Chapter'),
                Dest: [
                    pages[1]!.ref,
                    PDFName.of('Fit'),
                ],
            },
            {
                Title: PDFString.of('Remote'),
                A: {
                    S: PDFName.of('GoToR'),
                    F: pdf.context.register(pdf.context.obj({
                        Type: PDFName.of('Filespec'),
                        F: PDFString.of('chapter-two.pdf'),
                        UF: PDFHexString.fromText('chapter-two.pdf'),
                    })),
                    D: [
                        0,
                        PDFName.of('Fit'),
                    ],
                },
            },
        ]);
        const readRemote = async () => {
            const document = await PDFDocument.load(await readFile(fixture));
            const action = document.catalog.lookup(PDFName.of('Outlines'), PDFDict).lookup(PDFName.of('First'), PDFDict)
                .lookup(PDFName.of('Next'), PDFDict).lookupMaybe(PDFName.of('A'), PDFDict);
            return action && {
                kind: action.lookup(PDFName.of('S'))?.toString(),
                file: action.lookup(PDFName.of('F'), PDFDict).toString(),
                destination: action.lookup(PDFName.of('D'))?.toString(),
            };
        };
        const source = await readRemote();
        const {page} = sessions.getSession();
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        await openDocumentSidebarTab(page, 'Bookmarks');
        await renameBookmarkAsUser(page, 'Chapter', 'Chapter renamed');
        await saveViaVisibleToolbar(page, 90_000, fixture);
        const saved = await readRemote();
        console.info('INDIRECT_FILESPEC_SAVE ' + JSON.stringify({
            source,
            saved,
        }));
        expect(saved).toEqual(source);
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
        const editStart = performance.now();
        await clickAsUser(page, '.document-bookmarks-toolbar__actions button');
        await page.waitForSelector('.pdf-bookmark-item-actions-trigger', {visible: true});
        const editMs = performance.now() - editStart;
        console.info('BOOKMARK_EDIT_MODE ' + JSON.stringify({
            count: 10_000,
            editMs,
        }));
        // Generous compared with the viewport-sized edit list, while rejecting
        // the tens of seconds spent mounting the entire imported outline.
        expect(editMs).toBeLessThan(10_000);
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

    it('keeps virtual bookmark editing, focus and offscreen drag targets usable', async () => {
        const fixture = await createOutlinePageLabelFixturePdf(`virtual-outline-${Date.now()}.pdf`, [
            fixtureBookmark('مرحبا', 0),
            fixtureBookmark('Second', 1),
            fixtureBookmark('Parent', 2, [fixtureBookmark('Nested', 3)]),
            ...Array.from({length: 117}, (_, index) => fixtureBookmark(`Row ${index + 4}`, index % 4)),
        ]);
        const {page} = sessions.getSession();
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        await openDocumentSidebarTab(page, 'Bookmarks');
        await clickAsUser(page, 'button[aria-label="Enter bookmark edit mode"]');
        await clickAsUser(page, await findBookmarkRow(page, 'مرحبا'), {button: 'right'});
        await clickAsUser(page, '.bookmarks-context-menu .pdf-context-menu__action');
        await page.waitForSelector('.pdf-bookmark-item-input', {visible: true});
        await page.keyboard.type('مرحبا جديد');
        expect(await page.$eval('.pdf-bookmark-item-input', input => getComputedStyle(input).direction)).toBe('rtl');
        const list = await page.$eval('.document-bookmark-tree__list', element => {
            const rect = element.getBoundingClientRect();
            return {
                x: rect.x + rect.width / 2,
                y: rect.y + rect.height / 2,
            };
        });
        await page.mouse.move(list.x, list.y);
        await page.mouse.wheel({deltaY: 2_000});
        await waitForFunctionInPage(page, () => (document.querySelector('.document-bookmark-tree__list')?.scrollTop ?? 0) > 1_000);
        expect(await page.$eval('input.pdf-bookmark-item-input', input => ({
            value: input.value,
            focused: document.activeElement === input,
        })))
            .toEqual({
                value: 'مرحبا جديد',
                focused: true,
            });
        await page.keyboard.press('Escape');
        await waitForFunctionInPage(page, () => document.activeElement?.matches('.pdf-bookmark-item-row') === true);
        await page.keyboard.press('End');
        await waitForFunctionInPage(page, () => document.activeElement?.textContent?.trim() === 'Row 120');
        await page.keyboard.press('ArrowUp');
        await waitForFunctionInPage(page, () => document.activeElement?.textContent?.trim() === 'Row 119');
        await page.keyboard.press('Home');
        await waitForFunctionInPage(page, () => document.activeElement?.textContent?.trim() === 'مرحبا');
        await page.keyboard.press('Space');
        await waitForToolbarCurrentPage(page, 1);
        const first = await findBookmarkRow(page, 'مرحبا');
        await clickAsUser(page, (await first.$('.pdf-bookmark-item-actions-trigger'))!);
        await clickAsUser(page, '.bookmarks-context-menu .pdf-context-menu__action');
        await page.waitForSelector('.pdf-bookmark-item-input', {visible: true});
        await page.keyboard.type('Renamed');
        await page.keyboard.press('Enter');
        await waitForFunctionInPage(page, () => document.activeElement?.textContent?.trim() === 'Renamed');
        await activateMenuItemAsUser(page, {accelerator: 'CmdOrCtrl+Z'});
        await scrollBookmarkListToTop(page);
        await findBookmarkRow(page, 'مرحبا');

        const reorderSource = await (await findBookmarkRow(page, 'Second')).boundingBox();
        const reorderTarget = await (await findBookmarkRow(page, 'مرحبا')).boundingBox();
        expect(reorderSource).not.toBeNull();
        expect(reorderTarget).not.toBeNull();
        await page.setDragInterception(true);
        await page.mouse.dragAndDrop({
            x: reorderSource!.x + reorderSource!.width / 2,
            y: reorderSource!.y + reorderSource!.height / 2,
        }, {
            x: reorderTarget!.x + reorderTarget!.width / 2,
            y: reorderTarget!.y + 4,
        });
        await expect.poll(() => page.$$eval('.document-bookmark-item__title', titles => titles.slice(0, 3).map(title => title.textContent)))
            .toEqual([
                'Second',
                'مرحبا',
                'Parent',
            ]);
        await activateMenuItemAsUser(page, {accelerator: 'CmdOrCtrl+Z'});
        await scrollBookmarkListToTop(page);
        await expect.poll(() => page.$$eval('.document-bookmark-item__title', titles => titles.slice(0, 3).map(title => title.textContent)))
            .toEqual([
                'مرحبا',
                'Second',
                'Parent',
            ]);

        await clickAsUser(page, await findBookmarkRow(page, 'مرحبا'));
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.down(modifier);
        await clickAsUser(page, await findBookmarkRow(page, 'Second'));
        await page.keyboard.up(modifier);
        expect(await page.$$eval('.pdf-bookmark-item-row.is-selected', rows => rows.map(row => row.textContent?.trim())))
            .toEqual([
                'مرحبا',
                'Second',
            ]);
        await page.keyboard.down('Shift');
        await clickAsUser(page, await findBookmarkRow(page, 'Row 5'));
        await page.keyboard.up('Shift');
        expect(await page.$$eval('.pdf-bookmark-item-row.is-selected', rows => rows.map(row => row.textContent?.trim())))
            .toEqual([
                'Second',
                'Parent',
                'Row 4',
                'Row 5',
            ]);
        await waitForToolbarCurrentPage(page, 1);
        await clickAsUser(page, await findBookmarkRow(page, 'مرحبا'));

        // Native HTML drag input, including browser edge auto-scroll. The
        // source must survive leaving the virtual window until mouseup.
        const source = await findBookmarkRow(page, 'مرحبا');
        const sourceBox = await source.boundingBox();
        expect(sourceBox).not.toBeNull();
        const edge = await page.$eval('.document-bookmark-tree__list', element => {
            const rect = element.getBoundingClientRect();
            return {
                x: rect.x + rect.width / 2,
                y: rect.bottom - 4,
            };
        });
        const dragData = await page.mouse.drag({
            x: sourceBox!.x + sourceBox!.width / 2,
            y: sourceBox!.y + sourceBox!.height / 2,
        }, edge);
        await page.mouse.dragEnter(edge, dragData);
        await page.mouse.dragOver(edge, dragData);
        let targetTitle = '';
        try {
            await waitForFunctionInPage(page, () => (document.querySelector('.document-bookmark-tree__list')?.scrollTop ?? 0) > 1_000, {timeout: 15_000});
            // DragOver/drop coordinates do not move Chromium's actual pointer.
            // Leave the auto-scroll edge before choosing a stationary target.
            await page.mouse.move(list.x, list.y);
            await page.mouse.dragOver(list, dragData);
            await waitForFunctionInPage(page, async () => {
                const scroller = document.querySelector('.document-bookmark-tree__list')!;
                const position = scroller.scrollTop;
                await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
                await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
                return scroller.scrollTop === position;
            });
            targetTitle = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.pdf-bookmark-item-row'))
                .find(row => {
                    const box = row.getBoundingClientRect();
                    const listBox = document.querySelector('.document-bookmark-tree__list')!.getBoundingClientRect();
                    return box.top > listBox.top + 100 && box.bottom < listBox.bottom - 100;
                })?.textContent?.trim()) ?? '';
            expect(targetTitle).toMatch(/^Row /u);
            const targetRow = await findBookmarkRow(page, targetTitle);
            const targetBox = await targetRow.boundingBox();
            const dropPoint = {
                x: targetBox!.x + targetBox!.width / 2,
                y: targetBox!.y + targetBox!.height / 2,
            };
            await page.mouse.dragOver(dropPoint, dragData);
            await page.mouse.drop(dropPoint, dragData);
        } finally {
            await page.mouse.up();
        }
        await findBookmarkRow(page, 'مرحبا');
        await expect.poll(() => page.evaluate((title: string) => {
            const rows = Array.from(document.querySelectorAll<HTMLElement>('.pdf-bookmark-item-row'));
            const parent = rows.find(row => row.textContent?.trim() === title)!;
            const child = rows.find(row => row.textContent?.trim() === 'مرحبا')!;
            return child.getBoundingClientRect().left > parent.getBoundingClientRect().left;
        }, targetTitle)).toBe(true);
        await activateMenuItemAsUser(page, {accelerator: 'CmdOrCtrl+Z'});
        await scrollBookmarkListToTop(page);
        await findBookmarkRow(page, 'مرحبا');
        const parentRow = await findBookmarkRow(page, 'Parent');
        await clickAsUser(page, (await parentRow.$('.document-bookmark-item__toggle'))!);
        await findBookmarkRow(page, 'Nested');
        await clickAsUser(page, await findBookmarkRow(page, 'Parent'), {button: 'right'});
        await clickFoundAsUser(page, () => Array.from(document.querySelectorAll<HTMLElement>('.bookmarks-context-menu [role="menuitem"]'))
            .find(item => item.textContent?.trim() === 'Add child bookmark'), null, {description: 'Add bookmark child'});
        await page.waitForSelector('.pdf-bookmark-item-input', {visible: true});
        await page.keyboard.type('Added child');
        await page.keyboard.press('Enter');
        await findBookmarkRow(page, 'Added child');
        await clickAsUser(page, await findBookmarkRow(page, 'Added child'), {button: 'right'});
        await clickAsUser(page, '.bookmarks-context-menu .pdf-context-menu__action--danger');
        await waitForFunctionInPage(page, () => !Array.from(document.querySelectorAll('.document-bookmark-item__title')).some(title => title.textContent === 'Added child'));
        await activateMenuItemAsUser(page, {accelerator: 'CmdOrCtrl+Z'});
        await scrollBookmarkListToTop(page);
        const restoredParent = await findBookmarkRow(page, 'Parent');
        const restoredToggle = (await restoredParent.$('.document-bookmark-item__toggle'))!;
        if (await restoredToggle.evaluate(button => button.getAttribute('aria-expanded')) !== 'true') {
            await clickAsUser(page, restoredToggle);
        }
        await findBookmarkRow(page, 'Added child');
        await saveViaVisibleToolbar(page, 90_000, fixture);
        const saved = (await readPdfMetadataWithQpdf(fixture)).outlines;
        expect(saved[0]?.title).toBe('مرحبا');
        expect(saved.find(item => item.title === 'Parent')?.kids?.map(item => item.title)).toEqual([
            'Nested',
            'Added child',
        ]);
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
    // The bookmark editor selects its title when it opens.
    await waitForFunctionInPage(page, () => {
        const input = document.activeElement;
        return input instanceof HTMLInputElement && input.selectionStart === 0 && input.selectionEnd === input.value.length;
    });
    await page.keyboard.type(nextTitle);
    await page.keyboard.press('Enter');
    await findBookmarkRow(page, nextTitle);
}

async function openBookmarkEditor(page: Page, fixture: string) {
    await openPdfInApp(page, fixture);
    await waitForPdfLoaded(page);
    await openDocumentSidebarTab(page, 'Bookmarks');
    await clickAsUser(page, 'button[aria-label="Enter bookmark edit mode"]');
    await page.waitForSelector('.pdf-bookmark-item-actions-trigger', {visible: true});
}

async function wheelBookmarkList(page: Page, deltaY: number) {
    const point = await page.$eval('.document-bookmark-tree__list', list => {
        const rect = list.getBoundingClientRect();
        return {
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
        };
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel({deltaY});
}

async function expectBookmarkFocus(page: Page, title: string) {
    await expect.poll(() => page.evaluate(() => {
        const row = document.activeElement;
        const list = document.querySelector('.document-bookmark-tree__list');
        if (!row?.matches('.document-bookmark-item__row') || !list) return {tag: row?.tagName};
        const rect = row.getBoundingClientRect();
        const bounds = list.getBoundingClientRect();
        return {
            tag: row.tagName,
            title: row.textContent?.trim(),
            visible: rect.top >= bounds.top && rect.bottom <= bounds.bottom,
        };
    }), {timeout: 6_000}).toEqual({
        tag: 'DIV',
        title,
        visible: true,
    });
}

// Imported outlines can exceed one native mutation chunk. Construct their
// linked PDF dictionaries directly, as the destination-fidelity case does.
async function createBookmarkTreeFixturePdf(name: string, bookmarks: ReadonlyArray<ReturnType<typeof fixtureBookmark>>) {
    const fixture = await createOutlinePageLabelFixturePdf(name, []);
    const pdf = await PDFDocument.load(await readFile(fixture));
    const outlineRef = pdf.context.nextRef();
    function writeItems(items: ReadonlyArray<ReturnType<typeof fixtureBookmark>>, parent: PDFRef) {
        const refs = items.map(() => pdf.context.nextRef());
        items.forEach((item, index) => {
            const children = writeItems(item.items ?? [], refs[index]!);
            pdf.context.assign(refs[index]!, pdf.context.obj({
                Title: PDFString.of(item.title),
                Parent: parent,
                Dest: [
                    pdf.getPages()[item.pageIndex ?? 0]!.ref,
                    PDFName.of('Fit'),
                ],
                ...(index > 0 ? {Prev: refs[index - 1]} : {}),
                ...(index + 1 < refs.length ? {Next: refs[index + 1]} : {}),
                ...children,
            }));
        });
        return refs.length ? {
            First: refs[0],
            Last: refs.at(-1),
            Count: refs.length,
        } : {};
    }
    pdf.context.assign(outlineRef, pdf.context.obj({
        Type: PDFName.of('Outlines'),
        ...writeItems(bookmarks, outlineRef),
    }));
    pdf.catalog.set(PDFName.of('Outlines'), outlineRef);
    await writeFile(fixture, await pdf.save());
    return fixture;
}
