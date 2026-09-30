import {join} from 'node:path';
import {
    stat, writeFile,
} from 'node:fs/promises';
import {
    GlobalFonts, createCanvas,
} from '@napi-rs/canvas';
import {PDFDocument} from 'pdf-lib';
import type {
    ElementHandle,
    Page,
} from 'puppeteer-core';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IOcrCompleteResult} from '@contracts/electronApiOcr';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    createFixturePath,
    createScannedTextFixturePdf,
} from '@tests/e2e/electron/helpers/fixtures';
import {assertOcrPdfSemanticOutput} from '@tests/e2e/electron/helpers/electronApiHelpers';
import {
    openDocumentSidebarTab,
    openPdfInApp,
    saveViaVisibleToolbar,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {callWorkspaceCommand} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    activatePaneByTab,
    splitActiveTabFromTabMenu,
} from '@tests/e2e/electron/helpers/workspaceTabs';

GlobalFonts.registerFromPath(
    join(process.cwd(), 'scripts/fixtures/ocr-language-fonts/NotoSans-Regular.ttf'),
    'EvbOcrJourneySans',
);

const SCANNED_TEXT = 'Harbor lantern signal';
const SEARCHED_WORD = 'lantern';
const LATE_RESULT_TEXT = 'Copper weather beacon';
const LATE_RESULT_WORD = 'beacon';
const OCR_TIMEOUT_MS = 180_000;
const ACTIVE_HOST = '.workspace-host[data-workspace-active="true"]';

interface ILateOcrCompletionControl {
    result: IOcrCompleteResult | null;
    cancelClicked: boolean;
    restore: () => void;
}

type TOcrControlWindow = Window & {__lateOcrCompletionControl?: ILateOcrCompletionControl};

const sessionFixture = createElectronE2ESessionFixture({
    sessionName: () => `e2e-ocr-journey-${Date.now()}`,
    restartBeforeEach: false,
});

/** Clicks, with real pointer input, the visible enabled button whose label or text is `name`. */
async function clickVisibleButton(page: Page, scope: string, name: string, timeoutMs = 30_000) {
    const handle = await page.waitForFunction((selector: string, label: string) => (
        Array.from(document.querySelectorAll<HTMLButtonElement>(`${selector} button`)).find(button => (
            (button.getAttribute('aria-label') ?? button.textContent ?? '').trim() === label
            && !button.disabled
            && button.checkVisibility()
        ))
    ), {timeout: timeoutMs}, scope, name);
    await (handle.asElement() as ElementHandle<HTMLButtonElement>).click();
}

async function waitForTextLayerWord(page: Page) {
    await waitForFunctionInPage(page, (host: string, word: string) => (
        document.querySelector(`${host} .page_container[data-page="1"] .text-layer[data-pdf-text-layer-ready="true"]`)
            ?.textContent?.toLocaleLowerCase().includes(word) === true
    ), {timeout: 30_000}, ACTIVE_HOST, SEARCHED_WORD);
}

/** A scanned document long enough that its OCR run is still going when the user moves on. */
async function createScannedPagesFixturePdf(filename: string, pageCount: number) {
    const doc = await PDFDocument.create();
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const canvas = createCanvas(1224, 1584);
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#111111';
        context.font = '40px EvbOcrJourneySans';
        for (let line = 0; line < 24; line += 1) {
            context.fillText(`${SCANNED_TEXT} page ${pageNumber} line ${line + 1}`, 90, 140 + line * 56);
        }
        const image = await doc.embedPng(canvas.toBuffer('image/png'));
        doc.addPage([
            612,
            792,
        ]).drawImage(image, {
            x: 0,
            y: 0,
            width: 612,
            height: 792,
        });
    }
    const filePath = createFixturePath(filename);
    await writeFile(filePath, await doc.save());
    return filePath;
}

async function installLateOcrCompletionControl(page: Page) {
    await page.evaluate(() => {
        const testWindow = window as TOcrControlWindow;
        const ocr = window.electronAPI?.ocr;
        if (!ocr) {
            throw new Error('OCR capability unavailable in the renderer');
        }
        let stopObserving = () => {};
        const control: ILateOcrCompletionControl = {
            result: null,
            cancelClicked: false,
            restore() {
                stopObserving();
                delete testWindow.__lateOcrCompletionControl;
            },
        };
        stopObserving = ocr.onComplete((result) => {
            if (result.success && result.requiresCleanupAck === true && result.pdfPath) {
                control.result = result;
                const cancelButton = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
                    .find(button => (
                        (button.getAttribute('aria-label') ?? button.textContent ?? '').trim() === 'Cancel OCR'
                        && !button.disabled
                        && button.checkVisibility()
                    ));
                if (cancelButton) {
                    control.cancelClicked = true;
                    cancelButton.click();
                }
            }
        });
        testWindow.__lateOcrCompletionControl = control;
    });
}

