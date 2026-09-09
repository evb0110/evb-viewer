import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    createMultiPageTextFixturePdf, readPdfPageSnapshots,
} from '@tests/e2e/electron/helpers/fixtures';
import {getActiveWorkspaceWorkingCopyPath} from '@tests/e2e/electron/helpers/electronApiHelpers';
import {
    startElectronE2ESession,
    type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    callWorkspaceCommand,
    readWorkspaceStateValues,
    waitForWorkspaceToolbarIdle,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {workspaceCrashCheckpointPath} from '@scripts/electron-run/electronRunWorkspaceCheckpoint';
import {stopSingleSession} from '@scripts/electron-run/stopSession';

const E2E_TIMEOUT_MS = 240_000;

interface IRecoveredSession {
    pdfPath: string;
    session: IElectronE2ESession;
}

async function createRecoveredSession(label: string): Promise<IRecoveredSession> {
    const pdfPath = await createMultiPageTextFixturePdf(`project8-close-${label}-${Date.now()}.pdf`, 2);
    const sessionName = `e2e-project8-close-${label}-${Date.now()}`;
    let session = await startElectronE2ESession(sessionName, {
        clean: true,
        extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
        initialOpenPaths: [pdfPath],
    });
    await waitForPdfLoaded(session.page, 60_000);
    await waitForViewerInteractive(session.page, 60_000);
    const workingCopyPath = await getActiveWorkspaceWorkingCopyPath(session.page);
    expect((await callWorkspaceCommand(session.page, 'handleRotateCw', [[1]])).called).toBe(true);
    await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: 60_000});
    const checkpointPath = workspaceCrashCheckpointPath(session.name);
    await expect.poll(async () => {
        if (!existsSync(checkpointPath)) {
            return null;
        }
        const stored = JSON.parse(await readFile(checkpointPath, 'utf8')) as {checkpoint?: {tabs?: Array<{
            isDirty?: boolean;
            workingCopyRef?: string | null
        }>};};
        return stored.checkpoint?.tabs?.[0] ?? null;
    }, {timeout: 60_000}).toMatchObject({
        isDirty: true,
        workingCopyRef: expect.any(String),
    });
    expect((await readPdfPageSnapshots(workingCopyPath))[0]?.rotation).toBe(90);

    const crashed = session;
    await crashed.browser.disconnect();
    await stopSingleSession(crashed.name, {
        preserveWorkspaceCheckpoint: true,
        crashElectronBeforeStop: true,
    });
    session = await startElectronE2ESession(sessionName, {
        clean: false,
        extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
    });
    await waitForPdfLoaded(session.page, 60_000);
    await waitForViewerInteractive(session.page, 60_000);
    const state = await readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean}}>(session.page, ['dirtyState']);
    expect(state.dirtyState?.fileDirty).toBe(true);
    expect((await readPdfPageSnapshots(await getActiveWorkspaceWorkingCopyPath(session.page)))[0]?.rotation).toBe(90);
    return {
        pdfPath,
        session,
    };
}

async function clickWindowDecision(session: IElectronE2ESession, label: string) {
    await session.page.evaluate(() => window.electronAPI?.windowTabs.closeCurrentWindow());
    await session.page.waitForFunction(() => Boolean(document.querySelector('[role="dialog"]')));
    await session.page.evaluate((expectedLabel) => {
        const button = Array.from(document.querySelectorAll('button')).find(candidate => (
            (candidate.textContent ?? '').trim().includes(expectedLabel)
        ));
        if (!button) {
            throw new Error(`Window close action was not found: ${expectedLabel}`);
        }
        button.click();
    }, label);
}

describe('Project 8 recovered close decisions', () => {
    let session: IElectronE2ESession | null = null;

    afterEach(async () => {
        await session?.stop().catch(() => undefined);
        session = null;
    });

    it('Cancel keeps recovered dirty bytes open', async () => {
        const recovered = await createRecoveredSession('cancel');
        session = recovered.session;
        await clickWindowDecision(session, 'Cancel');
        const state = await readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean}}>(session.page, ['dirtyState']);
        expect(state.dirtyState?.fileDirty).toBe(true);
        expect((await readPdfPageSnapshots(await getActiveWorkspaceWorkingCopyPath(session.page)))[0]?.rotation).toBe(90);
    }, E2E_TIMEOUT_MS);

    it('Save commits recovered bytes and permits close without Save As', async () => {
        const recovered = await createRecoveredSession('save');
        session = recovered.session;
        await clickWindowDecision(session, 'Save changes');
        await expect.poll(async () => (await readPdfPageSnapshots(recovered.pdfPath))[0]?.rotation, {timeout: 60_000}).toBe(90);
    }, E2E_TIMEOUT_MS);

    it('Discard closes without committing recovered bytes', async () => {
        const recovered = await createRecoveredSession('discard');
        session = recovered.session;
        await clickWindowDecision(session, 'Discard Changes');
        await expect.poll(async () => (await readPdfPageSnapshots(recovered.pdfPath))[0]?.rotation, {timeout: 60_000}).toBe(0);
    }, E2E_TIMEOUT_MS);

    it('failed Save leaves the recovered document dirty and checkpointable', async () => {
        const recovered = await createRecoveredSession('failed-save');
        session = recovered.session;
        await session.page.evaluate(() => {
            window.__stagedPdfNativeMutationCommitBarrierForAutomation = async () => {
                throw new Error('injected recovered-save publication failure');
            };
        });
        await clickWindowDecision(session, 'Save changes');
        const state = await readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean}}>(session.page, ['dirtyState']);
        expect(state.dirtyState?.fileDirty).toBe(true);
        expect((await readPdfPageSnapshots(await getActiveWorkspaceWorkingCopyPath(session.page)))[0]?.rotation).toBe(90);
    }, E2E_TIMEOUT_MS);
});
