import {
    copyFileSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';
import type {Page} from 'puppeteer-core';
import type {TDocumentRef} from '@contracts/documentRef';
import {
    expect, it,
} from 'vitest';
import {startElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    waitForPdfLoaded, waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
import {readWorkspaceRecoveryRecords} from '@scripts/electron-run/electronRunWorkspaceCheckpoint';
import {stopSingleSession} from '@scripts/electron-run/stopSession';

const SLOW_FILE_NAME = 'slow-opening.pdf';

// One page in sixteen fonts whose ToUnicode CMaps decode to 128 MiB each.
// PDF.js reads them one after another, so the document stays opening for
// seconds while the renderer holds only one of them.
function writeSlowOpeningPdf(path: string) {
    const cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n'
        + '1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\nendcmap\nend\nend\n';
    const decoded = Buffer.alloc(128 * 1024 * 1024, 0x20);
    decoded.write(cmap, 'latin1');
    const stream = deflateSync(decoded);
    const objects = new Map<number, Buffer>();
    const text = (value: string) => Buffer.from(value, 'latin1');
    objects.set(1, text('<< /Type /Catalog /Pages 2 0 R >>'));
    objects.set(2, text('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
    objects.set(5, text('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /GlyphLessFont /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 /CIDToGIDMap /Identity >>'));
    const fonts: string[] = [];
    const shows: string[] = [];
    for (let index = 0; index < 16; index += 1) {
        const fontId = 6 + index * 2;
        objects.set(fontId + 1, Buffer.concat([
            text(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`),
            stream,
            text('\nendstream'),
        ]));
        objects.set(fontId, text(`<< /Type /Font /Subtype /Type0 /BaseFont /GlyphLessFont /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode ${fontId + 1} 0 R >>`));
        fonts.push(`/F${index} ${fontId} 0 R`);
        const label = Array.from(`Font ${index}`, character => character.charCodeAt(0).toString(16).padStart(4, '0')).join('');
        shows.push(`BT /F${index} 18 Tf 72 ${760 - index * 24} Td <${label}> Tj ET`);
    }
    const content = shows.join('\n');
    objects.set(4, text(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    objects.set(3, text(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << ${fonts.join(' ')} >> >> /Contents 4 0 R >>`));
    const parts: Buffer[] = [text('%PDF-1.7\n')];
    const offsets: number[] = [];
    let length = parts[0]!.length;
    const ids = [...objects.keys()].sort((left, right) => left - right);
    for (const id of ids) {
        const body = Buffer.concat([
            text(`${id} 0 obj\n`),
            objects.get(id)!,
            text('\nendobj\n'),
        ]);
        offsets[id] = length;
        parts.push(body);
        length += body.length;
    }
    const size = ids.at(-1)! + 1;
    const xref = [`xref\n0 ${size}\n0000000000 65535 f \n`];
    for (let id = 1; id < size; id += 1) {
        xref.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
    }
    xref.push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`);
    parts.push(text(xref.join('')));
    writeFileSync(path, Buffer.concat(parts));
}

function readTabTitles(page: Page) {
    return page.evaluate(() => Array.from(document.querySelectorAll('.tab'), tab => tab.textContent?.trim() ?? ''));
}

// Crashes the renderer, as running out of memory does, while the slow
// document is the shown tab, has not painted, and the recovery record names it.
async function crashWhileSlowDocumentOpens(page: Page, sessionName: string) {
    await expect.poll(async () => {
        const opening = await page.evaluate((fileName: string) => (
            (document.querySelector('.tab.is-active')?.textContent ?? '').includes(fileName)
            && document.querySelectorAll('.workspace-host[data-workspace-active="true"] .page_container--rendered').length === 0
        ), SLOW_FILE_NAME).catch(() => false);
        return opening && JSON.stringify(readWorkspaceRecoveryRecords(sessionName)).includes(SLOW_FILE_NAME);
    }, {
        timeout: 60_000,
        interval: 50,
    }).toBe(true);
    const client = await page.createCDPSession();
    void client.send('Page.crash').catch(() => undefined);
}

it('does not reopen a document whose restore ended the renderer, and keeps the workspace usable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'evb-renderer-crash-'));
    const goodPath = join(directory, 'good.pdf');
    const slowPath = join(directory, SLOW_FILE_NAME);
    copyFileSync(join(process.cwd(), 'tests/fixtures/release/packaged-core-smoke.pdf'), goodPath);
    writeSlowOpeningPdf(slowPath);
    const sessionName = `e2e-renderer-crash-${Date.now()}`;
    let session = await startElectronE2ESession(sessionName, {
        clean: true,
        initialOpenPaths: [goodPath],
    });
    try {
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await session.page.evaluate(async (path: TDocumentRef) => {
            await window.__allowRendererFileOpenForAutomation?.(path);
            void window.__openFileDirect?.(path);
        }, slowPath as TDocumentRef);
        // The open ends the renderer; recovery reloads the window and its
        // restore opens the document again, which ends the renderer again.
        await crashWhileSlowDocumentOpens(session.page, session.name);
        await crashWhileSlowDocumentOpens(session.page, session.name);

        // The next recovery keeps the workspace and leaves that document closed.
        await expect.poll(() => readTabTitles(session.page).catch(() => []), {timeout: 60_000}).toEqual([
            'good.pdf',
            'New Tab',
        ]);
        const goodTab = await session.page.waitForSelector('::-p-xpath(//*[contains(@class, "tab") and normalize-space(.)="good.pdf"])', {visible: true});
        await clickAsUser(session.page, goodTab!);
        await waitForPdfLoaded(session.page, 60_000);

        // A relaunch from the recovery record does not reopen it either.
        await session.browser.disconnect();
        await stopSingleSession(session.name, {
            preserveWorkspaceCheckpoint: true,
            crashElectronBeforeStop: true,
        });
        session = await startElectronE2ESession(sessionName, {clean: false});
        await expect.poll(() => readTabTitles(session.page).catch(() => []), {timeout: 60_000}).toEqual([
            'good.pdf',
            'New Tab',
        ]);
    } finally {
        await session.stop();
        rmSync(directory, {
            recursive: true,
            force: true,
        });
    }
});
