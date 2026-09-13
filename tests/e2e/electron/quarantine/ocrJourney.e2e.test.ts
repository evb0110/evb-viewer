import {
    describe,
    expect,
    it,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {createScannedTextFixturePdf} from '@tests/e2e/electron/helpers/fixtures';
import {
    assertOcrPdfSemanticOutput,
    consumeOcrResultIntoActiveWorkspace,
    getActiveWorkspaceWorkingCopyPath,
    runOcrSearchablePdf,
} from '@tests/e2e/electron/helpers/electronApiHelpers';
import {
    openPdfInApp,
    saveViaWindowHandle,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {evaluateInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {readWorkspaceStateValues} from '@tests/e2e/electron/helpers/workspaceExpose';

interface IPlaceholderProbeWindow extends Window {__evbOcrPlaceholderInsertions?: number;}

const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-ocr-journey-${Date.now()}`});

describe('nightly OCR journey', () => {
    it('recognizes, applies, reloads, and saves a scanned page through the real Electron API', async () => {
        const session = sessionFixture.getSession();
        expect(session).toBeTruthy();
        if (!session) {
            return;
        }

        const expectedText = 'EVB NIGHTLY OCR JOURNEY';
        const sourcePath = await createScannedTextFixturePdf(
            'ocr-journey-scanned.pdf',
            expectedText,
        );
        await openPdfInApp(session.page, sourcePath, 90_000);
        await waitForPdfLoaded(session.page, 90_000);
        await waitForViewerInteractive(session.page, 90_000);
        const workingCopyPath = await getActiveWorkspaceWorkingCopyPath(session.page);
        const requestId = `ocr-e2e-${Date.now()}`;
        const result = await runOcrSearchablePdf(
            session.page,
            workingCopyPath,
            requestId,
            expectedText,
        );

        expect(result).toMatchObject({
            started: true,
            success: true,
        });
        expect(result.progressEventCount).toBeGreaterThan(0);
        expect(result.pdfPath).toBeTruthy();
        expect(result.sourceDocumentRevisionToken).toBeTruthy();
        expect(result.recognizedText).toContain(expectedText);
        // Applying the result reloads the working copy in place. If the host
        // shows the Recent placeholder during that reload, the toolbar and the
        // OCR popup remount and the popup reopens on the already OCR-ed page.
        await evaluateInPage(session.page, () => {
            const probeWindow = window as IPlaceholderProbeWindow;
            probeWindow.__evbOcrPlaceholderInsertions = 0;
            new MutationObserver((records) => {
                for (const record of records) {
                    for (const node of record.addedNodes) {
                        if (node instanceof Element && (
                            node.matches('.workspace-host__placeholder')
                            || node.querySelector('.workspace-host__placeholder') !== null
                        )) {
                            probeWindow.__evbOcrPlaceholderInsertions! += 1;
                        }
                    }
                }
            }).observe(document.body, {
                childList: true,
                subtree: true,
            });
        });
        const applied = await consumeOcrResultIntoActiveWorkspace(
            session.page,
            requestId,
            result.pdfPath!,
            result.sourceDocumentRevisionToken!,
        );
        await waitForPdfLoaded(session.page, 90_000);
        await waitForViewerInteractive(session.page, 90_000);
        expect(await assertOcrPdfSemanticOutput(workingCopyPath, expectedText)).toContain(expectedText);

        // The renderer only learns about the OCR revision through the
        // revision-changed event. A stale token here is what turned the next
        // save into "Не удалось записать документ".
        const {documentIdentity} = await readWorkspaceStateValues<{documentIdentity: {token: string} | null}>(
            session.page,
            ['documentIdentity'],
        );
        expect(documentIdentity?.token).toBe(applied.workingCopyRevisionToken);
        expect(await evaluateInPage(
            session.page,
            () => (window as IPlaceholderProbeWindow).__evbOcrPlaceholderInsertions,
        )).toBe(0);

        await saveViaWindowHandle(session.page, 90_000);
    }, 240_000);
});
