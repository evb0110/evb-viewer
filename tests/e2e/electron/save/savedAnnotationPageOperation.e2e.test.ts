import {
    mkdtemp, readFile, rm, mkdir, writeFile,
} from 'node:fs/promises';
import {
    join, resolve,
} from 'node:path';
import {tmpdir} from 'node:os';
import type {IElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import type { Page } from 'puppeteer-core';
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFRawStream,
    PDFString,
} from 'pdf-lib';
import {
    expect,
    it,
} from 'vitest';
import { createMultiPageTextFixturePdf } from '@tests/e2e/electron/helpers/fixtures';
import { startElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    clickAnnotationTool,
    clickLatestVisibleNoteWindowClose,
    createCanonicalTextBoxWithPointer,
    createStickyNoteWithPointer,
    createTextMarkupWithPointer,
    selectAllFocusedAnnotationText,
    waitForNoOpenNoteWindows,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    goToPageViaToolbar,
    openDocumentSidebarTab,
    saveViaVisibleToolbar,
    waitForToolbarCurrentPage,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    clickAsUser,
    clickFoundAsUser,
    revealForPointer,
} from '@tests/e2e/electron/helpers/userInput';
import type { IE2EWindow } from '@tests/e2e/electron/helpers/e2EWindow';
import {getActiveWorkspaceWorkingCopyPath} from '@tests/e2e/electron/helpers/electronApiHelpers';

