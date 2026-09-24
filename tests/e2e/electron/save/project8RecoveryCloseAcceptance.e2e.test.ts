import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
    chmodSync,
    createReadStream,
    existsSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {
    readFile, rename, stat, utimes,
} from 'node:fs/promises';
import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {
    createFixturePath,
    createLargeScannedFixturePdf,
    createMultiPageTextFixturePdf,
    readPdfPageSnapshots,
} from '@tests/e2e/electron/helpers/fixtures';
import {createCanonicalTextBoxWithPointer} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {getActiveWorkspaceWorkingCopyPath} from '@tests/e2e/electron/helpers/electronApiHelpers';
import {
    startElectronE2ESession,
    type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    openDocumentSidebarTab,
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
    getWorkspaceToolbarSnapshot,
    readWorkspaceStateValues,
    requireWorkspaceCommand,
    waitForWorkspaceToolbarIdle,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {workspaceCrashCheckpointPath} from '@scripts/electron-run/electronRunWorkspaceCheckpoint';
import {stopSingleSession} from '@scripts/electron-run/stopSession';
import {projectRoot} from '@scripts/electron-run/projectRoot';
import {createE2ERunScopedSessionName} from '@scripts/electron-run/electronRunRunId';
import {getSessionInfo} from '@scripts/electron-run/electronRunSessionArtifacts';
import {isProcessAlive} from '@scripts/electron-run/electronRunProcessTree';
import {runElectronE2ETeardown} from '@tests/e2e/electron/helpers/electronE2ESessionFailure';

const E2E_TIMEOUT_MS = 240_000;

interface IRecoveredSession {
    pdfPath: string;
    workingCopyPath: string;
    session: IElectronE2ESession;
}

interface ICreateRecoveredSessionOptions {replacementSourcePath?: string;}

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

async function createRecoveredSession(
    label: string,
    options: ICreateRecoveredSessionOptions = {},
): Promise<IRecoveredSession> {
    const pdfPath = await createMultiPageTextFixturePdf(`project8-close-${label}-${Date.now()}.pdf`, 2);
    const sessionName = `e2e-project8-close-${label}-${Date.now()}`;
    let session = await startElectronE2ESession(sessionName, {
        clean: true,
        initialOpenPaths: [pdfPath],
    });
    // Callers own the session only after this returns, so a failed setup
    // stops it here.
    try {
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await createCanonicalTextBoxWithPointer(session.page, RECOVERED_ANNOTATION_TEXT, {
            x: 0.4,
            y: 0.3,
        });
        const workingCopyPath = await getActiveWorkspaceWorkingCopyPath(session.page);
        await requireWorkspaceCommand(session.page, 'handleRotateCw', [[1]]);
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
        if (options.replacementSourcePath) {
            await rename(options.replacementSourcePath, pdfPath);
        }
        session = await startElectronE2ESession(sessionName, {clean: false});
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
    } catch (error) {
        await runElectronE2ETeardown(error, [{
            label: `stop session '${session.name}'`,
            run: () => session.stop(),
        }]);
        throw error;
    }
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

async function getFileSha256(filePath: string) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

async function clickActiveTabClose(session: IElectronE2ESession) {
    const target = await session.page.evaluate(() => {
        const activePane = document.querySelector<HTMLElement>('.editor-pane.is-active');
        const activeTab = activePane?.querySelector<HTMLElement>('.tab-list .tab.is-active');
        const button = activeTab?.querySelector<HTMLButtonElement>('.tab-close');
        if (!activeTab || !button) {
            return {
                found: false as const,
                tabs: Array.from(activePane?.querySelectorAll<HTMLElement>('.tab-list .tab') ?? []).map(tab => ({
                    id: tab.dataset.tabId ?? null,
                    active: tab.classList.contains('is-active'),
                    closeLabel: tab.querySelector<HTMLButtonElement>('.tab-close')?.getAttribute('aria-label') ?? null,
                })),
            };
        }
        const bounds = button.getBoundingClientRect();
        return {
            found: true as const,
            disabled: button.disabled,
            label: button.getAttribute('aria-label'),
            x: bounds.left + bounds.width / 2,
            y: bounds.top + bounds.height / 2,
        };
    });
    expect(target.found, `active tab close button should be available: ${JSON.stringify(target)}`).toBe(true);
    if (!target.found) {
        throw new Error(`Active tab close button was not available: ${JSON.stringify(target)}`);
    }
    expect(target.disabled, `active tab close button should be enabled: ${JSON.stringify(target)}`).toBe(false);
    if (target.disabled) {
        throw new Error(`Active tab close button was disabled: ${JSON.stringify(target)}`);
    }
    await session.page.mouse.click(target.x, target.y);
}

async function clickActiveTabCloseIfEnabled(session: IElectronE2ESession) {
    const target = await session.page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>(
            '.editor-pane.is-active .tab-list .tab.is-active .tab-close',
        );
        if (!button || button.disabled) {
            return null;
        }
        const bounds = button.getBoundingClientRect();
        return {
            x: bounds.left + bounds.width / 2,
            y: bounds.top + bounds.height / 2,
        };
    });
    if (target) {
        await session.page.mouse.click(target.x, target.y);
    }
}

