import {existsSync} from 'node:fs';
import {
    readFile, rename, utimes,
} from 'node:fs/promises';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    createMultiPageTextFixturePdf, readPdfPageSnapshots,
} from '@tests/e2e/electron/helpers/fixtures';
import {createCanonicalTextBoxWithPointer} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {getActiveWorkspaceWorkingCopyPath} from '@tests/e2e/electron/helpers/electronApiHelpers';
import {
    startElectronE2ESession,
    type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    waitForPdfLoaded,
    waitForViewerInteractive,
    openPdfInApp,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    activateWorkspaceTab,
    createNewWorkspaceTab,
} from '@tests/e2e/electron/helpers/workspaceTabs';
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
    workingCopyPath: string;
    session: IElectronE2ESession;
}

interface IRecoveryDirtyState {
    [key: string]: unknown;
    fileDirty?: boolean;
    recoveryDirtyBaseline?: boolean;
}

interface IRecoveryAutomationState {
    [key: string]: unknown;
    dirtyState?: IRecoveryDirtyState;
}

const RECOVERED_ANNOTATION_TEXT = 'Project 8 recovered annotation';

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
    await createCanonicalTextBoxWithPointer(session.page, RECOVERED_ANNOTATION_TEXT, {
        x: 0.4,
        y: 0.3,
    });
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
    await session.page.waitForFunction((expectedText: string) => Array.from(
        document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"]',
        ),
    ).some(entity => entity.textContent?.replace(/[\u200B\uFEFF]/gu, '').trim() === expectedText), {timeout: 60_000}, RECOVERED_ANNOTATION_TEXT);
    const state = await readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean}}>(session.page, ['dirtyState']);
    expect(state.dirtyState?.fileDirty).toBe(true);
    const recoveredWorkingCopyPath = await getActiveWorkspaceWorkingCopyPath(session.page);
    expect((await readPdfPageSnapshots(recoveredWorkingCopyPath))[0]?.rotation).toBe(90);
    return {
        pdfPath,
        workingCopyPath: recoveredWorkingCopyPath,
        session,
    };
}

async function clickWindowDecision(
    session: IElectronE2ESession,
    label: string,
    options: {waitForClose?: boolean} = {},
) {
    const waitForClose = options.waitForClose ?? label !== 'Cancel';
    const closed = waitForClose
        ? new Promise<void>(resolve => session.page.once('close', () => resolve()))
        : null;
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
    if (label === 'Cancel') {
        await session.page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    }
    if (closed) {
        await closed;
        expect(session.page.isClosed()).toBe(true);
    }
}

