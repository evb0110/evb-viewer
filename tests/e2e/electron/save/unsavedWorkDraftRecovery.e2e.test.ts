import {
    copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {
    basename, join,
} from 'node:path';
import {
    expect, it,
} from 'vitest';
import {startElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    waitForPdfLoaded, waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {clickAnnotationTool} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
import {getActiveWorkspaceWorkingCopyPath} from '@tests/e2e/electron/helpers/electronApiHelpers';
import {
    createMultiPageTextFixturePdf, readPdfPageSnapshots,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    readWorkspaceStateValues, requireWorkspaceCommand, waitForWorkspaceToolbarIdle,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    hasWorkspaceCrashCheckpoint, readWorkspaceRecoveryRecords,
} from '@scripts/electron-run/electronRunWorkspaceCheckpoint';
import {stopSingleSession} from '@scripts/electron-run/stopSession';
import {electronUserDataPath} from '@scripts/electron-run/electronRunSessionPaths';

interface IPoint {
    readonly x: number;
    readonly y: number;
}

it('restores focused text draft after a crash checkpoint', async () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'evb-draft-recovery-'));
    const sourcePath = join(outputDirectory, 'draft-source.pdf');
    copyFileSync(join(process.cwd(), 'tests/fixtures/electron/test-scanned.pdf'), sourcePath);
    const sessionName = `e2e-unsaved-draft-${Date.now()}`;
    let session = await startElectronE2ESession(sessionName, {
        clean: true,
        initialOpenPaths: [sourcePath],
    });
    try {
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await requireWorkspaceCommand(session.page, 'handleRotateCw', [[1]]);
        await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: 60_000});
        await clickAnnotationTool(session.page, 'Text', 30_000);
        const pointHandle = await session.page.waitForFunction(() => {
            const page = document.querySelector<HTMLElement>('.editor-pane.is-active .page_container[data-page="1"]');
            const layer = page?.querySelector<HTMLElement>('.pdf-annotation-editor-layer');
            const background = layer?.querySelector<HTMLElement>('.pdf-annotation-editor-surface__background');
            const rect = layer?.getBoundingClientRect();
            if (
                !page
                || !page.classList.contains('page_container--rendered')
                || page.dataset.pageLayerReadiness !== 'ready'
                || !layer
                || layer.dataset.pdfAnnotationEditorReady !== 'true'
                || !layer.classList.contains('is-interactive')
                || !background
                || getComputedStyle(background).pointerEvents === 'none'
                || !rect
                || rect.width <= 0
                || rect.height <= 0
            ) return false;
            const x = rect.left + rect.width * 0.42;
            const y = rect.top + rect.height * 0.31;
            if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
            return document.elementFromPoint(x, y) === background
                ? {
                    x,
                    y,
                }
                : false;
        }, {timeout: 30_000});
        const point = await pointHandle.jsonValue() as IPoint;
        await pointHandle.dispose();
        await session.page.mouse.click(point.x, point.y);
        const editor = '.editor-pane.is-active .pdf-annotation-editor-text-box.is-editing [contenteditable="true"]';
        try {
            await session.page.waitForFunction((selector: string) => document.activeElement === document.querySelector(selector), {timeout: 30_000}, editor);
        } catch (error) {
            const visibleState = await session.page.evaluate(() => ({
                activeElement: document.activeElement?.tagName ?? null,
                editingEditorVisible: Boolean(document.querySelector('.pdf-annotation-editor-text-box.is-editing [contenteditable="true"]')),
                activeTool: document.querySelector('.editor-pane.is-active .notes-panel .tool-button.is-active')?.getAttribute('data-tool') ?? null,
                visiblePageText: document.querySelector<HTMLElement>('.editor-pane.is-active .page_container[data-page="1"]')?.innerText.slice(0, 240) ?? null,
            }));
            await session.page.screenshot({
                path: join(process.cwd(), '.devkit/project12/872/focus-timeout.png'),
                fullPage: true,
            });
            throw new Error(`${String(error)}; visible UI state: ${JSON.stringify(visibleState)}`);
        }
        const draftText = `Focused draft ${Date.now()}`;
        await session.page.keyboard.type(draftText, {delay: 10});
        await session.page.waitForFunction((text: string) => document.querySelector('.pdf-annotation-editor-text-box.is-editing [contenteditable="true"]')?.textContent === text, {timeout: 30_000}, draftText);
        const workingCopyPath = await getActiveWorkspaceWorkingCopyPath(session.page);
        await expect.poll(() => {
            if (!hasWorkspaceCrashCheckpoint(session.name)) return null;
            const checkpoint = readWorkspaceRecoveryRecords(session.name)[0] as {checkpoint?: {tabs?: Array<{
                isDirty?: boolean;
                annotationRecovery?: {artifactId?: string}
            }>} } | undefined;
            const tab = checkpoint?.checkpoint?.tabs?.[0];
            if (!tab?.isDirty || !tab.annotationRecovery?.artifactId) return null;
            const artifactPath = join(electronUserDataPath(session.name), 'workspace-annotation-recovery', `${tab.annotationRecovery.artifactId}.json`);
            const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as {payload?: {drafts?: Array<{text?: string}>}};
            return artifact.payload?.drafts ?? null;
        }, {timeout: 60_000}).toEqual(expect.arrayContaining([expect.objectContaining({text: draftText})]));

        const crashed = session;
        await crashed.browser.disconnect();
        await stopSingleSession(crashed.name, {
            preserveWorkspaceCheckpoint: true,
            crashElectronBeforeStop: true,
        });
        session = await startElectronE2ESession(sessionName, {clean: false});
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await session.page.waitForFunction((text: string) => Array.from(document.querySelectorAll<HTMLElement>('.pdf-annotation-editor-text-box.is-editing [contenteditable="true"]')).some(editor => editor.textContent === text), {timeout: 60_000}, draftText);
        const state = await readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean}}>(session.page, ['dirtyState']);
        expect(state.dirtyState?.fileDirty).toBe(true);
        expect(workingCopyPath).toBeTruthy();
    } finally {
        await session.stop();
        rmSync(outputDirectory, {
            recursive: true,
            force: true,
        });
    }
});