async function waitForActiveTabCloseEnabled(session: IElectronE2ESession) {
    await session.page.waitForFunction(() => {
        const button = document.querySelector<HTMLButtonElement>(
            '.editor-pane.is-active .tab-list .tab.is-active .tab-close',
        );
        return Boolean(button && !button.disabled);
    }, {timeout: 30_000});
}

async function clickDirtyTabDecision(session: IElectronE2ESession, labelFragment: string) {
    const rect = await session.page.evaluate((label) => {
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        const button = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])
            .find(candidate => candidate.textContent?.toLowerCase().includes(label.toLowerCase()));
        if (!button || button.disabled) {
            return null;
        }
        const bounds = button.getBoundingClientRect();
        return {
            x: bounds.left + bounds.width / 2,
            y: bounds.top + bounds.height / 2,
        };
    }, labelFragment);
    expect(rect, `dirty-close ${labelFragment} button should be available`).not.toBeNull();
    if (!rect) {
        throw new Error(`Dirty-close ${labelFragment} button was not available`);
    }
    await session.page.mouse.click(rect.x, rect.y);
    await session.page.waitForFunction(() => !document.querySelector('[role="dialog"]'), {timeout: 30_000});
}

async function rotateFirstPageCounterclockwise(session: IElectronE2ESession) {
    await openDocumentSidebarTab(session.page, 'Pages');

    await session.page.waitForFunction(() => {
        const item = document.querySelector<HTMLElement>(
            '.editor-pane.is-active [data-document-thumbnail-item][data-page="1"], '
            + '.editor-pane.is-active [data-document-thumbnail-item][data-thumbnail-page="1"]',
        );
        const bounds = item?.getBoundingClientRect();
        return Boolean(bounds && bounds.width > 0 && bounds.height > 0);
    }, {timeout: 30_000});
    const thumbnail = await session.page.evaluate(() => {
        const item = document.querySelector<HTMLElement>(
            '.editor-pane.is-active [data-document-thumbnail-item][data-page="1"], '
            + '.editor-pane.is-active [data-document-thumbnail-item][data-thumbnail-page="1"]',
        );
        if (!item) {
            return null;
        }
        item.scrollIntoView({block: 'center'});
        const bounds = item.getBoundingClientRect();
        return {
            x: bounds.left + bounds.width / 2,
            y: bounds.top + bounds.height / 2,
        };
    });
    expect(thumbnail, 'first page thumbnail should be visible').not.toBeNull();
    if (!thumbnail) {
        throw new Error('First page thumbnail was not visible');
    }
    await session.page.mouse.click(thumbnail.x, thumbnail.y, {button: 'right'});
    await session.page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .some((item) => {
            const label = item.textContent?.toLowerCase() ?? '';
            return label.includes('rotate counterclockwise') || label.includes('повернуть против часовой');
        }), {timeout: 15_000});
    const menuItem = await session.page.evaluate(() => {
        const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
            .find((candidate) => {
                const label = candidate.textContent?.toLowerCase() ?? '';
                return label.includes('rotate counterclockwise') || label.includes('повернуть против часовой');
            });
        if (!item) {
            return null;
        }
        const bounds = item.getBoundingClientRect();
        return {
            x: bounds.left + bounds.width / 2,
            y: bounds.top + bounds.height / 2,
        };
    });
    expect(menuItem, 'rotate counterclockwise menu item should be visible').not.toBeNull();
    if (!menuItem) {
        throw new Error('Rotate counterclockwise menu item was not visible');
    }
    await session.page.mouse.click(menuItem.x, menuItem.y);
}

