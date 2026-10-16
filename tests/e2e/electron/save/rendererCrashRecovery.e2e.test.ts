import {
    copyFileSync, mkdtempSync, rmSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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

it('does not reopen a document whose restore ended the renderer, says so, and keeps the workspace usable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'evb-renderer-crash-'));
    const goodPath = join(directory, 'good.pdf');
    const slowPath = join(directory, SLOW_FILE_NAME);
    copyFileSync(join(process.cwd(), 'tests/fixtures/release/packaged-core-smoke.pdf'), goodPath);
    copyFileSync(goodPath, slowPath);
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
        // Prepare a durable workspace before recovery. On low-tier hosts
        // its debounced checkpoint can arrive after the initial page paints.
        await session.page.waitForFunction((fileName: string) => (
            (document.querySelector('.tab.is-active')?.textContent ?? '').includes(fileName)
            && document.querySelectorAll('.workspace-host[data-workspace-active="true"] .page_container--rendered').length > 0
        ), {timeout: 60_000}, SLOW_FILE_NAME);
        await expect.poll(() => JSON.stringify(readWorkspaceRecoveryRecords(session.name))
            .includes(SLOW_FILE_NAME), {timeout: 60_000}).toBe(true);
        const client = await session.page.createCDPSession();
        // Hold the restored PDF.js worker before it executes. Unlike the
        // direct-open preload hold, this covers handleOpenFileWithResult too.
        // The fixture becomes a slow open at the actual rendering boundary,
        // independent of decompression speed or the host's performance tier.
        await client.send('Target.setAutoAttach', {
            autoAttach: true,
            waitForDebuggerOnStart: true,
            flatten: true,
            filter: [
                {type: 'worker'},
                {exclude: true},
            ],
        });
        let restoredWorkerHeld: boolean | null = null;
        client.on('Target.attachedToTarget', (target) => {
            if (target.targetInfo.type === 'worker') {
                restoredWorkerHeld = target.waitingForDebugger;
            }
        });
        try {
            void client.send('Page.crash').catch(() => undefined);
            await expect.poll(() => restoredWorkerHeld, {timeout: 60_000}).toBe(true);
            // Recovery really is opening this tab, without a painted page,
            // while its durable recovery record names the same document.
            await crashWhileSlowDocumentOpens(session.page, session.name);
        } finally {
            await client.send('Target.setAutoAttach', {
                autoAttach: false,
                waitForDebuggerOnStart: false,
                flatten: true,
            }).catch(() => undefined);
            await client.detach().catch(() => undefined);
        }

        // The next recovery keeps the workspace, leaves that document closed
        // and says so.
        await expect.poll(() => readTabTitles(session.page).catch(() => []), {timeout: 60_000}).toEqual([
            'good.pdf',
            'New Tab',
        ]);
        await expect.poll(() => session.page.evaluate(() => Array.from(
            document.querySelectorAll<HTMLElement>('[role="alert"], li[data-state]'),
            toast => toast.innerText,
        ).join('\n')).catch(() => ''), {timeout: 30_000}).toContain(
            `Document not reopened\n${SLOW_FILE_NAME} stopped the viewer while it was opening, so it was not reopened.`,
        );
        const goodTab = await session.page.waitForSelector('::-p-xpath(//*[contains(@class, "tab") and normalize-space(.)="good.pdf"])', {visible: true});
        await clickAsUser(session.page, goodTab!);
        await waitForPdfLoaded(session.page, 60_000);

        // A relaunch from the recovery record does not reopen it either. The
        // acknowledged restore removed its record; wait for the workspace's
        // own next checkpoint before ending the process.
        await expect.poll(() => {
            const records = JSON.stringify(readWorkspaceRecoveryRecords(session.name));
            return records.includes('good.pdf') && !records.includes(SLOW_FILE_NAME);
        }, {timeout: 60_000}).toBe(true);
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