it('keeps an unsaved page edit through a crash and a reboot that empties the temp folder', async () => {
    const sourcePath = await createMultiPageTextFixturePdf(`reboot-recovery-${Date.now()}.pdf`, 2);
    const rebootTempDir = mkdtempSync(join(tmpdir(), 'evb-reboot-tmp-'));
    const extraEnv = {
        TMPDIR: rebootTempDir,
        TMP: rebootTempDir,
        TEMP: rebootTempDir,
    };
    const sessionName = `e2e-reboot-recovery-${Date.now()}`;
    let session = await startElectronE2ESession(sessionName, {
        clean: true,
        extraEnv,
        initialOpenPaths: [sourcePath],
    });
    try {
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await requireWorkspaceCommand(session.page, 'handleRotateCw', [[1]]);
        await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: 60_000});
        await expect.poll(() => {
            if (!hasWorkspaceCrashCheckpoint(session.name)) return null;
            const record = readWorkspaceRecoveryRecords(session.name)[0] as {checkpoint?: {tabs?: Array<{isDirty?: boolean}>}} | undefined;
            return record?.checkpoint?.tabs?.[0]?.isDirty ?? null;
        }, {timeout: 60_000}).toBe(true);

        const crashed = session;
        await crashed.browser.disconnect();
        await stopSingleSession(crashed.name, {
            preserveWorkspaceCheckpoint: true,
            crashElectronBeforeStop: true,
        });
        // Empty this session's OS temp folder, preserving its durable app state
        // and every other session's scratch.
        for (const entry of readdirSync(rebootTempDir)) {
            rmSync(join(rebootTempDir, entry), {
                recursive: true,
                force: true,
            });
        }
        session = await startElectronE2ESession(sessionName, {
            clean: false,
            extraEnv,
        });
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);

        await session.page.waitForFunction(() => {
            const rect = document.querySelector('.editor-pane.is-active .page_container[data-page="1"]')?.getBoundingClientRect();
            return Boolean(rect && rect.width > rect.height);
        }, {timeout: 60_000});
        const state = await readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean}}>(session.page, ['dirtyState']);
        expect(state.dirtyState?.fileDirty).toBe(true);
        expect((await readPdfPageSnapshots(await getActiveWorkspaceWorkingCopyPath(session.page)))[0]?.rotation).toBe(90);
        expect((await readPdfPageSnapshots(sourcePath))[0]?.rotation).toBe(0);
    } finally {
        await session.stop();
        rmSync(sourcePath, {force: true});
        rmSync(rebootTempDir, {
            recursive: true,
            force: true,
        });
    }
});

