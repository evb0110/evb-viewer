import {createHash} from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {
    clickAsUser,
    clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {
    basename,
    join,
    resolve,
} from 'node:path';
import {
    afterAll,
    beforeAll,
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

// Thousands of sparse pages keep the conversion running long enough to end it midway.
const sourcePath = resolve('tests/fixtures/electron/djvu-fixtures/djvu-open-cancellation-5010-pages.djvu');
// Page 1 is encoded at 72 DPI and page 2 at 300 DPI.
const mixedDpiPath = resolve('tests/fixtures/djvu/sources/mixed-dpi.djvu');

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
    await clickAsUser(session.page, '[data-focus-restore="djvu-convert"]');
    await clickFoundAsUser(session.page, () => Array.from(Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
        .find(element => element.textContent?.includes('Convert DjVu to PDF'))
        ?.querySelectorAll<HTMLButtonElement>('button') ?? [])
        .find(candidate => candidate.textContent?.trim() === 'Convert' && !candidate.disabled), null, {
        description: 'Convert in the DjVu conversion dialog',
        timeoutMs: 60_000,
    });
    // The compact manifest marks a conversion past setup, with native page work running.
    await expect.poll(() => listExportScratch(tempRoot)
        .some(entry => existsSync(join(tempRoot, entry, 'compact-manifest.jsonl'))), {timeout: 120_000}).toBe(true);
}

describe('DjVu conversion scratch', () => {
    // Each test's app gets its own temp root, so one test's leftovers cannot
    // satisfy or fail the next. The fixture boots the first test's session.
    const suiteRoot = join(tmpdir(), `evb-e2e-djvu-scratch-${Date.now()}`);
    const cancelRoot = join(suiteRoot, 'cancel');
    const quitRoot = join(suiteRoot, 'quit');
    const resolutionRoot = join(suiteRoot, 'resolution');
    const scratchEnv = (tempRoot: string) => ({
        TMPDIR: tempRoot,
        TMP: tempRoot,
        TEMP: tempRoot,
        EVB_E2E_SAVE_DIALOG_PATH: join(tempRoot, 'converted.pdf'),
        EVB_PDF_IMAGE_COMBINE_ENABLE: '1',
    });
    beforeAll(() => {
        mkdirSync(cancelRoot, {recursive: true});
        mkdirSync(quitRoot, {recursive: true});
        mkdirSync(resolutionRoot, {recursive: true});
    });
    const sessions = createElectronE2ESessionFixture({
        sessionName: () => `e2e-djvu-convert-scratch-${Date.now()}`,
        restartBeforeEach: false,
        extraEnv: scratchEnv(cancelRoot),
    });

    // The session's processes write to the temp root until they stop.
    afterAll(async () => {
        await sessions.stop();
        rmSync(suiteRoot, {
            recursive: true,
            force: true,
        });
    });

    it('removes the export scratch when the conversion is canceled', async () => {
        const session = sessions.getSession();
        await startConversion(session, cancelRoot);
        await clickFoundAsUser(session.page, () => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
            .find(candidate => candidate.textContent?.trim() === 'Cancel' && !candidate.disabled), null, {
            description: 'Cancel of the running DjVu conversion',
            timeoutMs: 30_000,
        });
        await expect.poll(() => listExportScratch(cancelRoot), {timeout: 60_000}).toEqual([]);
    }, 300_000);

    it('removes the export scratch when the app quits during the conversion', async () => {
        const session = await sessions.start({
            clean: true,
            sessionName: () => `e2e-djvu-convert-scratch-${Date.now()}`,
            extraEnv: scratchEnv(quitRoot),
        });
        await startConversion(session, quitRoot);
        // A graceful quit that keeps the profile's app temp, as an installed app
        // does; a plain session stop wipes it and would hide what the quit left.
        await stopSingleSession(session.name, {preserveWorkspaceCheckpoint: true});
        expect(listExportScratch(quitRoot)).toEqual([]);
    }, 300_000);

    it('shows the first page\'s encoded resolution in the conversion dialog', async () => {
        const sourceHash = () => createHash('sha256').update(readFileSync(mixedDpiPath)).digest('hex');
        const hashBefore = sourceHash();
        const session = await sessions.start({
            clean: true,
            sessionName: () => `e2e-djvu-convert-resolution-${Date.now()}`,
            extraEnv: scratchEnv(resolutionRoot),
        });
        await openDjvuInApp(session.page, mixedDpiPath, 120_000);
        await waitForDjvuLoaded(session.page, 120_000);
        await clickAsUser(session.page, '[data-focus-restore="djvu-convert"]');
        const readSourceResolution = () => session.page.evaluate(() => document
            .querySelector('[role="dialog"] .convert-info-row:nth-child(3) .convert-info-value')
            ?.textContent?.trim() ?? null);
        await expect.poll(readSourceResolution, {timeout: 60_000}).toMatch(/\d/u);
        expect(await readSourceResolution()).toBe('72 DPI');
        await clickFoundAsUser(session.page, () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
            .find(candidate => candidate.textContent?.trim() === 'Cancel'), null, {
            description: 'Cancel of the DjVu conversion dialog',
            timeoutMs: 30_000,
        });
        await expect.poll(() => session.page.evaluate(() => document.querySelector('[role="dialog"] .convert-info-row')), {timeout: 30_000}).toBeNull();
        expect(sourceHash()).toBe(hashBefore);
    }, 300_000);
});
