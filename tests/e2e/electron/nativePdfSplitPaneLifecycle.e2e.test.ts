import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    resolveNativeLargePdfFixtureAvailability,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type {IElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {getActiveWorkspaceWorkingCopyPath} from '@tests/e2e/electron/helpers/electronApiHelpers';
import {
    openNativePdfPreviewInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {splitActiveWorkspaceDocument} from '@tests/e2e/electron/helpers/workspaceTabs';
import {getWorkspaceToolbarSnapshot} from '@tests/e2e/electron/helpers/workspaceExpose';

const LIFECYCLE_TIMEOUT_MS = 360_000;
const SOURCE_PANE_COUNT = 4;
const sourceFixture = resolveNativeLargePdfFixtureAvailability(2);
const lifecycleDescribe = selectFixtureDescribe(describe, sourceFixture);

async function waitForActivePdfReady(session: IElectronE2ESession) {
    await waitForPdfLoaded(session.page, LIFECYCLE_TIMEOUT_MS);
    await waitForViewerInteractive(session.page, LIFECYCLE_TIMEOUT_MS);
}

async function activatePane(session: IElectronE2ESession, paneId: string) {
    await session.page.evaluate((targetPaneId: string) => {
        document.querySelector<HTMLElement>(
            `.editor-pane[data-editor-pane-id="${CSS.escape(targetPaneId)}"]`,
        )?.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
    }, paneId);
    await session.page.waitForFunction((targetPaneId: string) => (
        document.querySelector<HTMLElement>('.editor-pane.is-active')?.dataset.editorPaneId === targetPaneId
    ), {timeout: 30_000}, paneId);
}

lifecycleDescribe('Electron E2E - Large PDF split-pane lifecycle', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-native-pdf-split-lifecycle-${Date.now()}`,
        timeoutMs: LIFECYCLE_TIMEOUT_MS,
    });

    it('keeps same-path panes independent after the native opening preview hands off to PDF.js', async () => {
        const session = sessionFixture.getSession();
        if (!sourceFixture.path) {
            throw new Error(`Large PDF split-pane fixture unavailable: ${sourceFixture.reason}`);
        }

        await session.page.setViewport({
            deviceScaleFactor: 2,
            height: 1_200,
            width: 4_000,
        });
        await openNativePdfPreviewInApp(session.page, sourceFixture.path, LIFECYCLE_TIMEOUT_MS);
        await waitForActivePdfReady(session);

        for (let paneIndex = 1; paneIndex < SOURCE_PANE_COUNT; paneIndex += 1) {
            await splitActiveWorkspaceDocument(session, 'right');
            await openNativePdfPreviewInApp(session.page, sourceFixture.path, LIFECYCLE_TIMEOUT_MS);
            await waitForActivePdfReady(session);
        }

        const paneIds = await session.page.$$eval(
            '.editor-pane',
            panes => panes.map(pane => (pane as HTMLElement).dataset.editorPaneId ?? ''),
        );
        expect(paneIds).toHaveLength(SOURCE_PANE_COUNT);
        expect(paneIds.every(Boolean)).toBe(true);

        const workingCopyPaths: string[] = [];
        for (const paneId of paneIds) {
            await activatePane(session, paneId);
            await waitForActivePdfReady(session);
            workingCopyPaths.push(await getActiveWorkspaceWorkingCopyPath(session.page));
            expect(await getWorkspaceToolbarSnapshot(session.page)).toMatchObject({
                currentPage: 1,
                totalPages: 2,
            });
        }
        expect(new Set(workingCopyPaths).size).toBe(SOURCE_PANE_COUNT);

        for (const paneId of paneIds) {
            await activatePane(session, paneId);
            await waitForActivePdfReady(session);
            expect(await getWorkspaceToolbarSnapshot(session.page)).toMatchObject({
                currentPage: 1,
                totalPages: 2,
            });
        }
    }, LIFECYCLE_TIMEOUT_MS);
});
