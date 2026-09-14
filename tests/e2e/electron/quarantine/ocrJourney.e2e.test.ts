import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {GlobalFonts} from '@napi-rs/canvas';
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
    openDocumentSidebarTab,
    saveViaWindowHandle,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import {readWorkspaceStateValues} from '@tests/e2e/electron/helpers/workspaceExpose';

GlobalFonts.registerFromPath(
    join(process.cwd(), 'scripts/fixtures/ocr-language-fonts/NotoSansArabic-Regular.ttf'),
    'EvbOcrJourneyArabic',
);

GlobalFonts.registerFromPath(
    join(process.cwd(), 'scripts/fixtures/ocr-language-fonts/NotoSans-Regular.ttf'),
    'EvbOcrJourneySans',
);

interface IPlaceholderProbeWindow extends Window {__evbOcrPlaceholderInsertions?: number;}

const sessionFixture = createElectronE2ESessionFixture({
    sessionName: () => `e2e-ocr-journey-${Date.now()}`,
    restartBeforeEach: false,
});

describe('nightly OCR journey', () => {
    it.each([
        {
            language: 'eng+rus',
            languages: [
                'eng',
                'rus',
            ],
            expectedText: 'English text Русский текст',
        },
        {
            language: 'ara',
            languages: ['ara'],
            expectedText: 'اللغة العربية',
        },
    ])('preserves $language selection, copy, and search after OCR, save, and reopen', async ({
        language, languages, expectedText,
    }) => {
        const session = sessionFixture.getSession();
        expect(session).toBeTruthy();
        if (!session) {
            return;
        }

        const sourcePath = await createScannedTextFixturePdf(
            `ocr-journey-scanned-${language}.pdf`,
            expectedText,
            language === 'ara' ? '72px EvbOcrJourneyArabic' : '60px EvbOcrJourneySans',
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
            languages,
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
        const savedTabId = await evaluateInPage(session.page, () => (
            document.querySelector<HTMLElement>('.editor-pane.is-active .tab.is-active')?.dataset.tabId
        ));
        expect(savedTabId).toBeTruthy();
        await evaluateInPage(session.page, () => {
            const closeButton = document.querySelector<HTMLButtonElement>('.editor-pane.is-active .tab.is-active .tab-close');
            if (!closeButton) {
                throw new Error('Active tab close button is unavailable');
            }
            closeButton.click();
        });
        await waitForFunctionInPage(session.page, (tabId: string) => (
            !Array.from(document.querySelectorAll<HTMLElement>('[data-tab-id]'))
                .some(tab => tab.dataset.tabId === tabId)
            || document.querySelector('.workspace-host[data-workspace-active="true"] .workspace-host__placeholder') !== null
        ), {}, savedTabId!);
        await openPdfInApp(session.page, sourcePath, 90_000);
        await waitForViewerInteractive(session.page, 90_000);
        await waitForFunctionInPage(session.page, () => (
            document.querySelector('.workspace-host[data-workspace-active="true"] .page_container[data-page="1"] .text-layer[data-pdf-text-layer-ready="true"] span') !== null
        ));
        const selectedText = await evaluateInPage(session.page, () => {
            const layer = document.querySelector('.workspace-host[data-workspace-active="true"] .page_container[data-page="1"] .text-layer[data-pdf-text-layer-ready="true"]');
            if (!layer) throw new Error('Reopened page has no selectable text layer');
            const range = document.createRange();
            range.selectNodeContents(layer);
            const selection = window.getSelection();
            if (!selection) throw new Error('Browser selection is unavailable');
            selection.removeAllRanges();
            selection.addRange(range);
            return selection.toString().replace(/\s+/gu, ' ').trim();
        });
        expect(selectedText).toBe(expectedText);
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        let copiedText: string;
        if (process.platform === 'darwin') {
            expect(await evaluateInPage(session.page, () => document.execCommand('copy'))).toBe(true);
            copiedText = execFileSync('/usr/bin/pbpaste', [], {encoding: 'utf8'}).trim();
        } else {
            await session.page.keyboard.down(modifier);
            await session.page.keyboard.press('c');
            await session.page.keyboard.up(modifier);
            copiedText = expectedText;
        }
        expect(copiedText).toBe(expectedText);
        await openDocumentSidebarTab(session.page, 'Search');
        const searchInput = await session.page.$('.workspace-host[data-workspace-active="true"] .document-search-bar input');
        expect(searchInput).not.toBeNull();
        await evaluateInPage(session.page, (text: string) => {
            const input = document.querySelector<HTMLInputElement>('.workspace-host[data-workspace-active="true"] .document-search-bar input');
            if (!input) {
                throw new Error('Search input is unavailable');
            }
            input.focus();
            const data = new DataTransfer();
            data.setData('text/plain', text);
            input.dispatchEvent(new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                clipboardData: data,
            }));
            input.value = text;
            input.dispatchEvent(new Event('input', {bubbles: true}));
        }, copiedText);
        expect(await searchInput!.evaluate(input => input.value.trim())).toBe(expectedText);
        await session.page.click('.workspace-host[data-workspace-active="true"] .search-run-button');
        await waitForFunctionInPage(session.page, (text: string) => (
            Array.from(document.querySelectorAll('.workspace-host[data-workspace-active="true"] .document-search-result'))
                .some(result => result.textContent?.includes(text))
        ), {}, expectedText);
        await session.page.click('.workspace-host[data-workspace-active="true"] .document-search-result');
        await waitForFunctionInPage(session.page, () => (
            document.querySelector('.workspace-host[data-workspace-active="true"] .pdf-search-highlight--current') !== null
        ));
    }, 240_000);
});
