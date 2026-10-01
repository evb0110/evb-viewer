import {
    mkdtemp, rm, writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {
    describe, expect, it, onTestFinished,
} from 'vitest';
import type {
    CDPSession,
    Page,
} from 'puppeteer-core';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    openPdfInApp,
    scrollToPageWithWheel,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import {waitForViewportQuiet} from '@tests/e2e/electron/helpers/viewportPageObservation';

const PAGE_COUNT = 40;
const pageLine = (pageNumber: number) => `Page ${pageNumber} keeps its selectable line`;

async function writeTextPdf(path: string) {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont('Helvetica');
    for (let pageNumber = 1; pageNumber <= PAGE_COUNT; pageNumber += 1) {
        pdf.addPage([
            612,
            792,
        ]).drawText(pageLine(pageNumber), {
            x: 72,
            y: 640,
            size: 24,
            font,
        });
    }
    await writeFile(path, await pdf.save());
}

/**
 * Holds the document's PDF.js worker inside its structure-tree handler, the
 * way a busy worker does, so a page can be scrolled away while its optional
 * structure enrichment is still pending. Setup only: every user action below
 * is trusted wheel and mouse input.
 */
async function holdStructureTreeRequests(page: Page) {
    const worker = page.workers().find(candidate => /pdf\.worker/u.test(candidate.url()));
    if (!worker) {
        throw new Error('The document has no PDF.js worker');
    }
    const client: CDPSession = worker.client;
    const scripts: Array<{
        scriptId: string;
        url: string
    }> = [];
    client.on('Debugger.scriptParsed', event => scripts.push({
        scriptId: event.scriptId,
        url: event.url,
    }));
    await client.send('Debugger.enable');
    const script = scripts.find(candidate => /pdf\.worker/u.test(candidate.url));
    if (!script) {
        throw new Error('The PDF.js worker script was not reported');
    }
    const {scriptSource} = await client.send('Debugger.getScriptSource', {scriptId: script.scriptId});
    const handler = scriptSource.indexOf('"GetStructTree"');
    const request = scriptSource.indexOf('"getStructTree"', handler);
    const returnAt = scriptSource.lastIndexOf('return', request);
    if (handler < 0 || request < 0 || returnAt < handler) {
        throw new Error('The PDF.js worker has no structure-tree handler');
    }
    const before = scriptSource.slice(0, returnAt);
    const lineNumber = before.split('\n').length - 1;
    const columnNumber = returnAt - (before.lastIndexOf('\n') + 1);
    // Resolves with the page whose structure tree the worker is holding.
    const paused = new Promise<number>((resolve, reject) => client.once('Debugger.paused', async (event) => {
        const local = event.callFrames[0]?.scopeChain.find(scope => scope.type === 'local');
        const properties = local?.object.objectId
            ? (await client.send('Runtime.getProperties', {objectId: local.object.objectId})).result
            : [];
        const pageIndex = properties.find(property => property.name === 'pageIndex')
            ?? properties.find(property => typeof property.value?.value === 'number');
        if (typeof pageIndex?.value?.value === 'number') {
            resolve(pageIndex.value.value + 1);
        } else {
            reject(new Error('The held structure-tree request names no page'));
        }
    }));
    const {breakpointId} = await client.send('Debugger.setBreakpoint', {location: {
        scriptId: script.scriptId,
        lineNumber,
        columnNumber,
    }});
    return {
        paused,
        async release() {
            await client.send('Debugger.removeBreakpoint', {breakpointId});
            await client.send('Debugger.resume');
            await client.send('Debugger.disable');
        },
    };
}

function readTextLayers(page: Page) {
    return evaluateInPage(page, () => Array.from(
        document.querySelectorAll<HTMLElement>('.editor-pane.is-active .page_container'),
    ).map((container) => {
        const layer = container.querySelector<HTMLElement>('.text-layer, .textLayer');
        return {
            pageNumber: Number(container.dataset.page),
            spans: layer?.querySelectorAll('span').length ?? 0,
            text: layer?.textContent ?? '',
            rendering: layer?.dataset.pdfTextLayerRendering ?? null,
            ready: layer?.dataset.pdfTextLayerReady ?? null,
        };
    }));
}

function readLinePoints(page: Page, pageNumber: number) {
    return evaluateInPage(page, (targetPage: number, expected: string) => {
        const span = Array.from(document.querySelectorAll<HTMLElement>(
            `.editor-pane.is-active .page_container[data-page="${String(targetPage)}"] .text-layer span`,
        )).find(candidate => candidate.textContent?.includes(expected));
        const node = span?.firstChild;
        const viewport = document.querySelector<HTMLElement>('.editor-pane.is-active .pdfViewer')?.getBoundingClientRect();
        if (!(node instanceof Text) || !viewport) {
            return null;
        }
        const start = node.textContent!.indexOf(expected);
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + 1);
        const first = range.getBoundingClientRect();
        range.setStart(node, start + expected.length - 1);
        range.setEnd(node, start + expected.length);
        const last = range.getBoundingClientRect();
        const y = first.top + first.height / 2;
        return {
            start: {
                x: first.left + 0.25,
                y,
            },
            end: {
                x: last.right - 0.25,
                y,
            },
            // How far the line sits from the middle of the viewer.
            offsetFromCentre: y - (viewport.top + viewport.height / 2),
        };
    }, pageNumber, pageLine(pageNumber));
}

