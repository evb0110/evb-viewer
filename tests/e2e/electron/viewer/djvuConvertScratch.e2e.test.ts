import {
    existsSync,
    mkdtempSync,
    readdirSync,
    rmSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {
    basename,
    join,
    resolve,
} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {stopSingleSession} from '@scripts/electron-run/stopSession';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type {IElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    openDjvuInApp,
    waitForDjvuLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';

// Thousands of sparse pages keep the conversion running long enough to end it midway.
const sourcePath = resolve('tests/fixtures/electron/djvu-fixtures/djvu-open-cancellation-5010-pages.djvu');

// The scratch lives in the app's temp namespace below the temp root.
function listExportScratch(tempRoot: string) {
    return readdirSync(tempRoot, {
        recursive: true,
        encoding: 'utf8',
    })
        .filter(entry => basename(entry).startsWith('djvu-export-'));
}

async function startConversion(session: IElectronE2ESession, tempRoot: string) {
    await openDjvuInApp(session.page, sourcePath, 120_000);
    await waitForDjvuLoaded(session.page, 120_000);
    await session.page.click('[data-focus-restore="djvu-convert"]');
    await waitForFunctionInPage(session.page, () => {
        const dialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
            .find(element => element.textContent?.includes('Convert DjVu to PDF'));
        const button = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])
            .find(candidate => candidate.textContent?.trim() === 'Convert' && !candidate.disabled);
        if (!button) return false;
        button.click();
        return true;
    }, {timeout: 60_000});
    // The compact manifest marks a conversion past setup, with native page work running.
    await expect.poll(() => listExportScratch(tempRoot)
        .some(entry => existsSync(join(tempRoot, entry, 'compact-manifest.jsonl'))), {timeout: 120_000}).toBe(true);
}

describe('DjVu conversion scratch', () => {
    const sessions = createElectronE2ESessionFixture({
        sessionName: () => `e2e-djvu-convert-scratch-${Date.now()}`,
        restartBeforeEach: false,
    });
    let tempRoot = '';

    // The session's processes write to the temp root until they stop.
    afterEach(async () => {
        await sessions.stop();
        if (tempRoot) rmSync(tempRoot, {
            recursive: true,
            force: true,
        });
        tempRoot = '';
    });

    async function startSession() {
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-e2e-djvu-scratch-'));
        return sessions.start({
            clean: true,
            sessionName: () => `e2e-djvu-convert-scratch-${Date.now()}`,
            extraEnv: {
                TMPDIR: tempRoot,
                EVB_E2E_SAVE_DIALOG_PATH: join(tempRoot, 'converted.pdf'),
                EVB_PDF_IMAGE_COMBINE_ENABLE: '1',
            },
        });
    }

    it('removes the export scratch when the conversion is canceled', async () => {
        const session = await startSession();
        await startConversion(session, tempRoot);
        await waitForFunctionInPage(session.page, () => {
            const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
                .find(candidate => candidate.textContent?.trim() === 'Cancel' && !candidate.disabled);
            if (!button) return false;
            button.click();
            return true;
        }, {timeout: 30_000});
        await expect.poll(() => listExportScratch(tempRoot), {timeout: 60_000}).toEqual([]);
    }, 300_000);

    it('removes the export scratch when the app quits during the conversion', async () => {
        const session = await startSession();
        await startConversion(session, tempRoot);
        // A graceful quit that keeps the profile's app temp, as an installed app
        // does; a plain session stop wipes it and would hide what the quit left.
        await stopSingleSession(session.name, {preserveWorkspaceCheckpoint: true});
        expect(listExportScratch(tempRoot)).toEqual([]);
    }, 300_000);
});
