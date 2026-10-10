import {
    mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';
import {
    PDFDocument, StandardFonts, rgb,
} from 'pdf-lib';
import {
    afterEach, describe, expect, it,
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
import type {Page} from 'puppeteer-core';
import {electronAppTempDirPath} from '@scripts/electron-run/electronRunSessionPaths';

const sessions = createElectronE2ESessionFixture({sessionName: () => `e2e-move-tab-view-state-${Date.now()}`});
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

function createSlowTransferFixture(filePath: string) {
    const name = 'Slow transfer';
    const count = 20;
    const objects = new Map<number, Buffer>();
    const text = (value: string) => Buffer.from(value, 'latin1');
    objects.set(1, text('<< /Type /Catalog /Pages 2 0 R >>'));
    objects.set(3, text('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));
    let next = 4;
    let fonts = '/F 3 0 R';
    {
        const decoded = Buffer.alloc(64 * 1024 * 1024, 0x20);
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
