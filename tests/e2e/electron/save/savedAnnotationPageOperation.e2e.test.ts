import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Page } from 'puppeteer-core';
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
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
    let session = await startElectronE2ESession('e2e-saved-annotation-page-operation', {
        initialOpenPaths: [path],
        extraEnv: {EVB_APP_STATE_DIR: resolve('.devkit/tmp/pageopdone-regression-state')},
    });
    try {
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
            extraEnv: {EVB_APP_STATE_DIR: resolve('.devkit/tmp/pageopdone-regression-reopen-state')},
        });
        await waitForViewerInteractive(session.page);
        await clickAsUser(session.page, '.page-controls .page-controls-item:nth-child(1) button');
        await waitForToolbarCurrentPage(session.page, 1);
        for (let number = 2; number <= 4; number += 1) {
            await clickAsUser(session.page, '.page-controls .page-controls-item:nth-child(4) button');
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
        await session.stop();
    }
}, 120_000);
