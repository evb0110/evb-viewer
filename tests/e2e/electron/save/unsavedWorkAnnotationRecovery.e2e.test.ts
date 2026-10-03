import {
    copyFileSync, readFileSync, mkdtempSync, rmSync,
} from 'node:fs';
import { clickFoundAsUser } from '@tests/e2e/electron/helpers/userInput';
import {tmpdir} from 'node:os';
import {
    basename, join, resolve,
} from 'node:path';
import {
    afterEach, describe, expect, it,
} from 'vitest';
import {
    createMultiPageTextFixturePdf, readPdfTextAnnotationRecords,
} from '@tests/e2e/electron/helpers/fixtures';
import {createCanonicalTextBoxWithPointer} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    openDocumentSidebarTab, waitForActiveDocumentSource, waitForPdfLoaded, waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    activatePaneByTab, splitActiveTabFromTabMenu,
} from '@tests/e2e/electron/helpers/workspaceTabs';
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

    it('recovers a split PDF as one document when its first view is hidden', async () => {
        const stamp = Date.now();
        const sharedPath = await createMultiPageTextFixturePdf(`recovery-split-shared-${stamp}.pdf`, 3);
        const otherPath = await createMultiPageTextFixturePdf(`recovery-split-other-${stamp}.pdf`, 2);
        const sessionName = `e2e-recovery-split-hidden-${stamp}`;
        session = await startElectronE2ESession(sessionName, {
            clean: true,
            initialOpenPaths: [
                sharedPath,
                otherPath,
            ],
        });
        // The tab menu is still animating closed right after a split; a person
        // clicks the tab once nothing covers it.
        const clickTab = (paneSelector: string, fileName: string) => clickFoundAsUser(session!.page, (query: {
            selector: string;
            name: string;
        }) => Array.from(document.querySelectorAll<HTMLElement>(`${query.selector} .tab[data-tab-id]`))
            .find(candidate => candidate.querySelector('.tab-label')?.textContent?.includes(query.name)), {
            selector: paneSelector,
            name: fileName,
        }, {description: `${fileName} tab in ${paneSelector}`});
        const paneIds = () => session!.page.$$eval('.editor-pane', panes => panes.map(pane => (pane as HTMLElement).dataset.editorPaneId ?? ''));
        try {
            await waitForPdfLoaded(session.page, 60_000);
            // Split the shared PDF, then show the other PDF where it was: the
            // first view of the split is now a hidden tab.
            await clickTab('.editor-pane', basename(sharedPath));
            await waitForActiveDocumentSource(session.page, sharedPath, 60_000);
            await waitForViewerInteractive(session.page, 60_000);
            await splitActiveTabFromTabMenu(session.page, 'right');
            const [leftPane] = await paneIds();
            await clickTab(`.editor-pane[data-editor-pane-id="${leftPane}"]`, basename(otherPath));
            await waitForActiveDocumentSource(session.page, otherPath, 60_000);
            await expect.poll(() => {
                const tabs = (readWorkspaceRecoveryRecords(session!.name)[0] as {checkpoint?: {tabs?: Array<{
                    workingCopyRef?: string | null;
                    fileName?: string | null
                }>}} | undefined)?.checkpoint?.tabs ?? [];
                const shared = tabs.filter(tab => tab.fileName === basename(sharedPath));
                return shared.length === 2 && shared[0]?.workingCopyRef && shared[0].workingCopyRef === shared[1]?.workingCopyRef;
            }, {timeout: 60_000}).toBeTruthy();

            const crashed = session;
            await crashed.browser.disconnect();
            await stopSingleSession(crashed.name, {
                preserveWorkspaceCheckpoint: true,
                crashElectronBeforeStop: true,
            });
            // The crashed session is stopped; a failed restart must not stop it again.
            session = null;
            session = await startElectronE2ESession(sessionName, {clean: false});
            await waitForPdfLoaded(session.page, 60_000);

            // An edit through the shown view of the split reaches its hidden view.
            const [
                restoredLeft,
                restoredRight,
            ] = await paneIds();
            await activatePaneByTab(session.page, restoredRight!);
            await waitForActiveDocumentSource(session.page, sharedPath, 60_000);
            await waitForViewerInteractive(session.page, 60_000);
            const marker = `Split recovery ${stamp}`;
            await createCanonicalTextBoxWithPointer(session.page, marker, {
                x: 0.4,
                y: 0.3,
            });
            await clickTab(`.editor-pane[data-editor-pane-id="${restoredLeft}"]`, basename(sharedPath));
            await session.page.waitForFunction((pane: string, text: string) => {
                const root = document.querySelector(`.editor-pane[data-editor-pane-id="${pane}"]`);
                return Boolean(root?.querySelector('.tab.is-active.is-dirty'))
                    && Array.from(root?.querySelectorAll('.pdf-annotation-editor-layer [data-annotation-kind="text-box"]') ?? [])
                        .some(entity => entity.textContent?.trim() === text);
            }, {timeout: 60_000}, restoredLeft!, marker);
        } finally {
            await session?.stop();
            session = null;
        }
    }, 360_000);
});
