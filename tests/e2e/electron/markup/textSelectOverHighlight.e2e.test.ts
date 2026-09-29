import {
    mkdtemp, rm, writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString,
} from 'pdf-lib';
import {
    describe, expect, it, onTestFinished,
} from 'vitest';
import type {Page} from 'puppeteer-core';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    openPdfInApp, waitForPdfLoaded, waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {readWorkspaceStateValues} from '@tests/e2e/electron/helpers/workspaceExpose';
import {evaluateInPage} from '@tests/e2e/electron/helpers/pageRuntime';

async function highlightedTextPdf(path: string) {
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
        F: PDFNumber.of(4),
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
        Contents: PDFString.of(''),
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
});