it('keeps a restored tab\'s unsaved changes for a later start when its working copy is missing', async () => {
    const sourcePath = await createMultiPageTextFixturePdf(`lost-working-copy-${Date.now()}.pdf`, 2);
    const fileName = basename(sourcePath);
    const sessionName = `e2e-lost-working-copy-${Date.now()}`;
    const firstPageIsLandscape = () => {
        const rect = document.querySelector('.editor-pane.is-active .page_container[data-page="1"]')?.getBoundingClientRect();
        return rect ? rect.width > rect.height : null;
    };
    let session = await startElectronE2ESession(sessionName, {
        clean: true,
        initialOpenPaths: [sourcePath],
    });
    try {
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await requireWorkspaceCommand(session.page, 'handleRotateCw', [[1]]);
        await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: 60_000});
        const workingCopyPath = await getActiveWorkspaceWorkingCopyPath(session.page);
        const readStoredTab = () => {
            if (!hasWorkspaceCrashCheckpoint(session.name)) return null;
            const record = readWorkspaceRecoveryRecords(session.name)[0] as {checkpoint?: {tabs?: Array<{
                isDirty?: boolean;
                workingCopyRef?: string | null;
            }>}} | undefined;
            return record?.checkpoint?.tabs?.[0] ?? null;
        };
        await expect.poll(readStoredTab, {timeout: 60_000}).toMatchObject({
            isDirty: true,
            workingCopyRef: workingCopyPath,
        });
        // Moves the working copy while the app is down.
        const awayPath = `${workingCopyPath}.away`;
        const crashAndRestart = async (from: string, to: string) => {
            await session.browser.disconnect();
            await stopSingleSession(session.name, {
                preserveWorkspaceCheckpoint: true,
                crashElectronBeforeStop: true,
            });
            renameSync(from, to);
            session = await startElectronE2ESession(sessionName, {clean: false});
            await waitForPdfLoaded(session.page, 60_000);
            await waitForViewerInteractive(session.page, 60_000);
        };

        // The checkpoint came along and its working copy did not, as on a
        // roaming profile opened on another computer.
        await crashAndRestart(workingCopyPath, awayPath);

        const note = await session.page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>('li, [role="status"], [role="alert"]'))
            .map(element => element.innerText)
            .find(text => text.includes('Unsaved changes not found')) ?? false, {timeout: 60_000});
        expect(await note.jsonValue()).toContain(`The unsaved changes to ${fileName} are in a working copy that is missing on this computer, so the document opened as last saved. They are kept for a later start that finds the working copy.`);
        await expect.poll(() => session.page.evaluate(firstPageIsLandscape), {timeout: 60_000}).toBe(false);
        // Saving the document as it shows would drop those changes, so Save refuses and the tab stays changed.
        await clickAsUser(session.page, 'button.save-split-primary');
        await session.page.waitForFunction(() => document.body.innerText.includes('these changes cannot be saved'), {timeout: 60_000});
        await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: 60_000});
        expect((await readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean}}>(session.page, ['dirtyState'])).dirtyState?.fileDirty).toBe(true);
        expect(existsSync(workingCopyPath)).toBe(false);
        await expect.poll(readStoredTab, {timeout: 60_000}).toMatchObject({
            isDirty: true,
            workingCopyRef: workingCopyPath,
        });

        await crashAndRestart(awayPath, workingCopyPath);
        await expect.poll(() => session.page.evaluate(firstPageIsLandscape), {timeout: 60_000}).toBe(true);
        expect((await readPdfPageSnapshots(sourcePath))[0]?.rotation).toBe(0);
    } finally {
        await session.stop();
        rmSync(sourcePath, {force: true});
    }
});
