import {
    mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';
import {
    PDFDocument, StandardFonts, rgb,
} from 'pdf-lib';
import {
    afterEach, describe, expect, it, onTestFinished,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    clickAsUser,
    clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {
    ensureSidebarOpen, goToPageViaToolbar, openPdfInApp, waitForPdfLoaded, waitForToolbarCurrentPage,
} from '@tests/e2e/electron/helpers/viewerCore';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import type * as Pdfjs from 'pdfjs-dist';
import type {
    ConsoleMessage, Page,
} from 'puppeteer-core';
import type {IE2EWindow} from '@tests/e2e/electron/helpers/e2EWindow';
import {
    requireDocumentRef, type TDocumentRef,
} from '@contracts/documentRef';
import {callWorkspaceCommand} from '@tests/e2e/electron/helpers/workspaceExpose';
import {electronAppTempDirPath} from '@scripts/electron-run/electronRunSessionPaths';

const sessionName = `e2e-move-tab-view-state-${Date.now()}`;
const replacementDialogPath = join(electronAppTempDirPath(sessionName), 'cancelled-transfer-replacement.pdf');
const sessions = createElectronE2ESessionFixture({
    sessionName,
    extraEnv: {EVB_E2E_OPEN_DIALOG_PATH: replacementDialogPath},
});
let outputDirectory: string | null = null;

afterEach(() => {
    if (outputDirectory) rmSync(outputDirectory, {
        recursive: true,
        force: true,
    });
    outputDirectory = null;
});

async function createTwelvePageFixture(filePath: string) {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (let pageNumber = 1; pageNumber <= 12; pageNumber += 1) {
        const page = document.addPage([
            612,
            792,
        ]);
        page.drawText(`Transfer view page ${pageNumber}`, {
            x: 72,
            y: 700,
            size: 24,
            font,
            color: rgb(0.1, 0.1, 0.1),
        });
    }
    writeFileSync(filePath, await document.save());
}

async function moveTabToNewWindow(page: Page) {
    const browser = page.browser();
    const previous = new Set(await browser.pages());
    // Keep a second source tab so closing the moved tab cannot destroy the
    // source window; then act on the loaded PDF tab through its real menu.
    await clickAsUser(page, '.tab-new');
    await clickAsUser(page, '.tab-list [role="tab"]:first-child');
    await clickAsUser(page, '.tab-list [role="tab"].is-active', {button: 'right'});
    await page.waitForFunction(() => Array.from(document.querySelectorAll('[role="menuitem"]'))
        .some(item => item.textContent?.includes('Move Tab to New Window')));
    const menuItems = await page.$$('[role="menuitem"]');
    const transferItems = await Promise.all(menuItems.map(async candidate => ({
        candidate,
        text: await candidate.evaluate(element => element.textContent ?? ''),
    })));
    const transferItem = transferItems.find(item => item.text.includes('Move Tab to New Window'));
    if (!transferItem) throw new Error('Move Tab to New Window menu item was not rendered');
    await clickAsUser(page, transferItem.candidate);
    let destination: Page | undefined;
    const deadline = Date.now() + 30_000;
    while (!destination && Date.now() < deadline) {
        destination = (await browser.pages()).find(candidate => !previous.has(candidate));
        if (!destination) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!destination) throw new Error('Transfer did not create a destination window');
    await waitForFunctionInPage(destination, () => document.querySelector('.page_container--rendered') !== null, {timeout: 30_000});
    return destination;
}

function createSlowTransferFixture(filePath: string, fontMapBytes = 64 * 1024 * 1024) {
    const name = 'Slow transfer';
    const count = 20;
    const objects = new Map<number, Buffer>();
    const text = (value: string) => Buffer.from(value, 'latin1');
    objects.set(1, text('<< /Type /Catalog /Pages 2 0 R >>'));
    objects.set(3, text('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));
    let next = 4;
    let fonts = '/F 3 0 R';
    {
        const decoded = Buffer.alloc(fontMapBytes, 0x20);
        decoded.write('/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\nendcmap\nend\nend\n', 'latin1');
        const stream = deflateSync(decoded);
        const descendant = next++;
        objects.set(descendant, text('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /GlyphLessFont /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 /CIDToGIDMap /Identity >>'));
        for (let i = 0; i < 16; i++) {
            const cmap = next++, font = next++;
            objects.set(cmap, Buffer.concat([
                text(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`),
                stream,
                text('\nendstream'),
            ]));
            objects.set(font, text(`<< /Type /Font /Subtype /Type0 /BaseFont /GlyphLessFont /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] /ToUnicode ${cmap} 0 R >>`));
            fonts += ` /S${i} ${font} 0 R`;
        }
    }
    const kids: string[] = [];
    for (let page = 1; page <= count; page++) {
        const id = next++, contentId = next++;
        kids.push(`${id} 0 R`);
        let content = `BT /F 22 Tf 50 790 Td (${name} / PAGE ${page}) Tj ET\n`;
        for (let row = 0; row < 20; row++) content += `BT /F 12 Tf 55 ${740-row*30} Td (Reading marker ${page}.${row} - stable text and geometry) Tj ET\n`;
        for (let font = 0; font < 16; font++) content += `BT /S${font} 10 Tf 460 ${750-font*22} Td <0053004C004F0057> Tj ET\n`;
        objects.set(contentId, text(`<< /Length ${content.length} >>\nstream\n${content}endstream`));
        objects.set(id, text(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << ${fonts} >> >> /Contents ${contentId} 0 R >>`));
    }
    objects.set(2, text(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${count} >>`));
    const header = text('%PDF-1.7\n');
    const parts = [header], offsets = [0];
    let length = header.length;
    for (const id of [...objects.keys()].sort((a,b)=>a-b)) {
        offsets[id] = length;
        const body = Buffer.concat([
            text(`${id} 0 obj\n`),
            objects.get(id)!,
            text('\nendobj\n'),
        ]);
        parts.push(body); length += body.length;
    }
    const size = next;
    parts.push(text(`xref\n0 ${size}\n0000000000 65535 f \n` + Array.from({length:size-1},(_,i)=>`${String(offsets[i+1]).padStart(10,'0')} 00000 n \n`).join('') + `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
    writeFileSync(filePath, Buffer.concat(parts));
}

// The page under the middle of the viewport, taken from layout rather than from
// the viewer's own page bookkeeping, which can disagree with what is on screen.
async function readView(page: Page) {
    return page.evaluate(() => {
        const snapshot = (window as Window & {__evbTestApi?: {getActiveToolbarSnapshot?: () => {
            effectiveZoom?: number;
            zoomMode?: string;
        }}}).__evbTestApi?.getActiveToolbarSnapshot?.();
        const viewport = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host[data-workspace-active="true"] [data-document-viewer-chassis-viewport]');
        const viewportRect = viewport?.getBoundingClientRect();
        const centerY = viewportRect ? viewportRect.top + viewportRect.height / 2 : 0;
        const centerPage = Array.from(viewport?.querySelectorAll<HTMLElement>('[data-document-page-number]') ?? [])
            .find((element) => {
                const rect = element.getBoundingClientRect();
                return rect.top <= centerY && centerY <= rect.bottom;
            });
        return {
            page: Number(centerPage?.dataset.documentPageNumber ?? 0),
            sidebarOpen: Boolean(document.querySelector('.editor-pane.is-active .sidebar-wrapper:not(.is-closed)')),
            zoomText: document.querySelector('#editor-global-toolbar-host .zoom-controls-display-value')?.textContent?.trim() ?? '',
            zoomMode: snapshot?.zoomMode ?? '',
            effectiveZoom: snapshot?.effectiveZoom ?? 0,
        };
    });
}

// The restored sidebar slides in after the page is placed; the view is final
// once that slide has ended and the viewer has laid out for its last width.
async function waitForTransferredViewSettled(page: Page) {
    await waitForFunctionInPage(page, () => {
        const pane = document.querySelector('.editor-pane.is-active');
        const sidebar = pane?.querySelector('.sidebar-wrapper:not(.is-closed)');
        return sidebar !== null && sidebar !== undefined && sidebar.getAnimations().length === 0
            && pane?.querySelector('.document-viewer-chassis')?.getAttribute('data-viewport-lifecycle') === 'ready';
    }, {timeout: 30_000});
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

describe('Move Tab to New Window view state', () => {
    it('restores a fast incoming tab while another source is still opening in the target', async () => {
        const {page: target} = sessions.getSession();
        const appTempDirectory = electronAppTempDirPath(sessions.getSession().name);
        mkdirSync(appTempDirectory, {recursive: true});
        outputDirectory = realpathSync(mkdtempSync(join(appTempDirectory, 'concurrent-tab-transfers-')));
        const slowPath = join(outputDirectory, 'slow-transfer.pdf');
        const fastPath = join(outputDirectory, 'fast-transfer.pdf');
        // Large compressed font maps make the actual PDF open slow; no product
        // method or transfer acknowledgement is replaced by a test stub.
        createSlowTransferFixture(slowPath);
        await createTwelvePageFixture(fastPath);
        await openPdfInApp(target, slowPath);
        await waitForPdfLoaded(target, 120_000);
        const slowSource = await moveTabToNewWindow(target);
        await openPdfInApp(target, fastPath);
        await waitForPdfLoaded(target);
        const fastSource = await moveTabToNewWindow(target);
        await goToPageViaToolbar(slowSource, 12);
        await goToPageViaToolbar(fastSource, 5);
        for (const source of [
            slowSource,
            fastSource,
        ]) {
            await clickAsUser(source, '.tab-new');
            await clickAsUser(source, '.tab-list [role="tab"]:first-child');
        }
        for (const [
            source,
            percent,
        ] of [
                [
                    slowSource,
                    110,
                ],
                [
                    fastSource,
                    80,
                ],
            ] as const) {
            await clickAsUser(source, '#editor-global-toolbar-host .zoom-controls-display');
            await clickAsUser(source, '.zoom-chip-custom-input', {count: 3});
            await source.keyboard.type(String(percent));
            await source.keyboard.press('Enter');
        }
        const targetTitle = await target.title();
        const moveToTarget = async (source: Page) => {
            await clickAsUser(source, '.tab.is-active[data-tab-id]', {button: 'right'});
            await clickFoundAsUser(source, (title: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
                .find(item => item.textContent?.trim().startsWith(`Move Tab to Window: ${title}`)), targetTitle,
            {description: `Move Tab to Window: ${targetTitle}`});
        };
        await moveToTarget(slowSource);
        await moveToTarget(fastSource);
        // Native transfers close their source only after target restoration and
        // the committed acknowledgement. The fast one must finish first.
        await waitForFunctionInPage(fastSource, () => !Array.from(document.querySelectorAll('.tab-label'))
            .some(tab => tab.textContent?.trim() === 'fast-transfer.pdf'), {timeout: 30_000});
        expect(await slowSource.$$eval('.tab-label', tabs => tabs.map(tab => tab.textContent?.trim())))
            .toContain('slow-transfer.pdf');
        await clickFoundAsUser(target, () => Array.from(document.querySelectorAll<HTMLElement>('.tab[data-tab-id]'))
            .find(tab => tab.querySelector('.tab-label')?.textContent?.trim() === 'fast-transfer.pdf'), undefined,
        {description: 'fast transferred tab'});
        await waitForToolbarCurrentPage(target, 5);
        await waitForPdfLoaded(target);
        expect(await readView(target)).toMatchObject({
            page: 5,
            zoomText: '80%',
        });
        await clickFoundAsUser(target, () => Array.from(document.querySelectorAll<HTMLElement>('.tab[data-tab-id]'))
            .find(tab => tab.querySelector('.tab-label')?.textContent?.trim() === 'slow-transfer.pdf'), undefined,
        {description: 'slow transferred tab'});
        await waitForToolbarCurrentPage(target, 12);
        await waitForPdfLoaded(target, 120_000);
        expect(await readView(target)).toMatchObject({
            page: 12,
            zoomText: '110%',
        });
        await waitForFunctionInPage(slowSource, () => !Array.from(document.querySelectorAll('.tab-label'))
            .some(tab => tab.textContent?.trim() === 'slow-transfer.pdf'), {timeout: 120_000});

        expect(await target.$$eval('.tab-label', tabs => tabs.map(tab => tab.textContent?.trim())))
            .toEqual(expect.arrayContaining([
                'slow-transfer.pdf',
                'fast-transfer.pdf',
            ]));
    }, 180_000);

    it('keeps the replacement document view and source copy when an incoming open is superseded', async () => {
        const session = sessions.getSession();
        const target = session.page;
        const appTempDirectory = electronAppTempDirPath(session.name);
        mkdirSync(appTempDirectory, {recursive: true});
        outputDirectory = realpathSync(mkdtempSync(join(appTempDirectory, 'superseded-tab-transfer-')));
        const slowPath = join(outputDirectory, 'superseded-slow.pdf');
        const replacementPath = join(outputDirectory, 'replacement.pdf');
        createSlowTransferFixture(slowPath, 4 * 1024 * 1024);
        await createTwelvePageFixture(replacementPath);
        await openPdfInApp(target, slowPath, 120_000);
        const source = await moveTabToNewWindow(target);
        await goToPageViaToolbar(source, 12);
        await clickAsUser(source, '#editor-global-toolbar-host .zoom-controls-display');
        await clickAsUser(source, '.zoom-chip-custom-input', {count: 3});
        await source.keyboard.type('200');
        await source.keyboard.press('Enter');
        await clickAsUser(source, '.tab-new');
        await clickAsUser(source, '.tab-list [role="tab"]:first-child');

        // Recent remembers B's own zoom. A's later view restoration must not
        // overwrite it when B replaces the incoming document in the same tab.
        await openPdfInApp(target, replacementPath);
        await clickAsUser(target, '#editor-global-toolbar-host .zoom-controls-display');
        await clickAsUser(target, '.zoom-chip-custom-input', {count: 3});
        await target.keyboard.type('80');
        await target.keyboard.press('Enter');
        await waitForFunctionInPage(target, () => document.querySelector('.zoom-controls-display-value')?.textContent?.trim() === '80%');
        await clickAsUser(target, '.tab.is-active .tab-close');

        // Inject the first-page raster failure through PDF.js's continuation,
        // as in the failed-raster lane. The real viewer presents the error
        // and ends A's open while its reload waiter awaits a ready viewport.
        const restoreRender = await target.evaluate(async () => {
            const pdfjs = (window as Window & {pdfjsLib?: typeof Pdfjs}).pdfjsLib;
            if (!pdfjs) throw new Error('PDF.js is not loaded in the renderer');
            pdfjs.GlobalWorkerOptions.workerSrc ||= new URL('/pdf/pdf.worker.min.mjs', document.baseURI).href;
            const probe = pdfjs.getDocument({data: new TextEncoder().encode('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF')});
            const proxy = await (await probe.promise).getPage(1);
            const prototype = Object.getPrototypeOf(proxy) as typeof proxy;
            await probe.destroy();
            const render = prototype.render;
            prototype.render = function (...args: Parameters<typeof render>) {
                const task = render.apply(this, args);
                if (this.pageNumber === 1) Object.defineProperty(task, 'onContinue', {
                    configurable: true,
                    get: () => () => {throw new Error('Transfer fixture: first-page raster failed');},
                    set: () => {},
                });
                return task;
            };
            (window as Window & {__restoreTransferRender?: () => void}).__restoreTransferRender = () => {
                prototype.render = render;
            };
            return true;
        });
        expect(restoreRender).toBe(true);
        const transferFailed = Promise.withResolvers<undefined>();
        const onTransferFailure = (message: ConsoleMessage) => {
            if (message.text().includes('Cross-window transfer failed')) transferFailed.resolve(undefined);
        };
        source.on('console', onTransferFailure);
        onTestFinished(() => {source.off('console', onTransferFailure);});
        try {
            const targetTitle = await target.title();
            await clickAsUser(source, '.tab.is-active[data-tab-id]', {button: 'right'});
            await clickFoundAsUser(source, (title: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
                .find(item => item.textContent?.trim().startsWith(`Move Tab to Window: ${title}`)), targetTitle,
            {description: `Move Tab to Window: ${targetTitle}`});
            await waitForFunctionInPage(target, () => {
                const toolbar = (window as IE2EWindow).__evbTestApi?.getActiveToolbarSnapshot();
                return toolbar?.initialVisualReady === true
                    && document.querySelector('.pdf-page-render-error') !== null;
            }, {timeout: 120_000});
            expect(await source.$$eval('.tab-label', tabs => tabs.map(tab => tab.textContent?.trim())))
                .toContain('superseded-slow.pdf');
        } finally {
            await target.evaluate(() => (window as Window & {__restoreTransferRender?: () => void}).__restoreTransferRender?.());
        }

        // This public workspace open replaces A in its tab, rather than the
        // shell's ordinary open dispatcher which creates another tab for B.
        await target.evaluate(async (path: TDocumentRef) => {
            await window.__allowRendererFileOpenForAutomation?.(path);
        }, requireDocumentRef(replacementPath));
        const opened = await callWorkspaceCommand(target, 'handleOpenFileDirectWithPersist', [replacementPath]);
        expect(opened).toMatchObject({
            called: true,
            value: true,
        });
        await waitForPdfLoaded(target);
        // Wait for the actual transfer decision before checking the copies.
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Superseded transfer did not report failure within 15 seconds')), 15_000);
            void transferFailed.promise.then(() => {
                clearTimeout(timeout);
                resolve();
            });
        });
        const outcome = {
            replacement: await readView(target),
            sourceTabs: await source.$$eval('.tab-label', tabs => tabs.map(tab => tab.textContent?.trim())),
            targetTabs: await target.$$eval('.tab-label', tabs => tabs.map(tab => tab.textContent?.trim())),
        };
        console.log('SUPERSEDED_TRANSFER', JSON.stringify(outcome));
        expect(outcome.replacement.zoomText).toBe('80%');
        expect(outcome.sourceTabs).toContain('superseded-slow.pdf');
        expect(outcome.targetTabs).toContain('replacement.pdf');
    }, 180_000);

    it('keeps page one and the source copy when a transfer is cancelled before presentation', async () => {
        const {page: target} = sessions.getSession();
        const appTempDirectory = electronAppTempDirPath(sessionName);
        mkdirSync(appTempDirectory, {recursive: true});
        outputDirectory = realpathSync(mkdtempSync(join(appTempDirectory, 'cancelled-tab-transfer-')));
        const incomingPath = join(outputDirectory, 'cancelled-incoming.pdf');
        await createTwelvePageFixture(incomingPath);
        await createTwelvePageFixture(replacementDialogPath);
        await openPdfInApp(target, incomingPath);
        const source = await moveTabToNewWindow(target);
        await goToPageViaToolbar(source, 6);
        await clickAsUser(source, '.tab-new');
        await clickAsUser(source, '.tab-list [role="tab"]:first-child');

        // Hold the next opening-geometry answer before A can load its source.
        // The transfer and replacement still use the real tab menu and picker.
        await target.evaluate(() => {
            const descriptor = Object.getOwnPropertyDescriptor(Promise.prototype, 'catch')!;
            const then = Promise.prototype.then;
            let release: () => void = () => {};
            const gate = new Promise<void>(resolve => {release = resolve;});
            const state = {
                held: false,
                restore: () => {
                    Object.defineProperty(Promise.prototype, 'catch', descriptor);
                    release();
                },
            };
            Object.defineProperty(Promise.prototype, 'catch', {
                ...descriptor,
                value(this: Promise<unknown>, onRejected: (reason: unknown) => unknown) {
                    return then.call(this, (value: unknown) => {
                        if (value && typeof value === 'object' && 'pageNumber' in value
                            && 'width' in value && 'height' in value && 'pageCount' in value) {
                            state.held = true;
                            Object.defineProperty(Promise.prototype, 'catch', descriptor);
                            return gate.then(() => value);
                        }
                        return value;
                    }, onRejected);
                },
            });
            (window as Window & {__cancelledTransferLoad?: typeof state}).__cancelledTransferLoad = state;
        });
        const rejected = Promise.withResolvers<undefined>();
        const onRejection = (message: ConsoleMessage) => {
            if (message.text().includes('Cross-window transfer failed')) rejected.resolve(undefined);
        };
        source.on('console', onRejection);
        onTestFinished(() => {source.off('console', onRejection);});
        try {
            const targetTitle = await target.title();
            await clickAsUser(source, '.tab.is-active[data-tab-id]', {button: 'right'});
            await clickFoundAsUser(source, (title: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
                .find(item => item.textContent?.trim().startsWith(`Move Tab to Window: ${title}`)), targetTitle,
            {description: `Move Tab to Window: ${targetTitle}`});
            await waitForFunctionInPage(target, () => (window as Window & {__cancelledTransferLoad?: {held: boolean}}).__cancelledTransferLoad?.held === true);
            await clickAsUser(target, '#editor-global-toolbar-host button[aria-label="More tools"]');
            await clickFoundAsUser(target, () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
                .find(item => item.textContent?.trim() === 'Open File'), undefined,
            {description: 'Open PDF in the incoming tab'});
            await rejected.promise;
            await waitForPdfLoaded(target);
            const result = {
                replacement: await readView(target),
                sourceTabs: await source.$$eval('.tab-label', tabs => tabs.map(tab => tab.textContent?.trim())),
                targetTabs: await target.$$eval('.tab-label', tabs => tabs.map(tab => tab.textContent?.trim())),
            };
            console.log('CANCELLED_TRANSFER_PAGE', JSON.stringify(result));
            expect(result.sourceTabs).toContain('cancelled-incoming.pdf');
            expect(result.targetTabs).toContain('cancelled-transfer-replacement.pdf');
            expect(result.replacement.page).toBe(1);
        } finally {
            await target.evaluate(() => (window as Window & {__cancelledTransferLoad?: {restore: () => void}}).__cancelledTransferLoad?.restore());
        }
    }, 120_000);

    it('preserves page, custom zoom, and open sidebar in the destination', async () => {
        const session = sessions.getSession();
        const appTempDirectory = electronAppTempDirPath(session.name);
        mkdirSync(appTempDirectory, {recursive: true});
        outputDirectory = realpathSync(mkdtempSync(join(appTempDirectory, 'tab-view-transfer-')));
        const fixture = join(outputDirectory, 'transfer-view.pdf');
        await createTwelvePageFixture(fixture);
        await openPdfInApp(session.page, fixture);
        await waitForPdfLoaded(session.page);
        await goToPageViaToolbar(session.page, 7);
        await ensureSidebarOpen(session.page);
        const zoomButton = await session.page.$('#editor-global-toolbar-host .zoom-controls-display:not(:disabled)');
        if (!zoomButton) throw new Error('Custom zoom control was not available');
        await clickAsUser(session.page, zoomButton);
        await session.page.waitForSelector('.zoom-dropdown input', {
            visible: true,
            timeout: 10_000,
        });
        await waitForFunctionInPage(session.page, () => {
            const input = document.querySelector<HTMLInputElement>('.zoom-dropdown input');
            return input !== null
                && document.activeElement === input
                && input.selectionStart === 0
                && input.selectionEnd === input.value.length;
        }, {timeout: 10_000});
        await session.page.keyboard.type('137');
        await session.page.keyboard.press('Enter');
        await waitForFunctionInPage(session.page, () => {
            const snapshot = (window as Window & {__evbTestApi?: {getActiveToolbarSnapshot?: () => {
                zoomMode?: string;
                effectiveZoom?: number
            }}})
                .__evbTestApi?.getActiveToolbarSnapshot?.();
            return snapshot?.zoomMode === 'custom';
        }, {timeout: 15_000});
        const beforeTransfer = await readView(session.page);
        expect(beforeTransfer.page).toBe(7);
        expect(beforeTransfer.zoomMode).toBe('custom');
        expect(beforeTransfer.zoomText).toContain('137');
        expect(beforeTransfer.effectiveZoom).toBeCloseTo(1.37, 2);
        expect(beforeTransfer.sidebarOpen).toBe(true);

        const destination = await moveTabToNewWindow(session.page);
        await waitForTransferredViewSettled(destination);
        const result = await readView(destination);
        expect(result.page).toBe(7);
        expect(result.zoomMode).toBe('custom');
        expect(result.zoomText).toContain('137');
        expect(result.sidebarOpen).toBe(true);
    }, 120_000);

    it('keeps the moved view over the place Recent remembers for its document', async () => {
        const session = sessions.getSession();
        const appTempDirectory = electronAppTempDirPath(session.name);
        mkdirSync(appTempDirectory, {recursive: true});
        outputDirectory = realpathSync(mkdtempSync(join(appTempDirectory, 'tab-view-transfer-recent-')));
        const fixture = join(outputDirectory, 'transfer-recent.pdf');
        await createTwelvePageFixture(fixture);
        await openPdfInApp(session.page, fixture);
        await waitForPdfLoaded(session.page);
        await goToPageViaToolbar(session.page, 3);
        // Closing the tab remembers page 3; reopening from Recent goes back there.
        await clickAsUser(session.page, '.editor-pane.is-active .tab.is-active .tab-close');
        // Match the native path by dataset value: a Windows path is not a
        // safe CSS attribute literal.
        const findRecentOpen = (source: string) => Array.from(
            document.querySelectorAll<HTMLElement>('.editor-pane.is-active [data-recent-source]'),
        ).find(row => row.dataset.recentSource === source)
            ?.querySelector<HTMLButtonElement>('.recent-open');
        await waitForFunctionInPage(session.page, (source: string) => {
            const rect = Array.from(
                document.querySelectorAll<HTMLElement>('.editor-pane.is-active [data-recent-source]'),
            ).find(row => row.dataset.recentSource === source)
                ?.querySelector<HTMLButtonElement>('.recent-open')
                ?.getBoundingClientRect();
            return Boolean(rect && rect.width > 0 && rect.height > 0);
        }, {timeout: 20_000}, fixture);
        await clickFoundAsUser(session.page, findRecentOpen, fixture, {description: `Recent open button for ${fixture}`});
        await waitForPdfLoaded(session.page);
        await waitForToolbarCurrentPage(session.page, 3);
        await goToPageViaToolbar(session.page, 7);

        const destination = await moveTabToNewWindow(session.page);
        await waitForFunctionInPage(destination, () => (
            document.querySelector('.editor-pane.is-active .document-viewer-chassis')?.getAttribute('data-viewport-lifecycle') === 'ready'
        ), {timeout: 30_000});
        expect((await readView(destination)).page).toBe(7);

    }, 120_000);
});