const ROTATE_FAILURE_TEXT = 'Failed to rotate pages';
const NATIVE_PDF_PAGE_OPS_PATH = join(
    process.cwd(),
    '.tmp',
    'pdf-page-ops',
    `${process.platform}-${process.arch}`,
    'bin',
    'evb-pdf-page-ops',
);

/**
 * Stands in for the page-ops tool so a rotation stays in its native write
 * while the test holds it: canceling kills the held call, releasing lets it
 * run the real binary. Every other call goes straight to the real binary.
 */
function createHeldPageOpsTool(name: string) {
    const toolPath = createFixturePath(`${name}-page-ops.sh`);
    const armPath = createFixturePath(`${name}-page-ops.arm`);
    const heldPath = createFixturePath(`${name}-page-ops.held`);
    writeFileSync(toolPath, [
        '#!/usr/bin/env bash',
        `if [ "$1" = "save-mutations" ] && [ -e ${JSON.stringify(armPath)} ]; then`,
        `    : > ${JSON.stringify(heldPath)}`,
        `    while [ -e ${JSON.stringify(armPath)} ]; do sleep 0.05; done`,
        'fi',
        `exec ${JSON.stringify(NATIVE_PDF_PAGE_OPS_PATH)} "$@"`,
        '',
    ].join('\n'));
    chmodSync(toolPath, 0o755);
    onTestFinished(() => {
        rmSync(toolPath, {force: true});
        rmSync(armPath, {force: true});
        rmSync(heldPath, {force: true});
    });
    return {
        toolPath,
        hold: () => writeFileSync(armPath, ''),
        waitUntilHeld: () => expect.poll(() => existsSync(heldPath), {timeout: 30_000}).toBe(true),
        release: () => rmSync(armPath, {force: true}),
    };
}

async function clickPageOperationCancel(session: IElectronE2ESession) {
    const button = await session.page.waitForFunction(() => {
        const candidate = Array.from(document.querySelectorAll<HTMLButtonElement>(
            '.workspace-page-op-progress-overlay button',
        )).find(element => element.textContent?.trim() === 'Cancel' && !element.disabled);
        if (!candidate) {
            return null;
        }
        const bounds = candidate.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0
            ? {
                x: bounds.left + bounds.width / 2,
                y: bounds.top + bounds.height / 2,
            }
            : null;
    }, {timeout: 30_000});
    const point = await button.jsonValue();
    if (!point) {
        throw new Error('Page operation Cancel button was not visible');
    }
    await session.page.mouse.click(point.x, point.y);
}

