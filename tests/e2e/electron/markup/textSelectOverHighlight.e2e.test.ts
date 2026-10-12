import {
    copyFile, mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString,
} from 'pdf-lib';
import {
    describe, expect, it, onTestFinished,
} from 'vitest';
import type {Page} from 'puppeteer-core';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    openPdfInApp, waitForPdfLoaded, waitForViewerInteractive,openAnnotationsTab, saveViaVisibleToolbar,
} from '@tests/e2e/electron/helpers/viewerCore';
import {readWorkspaceStateValues} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    clickAsUser, revealForPointer,
} from '@tests/e2e/electron/helpers/userInput';
import {evaluateInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {createCanonicalTextBoxWithPointer} from '@tests/e2e/electron/helpers/viewerAnnotations';

async function highlightedTextPdf(path: string, note = '', flags = 4) {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([
        612,
        792,
    ]);
    const font = await pdf.embedFont('Helvetica');
    page.drawText('Marked sentence must remain selectable', {
        x: 90,
        y: 520,
        size: 22,
        font,
    });
    page.drawText('Unmarked sentence selects normally', {
        x: 90,
        y: 460,
        size: 22,
        font,
    });
    const annotation = pdf.context.register(pdf.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Highlight'),
        P: page.ref,
        F: PDFNumber.of(flags),
        NM: PDFHexString.fromText('text-select-highlight'),
        Rect: [
            88,
            516,
            485,
            550,
        ],
        QuadPoints: [
            88,
            550,
            485,
            550,
            88,
            516,
            485,
            516,
        ],
        C: [
            1,
            0.8,
            0,
        ],
        CA: PDFNumber.of(0.6),
        Contents: PDFString.of(note),
    }));
    page.node.set(PDFName.of('Annots'), pdf.context.obj([annotation]));
    await writeFile(path, await pdf.save());
}

async function lineDragPoints(page: Page, text: string) {
    return page.evaluate((expected: string) => {
        const spans = Array.from(document.querySelectorAll<HTMLElement>('.editor-pane.is-active .textLayer span, .editor-pane.is-active .text-layer span'));
        const span = spans.find(candidate => candidate.textContent?.includes(expected));
        const node = span?.firstChild;
        if (!(node instanceof Text)) throw new Error(`Rendered PDF text was unavailable: ${expected}`);
        const start = node.textContent!.indexOf(expected);
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + 1);
        const first = range.getBoundingClientRect();
        range.setStart(node, start + expected.length - 1);
        range.setEnd(node, start + expected.length);
        const last = range.getBoundingClientRect();
        return {
            start: {
                x: first.left + 0.25,
                y: first.top + first.height / 2,
            },
            end: {
                x: last.right - 0.25,
                y: last.top + last.height / 2,
            },
        };
    }, text);
}

async function drag(page: Page, points: Awaited<ReturnType<typeof lineDragPoints>>) {
    await page.mouse.move(points.start.x, points.start.y);
    await page.mouse.down();
    await page.mouse.move(points.end.x, points.end.y, {steps: 12});
    await page.mouse.up();
    return evaluateInPage(page, () => document.getSelection()?.toString() ?? '');
}