// Tagged books remain editable; saved subsets retain only the selected pages and their tags.
it.each([
    'delete',
    'extract',
    'insert-tagged-destination',
    'insert-tagged-source',
])('preserves tagged pages through real %s input', async operation => {
    const evidence = resolve('.devkit/extract-structure', process.env.EVB_STRUCTURE_PROOF_PHASE ?? 'after', operation);
    await mkdir(evidence, {recursive: true});
    const book = await PDFDocument.load(await readFile(resolve('tests/fixtures/electron/pdf-preservation/tagged.pdf')));
    const scan = await book.embedPng(await readFile(resolve('tests/fixtures/browser/rtl-ocr/pointed-hebrew-scan.png')));
    for (const [
        index,
        page,
    ] of book.getPages().entries()) {
        page.drawImage(scan, {
            x: 0,
            y: 0,
            width: 200,
            height: 200,
        });
        page.drawText(`Scanned book page ${index + 1}`, {
            x: 10,
            y: 10,
            size: 10,
            opacity: 0,
        });
    }
    const tagged = await book.save();
    const ordinary = await readFile(resolve('tests/fixtures/electron/generated-text.pdf'));
    const inputPath = join(evidence, 'input.pdf');
    const insertPath = join(evidence, 'insert.pdf');
    const extractedPath = join(evidence, 'extracted.pdf');
    await writeFile(inputPath, operation === 'insert-tagged-source' ? ordinary : tagged);
    await writeFile(insertPath, operation === 'insert-tagged-source' ? tagged : ordinary);
    await writeFile(extractedPath, ordinary);
    const original = await readFile(inputPath);
    let session: IElectronE2ESession | undefined;
    try {
        session = await startElectronE2ESession(`e2e-tagged-refusal-${operation}`, {
            clean: true,
            initialOpenPaths: [inputPath],
            extraEnv: {EVB_E2E_SAVE_DIALOG_PATH: extractedPath},
        });
        const {page} = session;
        await waitForViewerInteractive(page);
        const workingPath = await getActiveWorkspaceWorkingCopyPath(page);
        const baseline = await readFile(workingPath);
        const baselinePdf = await PDFDocument.load(baseline);
        await openDocumentSidebarTab(page, 'Pages');
        if (operation.startsWith('insert-')) {
            const point = await revealForPointer(page, '.editor-pane.is-active [data-thumbnail-page="1"]');
            const client = await page.createCDPSession();
            try {
                for (const type of [
                    'dragEnter',
                    'dragOver',
                    'drop',
                ] as const) {
                    await client.send('Input.dispatchDragEvent', {
                        type,
                        x: point.x,
                        y: point.y,
                        data: {
                            items: [],
                            files: [insertPath],
                            dragOperationsMask: 1,
                        },
                    });
                }
            } finally {
                await client.detach();
            }
        } else {
            await clickAsUser(page, '.editor-pane.is-active [data-thumbnail-page="1"]', {button: 'right'});
            const label = operation === 'delete' ? 'Delete Pages' : 'Extract to New PDF';
            await clickFoundAsUser(page, (text: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
                .find(element => element.textContent?.trim() === text), label, {description: label});
        }
        await page.waitForFunction(() => (window as IE2EWindow).__evbTestApi
            ?.readActiveWorkspaceStateValues(['isPageOperationInProgress']).isPageOperationInProgress === false);
        expect(await page.$$eval('.app-toast-failure', elements => elements.map(element => element.textContent).join('\n'))).toBe('');
        await waitForViewerInteractive(page);
        await page.waitForSelector('.editor-pane.is-active .page_container--rendered canvas', {visible: true});
        await page.screenshot({path: join(evidence, 'result.png')});
        const saved = await PDFDocument.load(await readFile(operation === 'extract' ? extractedPath : workingPath));
        expect(saved.getPageCount()).toBe(operation.startsWith('insert-')
            ? baselinePdf.getPageCount() + (await PDFDocument.load(await readFile(insertPath))).getPageCount()
            : 1);
        expect(await readFile(inputPath)).toEqual(original);
        if (operation === 'extract') expect(await readFile(workingPath)).toEqual(baseline);
        const imageBytes = (pdf: PDFDocument) => pdf.context.enumerateIndirectObjects()
            .map(([
                , object,
            ]) => object).filter((object): object is PDFRawStream => object instanceof PDFRawStream
                && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'))
            .map(object => Buffer.from(object.getContents()).toString('base64'));
        expect(imageBytes(saved)).toEqual(expect.arrayContaining(imageBytes(book)));
        if (operation !== 'insert-tagged-source') {
            const root = saved.catalog.lookup(PDFName.of('StructTreeRoot'), PDFDict);
            expect(root.lookup(PDFName.of('K'), PDFArray).size()).toBe(operation.startsWith('insert-') ? 2 : 1);
        }
    } finally {
        await session?.stop();
    }
});

// T3: page subsets publish only widgets on retained pages, with one field identity.
it.each([
    'delete',
    'extract',
] as const)('prunes removed shared-field widgets after desktop %s', async operation => {
    const directory = await mkdtemp(join(tmpdir(), 'shared-field-page-operation-'));
    const inputPath = join(directory, 'input.pdf');
    const extractedPath = join(directory, 'extracted.pdf');
    const source = await PDFDocument.load(await readFile(resolve('tests/fixtures/electron/pdf-preservation/shared-field.pdf')));
    const form = source.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    const field = form.lookup(PDFName.of('Fields'), PDFArray).get(0);
    form.set(PDFName.of('CO'), source.context.obj([field]));
    for (const kind of [
        'ResetForm',
        'SubmitForm',
    ]) {
        const action = source.context.register(source.context.obj({
            S: kind,
            Fields: [field],
            F: PDFString.of('https://example.invalid/form'),
        }));
        source.getPage(0).node.addAnnot(source.context.register(source.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [
                120,
                10,
                130,
                20,
            ],
            A: action,
        })));
    }
    const original = await source.save({updateFieldAppearances: false});
    await writeFile(inputPath, original);
    let session: IElectronE2ESession | undefined;
    try {
        session = await startElectronE2ESession(`e2e-shared-field-${operation}`, {
            clean: true,
            initialOpenPaths: [inputPath],
            extraEnv: {EVB_E2E_SAVE_DIALOG_PATH: extractedPath},
        });
        const {page} = session;
        await waitForViewerInteractive(page);
        await openDocumentSidebarTab(page, 'Pages');
        await clickAsUser(page, `.editor-pane.is-active [data-thumbnail-page="${operation === 'delete' ? 2 : 1}"]`, {button: 'right'});
        const label = operation === 'delete' ? 'Delete Pages' : 'Extract to New PDF';
        await clickFoundAsUser(page, (text: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
            .find(element => element.textContent?.trim() === text), label, {description: label});
        await page.waitForFunction(() => document.querySelector('.page-controls-total')?.textContent?.trim() === '1'
            || document.querySelector('.app-toast-failure'));
        expect(await page.$('.app-toast-failure')).toBeNull();
        await waitForViewerInteractive(page);
        if (operation === 'delete') await saveViaVisibleToolbar(page);
        else expect(await readFile(inputPath)).toEqual(Buffer.from(original));
        const saved = await PDFDocument.load(await readFile(operation === 'delete' ? inputPath : extractedPath));
        expect(saved.getPageCount()).toBe(1);
        const savedForm = saved.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
        const savedField = savedForm.lookup(PDFName.of('Fields'), PDFArray).get(0);
        const kids = saved.context.lookup(savedField, PDFDict).lookup(PDFName.of('Kids'), PDFArray).asArray();
        const annotations = saved.getPage(0).node.Annots()!.asArray();
        const widgets = annotations.filter(ref => saved.context.lookup(ref, PDFDict).get(PDFName.of('Subtype')) === PDFName.of('Widget'));
        expect(widgets).toHaveLength(1);
        expect(kids.map(String).sort(), `${operation}: field Kids must equal retained page widgets`).toEqual(widgets.map(String).sort());
        for (const ref of widgets) {
            expect(String(saved.context.lookup(ref, PDFDict).get(PDFName.of('Parent')))).toBe(String(savedField));
        }
        expect(String(savedForm.lookup(PDFName.of('CO'), PDFArray).get(0))).toBe(String(savedField));
        const actions = annotations.flatMap(ref => {
            const action = saved.context.lookup(ref, PDFDict).lookupMaybe(PDFName.of('A'), PDFDict);
            return action ? [action] : [];
        });
        expect(actions).toHaveLength(2);
        for (const action of actions) {
            expect(String(action.lookup(PDFName.of('Fields'), PDFArray).get(0))).toBe(String(savedField));
        }
    } finally {
        await session?.stop();
        await rm(directory, {
            recursive: true,
            force: true,
        });
    }
}, 120_000);

async function readAnnotations(path: string) {
    const pdf = await PDFDocument.load(await readFile(path));
    const annotations = pdf.getPages().flatMap((page, index) => {
        const entries = page.node.Annots();
        return entries?.asArray().flatMap(entry => {
            const annotation = pdf.context.lookupMaybe(entry, PDFDict);
            if (!annotation) return [];
            const text = annotation.get(PDFName.of('Contents'));
            const subtype = String(annotation.get(PDFName.of('Subtype')));
            if (subtype === '/Popup') return [];
            return [{
                page: index + 1,
                subtype,
                text: text instanceof PDFString || text instanceof PDFHexString ? text.decodeText() : '',
                rect: annotation.lookupMaybe(PDFName.of('Rect'), PDFArray)?.asArray().map(value => Number(String(value))),
            }];
        }) ?? [];
    });
    return {
        count: pdf.getPageCount(),
        annotations,
    };
}

async function selectTextBox(page: Page, text: string, count = 1) {
    await clickAnnotationTool(page, 'Select');
    await clickFoundAsUser(page, (expected: string) => Array.from(document.querySelectorAll<HTMLElement>(
        '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"]',
    )).find(element => element.textContent?.trim() === expected), text, {
        description: text,
        count,
    });
}

it('materializes edits, deletion and a moved saved note before deleting an earlier page', async () => {
    const path = await createMultiPageTextFixturePdf(
        'saved-annotation-page-operation.pdf',
        8,
    );
    const stateDirectory = await mkdtemp(join(tmpdir(), 'saved-annotation-page-operation-'));
    let session: IElectronE2ESession | undefined;
    try {
        session = await startElectronE2ESession('e2e-saved-annotation-page-operation', {
            initialOpenPaths: [path],
            extraEnv: {EVB_APP_STATE_DIR: join(stateDirectory, 'initial')},
        });
        const page = session.page;
        await waitForViewerInteractive(page);
        await goToPageViaToolbar(page, 5);
        await createCanonicalTextBoxWithPointer(page, 'Before edit', {
            x: 0.32,
            y: 0.24,
        }, 5);
        await createCanonicalTextBoxWithPointer(page, 'Remove this box', {
            x: 0.32,
            y: 0.47,
        }, 5);
        await createStickyNoteWithPointer(page, 'Keep this note', {
            x: 0.6,
            y: 0.4,
        }, 5, {allowClearPointSearch: true});
        await clickLatestVisibleNoteWindowClose(page);
        await waitForNoOpenNoteWindows(page);
        await saveViaVisibleToolbar(page);
        const baseline = await readAnnotations(path);
        expect(baseline.annotations).toHaveLength(3);
        const savedNote = baseline.annotations.find(annotation => annotation.text === 'Keep this note');
        expect(savedNote?.subtype).toBe('/Text');

        await selectTextBox(page, 'Before edit', 2);
        await page.waitForSelector('.pdf-annotation-editor-text-box.is-editing [contenteditable="true"]');
        await selectAllFocusedAnnotationText(page);
        await page.keyboard.type('After edit');
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.down(modifier);
        await page.keyboard.press('Enter');
        await page.keyboard.up(modifier);
        await selectTextBox(page, 'Remove this box');
        await page.keyboard.press('Delete');
        // Finish the deletion before the independent note move changes selection.
        await page.waitForFunction(() => !Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"]',
        )).some(element => element.textContent?.trim() === 'Remove this box'));

        const marker = await revealForPointer(page, '.editor-pane.is-active .pdf-annotation-editor-note');
        await page.mouse.move(marker.x, marker.y);
        await page.mouse.down();
        await page.mouse.move(marker.x + 40, marker.y + 30, {steps: 8});
        await page.mouse.up();
        if (await page.$('.note-window__close')) await clickLatestVisibleNoteWindowClose(page);
        await goToPageViaToolbar(page, 5);
        await createTextMarkupWithPointer(page, 'Highlight', 0, 5);
        await clickAnnotationTool(page, 'Select');

        await openDocumentSidebarTab(page, 'Pages');
        await clickAsUser(page, '.editor-pane.is-active [data-thumbnail-page="2"]', {button: 'right'});
        await clickFoundAsUser(page, () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
            .find(element => element.textContent?.trim() === 'Delete Pages'), null, {description: 'Delete page 2'});
        await page.waitForFunction(() => {
            const api = (window as IE2EWindow).__evbTestApi;
            return api?.readActiveWorkspaceStateValues(['isPageOperationInProgress']).isPageOperationInProgress === false
                && (document.querySelector('.page-controls-total')?.textContent?.trim() === '7'
                    || document.querySelector('.app-toast-failure'));
        });
        expect(await page.$('.app-toast-failure')).toBeNull();
        expect(await page.$eval('.page-controls-total', element => element.textContent?.trim())).toBe('7');
        await saveViaVisibleToolbar(page);
        const saved = await readAnnotations(path);
        expect(saved.count).toBe(7);
        expect(saved.annotations).toHaveLength(3);
        expect(saved.annotations.map(({
            page: number, subtype, text,
        }) => ({
            number,
            subtype,
            text,
        })))
            .toEqual(expect.arrayContaining([
                {
                    number: 4,
                    subtype: '/FreeText',
                    text: 'After edit',
                },
                {
                    number: 4,
                    subtype: '/Text',
                    text: 'Keep this note',
                },
                {
                    number: 4,
                    subtype: '/Highlight',
                    text: '',
                },
            ]));
        expect(saved.annotations.find(annotation => annotation.text === 'Keep this note')?.rect).not.toEqual(savedNote?.rect);

        await session.stop();
        session = await startElectronE2ESession('e2e-saved-annotation-page-operation-reopen', {
            initialOpenPaths: [path],
            extraEnv: {EVB_APP_STATE_DIR: join(stateDirectory, 'reopen')},
        });
        await waitForViewerInteractive(session.page);
        await clickAsUser(session.page, '.page-controls button[aria-label^="First Page"]');
        await waitForToolbarCurrentPage(session.page, 1);
        for (let number = 2; number <= 4; number += 1) {
            await clickAsUser(session.page, '.page-controls button[aria-label^="Next Page"]');
            await waitForToolbarCurrentPage(session.page, number);
        }
        await waitForViewerInteractive(session.page);
        const rendered = await session.page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(
            '.pdf-annotation-editor-layer [data-annotation-kind]',
        )).filter(element => element.closest<HTMLElement>('.page_container')?.dataset.page === '4')
            .map(element => ({
                kind: element.dataset.annotationKind,
                text: element.textContent?.trim(),
            })));
        expect(rendered).toEqual(expect.arrayContaining([
            {
                kind: 'text-box',
                text: 'After edit',
            },
            expect.objectContaining({kind: 'note'}),
            expect.objectContaining({kind: 'text-markup'}),
        ]));
        expect(await readAnnotations(path)).toEqual(saved);
    } finally {
        await session?.stop();
        await rm(stateDirectory, {
            recursive: true,
            force: true,
        });
    }
}, 120_000);