async function startBusyCloseAndWaitForDecision(
    session: IElectronE2ESession,
    heldTool: ReturnType<typeof createHeldPageOpsTool>,
) {
    await waitForActiveTabCloseEnabled(session);
    heldTool.hold();
    await rotateFirstPageCounterclockwise(session);
    await heldTool.waitUntilHeld();
    await expect.poll(async () => (
        await readWorkspaceStateValues<{isPageOperationInProgress?: boolean}>(session.page, ['isPageOperationInProgress'])
    ).isPageOperationInProgress, {timeout: 30_000}).toBe(true);

    const toolbarAtClick = await getWorkspaceToolbarSnapshot(session.page);
    const workspaceStateAtClick = await readWorkspaceStateValues<{
        dirtyState?: {fileDirty?: boolean};
        isPageOperationInProgress?: boolean;
    }>(session.page, [
        'dirtyState',
        'isPageOperationInProgress',
    ]);
    expect(toolbarAtClick).toMatchObject({
        hasPdf: true,
        isPageOperationInProgress: true,
    });
    expect(workspaceStateAtClick).toMatchObject({
        dirtyState: {fileDirty: false},
        isPageOperationInProgress: true,
    });

    await clickActiveTabClose(session);
    // A duplicate close may be unavailable once the close transition commits;
    // if it is still actionable, send a second real click while the request is pending.
    await clickActiveTabCloseIfEnabled(session);

    expect((await getWorkspaceToolbarSnapshot(session.page))?.hasPdf).toBe(true);
    expect(await session.page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const bounds = host?.getBoundingClientRect();
        return Boolean(bounds && bounds.width > 0 && bounds.height > 0);
    })).toBe(true);
    await expect.poll(async () => session!.page.evaluate(() => {
        const bodyText = document.body.innerText;
        return bodyText.includes('Closing after page processing finishes.')
            || bodyText.includes('Закрытие продолжится после завершения обработки страниц.');
    }), {timeout: 2_000}).toBe(true);

    heldTool.release();
    await session.page.waitForFunction(() => {
        const snapshot = window.__evbTestApi?.getActiveToolbarSnapshot?.();
        return Boolean(document.querySelector('[role="dialog"]')) || snapshot?.hasPdf === false;
    }, {timeout: 120_000});
    const dialogCount = await session.page.$$eval('[role="dialog"]', dialogs => dialogs.length);
    expect(dialogCount).toBe(1);
    await expect.poll(async () => session!.page.evaluate(() => {
        const bodyText = document.body.innerText;
        return bodyText.includes('Closing after page processing finishes.')
            || bodyText.includes('Закрытие продолжится после завершения обработки страниц.');
    }), {timeout: 2_000}).toBe(false);
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

    it.skipIf(process.platform === 'win32')('waits for page work before showing the tab decision and only saves after explicit Save', async () => {
        const heldTool = createHeldPageOpsTool(`project8-busy-tab-close-${Date.now()}`);
        const pdfPath = await createLargeScannedFixturePdf(
            `project8-busy-tab-close-${Date.now()}.pdf`,
            882,
            128 * 1024 * 1024,
            1,
            {runOwner: 'w3-busy-close'},
        );
        const originalDigest = await getFileSha256(pdfPath);
        const originalMtime = (await stat(pdfPath)).mtimeMs;
        session = await startElectronE2ESession(`e2e-project8-busy-tab-close-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_PATH: heldTool.toolPath},
        });
        await openPdfInApp(session.page, pdfPath, 60_000);
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);

        await startBusyCloseAndWaitForDecision(session, heldTool);
        await clickDirtyTabDecision(session, 'Cancel');
        const afterCancel = await getWorkspaceToolbarSnapshot(session.page);
        expect(afterCancel).toMatchObject({
            hasPdf: true,
            canSave: true,
        });
        expect((await readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean}}>(session.page, ['dirtyState'])).dirtyState?.fileDirty).toBe(true);
        expect(await getFileSha256(pdfPath)).toBe(originalDigest);
        expect((await stat(pdfPath)).mtimeMs).toBe(originalMtime);

        await clickActiveTabClose(session);
        await session.page.waitForSelector('[role="dialog"]', {
            visible: true,
            timeout: 30_000,
        });
        await clickDirtyTabDecision(session, 'Save');
        await expect.poll(async () => (await getWorkspaceToolbarSnapshot(session!.page))?.hasPdf, {timeout: 30_000}).toBe(false);
        await expect.poll(async () => (await readPdfPageSnapshots(pdfPath))[0]?.rotation, {timeout: 60_000}).toBe(270);
        expect(await getFileSha256(pdfPath)).not.toBe(originalDigest);

        await openPdfInApp(session.page, pdfPath, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        const cleanSnapshot = await getWorkspaceToolbarSnapshot(session.page);
        expect(cleanSnapshot).toMatchObject({
            hasPdf: true,
            canSave: false,
        });
        await clickActiveTabClose(session);
        await expect.poll(async () => (await getWorkspaceToolbarSnapshot(session!.page))?.hasPdf, {timeout: 10_000}).toBe(false);
        expect(await session.page.$$('[role="dialog"]')).toHaveLength(0);
    }, E2E_TIMEOUT_MS);

    it.skipIf(process.platform === 'win32')('cancels a running page operation and leaves the document unchanged', async () => {
        const heldTool = createHeldPageOpsTool(`project8-cancel-page-op-${Date.now()}`);
        const pdfPath = await createMultiPageTextFixturePdf(`project8-cancel-page-op-${Date.now()}.pdf`, 3);
        session = await startElectronE2ESession(`e2e-project8-cancel-page-op-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_PATH: heldTool.toolPath},
        });
        await openPdfInApp(session.page, pdfPath, 60_000);
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        const workingCopyPath = await getActiveWorkspaceWorkingCopyPath(session.page);
        const workingCopyDigest = await getFileSha256(workingCopyPath);

        heldTool.hold();
        await rotateFirstPageCounterclockwise(session);
        await heldTool.waitUntilHeld();
        // A write with no measurable count keeps visibly moving (contract I4).
        await expect.poll(() => session!.page.evaluate(() => (
            document.querySelector('.workspace-page-op-progress-overlay')?.textContent?.replace(/\s+/gu, ' ') ?? ''
        )), {timeout: 5_000}).toMatch(/\d+:\d{2} elapsed/u);
        await clickPageOperationCancel(session);

        await expect.poll(async () => (
            await readWorkspaceStateValues<{isPageOperationInProgress?: boolean}>(session!.page, ['isPageOperationInProgress'])
        ).isPageOperationInProgress, {timeout: 30_000}).toBe(false);
        await expect.poll(() => session!.page.evaluate(() => document.body.innerText), {timeout: 10_000})
            .toContain('Page operation canceled. The document is unchanged.');
        expect(await session.page.evaluate(() => document.body.innerText)).not.toContain(ROTATE_FAILURE_TEXT);
        expect(await getFileSha256(workingCopyPath)).toBe(workingCopyDigest);
        expect((await readPdfPageSnapshots(workingCopyPath))[0]?.rotation).toBe(0);
        expect((await readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean}}>(session.page, ['dirtyState'])).dirtyState?.fileDirty).toBe(false);

        heldTool.release();
        await rotateFirstPageCounterclockwise(session);
        await expect.poll(async () => (
            await readPdfPageSnapshots(workingCopyPath)
        )[0]?.rotation, {timeout: 30_000}).toBe(270);
    }, E2E_TIMEOUT_MS);

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

    it('rejects Save after the source changes while EVB is stopped', async () => {
        const replacementSourcePath = await createMultiPageTextFixturePdf(`project8-close-external-${Date.now()}.pdf`, 2);
        const externalBytes = await readFile(replacementSourcePath);
        const recovered = await createRecoveredSession('external-replacement', {replacementSourcePath});
        session = recovered.session;
        const recoveredWorkingBytes = await readFile(recovered.workingCopyPath);

        await expect(callWorkspaceCommand<boolean>(session.page, 'handleSave')).resolves.toEqual({
            called: true,
            value: false,
        });
        await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: 60_000});
        const state = await readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean}}>(session.page, ['dirtyState']);
        expect(state.dirtyState?.fileDirty).toBe(true);
        await expect(readFile(recovered.pdfPath)).resolves.toEqual(externalBytes);
        await expect(readFile(recovered.workingCopyPath)).resolves.toEqual(recoveredWorkingBytes);
        expect((await readPdfPageSnapshots(recovered.pdfPath))[0]?.rotation).toBe(0);
        expect((await readPdfPageSnapshots(recovered.workingCopyPath))[0]?.rotation).toBe(90);
    }, E2E_TIMEOUT_MS);

    it('Discard closes without committing recovered bytes', async () => {
        const recovered = await createRecoveredSession('discard');
        session = recovered.session;
        await clickWindowDecision(session, 'Discard changes', {waitForClose: true});
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
        const firstRecoverySidecarPaths = [`${firstWorkingCopyPath}.evb-revision.json`];
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

        session = await startElectronE2ESession(sessionName, {clean: false});

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
        session = await startElectronE2ESession(sessionName, {clean: false});
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

    it('keeps dirty checkpoints separate across two windows and a restart', async () => {
        const firstPdfPath = await createMultiPageTextFixturePdf(`project8-owner-a-${Date.now()}.pdf`, 1);
        const secondPdfPath = await createMultiPageTextFixturePdf(`project8-owner-b-${Date.now()}.pdf`, 1);
        const sessionName = `e2e-project8-owner-isolation-${Date.now()}`;
        session = await startElectronE2ESession(sessionName, {
            clean: true,
            initialOpenPaths: [firstPdfPath],
        });
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await expect(callWorkspaceCommand(session.page, 'handleRotateCw', [[1]])).resolves.toMatchObject({called: true});

        await createNewWorkspaceTab(session);
        await openPdfInApp(session.page, secondPdfPath, 60_000);
        await expect(callWorkspaceCommand(session.page, 'handleRotateCw', [[1]])).resolves.toMatchObject({called: true});
        await session.page.click('.tab-list .tab[data-tab-id]:last-child', {button: 'right'});
        await session.page.waitForSelector('.tab-context-menu');
        const movedToNewWindow = await session.page.evaluate(() => {
            const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
                .find(candidate => (candidate.textContent ?? '').toLowerCase().includes('move tab to new window'));
            item?.click();
            return Boolean(item);
        });
        expect(movedToNewWindow, 'move tab to new window menu item').toBe(true);

        const appPages = async () => (await session!.browser.pages()).filter(page => (
            !page.isClosed()
            && (page.url().startsWith('evb-viewer://app/')
                || page.url().includes('localhost:')
                || page.url().includes('127.0.0.1:'))
        ));
        await expect.poll(async () => (await appPages()).length, {timeout: 60_000}).toBe(2);
        const livePages = await appPages();
        await Promise.all(livePages.map(page => waitForViewerInteractive(page, 60_000)));

        const checkpointPath = workspaceCrashCheckpointPath(session.name);
        // Each window debounces its own record, so the journal reaches two
        // records while the source window still lists the moved tab and the new
        // window lists an empty tab. Crash only once each record holds exactly
        // its own dirty document.
        await expect.poll(async () => {
            try {
                const stored = JSON.parse(await readFile(checkpointPath, 'utf8')) as {records?: Array<{checkpoint: {tabs: Array<{
                    sourceRef?: string | null;
                    workingCopyRef?: string | null;
                    isDirty?: boolean;
                }>}}>};
                return (stored.records ?? []).map(record => record.checkpoint.tabs.map(tab => (
                    tab.isDirty && tab.workingCopyRef ? tab.sourceRef : null
                ))).sort((left, right) => String(left).localeCompare(String(right)));
            } catch {
                return [];
            }
        }, {timeout: 60_000}).toEqual([
            [firstPdfPath],
            [secondPdfPath],
        ]);

        await session.browser.disconnect();
        await stopSingleSession(session.name, {
            preserveWorkspaceCheckpoint: true,
            crashElectronBeforeStop: true,
        });
        session = await startElectronE2ESession(sessionName, {clean: false});
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await expect.poll(async () => (await appPages()).length, {timeout: 60_000}).toBe(2);

        const recoveredPages = await appPages();
        await expect.poll(async () => {
            const recoveredFileNames = await Promise.all(recoveredPages.map(page => page.evaluate(() => (
                document.querySelector('.tab-list .tab[data-tab-id]')?.textContent?.trim() ?? ''
            ))));
            return [
                'project8-owner-a-',
                'project8-owner-b-',
            ]
                .every(owner => recoveredFileNames.some(name => name.includes(owner)));
        }, {timeout: 60_000}).toBe(true);
        await expect.poll(async () => {
            const recoveredDirtyStates = await Promise.all(recoveredPages.map(page => (
                readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean}}>(page, ['dirtyState'])
            )));
            return recoveredDirtyStates.every(state => state.dirtyState?.fileDirty === true);
        }, {timeout: 60_000}).toBe(true);
    }, E2E_TIMEOUT_MS);
});