describe('Electron E2E - OCR journey', () => {
    it('makes a scanned page searchable, saves it, and finds a recognized word after reopening', async () => {
        const session = sessionFixture.getSession();
        const {page} = session;
        const sourcePath = await createScannedTextFixturePdf(
            'ocr-journey-scan.pdf',
            SCANNED_TEXT,
            '60px EvbOcrJourneySans',
        );
        await openPdfInApp(page, sourcePath, 90_000);
        await waitForViewerInteractive(page, 90_000);

        await session.command('windowResize', [
            1440,
            900,
        ]);
        // English is the preselected recognition language.
        await clickVisibleButton(page, '#editor-global-toolbar-host', 'OCR');
        await page.waitForSelector('[role="dialog"]', {visible: true});
        const dialogLayout = await page.$eval('[role="dialog"]', (dialog) => {
            const scrollableElements = Array.from(dialog.querySelectorAll<HTMLElement>('*')).filter((element) => {
                const overflowY = window.getComputedStyle(element).overflowY;
                return element.scrollHeight > element.clientHeight
                    && (overflowY === 'auto' || overflowY === 'scroll');
            });
            return {
                width: dialog.getBoundingClientRect().width,
                hasNestedScrollRegions: scrollableElements.some(element => (
                    scrollableElements.some(parent => parent !== element && parent.contains(element))
                )),
            };
        });
        expect(dialogLayout.width).toBeGreaterThanOrEqual(900);
        expect(dialogLayout.hasNestedScrollRegions).toBe(false);

        await clickVisibleButton(page, '[role="dialog"]', 'Start OCR');
        await waitForFunctionInPage(page, () => (
            document.querySelector('[role="dialog"]')?.textContent?.includes('OCR complete - PDF is now searchable') === true
        ), {timeout: OCR_TIMEOUT_MS});
        await clickVisibleButton(page, '[role="dialog"]', 'Close');
        await page.waitForSelector('[role="dialog"]', {hidden: true});
        await waitForTextLayerWord(page);

        await saveViaVisibleToolbar(page, 90_000);
        expect(await assertOcrPdfSemanticOutput(sourcePath, SCANNED_TEXT)).toContain(SEARCHED_WORD);

        await clickVisibleButton(page, 'body', 'Close Tab');
        await page.waitForSelector(`${ACTIVE_HOST} .page_container`, {hidden: true});
        await openPdfInApp(page, sourcePath, 90_000);
        await waitForViewerInteractive(page, 90_000);

        await openDocumentSidebarTab(page, 'Search');
        await page.click(`${ACTIVE_HOST} .document-search-bar input`);
        await page.keyboard.type(SEARCHED_WORD);
        await page.keyboard.press('Enter');
        await waitForFunctionInPage(page, (host: string, word: string) => (
            Array.from(document.querySelectorAll(`${host} .document-search-result`))
                .some(result => result.textContent?.toLocaleLowerCase().includes(word))
        ), {timeout: 30_000}, ACTIVE_HOST, SEARCHED_WORD);
        await page.click(`${ACTIVE_HOST} .document-search-result`);
        await page.waitForSelector(`${ACTIVE_HOST} .pdf-search-highlight--current`, {visible: true});
    }, 300_000);

    it('acknowledges a real OCR result that arrives after the user cancels', async () => {
        const session = await sessionFixture.restart({
            clean: true,
            hard: true,
            sessionName: () => `e2e-ocr-late-result-${Date.now()}`,
        });
        const {page} = session;
        const sourcePath = await createScannedTextFixturePdf(
            'ocr-late-result-scan.pdf',
            LATE_RESULT_TEXT,
            '60px EvbOcrJourneySans',
        );
        await openPdfInApp(page, sourcePath, 90_000);
        await waitForViewerInteractive(page, 90_000);
        await session.command('windowResize', [
            1440,
            900,
        ]);
        await installLateOcrCompletionControl(page);

        try {
            await clickVisibleButton(page, '#editor-global-toolbar-host', 'OCR');
            await page.waitForSelector('[role="dialog"]', {visible: true});
            await clickVisibleButton(page, '[role="dialog"]', 'Start OCR');
            await waitForFunctionInPage(page, () => {
                const control = (window as TOcrControlWindow).__lateOcrCompletionControl;
                return control?.result?.success === true;
            }, {timeout: 30_000});
            const completionControl = await page.evaluate(() => {
                const control = (window as TOcrControlWindow).__lateOcrCompletionControl;
                return control?.cancelClicked ?? false;
            });
            expect(completionControl).toBe(true);

            const stagedResult = await page.evaluate(() => (
                (window as TOcrControlWindow).__lateOcrCompletionControl?.result ?? null
            ));
            expect(stagedResult).toMatchObject({
                success: true,
                requiresCleanupAck: true,
            });
            expect(stagedResult?.pdfPath).toBeTruthy();

            await waitForFunctionInPage(page, () => (
                Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
                    .some(button => (
                        (button.getAttribute('aria-label') ?? button.textContent ?? '').trim() === 'Start OCR'
                        && !button.disabled
                        && button.checkVisibility()
                    ))
            ), {timeout: 30_000});

            const stagedTextWasApplied = await page.evaluate((host: string, word: string) => (
                document.querySelector(`${host} .page_container[data-page="1"] .text-layer`)
                    ?.textContent?.toLocaleLowerCase().includes(word) === true
            ), ACTIVE_HOST, LATE_RESULT_WORD);
            expect(stagedTextWasApplied).toBe(false);

            await vi.waitFor(async () => {
                await expect(stat(stagedResult!.pdfPath!)).rejects.toMatchObject({code: 'ENOENT'});
            }, {timeout: 30_000});

            const textAfterLateCompletion = await page.evaluate((host: string, word: string) => (
                document.querySelector(`${host} .page_container[data-page="1"] .text-layer`)
                    ?.textContent?.toLocaleLowerCase().includes(word) === true
            ), ACTIVE_HOST, LATE_RESULT_WORD);
            expect(textAfterLateCompletion).toBe(false);
        } finally {
            await page.evaluate(() => {
                (window as TOcrControlWindow).__lateOcrCompletionControl?.restore();
            });
        }
    }, 300_000);

    it('finishes OCR started in one linked view after the user switches to the other view', async () => {
        const session = await sessionFixture.restart({
            clean: true,
            hard: true,
            sessionName: () => `e2e-ocr-linked-views-${Date.now()}`,
        });
        const {page} = session;
        const sourcePath = await createScannedPagesFixturePdf('ocr-linked-views-scan.pdf', 24);
        await openPdfInApp(page, sourcePath, 90_000);
        await waitForViewerInteractive(page, 90_000);
        await session.command('windowResize', [
            1440,
            900,
        ]);
        await splitActiveTabFromTabMenu(page, 'right');
        const [
            leftPane,
            rightPane,
        ] = await page.$$eval('.editor-pane', panes => panes.map(pane => (pane as HTMLElement).dataset.editorPaneId ?? ''));
        const paneHost = (paneId: string) => `.editor-pane[data-editor-pane-id="${paneId}"]`;
        await waitForFunctionInPage(page, (host: string) => (
            document.querySelector(`${host} .page_container--rendered`) !== null
        ), {timeout: 30_000}, paneHost(rightPane!));

        // An agent connected to EVB starts OCR of every page in the right
        // view without opening the OCR dialog, so the window stays usable.
        const agentRun = callWorkspaceCommand<{
            ok?: boolean;
            error?: string;
            ocr?: unknown;
        }>(page, 'runAgentAction', [
            'ocr.start',
            {
                pageRange: 'all',
                open: false,
            },
        ]);
        // The agent's status read is the sync point: the run is under way
        // and has pages left.
        await vi.waitFor(async () => {
            const status = await callWorkspaceCommand<{ocr?: {
                isRunning?: boolean;
                processedCount?: number;
                totalPages?: number
            }}>(page, 'runAgentAction', [
                'ocr.status',
                {},
            ]);
            const ocr = status.value?.ocr;
            if (!ocr?.isRunning || (ocr.processedCount ?? 0) >= (ocr.totalPages ?? 0) - 4) {
                throw new Error(`OCR is not under way with pages left: ${JSON.stringify(ocr)}`);
            }
        }, {timeout: 30_000});

        // Meanwhile the user goes on reading in the left view.
        await activatePaneByTab(page, leftPane!);

        // The run continues and the document becomes searchable in the view in use.
        const outcome = await agentRun;
        const recognized = await page.waitForFunction((host: string, word: string) => (
            document.querySelector(`${host} .page_container[data-page="1"] .text-layer[data-pdf-text-layer-ready="true"]`)
                ?.textContent?.toLocaleLowerCase().includes(word) === true
        ), {timeout: 30_000}, paneHost(leftPane!), SEARCHED_WORD).then(() => true, () => false);
        const {
            ok, error, ocr,
        } = outcome.value ?? {};
        expect({
            agentResult: outcome.value,
            leftViewShowsRecognizedText: recognized,
        }, JSON.stringify({
            ok,
            error,
            ocr,
        })).toMatchObject({
            agentResult: {ok: true},
            leftViewShowsRecognizedText: true,
        });
    }, 300_000);
});