describe('Electron E2E - Text Select over existing highlight', () => {
    const sessions = createElectronE2ESessionFixture({sessionName: () => `e2e-text-select-highlight-${Date.now()}`});

    it.each([
        68,
        644,
    ])('keeps restricted highlight flags %i foreign and preserves its contents on Save', async flags => {
        const {page} = sessions.getSession();
        const directory = await mkdtemp(join(tmpdir(), 'evb-restricted-highlight-'));
        onTestFinished(() => rm(directory, {
            recursive: true,
            force: true,
        }));
        const path = join(directory, 'restricted.pdf');
        await highlightedTextPdf(path, 'Locked note', flags);
        const contents = async () => {
            const pdf = await PDFDocument.load(await readFile(path));
            const annots = pdf.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
            const highlight = annots.asArray().map(ref => pdf.context.lookup(ref, PDFDict))
                .find(dict => dict.get(PDFName.of('Subtype'))?.toString() === '/Highlight')!;
            return {
                bytes: Array.from(highlight.lookup(PDFName.of('Contents'), PDFString).asBytes()),
                flags: highlight.lookup(PDFName.of('F'), PDFNumber).asNumber(),
            };
        };
        const before = await contents();
        await openPdfInApp(page, path);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await openAnnotationsTab(page);
        await clickAsUser(page, '.notes-panel .tool-button[data-tool="select"]');
        await page.waitForSelector('.editor-pane.is-active .textLayer span, .editor-pane.is-active .text-layer span');
        const {start} = await lineDragPoints(page, 'Marked sentence must remain selectable');
        await page.mouse.click(start.x, start.y, {count: 2});
        await page.evaluate(async () => {
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        });
        expect(await page.$$('textarea.note-window__textarea:not([readonly]):not([disabled])')).toHaveLength(0);
        expect(await page.$$('.editor-pane.is-active [data-annotation-kind="text-markup"]')).toHaveLength(0);
        const yellowPixels = await page.$eval('.editor-pane.is-active .page_container[data-page="1"] canvas', element => {
            if (!(element instanceof HTMLCanvasElement)) throw new Error('Page canvas is missing');
            const {data} = element.getContext('2d')!.getImageData(0, 0, element.width, element.height);
            let yellow = 0;
            for (let index = 0; index < data.length; index += 4) {
                if (data[index]! > 180 && data[index + 1]! > 140 && data[index + 2]! < 160
                    && data[index]! > data[index + 2]! + 60) yellow += 1;
            }
            return yellow;
        });
        expect(yellowPixels).toBeGreaterThan(1_000);
        await createCanonicalTextBoxWithPointer(page, 'Unrelated saved edit', {
            x: 0.2,
            y: 0.65,
        });
        await saveViaVisibleToolbar(page, 30_000, path);
        expect(await contents()).toEqual(before);
        const artifacts = join('.devkit', 'artifacts', `restricted-highlight-${flags}-${Date.now()}`);
        await mkdir(artifacts, {recursive: true});
        await copyFile(path, join(artifacts, 'saved.pdf'));
        await page.screenshot({path: join(artifacts, 'restricted-highlight.png')});
        console.log(`RESTRICTED_HIGHLIGHT_EVIDENCE ${artifacts}`);
    }, 90_000);

    it('selects text through a highlight without moving its mark or dirtying the file', async () => {
        const {page} = sessions.getSession();
        const directory = await mkdtemp(join(tmpdir(), 'evb-text-select-highlight-'));
        const path = join(directory, 'highlight.pdf');
        onTestFinished(() => rm(directory, {
            recursive: true,
            force: true,
        }));
        await highlightedTextPdf(path);
        await openPdfInApp(page, path);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        expect(await page.$eval('.editor-pane.is-active .pdfViewer', element => element.classList.contains('is-text-selection-mode')))
            .toBe(true);
        await page.waitForSelector('.page_container[data-page="1"] .textLayer span, .page_container[data-page="1"] .text-layer span');
        await page.waitForSelector('.page_container[data-page="1"] .highlightAnnotation, .page_container[data-page="1"] [data-annotation-kind="text-markup"]');

        const positiveControl = await drag(page, await lineDragPoints(page, 'Unmarked sentence selects normally'));
        expect(positiveControl).toContain('Unmarked sentence selects normally');
        await page.evaluate(() => document.getSelection()?.removeAllRanges());

        const highlight = '.page_container[data-page="1"] .highlightAnnotation, .page_container[data-page="1"] [data-annotation-kind="text-markup"]';
        const before = await page.$eval(highlight, element => {
            const rect = element.getBoundingClientRect();
            return {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            };
        });
        const beforeDirty = await readWorkspaceStateValues<{dirtyState: {hasPendingUnsavedChanges: boolean}}>(page, ['dirtyState']);
        expect(beforeDirty.dirtyState.hasPendingUnsavedChanges).toBe(false);
        const selected = await drag(page, await lineDragPoints(page, 'Marked sentence must remain selectable'));
        const after = await page.$eval(highlight, element => {
            const rect = element.getBoundingClientRect();
            return {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            };
        });
        const afterDirty = await readWorkspaceStateValues<{dirtyState: {hasPendingUnsavedChanges: boolean}}>(page, ['dirtyState']);
        console.log(`TEXT_SELECT_HIGHLIGHT ${JSON.stringify({
            positiveControl,
            selected,
            before,
            after,
            dirtyBefore: beforeDirty.dirtyState.hasPendingUnsavedChanges,
            dirtyAfter: afterDirty.dirtyState.hasPendingUnsavedChanges,
        })}`);
        expect(selected).toContain('Marked sentence must remain selectable');
        expect(after).toEqual(before);
        expect(afterDirty.dirtyState.hasPendingUnsavedChanges).toBe(false);
    }, 90_000);
    it('opens the existing or empty highlight note on double-click and reuses its window', async () => {
        const {page} = sessions.getSession();
        const directory = await mkdtemp(join(tmpdir(), 'evb-highlight-note-'));
        onTestFinished(() => rm(directory, {
            recursive: true,
            force: true,
        }));
        for (const note of [
            'Existing highlight note',
            '',
        ]) {
            const path = join(directory, note ? 'with-note.pdf' : 'empty-note.pdf');
            // Locked geometry alone permits contents edits, unlike ReadOnly or LockedContents.
            await highlightedTextPdf(path, note, note ? 4 : 132);
            await openPdfInApp(page, path);
            await waitForPdfLoaded(page);
            await waitForViewerInteractive(page);
            const highlight = '.editor-pane.is-active .page_container[data-page="1"] [data-annotation-kind="text-markup"]';
            await page.waitForSelector(highlight);
            await page.waitForSelector('.editor-pane.is-active .textLayer span, .editor-pane.is-active .text-layer span');
            await openAnnotationsTab(page);
            await clickAsUser(page, '.notes-panel .tool-button[data-tool="select"]');
            const hitTarget = `${highlight} [data-annotation-hit-target]`;
            const point = await revealForPointer(page, hitTarget);
            await page.mouse.move(point.x, point.y);
            await page.mouse.down();
            await page.waitForSelector(`${highlight}.is-selected`, {visible: true});
            await page.mouse.up();
            await clickAsUser(page, hitTarget, {count: 2});
            const editor = 'textarea.note-window__textarea';
            await page.waitForSelector(editor, {
                visible: true,
                timeout: 10_000,
            });
            expect(await page.$eval(editor, element => element.value)).toBe(note);
            expect(await page.$$(editor)).toHaveLength(1);
            // The open note covers the highlight's centre. Double-click its
            // exposed edge, checking the actual hit before trusted input.
            const exposedPoint = await page.$eval(hitTarget, element => {
                const rect = element.getBoundingClientRect();
                const x = rect.right - 4;
                const y = rect.top + rect.height / 2;
                if (!element.contains(document.elementFromPoint(x, y))) throw new Error('Highlight edge is covered');
                return {
                    x,
                    y,
                };
            });
            await page.mouse.click(exposedPoint.x, exposedPoint.y, {count: 2});
            expect(await page.$$(editor)).toHaveLength(1);
            expect(await page.$eval(editor, element => element.value)).toBe(note);
            if (!note) {
                await clickAsUser(page, editor);
                await page.keyboard.type('Note attached to this highlight');
                await expect.poll(() => page.$eval(editor, element => element.value)).toBe('Note attached to this highlight');
            }
            await clickAsUser(page, '.note-window__close');
            await page.waitForFunction(() => !document.querySelector('textarea.note-window__textarea'));
            await clickAsUser(page, hitTarget, {count: 2});
            await page.waitForSelector(editor, {visible: true});
            expect(await page.$eval(editor, element => element.value)).toBe(note || 'Note attached to this highlight');
            expect(await page.$$(editor)).toHaveLength(1);
            await clickAsUser(page, '.note-window__close');
            console.log(`HIGHLIGHT_NOTE ${JSON.stringify({
                note,
                oneWindow: true,
                pressSelected: true,
            })}`);
        }
    }, 90_000);

});