describe('Project 8 session owner lifetime', () => {
    it('stops the session and its Electron when the owning process dies without stopping it', async () => {
        const sessionName = createE2ERunScopedSessionName(`e2e-project8-owner-lost-${Date.now()}`);
        const owner = spawn(process.execPath, [
            '--import',
            'tsx',
            join(projectRoot, 'tests', 'e2e', 'electron', 'helpers', 'holdE2ESessionOwner.ts'),
            sessionName,
        ], {
            cwd: projectRoot,
            stdio: [
                'ignore',
                'pipe',
                'inherit',
            ],
        });
        onTestFinished(async () => {
            owner.kill('SIGKILL');
            await stopSingleSession(sessionName);
        });
        await new Promise<void>((resolve, reject) => {
            let output = '';
            owner.stdout.on('data', (chunk: Buffer) => {
                output += chunk.toString();
                if (/^ready$/mu.test(output)) {
                    resolve();
                }
            });
            owner.once('exit', (code, signal) => reject(new Error(
                `Session owner exited before readiness (code ${String(code)}, signal ${String(signal)})`,
            )));
        });
        const info = getSessionInfo(sessionName);
        const sessionPids = [
            info?.pid,
            info?.electronPid,
        ];
        expect(sessionPids).toEqual([
            expect.any(Number),
            expect.any(Number),
        ]);
        expect(sessionPids.every(pid => isProcessAlive(pid!))).toBe(true);

        // SIGKILL stands in for a cancelled or crashed Vitest worker: the
        // owner gets no chance to stop the session.
        owner.kill('SIGKILL');
        await expect.poll(() => sessionPids.filter(pid => isProcessAlive(pid!)), {timeout: 30_000}).toEqual([]);
        expect(getSessionInfo(sessionName)).toBeNull();
    }, E2E_TIMEOUT_MS);
});
