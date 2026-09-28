import {
    copyFileSync, readFileSync, mkdtempSync, rmSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {
    join, resolve,
} from 'node:path';
import {
    afterEach, describe, expect, it,
} from 'vitest';
import {readPdfTextAnnotationRecords} from '@tests/e2e/electron/helpers/fixtures';
import {createCanonicalTextBoxWithPointer} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    openDocumentSidebarTab, waitForPdfLoaded, waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {callWorkspaceCommand} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    startElectronE2ESession, type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    hasWorkspaceCrashCheckpoint, readWorkspaceRecoveryRecords,
} from '@scripts/electron-run/electronRunWorkspaceCheckpoint';
import {stopSingleSession} from '@scripts/electron-run/stopSession';
import {electronUserDataPath} from '@scripts/electron-run/electronRunSessionPaths';

const FIXTURE_PATH = resolve(process.cwd(), 'tests/fixtures/electron/test-scanned.pdf');

describe('checkpointed annotation recovery', () => {
    let session: IElectronE2ESession | null = null;
    let outputDirectory: string | null = null;

    afterEach(async () => {
        await session?.stop();
        session = null;
        if (outputDirectory) rmSync(outputDirectory, {
            recursive: true,
            force: true,
        });
        outputDirectory = null;
    });

    it('restores committed FreeText through restart and Save As', async () => {
        outputDirectory = mkdtempSync(join(tmpdir(), 'evb-annotation-recovery-'));
        const sourcePath = join(outputDirectory, 'annotation-source.pdf');
        const destinationPath = join(outputDirectory, 'annotation-recovered-save-as.pdf');
        copyFileSync(FIXTURE_PATH, sourcePath);
        const sourceBytes = readFileSync(sourcePath);
        const sessionName = `e2e-unsaved-annotation-${Date.now()}`;
        const saveAsEnv = {EVB_E2E_SAVE_DIALOG_PATH: destinationPath};
        session = await startElectronE2ESession(sessionName, {
            clean: true,
            extraEnv: saveAsEnv,
            initialOpenPaths: [sourcePath],
        });
        try {
            await waitForPdfLoaded(session.page, 60_000);
            await waitForViewerInteractive(session.page, 60_000);
            const marker = `Recovered FreeText ${Date.now()}`;
            await createCanonicalTextBoxWithPointer(session.page, marker, {
                x: 0.4,
                y: 0.31,
            });
            await expect.poll(() => {
                if (!hasWorkspaceCrashCheckpoint(session!.name)) return null;
                const entry = readWorkspaceRecoveryRecords(session!.name)[0] as {checkpoint?: {tabs?: Array<{
                    isDirty?: boolean;
                    annotationRecovery?: {artifactId?: string}
                }>}} | undefined;
                const recovery = entry?.checkpoint?.tabs?.[0]?.annotationRecovery;
                if (!entry?.checkpoint?.tabs?.[0]?.isDirty || !recovery?.artifactId) return null;
                const artifactPath = join(electronUserDataPath(session!.name), 'workspace-annotation-recovery', `${recovery.artifactId}.json`);
                const payload = JSON.parse(readFileSync(artifactPath, 'utf8')) as {payload?: {entities?: Array<{text?: string}>}};
                return payload.payload?.entities ?? null;
            }, {timeout: 60_000}).toEqual(expect.arrayContaining([expect.objectContaining({text: marker})]));
            expect(readFileSync(sourcePath)).toEqual(sourceBytes);

            const crashed = session;
            await crashed.browser.disconnect();
            await stopSingleSession(crashed.name, {
                preserveWorkspaceCheckpoint: true,
                crashElectronBeforeStop: true,
            });
            session = await startElectronE2ESession(sessionName, {
                clean: false,
                extraEnv: saveAsEnv,
            });
            await waitForPdfLoaded(session.page, 60_000);
            await waitForViewerInteractive(session.page, 60_000);
            await session.page.waitForFunction((text: string) => Array.from(
                document.querySelectorAll<HTMLElement>('.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"]'),
            ).some(entity => entity.textContent?.trim() === text), {timeout: 60_000}, marker);
            await openDocumentSidebarTab(session.page, 'Annotations', 30_000);
            await session.page.waitForFunction((text: string) => Array.from(
                document.querySelectorAll<HTMLElement>('.editor-pane.is-active .notes-list .note-item'),
            ).some(item => item.textContent?.includes(text)), {timeout: 30_000}, marker);

            await expect(callWorkspaceCommand<boolean>(session.page, 'handleSaveAs')).resolves.toEqual({
                called: true,
                value: true,
            });
            expect(await readPdfTextAnnotationRecords(destinationPath)).toEqual(expect.arrayContaining([expect.objectContaining({contents: marker})]));
            expect(readFileSync(sourcePath)).toEqual(sourceBytes);
        } finally {
            await session.stop();
        }
    }, 240_000);
});
