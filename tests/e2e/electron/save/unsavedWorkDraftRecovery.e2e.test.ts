import {
    copyFileSync, existsSync, mkdirSync, readFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {
    expect, it,
} from 'vitest';
import {startElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    waitForPdfLoaded, waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {clickAnnotationTool} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {getActiveWorkspaceWorkingCopyPath} from '@tests/e2e/electron/helpers/electronApiHelpers';
import {
    readWorkspaceStateValues, requireWorkspaceCommand, waitForWorkspaceToolbarIdle,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    hasWorkspaceCrashCheckpoint, readWorkspaceRecoveryRecords,
} from '@scripts/electron-run/electronRunWorkspaceCheckpoint';
import {stopSingleSession} from '@scripts/electron-run/stopSession';
import {
    electronUserDataPath, sessionDir,
} from '@scripts/electron-run/electronRunSessionPaths';

it('restores focused text draft after a crash checkpoint', async () => {
    const sourcePath = `${process.cwd()}/.devkit/project12/872/draft-source.pdf`;
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
        const point = await session.page.evaluate(() => {
            const layer = document.querySelector<HTMLElement>('.editor-pane.is-active .page_container[data-page="1"] .pdf-annotation-editor-layer');
            const rect = layer?.getBoundingClientRect();
            return rect ? {
                x: rect.left + rect.width * 0.42,
                y: rect.top + rect.height * 0.31,
            } : null;
        });
        expect(point).toBeTruthy();
        if (!point) throw new Error('Text placement point missing');
        await session.page.mouse.click(point.x, point.y);
        const editor = '.editor-pane.is-active .pdf-annotation-editor-text-box.is-editing [contenteditable="true"]';
        await session.page.waitForFunction((selector: string) => document.activeElement === document.querySelector(selector), {timeout: 30_000}, editor);
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
        const logPath = join(sessionDir(session.name), 'session.log');
        if (existsSync(logPath)) {
            const evidenceDirectory = join(process.cwd(), '.devkit/project12/872');
            mkdirSync(evidenceDirectory, {recursive: true});
            copyFileSync(logPath, join(evidenceDirectory, 'session.log'));
        }
        await session.stop();
    }
});