async function selectLineByDragging(page: Page, pageNumber: number) {
    let points = await readLinePoints(page, pageNumber);
    if (!points) {
        throw new Error(`Page ${String(pageNumber)} shows no text to select`);
    }
    if (Math.abs(points.offsetFromCentre) > 100) {
        const viewport = await evaluateInPage(page, () => {
            const rect = document.querySelector<HTMLElement>('.editor-pane.is-active .pdfViewer')!.getBoundingClientRect();
            return {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
            };
        });
        await page.mouse.move(viewport.x, viewport.y);
        await page.mouse.wheel({deltaY: Math.round(points.offsetFromCentre)});
        await waitForViewportQuiet(page);
        points = await readLinePoints(page, pageNumber);
        if (!points) {
            throw new Error(`Page ${String(pageNumber)} lost its text while scrolling to it`);
        }
    }
    await page.mouse.move(points.start.x, points.start.y);
    await page.mouse.down();
    await page.mouse.move(points.end.x, points.end.y, {steps: 12});
    await page.mouse.up();
    return evaluateInPage(page, () => document.getSelection()?.toString() ?? '');
}

describe('Electron E2E - text layer after scrolling away during enrichment', () => {
    const sessions = createElectronE2ESessionFixture({sessionName: () => `e2e-text-layer-scroll-away-${Date.now()}`});

    it('rebuilds the text of a page whose structure enrichment settled after it was scrolled away', async () => {
        const {page} = sessions.getSession();
        const directory = await mkdtemp(join(tmpdir(), 'evb-text-layer-scroll-away-'));
        const path = join(directory, 'forty-pages.pdf');
        onTestFinished(() => rm(directory, {
            recursive: true,
            force: true,
        }));
        await writeTextPdf(path);
        await openPdfInApp(page, path);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);

        const hold = await holdStructureTreeRequests(page);
        let released = false;
        onTestFinished(async () => {
            if (!released) {
                await hold.release();
            }
        });
        await scrollToPageWithWheel(page, 3);
        const pendingPage = await hold.paused;

        // Leave the page while its optional structure enrichment is pending:
        // far enough that the viewer releases its layers, near enough that
        // the page shell stays mounted.
        await scrollToPageWithWheel(page, pendingPage + 5);
        const away = (await readTextLayers(page)).find(layer => layer.pageNumber === pendingPage);
        expect(away, 'scrolling away released the page text').toMatchObject({
            spans: 0,
            ready: null,
        });

        await hold.release();
        released = true;
        await scrollToPageWithWheel(page, pendingPage);
        await waitForFunctionInPage(page, (targetPage: number) => {
            const layer = document.querySelector<HTMLElement>(
                `.editor-pane.is-active .page_container[data-page="${String(targetPage)}"] .text-layer`,
            );
            return layer?.dataset.pdfTextLayerReady === 'true';
        }, {timeout: 20_000}, pendingPage);

        const back = (await readTextLayers(page)).find(layer => layer.pageNumber === pendingPage);
        expect(back?.text).toContain(pageLine(pendingPage));
        expect(await selectLineByDragging(page, pendingPage)).toContain(pageLine(pendingPage));
    });
});