async function activateTabWithWorkingCopy(
    session: IElectronE2ESession,
    expectedPath: string,
    expectedOriginalPath = expectedPath,
) {
    for (const tabIndex of [
        0,
        1,
    ]) {
        const tabId = await session.page.$$eval(
            '.tab-list .tab[data-tab-id]',
            (tabs, index) => tabs[index as number]?.getAttribute('data-tab-id'),
            tabIndex,
        );
        if (!tabId) {
            continue;
        }
        await activateWorkspaceTab(session, tabIndex);
        await session.page.waitForFunction((expectedTabId: string) => (
            window.__evbTestApi?.getActiveTabId() === expectedTabId
        ), {timeout: 10_000}, tabId);
        for (let attempt = 0; attempt < 20; attempt += 1) {
            const state = await readWorkspaceStateValues<{
                originalPath?: string | null;
                workingCopyPath?: string | null;
            }>(session.page, [
                'originalPath',
                'workingCopyPath',
            ]);
            if (state.workingCopyPath === expectedPath || state.originalPath === expectedOriginalPath) {
                return state;
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }
    throw new Error(`Could not activate tab with working copy ${expectedPath}`);
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
        expect(session.page.isClosed()).toBe(false);
        const state = await readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean}}>(session.page, ['dirtyState']);
        expect(state.dirtyState?.fileDirty).toBe(true);
        expect((await readPdfPageSnapshots(await getActiveWorkspaceWorkingCopyPath(session.page)))[0]?.rotation).toBe(90);
    }, E2E_TIMEOUT_MS);

    it('Save commits recovered bytes and permits close without Save As', async () => {
        const recovered = await createRecoveredSession('save');
        session = recovered.session;
        await clickWindowDecision(session, 'Save changes', {waitForClose: true});
        await expect.poll(async () => (await readPdfPageSnapshots(recovered.pdfPath))[0]?.rotation, {timeout: 60_000}).toBe(90);
    }, E2E_TIMEOUT_MS);

    it('Discard closes without committing recovered bytes', async () => {
        const recovered = await createRecoveredSession('discard');
        session = recovered.session;
        await clickWindowDecision(session, 'Discard Changes', {waitForClose: true});
        await expect.poll(async () => (await readPdfPageSnapshots(recovered.pdfPath))[0]?.rotation, {timeout: 60_000}).toBe(0);
    }, E2E_TIMEOUT_MS);

    it('failed Save leaves the recovered document dirty and checkpointable', async () => {
        const recovered = await createRecoveredSession('failed-save');
        session = recovered.session;
        await utimes(recovered.pdfPath, new Date(), new Date(Date.now() + 2_000));
        const saveResult = await callWorkspaceCommand<boolean>(session.page, 'handleSave');
        expect(saveResult).toEqual({
            called: true,
            value: false,
        });
        await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: 60_000});
        expect(session.page.isClosed()).toBe(false);
        const state = await readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean;};}>(session.page, ['dirtyState']);
        expect(state.dirtyState?.fileDirty).toBe(true);
        expect((await readPdfPageSnapshots(recovered.workingCopyPath))[0]?.rotation).toBe(90);
        await expect.poll(async () => {
            const checkpointPath = workspaceCrashCheckpointPath(session!.name);
            if (!existsSync(checkpointPath)) {
                return null;
            }
            const stored = JSON.parse(await readFile(checkpointPath, 'utf8')) as {checkpoint?: {tabs?: Array<{
                isDirty?: boolean;
                workingCopyRef?: string | null;
            }>};};
            return stored.checkpoint?.tabs?.[0] ?? null;
        }, {timeout: 60_000}).toMatchObject({
            isDirty: true,
            workingCopyRef: expect.any(String),
        });
    }, E2E_TIMEOUT_MS);

    it('retains a failed dirty tab while a sibling tab restores across a crash', async () => {
        const firstPdfPath = await createMultiPageTextFixturePdf(`project8-two-tab-failed-${Date.now()}.pdf`, 2);
        const secondPdfPath = await createMultiPageTextFixturePdf(`project8-two-tab-success-${Date.now()}.pdf`, 2);
        const sessionName = `e2e-project8-two-tab-${Date.now()}`;
        session = await startElectronE2ESession(sessionName, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [firstPdfPath],
        });
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        const firstWorkingCopyPath = await getActiveWorkspaceWorkingCopyPath(session.page);
        expect(await callWorkspaceCommand(session.page, 'handleRotateCw', [[1]])).toMatchObject({called: true});
        await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: 60_000});
        const checkpointPath = workspaceCrashCheckpointPath(session.name);
        await expect.poll(async () => {
            if (!existsSync(checkpointPath)) {
                return null;
            }
            const stored = JSON.parse(await readFile(checkpointPath, 'utf8')) as {checkpoint?: {tabs?: Array<{
                sourceRef?: string | null;
                workingCopyRef?: string | null;
                isDirty?: boolean;
            }>};};
            return stored.checkpoint?.tabs?.find(tab => tab.sourceRef === firstPdfPath) ?? null;
        }, {timeout: 60_000}).toMatchObject({
            sourceRef: firstPdfPath,
            workingCopyRef: firstWorkingCopyPath,
            isDirty: true,
        });

        await createNewWorkspaceTab(session);
        await openPdfInApp(session.page, secondPdfPath, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        const secondWorkingCopyPath = await getActiveWorkspaceWorkingCopyPath(session.page);
        expect(await callWorkspaceCommand(session.page, 'handleRotateCw', [[1]])).toMatchObject({called: true});
        await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: 60_000});

        await expect.poll(async () => {
            if (!existsSync(checkpointPath)) {
                return null;
            }
            const stored = JSON.parse(await readFile(checkpointPath, 'utf8')) as {checkpoint?: {tabs?: Array<{
                sourceRef?: string | null;
                workingCopyRef?: string | null;
                isDirty?: boolean;
            }>};};
            return stored.checkpoint?.tabs ?? null;
        }, {timeout: 60_000}).toEqual(expect.arrayContaining([
            expect.objectContaining({
                sourceRef: firstPdfPath,
                isDirty: true,
            }),
            expect.objectContaining({
                sourceRef: secondPdfPath,
                isDirty: true,
            }),
        ]));
        expect((await readPdfPageSnapshots(firstWorkingCopyPath))[0]?.rotation).toBe(90);
        expect((await readPdfPageSnapshots(secondWorkingCopyPath))[0]?.rotation).toBe(90);
        const firstRecoverySidecarPaths = [
            `${firstWorkingCopyPath}.evb-revision.json`,
            `${firstWorkingCopyPath}.evb-pages.json`,
        ];
        expect(firstRecoverySidecarPaths.every(path => existsSync(path))).toBe(true);

        const initialCheckpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as {checkpoint?: {tabs?: Array<{
            sourceRef?: string | null;
            workingCopyRef?: string | null;
            isDirty?: boolean;
        }>};};
        const initialTabs = initialCheckpoint.checkpoint?.tabs ?? [];
        const failedTab = initialTabs.find(tab => tab.sourceRef === firstPdfPath);
        const successfulTab = initialTabs.find(tab => tab.sourceRef === secondPdfPath);
        expect(failedTab?.workingCopyRef).toBe(firstWorkingCopyPath);
        expect(successfulTab?.workingCopyRef).toBe(secondWorkingCopyPath);

        const unavailableWorkingCopyPath = `${firstWorkingCopyPath}.project8-open-failure`;
        await rename(firstWorkingCopyPath, unavailableWorkingCopyPath);
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

        await activateTabWithWorkingCopy(session, secondWorkingCopyPath, secondPdfPath);
        await waitForPdfLoaded(session.page, 60_000);
        await expect.poll(async () => {
            if (!existsSync(checkpointPath)) {
                return null;
            }
            const stored = JSON.parse(await readFile(checkpointPath, 'utf8')) as {checkpoint?: {tabs?: Array<{
                sourceRef?: string | null;
                workingCopyRef?: string | null;
                isDirty?: boolean;
            }>};};
            return stored.checkpoint?.tabs?.find(tab => tab.sourceRef === firstPdfPath) ?? null;
        }, {timeout: 60_000}).toMatchObject({
            sourceRef: firstPdfPath,
            workingCopyRef: firstWorkingCopyPath,
            isDirty: true,
        });
        expect(firstRecoverySidecarPaths.every(path => existsSync(path))).toBe(true);
        await rename(unavailableWorkingCopyPath, firstWorkingCopyPath);

        const recoveredAfterFailedOpen = await readPdfPageSnapshots(firstWorkingCopyPath);
        expect(recoveredAfterFailedOpen[0]?.rotation).toBe(90);
        expect((await readPdfPageSnapshots(secondWorkingCopyPath))[0]?.rotation).toBe(90);

        const failedRestart = session;
        await failedRestart.browser.disconnect();
        await stopSingleSession(failedRestart.name, {
            preserveWorkspaceCheckpoint: true,
            crashElectronBeforeStop: true,
        });
        session = await startElectronE2ESession(sessionName, {
            clean: false,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
        });
        const finalFailedState = await activateTabWithWorkingCopy(session, firstWorkingCopyPath, firstPdfPath);
        await waitForPdfLoaded(session.page, 60_000);
        const recoveryPage = session.page;
        const settledFailedState = await readWorkspaceStateValues<IRecoveryAutomationState & {
            originalPath?: string | null;
            workingCopyPath?: string | null;
        }>(session.page, [
            'dirtyState',
            'originalPath',
            'workingCopyPath',
        ]);
        expect(finalFailedState?.workingCopyPath).toEqual(expect.any(String));
        expect(settledFailedState.workingCopyPath).toEqual(expect.any(String));
        expect(settledFailedState.originalPath).toBe(firstPdfPath);
        await expect.poll(async () => (
            (await readWorkspaceStateValues<IRecoveryAutomationState>(recoveryPage, ['dirtyState'])).dirtyState
        ), {timeout: 60_000}).toMatchObject({
            fileDirty: true,
            recoveryDirtyBaseline: true,
        });
        expect((await readPdfPageSnapshots(firstWorkingCopyPath))[0]?.rotation).toBe(90);
        await expect.poll(async () => {
            if (!existsSync(checkpointPath)) {
                return null;
            }
            const stored = JSON.parse(await readFile(checkpointPath, 'utf8')) as {checkpoint?: {tabs?: Array<{
                sourceRef?: string | null;
                workingCopyRef?: string | null;
                isDirty?: boolean;
            }>};};
            return stored.checkpoint?.tabs?.find(tab => tab.sourceRef === firstPdfPath) ?? null;
        }, {timeout: 60_000}).toMatchObject({
            sourceRef: firstPdfPath,
            workingCopyRef: firstWorkingCopyPath,
            isDirty: true,
        });
        const finalSuccessfulState = await activateTabWithWorkingCopy(session, secondWorkingCopyPath, secondPdfPath);
        await waitForPdfLoaded(session.page, 60_000);
        const settledSuccessfulState = await readWorkspaceStateValues<{workingCopyPath?: string | null}>(session.page, ['workingCopyPath']);
        expect(finalSuccessfulState?.workingCopyPath).toEqual(expect.any(String));
        expect(settledSuccessfulState.workingCopyPath).toEqual(expect.any(String));
        expect((await readPdfPageSnapshots(settledSuccessfulState.workingCopyPath!))[0]?.rotation).toBe(90);
        expect((await readPdfPageSnapshots(secondWorkingCopyPath))[0]?.rotation).toBe(90);
    }, E2E_TIMEOUT_MS);
});
