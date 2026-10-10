import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {delay} from 'es-toolkit/promise';
import {tmpdir} from 'node:os';
import {
    dirname, join,
} from 'node:path';
import {
    copyFile, mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile,
} from 'node:fs/promises';
import {
    GlobalFonts, createCanvas,
} from '@napi-rs/canvas';
import {
    PDFDocument,
    PDFName,
    StandardFonts,
} from 'pdf-lib';
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
import {OCR_LANGUAGE_MODEL_SHA256} from '@contracts/ocrLanguages';
import {decodeWorkspaceCheckpoint} from '@contracts/workspaceCheckpoint';
import {readWorkspaceRecoveryRecords} from '@scripts/electron-run/electronRunWorkspaceCheckpoint';
import {electronUserDataPath} from '@scripts/electron-run/electronRunSessionPaths';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    activateMenuItemAsUser,
    clickAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {
    createFixturePath,
    createScannedTextFixturePdf,
    readPdfTextAnnotationRecords,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    assertOcrPdfSemanticOutput, getActiveWorkspaceWorkingCopyPath,
} from '@tests/e2e/electron/helpers/electronApiHelpers';
import {createStickyNoteWithPointer} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {extractTextWithPdfjs} from '@electron/features/search/pdfjsPageTexts';
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

interface IClosedDocumentOcrWatch {
    terminal: boolean;
    dialogSeen: boolean;
    stop: () => void;
}

type TOcrControlWindow = Window & {
    __lateOcrCompletionControl?: ILateOcrCompletionControl;
    __closedDocumentOcrWatch?: IClosedDocumentOcrWatch;
};

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
    await clickAsUser(page, handle.asElement() as ElementHandle<HTMLButtonElement>);
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
    doc.setCreationDate(new Date('2020-01-01T00:00:00Z'));
    doc.setModificationDate(new Date('2020-01-01T00:00:00Z'));
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

/**
 * Three pages whose existing text a PDF reader shows differently from what a
 * line-oriented reading of the content stream suggests. Page 1 shows its
 * heading after `Q` restores visible text from an earlier hidden object, page 2
 * starts with a comment that only looks like hidden text, and page 3 is a scan
 * under a hidden foreign OCR layer with no visible text.
 */
async function createExistingTextVisibilityFixturePdf(filename: string) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const canvas = createCanvas(1224, 1584);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#111111';
    context.font = '64px EvbOcrJourneySans';
    context.fillText('Quiet meadow anchor', 120, 800);
    const scan = await doc.embedPng(canvas.toBuffer('image/png'));
    const pageContents = [
        'q BT /F1 9 Tf 3 Tr 72 720 Td (stale hidden note) Tj ET Q\nBT /F1 36 Tf 72 400 Td (Harbor lantern signal) Tj ET',
        '% BT 3 Tr (fake hidden words) Tj ET\nBT /F1 36 Tf 72 400 Td (Copper weather beacon) Tj ET',
        'q 612 0 0 792 0 0 cm /Im0 Do Q\nBT /F1 32 Tf 3 Tr 60 392 Td (Qu1et rneadow anc) Tj ET',
    ];
    for (const content of pageContents) {
        const page = doc.addPage([
            612,
            792,
        ]);
        page.node.setFontDictionary(PDFName.of('F1'), font.ref);
        page.node.setXObject(PDFName.of('Im0'), scan.ref);
        page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(content)));
    }
    const filePath = createFixturePath(filename);
    await writeFile(filePath, await doc.save());
    return filePath;
}

/** A 1677 Latin page set at 72 ppi, as the user's scan of it was. */
async function createEarlyPrintFixturePdf(filename: string) {
    const doc = await PDFDocument.create();
    const scan = await doc.embedJpg(await readFile(join(process.cwd(), 'tests/fixtures/electron/early-print/breviary-1677-rubrics.jpg')));
    doc.addPage([
        scan.width,
        scan.height,
    ]).drawImage(scan, {
        x: 0,
        y: 0,
        width: scan.width,
        height: scan.height,
    });
    const filePath = createFixturePath(filename);
    await writeFile(filePath, await doc.save());
    return filePath;
}

/** Picks a recognition language by clicking its chip in the OCR dialog. */
async function chooseOcrLanguage(page: Page, code: string) {
    const chip = await page.waitForFunction((languageCode: string) => (
        Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] [data-slot="item"]')).find(item => (
            item.querySelector('.chip-code')?.textContent?.trim() === languageCode && item.checkVisibility()
        ))
    ), {timeout: 30_000}, code);
    await clickAsUser(page, chip.asElement() as ElementHandle<HTMLElement>);
    await waitForFunctionInPage(page, (languageCode: string) => (
        Array.from(document.querySelectorAll('[role="dialog"] [data-slot="item"]')).some(item => (
            item.querySelector('.chip-code')?.textContent?.trim() === languageCode
            && item.querySelector('[role="radio"]')?.getAttribute('aria-checked') === 'true'
        ))
    ), {timeout: 10_000}, code);
}

function countWord(text: string, word: string) {
    return text.toLocaleLowerCase().split(word).length - 1;
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
    it('shows model download progress, cancels cleanly and recognizes after a dropped connection', async () => {
        const scratch = await mkdtemp(join(tmpdir(), 'ocr-download-progress-'));
        const evidence = process.env.EVB_OCR_DOWNLOAD_EVIDENCE_DIR ?? scratch;
        await mkdir(evidence, {recursive: true});
        const modelDirectory = join(process.cwd(), 'resources/tesseract/tessdata');
        const modelPath = join(modelDirectory, 'deu.traineddata');
        const backupPath = join(scratch, 'deu-original.traineddata');
        const modelBytes = await readFile(modelPath);
        expect(createHash('sha256').update(modelBytes).digest('hex')).toBe(OCR_LANGUAGE_MODEL_SHA256.deu);
        let attempt = 0;
        const transportEvents: Array<{
            at: number;
            event: string;
            attempt: number
        }> = [];
        const samples: Array<{
            at: number;
            run: string;
            text: string
        }> = [];
        const transport = createServer((request, response) => {
            response.writeHead(200, {'Content-Length': modelBytes.length});
            if (request.method === 'HEAD') {
                response.end();
                return;
            }
            const currentAttempt = ++attempt;
            transportEvents.push({
                at: Date.now(),
                event: 'start',
                attempt: currentAttempt,
            });
            let offset = 0;
            const stream = setInterval(() => {
                response.write(modelBytes.subarray(offset, offset + 262_144));
                offset += 262_144;
                // The first run is cancelled by the user; the next loses its
                // connection and must expose the existing automatic retry.
                if (currentAttempt === 2 && offset >= 2_097_152) response.destroy();
                else if (offset >= modelBytes.length) response.end();
            }, 250);
            response.once('close', () => {
                clearInterval(stream);
                transportEvents.push({
                    at: Date.now(),
                    event: 'close',
                    attempt: currentAttempt,
                });
            });
        });
        await sessionFixture.stop({preserveArtifacts: true});
        await rename(modelPath, backupPath);
        try {
            await new Promise<void>(resolve => transport.listen(0, '127.0.0.1', resolve));
            const address = transport.address();
            if (!address || typeof address === 'string') throw new Error('Model transport has no TCP address');
            const hookPath = join(scratch, 'model-transport.cjs');
            await writeFile(hookPath, `
if (process.versions.electron && process.type === 'browser') {
    const fetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
        if (!String(url).endsWith('/deu.traineddata')) return fetch(url, options);
        if (String(url) !== 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/e12c65a915945e4c28e237a9b52bc4a8f39a0cec/deu.traineddata') throw new Error('Unexpected model source');
        return fetch('http://127.0.0.1:${address.port}/deu.traineddata', options);
    };
}
`);
            const session = await sessionFixture.start({
                sessionName: () => `e2e-ocr-download-progress-${Date.now()}`,
                extraEnv: {NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${hookPath}`},
            });
            const {page} = session;
            const sourcePath = await createScannedTextFixturePdf('ocr-download-progress.pdf', 'Hafen Laterne Signal', '60px EvbOcrJourneySans');
            await copyFile(sourcePath, join(evidence, 'input.pdf'));
            await openPdfInApp(page, sourcePath, 90_000);
            await waitForViewerInteractive(page, 90_000);
            await session.command('windowResize', [
                1440,
                900,
            ]);
            await clickVisibleButton(page, '#editor-global-toolbar-host', 'OCR');
            await page.waitForSelector('[role="dialog"]', {visible: true});
            await chooseOcrLanguage(page, 'deu');

            async function sample(run: string) {
                const text = await page.$eval('[role="dialog"]', dialog => (dialog as HTMLElement).innerText);
                samples.push({
                    at: Date.now(),
                    run,
                    text,
                });
                return text;
            }
            await clickVisibleButton(page, '[role="dialog"]', 'Download and start OCR');
            for (let index = 0; index < 6; index++) {
                await sample('cancel');
                await delay(500);
            }
            await page.screenshot({path: join(evidence, 'downloading.png')});
            await clickVisibleButton(page, '[role="dialog"]', 'Cancel OCR');
            await vi.waitFor(async () => {
                expect((await readdir(modelDirectory)).filter(file => file.startsWith('deu.traineddata'))).toEqual([]);
            }, {timeout: 10_000});
            await page.screenshot({path: join(evidence, 'cancelled.png')});
            // Reopening refreshes the inventory after the cancelled shared
            // download has released its final waiter.
            await clickVisibleButton(page, '[role="dialog"]', 'Cancel');
            await page.waitForSelector('[role="dialog"]', {hidden: true});
            await clickVisibleButton(page, '#editor-global-toolbar-host', 'OCR');
            await page.waitForSelector('[role="dialog"]', {visible: true});

            await clickVisibleButton(page, '[role="dialog"]', 'Download and start OCR');
            const deadline = Date.now() + OCR_TIMEOUT_MS;
            let completed = false;
            while (Date.now() < deadline) {
                const text = await sample('complete');
                if (text.includes('OCR complete - PDF is now searchable')) {
                    completed = true;
                    break;
                }
                if (text.includes('Copy logs')) break;
                await delay(500);
            }
            await page.screenshot({path: join(evidence, 'complete.png')});
            expect(completed, 'recognition completes after model preparation').toBe(true);
            expect((await readFile(modelPath)).equals(modelBytes)).toBe(true);
            await clickVisibleButton(page, '[role="dialog"]', 'Close');
            await waitForFunctionInPage(page, () => (
                document.querySelector('.text-layer')?.textContent?.includes('Laterne') === true
            ), {timeout: 30_000});
            await page.screenshot({path: join(evidence, 'recognized.png')});

            const downloadSamples = samples.filter(item => /Downloading German:.*\(\d+%\)/u.test(item.text));
            expect(downloadSamples.length, 'I1: the dialog shows numerical download progress').toBeGreaterThan(4);
            const firstStart = transportEvents.find(event => event.event === 'start')!.at;
            expect(downloadSamples.find(item => item.run === 'cancel')!.at - firstStart).toBeLessThanOrEqual(1_000);
            for (const run of [
                'cancel',
                'complete',
            ]) {
                const values = downloadSamples.filter(item => item.run === run);
                const changes = values.filter((item, index) => index === 0 || item.text !== values[index - 1]!.text);
                expect(changes.length).toBeGreaterThan(2);
                for (let index = 1; index < changes.length; index++) {
                    const previous = changes[index - 1]!;
                    const current = changes[index]!;
                    if (samples.some(item => item.at > previous.at && item.at < current.at
                        && item.text.includes('Retrying German') && !item.text.includes('Downloading German:'))) continue;
                    expect(current.at - previous.at, 'progress increases at least once a second').toBeLessThanOrEqual(1_000);
                }
            }
            expect(samples.some(item => item.text.includes('Retrying German download (attempt 2 of 3)'))).toBe(true);
        } finally {
            await writeFile(join(evidence, 'samples.json'), JSON.stringify(samples, null, 2));
            await writeFile(join(evidence, 'transport.json'), JSON.stringify(transportEvents, null, 2));
            try {
                await sessionFixture.stop({preserveArtifacts: true});
            } finally {
                transport.closeAllConnections();
                if (transport.listening) await new Promise<void>(resolve => transport.close(() => resolve()));
                await rename(backupPath, modelPath);
            }
        }
    }, 300_000);

    it('preserves an accepted note through OCR cancel, crash recovery, resumed OCR and Save', async () => {
        let session = sessionFixture.getSession();
        const evidence = join(process.cwd(), '.devkit', session.name, 'ocr-note-recovery');
        await mkdir(evidence, {recursive: true});
        const sourcePath = await createScannedPagesFixturePdf('ocr-note-recovery.pdf', 6);
        const originalBytes = await readFile(sourcePath);
        await copyFile(sourcePath, join(evidence, 'input.pdf'));
        await openPdfInApp(session.page, sourcePath, 90_000);
        await waitForViewerInteractive(session.page, 90_000);
        await session.command('windowResize', [
            1440,
            900,
        ]);
        const marker = 'Accepted note survives cancelled and resumed OCR';
        await createStickyNoteWithPointer(session.page, marker, {
            x: 0.8,
            y: 0.1,
        }, 1, {allowClearPointSearch: true});
        const workingPath = await getActiveWorkspaceWorkingCopyPath(session.page);
        const checkpointDirectory = join(dirname(dirname(workingPath)), 'ocr-checkpoints');
        await copyFile(workingPath, join(evidence, 'before-ocr.pdf'));

        async function startAllPagesOcr(page: Page) {
            await clickVisibleButton(page, '#editor-global-toolbar-host', 'OCR');
            const allPages = await page.waitForFunction(() => (
                Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] label'))
                    .find(label => label.textContent?.trim() === 'All pages (6)' && label.checkVisibility())
            ), {timeout: 30_000});
            await clickAsUser(page, allPages.asElement() as ElementHandle<HTMLElement>);
            await clickVisibleButton(page, '[role="dialog"]', 'Start OCR');
        }

        await startAllPagesOcr(session.page);
        await expect.poll(async () => (
            await readdir(checkpointDirectory, {recursive: true}).catch(() => [])
        ).some(file => file.endsWith('page-1.json')), {timeout: OCR_TIMEOUT_MS}).toBe(true);
        await clickVisibleButton(session.page, '[role="dialog"]', 'Cancel OCR');
        await session.page.waitForFunction(() => (
            Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
                .some(button => button.textContent?.trim() === 'Start OCR' && !button.disabled)
        ), {timeout: 30_000});
        await clickVisibleButton(session.page, '[role="dialog"]', 'Close');
        expect(await readFile(sourcePath)).toEqual(originalBytes);

        await expect.poll(async () => {
            const checkpoint = readWorkspaceRecoveryRecords(session.name)
                .map(record => decodeWorkspaceCheckpoint(record.checkpoint)).find(Boolean);
            const recovery = checkpoint?.tabs.find(tab => tab.workingCopyRef === workingPath)?.annotationRecovery;
            if (!recovery) return false;
            const payloadBytes = await readFile(join(
                electronUserDataPath(session.name), 'workspace-annotation-recovery', `${recovery.artifactId}.json`,
            ));
            const payload = JSON.parse(payloadBytes.toString()) as {payload?: {entities?: Array<{contents?: string}>}};
            const notePresent = payload.payload?.entities?.some(entity => entity.contents === marker) ?? false;
            if (notePresent) {
                await writeFile(join(evidence, 'workspace-before-crash.json'), JSON.stringify(checkpoint, null, 2));
                await writeFile(join(evidence, 'annotation-recovery.json'), payloadBytes);
            }
            return notePresent;
        }, {timeout: 30_000}).toBe(true);

        session = await sessionFixture.restart({
            clean: false,
            hard: true,
        });
        await waitForViewerInteractive(session.page, 90_000);
        await session.command('windowResize', [
            1440,
            900,
        ]);
        expect(await getActiveWorkspaceWorkingCopyPath(session.page)).toBe(workingPath);
        await openDocumentSidebarTab(session.page, 'Annotations');
        await session.page.waitForFunction((text: string) => (
            Array.from(document.querySelectorAll('.notes-panel .note-item'))
                .some(item => item.textContent?.includes(text))
        ), {timeout: 30_000}, marker);
        await copyFile(workingPath, join(evidence, 'after-recovery.pdf'));
        await session.page.screenshot({path: join(evidence, 'recovered-note.png')});

        await startAllPagesOcr(session.page);
        await session.page.waitForFunction(() => (
            document.querySelector('[role="dialog"]')?.textContent?.includes('OCR complete - PDF is now searchable')
        ), {timeout: OCR_TIMEOUT_MS});
        await clickVisibleButton(session.page, '[role="dialog"]', 'Close');
        await waitForViewerInteractive(session.page, 90_000);
        await copyFile(workingPath, join(evidence, 'after-resumed-ocr.pdf'));
        await session.page.screenshot({path: join(evidence, 'after-resumed-ocr.png')});
        await saveViaVisibleToolbar(session.page, 90_000);
        await copyFile(sourcePath, join(evidence, 'saved.pdf'));
        const records = await readPdfTextAnnotationRecords(sourcePath);
        await writeFile(join(evidence, 'saved-annotations.json'), JSON.stringify(records, null, 2));
        expect(records).toEqual(expect.arrayContaining([expect.objectContaining({contents: marker})]));
        const pages = await extractTextWithPdfjs(sourcePath);
        expect(pages).toHaveLength(6);
        for (const page of pages) expect(page.text.toLocaleLowerCase()).toContain(SEARCHED_WORD);
        await sessionFixture.resetForE2E();
    }, 420_000);

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
        await clickAsUser(page, `${ACTIVE_HOST} .document-search-bar input`);
        await page.keyboard.type(SEARCHED_WORD);
        await page.keyboard.press('Enter');
        await waitForFunctionInPage(page, (host: string, word: string) => (
            Array.from(document.querySelectorAll(`${host} .document-search-result`))
                .some(result => result.textContent?.toLocaleLowerCase().includes(word))
        ), {timeout: 30_000}, ACTIVE_HOST, SEARCHED_WORD);
        await clickAsUser(page, `${ACTIVE_HOST} .document-search-result`);
        await page.waitForSelector(`${ACTIVE_HOST} .pdf-search-highlight--current`, {visible: true});
    }, 300_000);

    // #928 F1: the pages OCR may replace are the pages whose existing text is
    // only hidden, read the way a PDF reader paints them.
    it('keeps visible native text and repairs only a hidden-only foreign OCR layer', async () => {
        const session = await sessionFixture.restart({
            clean: true,
            hard: true,
            sessionName: () => `e2e-ocr-existing-text-${Date.now()}`,
        });
        const {page} = session;
        const sourcePath = await createExistingTextVisibilityFixturePdf('ocr-existing-text-visibility.pdf');
        await openPdfInApp(page, sourcePath, 90_000);
        await waitForViewerInteractive(page, 90_000);
        await session.command('windowResize', [
            1440,
            900,
        ]);

        await clickVisibleButton(page, '#editor-global-toolbar-host', 'OCR');
        await page.waitForSelector('[role="dialog"]', {visible: true});
        const allPagesOption = await page.waitForFunction(() => (
            Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] label'))
                .find(label => label.textContent?.trim() === 'All pages (3)' && label.checkVisibility())
        ), {timeout: 30_000});
        await clickAsUser(page, allPagesOption.asElement() as ElementHandle<HTMLElement>);
        await clickVisibleButton(page, '[role="dialog"]', 'Start OCR');
        await waitForFunctionInPage(page, () => (
            document.querySelector('[role="dialog"]')?.textContent?.includes('OCR complete') === true
        ), {timeout: OCR_TIMEOUT_MS});
        // Preserving a page's own text is the outcome asked for, not a failure.
        expect(await page.$eval('[role="dialog"]', dialog => dialog.textContent ?? ''))
            .toContain('OCR complete - PDF is now searchable');
        await clickVisibleButton(page, '[role="dialog"]', 'Close');
        await page.waitForSelector('[role="dialog"]', {hidden: true});
        await saveViaVisibleToolbar(page, 90_000);

        const savedPages = await extractTextWithPdfjs(sourcePath);
        expect({
            restoredVisibleHeading: countWord(savedPages[0]?.text ?? '', 'lantern'),
            restoredPageHiddenNote: countWord(savedPages[0]?.text ?? '', 'stale hidden note'),
            commentedPageHeading: countWord(savedPages[1]?.text ?? '', 'beacon'),
            repairedScanWord: countWord(savedPages[2]?.text ?? '', 'meadow'),
            repairedScanStaleWord: countWord(savedPages[2]?.text ?? '', 'rneadow'),
        }, JSON.stringify(savedPages)).toEqual({
            restoredVisibleHeading: 1,
            restoredPageHiddenNote: 1,
            commentedPageHeading: 1,
            repairedScanWord: 1,
            repairedScanStaleWord: 0,
        });
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
        // Whatever happens next, the run must not outlive the test unobserved.
        const agentRunSettled = agentRun.then(() => undefined, () => undefined);
        try {
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
        } finally {
            await activatePaneByTab(page, rightPane!).catch(() => undefined);
            await callWorkspaceCommand(page, 'runAgentAction', [
                'ocr.cancel',
                {},
            ]).catch(() => undefined);
            await agentRunSettled;
        }
    }, 300_000);

    // #913: the OCR run belongs to the document, not to the view that started it.
    // The narrow window reaches OCR through More tools; the running run must stay reachable there.
    it.each([
        {
            width: 1440,
            height: 900,
            viaOverflow: false,
        },
        {
            width: 900,
            height: 672,
            viaOverflow: true,
        },
    ])('keeps an OCR run going when the view that started it is closed, and shows it in the other view at $width px', async ({
        width, height, viaOverflow,
    }) => {
        const session = await sessionFixture.restart({
            clean: true,
            hard: true,
            sessionName: () => `e2e-ocr-closed-view-${Date.now()}`,
        });
        const {page} = session;
        const sourcePath = await createScannedPagesFixturePdf('ocr-closed-view-scan.pdf', 40);
        await openPdfInApp(page, sourcePath, 90_000);
        await waitForViewerInteractive(page, 90_000);
        await session.command('windowResize', [
            width,
            height,
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

        const agentRun = callWorkspaceCommand<{ok?: boolean}>(page, 'runAgentAction', [
            'ocr.start',
            {
                pageRange: 'all',
                open: false,
            },
        ]);
        const agentRunSettled = agentRun.then(() => undefined, () => undefined);
        try {
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

            // The user closes the view that started the run; the left view stays.
            await clickAsUser(page, `${paneHost(rightPane!)} .tab.is-active .tab-close`);
            await waitForFunctionInPage(page, () => document.querySelectorAll('.editor-pane').length === 1, {timeout: 20_000});

            // The left view shows the run under way.
            if (viaOverflow) {
                await clickVisibleButton(page, '#editor-global-toolbar-host', 'More tools');
                const ocrItem = await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item => (
                    item.textContent?.trim() === 'OCR'
                    && !item.hasAttribute('data-disabled')
                    && item.getAttribute('aria-disabled') !== 'true'
                    && item.checkVisibility()
                )), {timeout: 30_000});
                await clickAsUser(page, ocrItem.asElement() as ElementHandle<HTMLElement>);
            } else {
                await clickVisibleButton(page, '#editor-global-toolbar-host', 'OCR');
            }
            await page.waitForSelector('[role="dialog"]', {visible: true});
            await waitForFunctionInPage(page, () => {
                const text = document.querySelector('[role="dialog"]')?.textContent ?? '';
                return /Processing page \d+/u.test(text);
            }, {timeout: 30_000});
            if (viaOverflow) {
                // The user cancels the run from the narrow window, and OCR can be started again.
                await clickVisibleButton(page, '[role="dialog"]', 'Cancel OCR');
                await waitForFunctionInPage(page, () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).some(button => (
                    button.textContent?.trim() === 'Start OCR' && !button.disabled && button.checkVisibility()
                )), {timeout: 30_000});
                return;
            }
            // It finishes.
            await waitForFunctionInPage(page, () => (
                document.querySelector('[role="dialog"]')?.textContent?.includes('OCR complete - PDF is now searchable') === true
            ), {timeout: OCR_TIMEOUT_MS});
            await clickVisibleButton(page, '[role="dialog"]', 'Close');
            await page.waitForSelector('[role="dialog"]', {hidden: true});
            const recognized = await page.waitForFunction((host: string, word: string) => (
                document.querySelector(`${host} .page_container[data-page="1"] .text-layer[data-pdf-text-layer-ready="true"]`)
                    ?.textContent?.toLocaleLowerCase().includes(word) === true
            ), {timeout: 30_000}, paneHost(leftPane!), SEARCHED_WORD).then(() => true, () => false);
            expect(recognized).toBe(true);
        } finally {
            await callWorkspaceCommand(page, 'runAgentAction', [
                'ocr.cancel',
                {},
            ]).catch(() => undefined);
            await agentRunSettled;
        }
    }, 300_000);

    // #969: closing the last document while OCR runs leaves an empty, usable New Tab.
    it('leaves no OCR dialog over New Tab when the final document closes during OCR', async () => {
        const session = await sessionFixture.restart({
            clean: true,
            hard: true,
            sessionName: () => `e2e-ocr-close-final-tab-${Date.now()}`,
        });
        const {page} = session;
        const sourcePath = createFixturePath('ocr-close-final-tab-scan.pdf');
        await copyFile(join(process.cwd(), 'tests/fixtures/release/scan-cleanup-four-page-grayscale.pdf'), sourcePath);
        await openPdfInApp(page, sourcePath, 90_000);
        await waitForViewerInteractive(page, 90_000);
        await session.command('windowResize', [
            1440,
            900,
        ]);

        await clickVisibleButton(page, '#editor-global-toolbar-host', 'OCR');
        await page.waitForSelector('[role="dialog"]', {visible: true});
        const allPagesOption = await page.waitForFunction(() => (
            Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] label'))
                .find(label => label.textContent?.trim() === 'All pages (4)' && label.checkVisibility())
        ), {timeout: 30_000});
        await clickAsUser(page, allPagesOption.asElement() as ElementHandle<HTMLElement>);
        await clickVisibleButton(page, '[role="dialog"]', 'Start OCR');
        await page.waitForSelector('xpath///*[@role="dialog"]//button[normalize-space()="Cancel OCR"]', {visible: true});

        // Once the tab shows no document, no frame until the run ends, or after, may show a dialog.
        await page.evaluate((host: string) => {
            const testWindow = window as TOcrControlWindow;
            const watch: IClosedDocumentOcrWatch = {
                terminal: false,
                dialogSeen: false,
                stop: () => {},
            };
            let frame = 0;
            const sample = () => {
                watch.dialogSeen ||= document.querySelector(`${host} .page_container`) === null
                    && Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).some(dialog => dialog.checkVisibility());
                frame = requestAnimationFrame(sample);
            };
            const stopObserving = window.electronAPI!.ocr.onComplete(() => {
                watch.terminal = true;
            });
            watch.stop = () => {
                cancelAnimationFrame(frame);
                stopObserving();
            };
            testWindow.__closedDocumentOcrWatch = watch;
            sample();
        }, ACTIVE_HOST);
        try {
            await activateMenuItemAsUser(page, {accelerator: 'CmdOrCtrl+W'});
            await page.waitForSelector(`${ACTIVE_HOST} .page_container`, {
                hidden: true,
                timeout: 30_000,
            });
            await waitForFunctionInPage(page, () => (
                (window as TOcrControlWindow).__closedDocumentOcrWatch?.terminal === true
            ), {timeout: OCR_TIMEOUT_MS});
            await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
            const dialogSeen = await page.evaluate(() => (window as TOcrControlWindow).__closedDocumentOcrWatch?.dialogSeen);
            expect(dialogSeen, 'an OCR dialog showed over New Tab after its document closed').toBe(false);
        } finally {
            await page.evaluate(() => {
                (window as TOcrControlWindow).__closedDocumentOcrWatch?.stop();
                delete (window as TOcrControlWindow).__closedDocumentOcrWatch;
            });
        }

        // New Tab takes real input.
        await clickAsUser(page, `${ACTIVE_HOST} .empty-state .rail-item`);
        await page.waitForSelector(`${ACTIVE_HOST} .empty-state .rail-item.is-active`, {visible: true});

        // A good document opens untouched by the cancelled run.
        const goodPath = await createScannedTextFixturePdf('ocr-close-final-tab-next.pdf', SCANNED_TEXT, '60px EvbOcrJourneySans');
        await openPdfInApp(page, goodPath, 90_000);
        await waitForViewerInteractive(page, 90_000);
        expect(await page.$$eval('[role="dialog"]', dialogs => dialogs.some(dialog => (dialog as HTMLElement).checkVisibility()))).toBe(false);
        await clickVisibleButton(page, '#editor-global-toolbar-host', 'OCR');
        await page.waitForSelector('xpath///*[@role="dialog"]//button[normalize-space()="Start OCR" and not(@disabled)]', {visible: true});
        expect(await page.$eval('[role="dialog"]', dialog => dialog.textContent ?? '')).not.toContain('OCR complete');
    }, 300_000);

    // The OCR dialog belongs to the view that opened it (T4); only the run is shared.
    it('reads an early printed page as printed, with its long s, æ, œ and ct, when the user picks Latin', async () => {
        const session = sessionFixture.getSession();
        const {page} = session;
        const sourcePath = await createEarlyPrintFixturePdf('ocr-journey-early-print.pdf');
        await openPdfInApp(page, sourcePath, 90_000);
        await waitForViewerInteractive(page, 90_000);
        await session.command('windowResize', [
            1440,
            900,
        ]);

        await clickVisibleButton(page, '#editor-global-toolbar-host', 'OCR');
        await page.waitForSelector('[role="dialog"]', {visible: true});
        await chooseOcrLanguage(page, 'lat');
        await clickVisibleButton(page, '[role="dialog"]', 'Start OCR');
        await waitForFunctionInPage(page, () => (
            document.querySelector('[role="dialog"]')?.textContent?.includes('OCR complete - PDF is now searchable') === true
        ), {timeout: OCR_TIMEOUT_MS});
        await clickVisibleButton(page, '[role="dialog"]', 'Close');
        await page.waitForSelector('[role="dialog"]', {hidden: true});
        await waitForFunctionInPage(page, (host: string) => (
            (document.querySelector(`${host} .page_container[data-page="1"] .text-layer[data-pdf-text-layer-ready="true"]`)
                ?.textContent?.length ?? 0) > 200
        ), {timeout: 30_000}, ACTIVE_HOST);
        const text = await page.$eval(
            `${ACTIVE_HOST} .page_container[data-page="1"] .text-layer`,
            layer => layer.textContent ?? '',
        );
        console.log('ocr-early-print-text-layer', JSON.stringify(text));

        // Latin's own model reads this page's long s as f, its æ as z or x,
        // and its ct ligature as é or &.
        const printed = {
            longS: [
                'uſque',
                'ſequentibus',
                'feſto',
                'Chriſti',
                'Feſtis',
                'quaſdam',
                'ſolemniter',
                'Feſtum',
            ],
            ligatures: [
                'Paſchæ',
                'Eccleſiæ',
                'hæc',
                'propriæ',
                'Cœna',
            ],
            ct: [
                'Sanctorum',
                'Defunctorum',
                'Defuncti',
                'Octavam',
                'prædicta',
            ],
        };
        for (const [
            kind,
            words,
        ] of Object.entries(printed)) {
            const read = words.filter(word => text.includes(word));
            expect(read.length, `${kind} words read: ${read.join(', ')}`).toBeGreaterThanOrEqual(words.length - 1);
        }
        const misread = [
            ...printed.longS.map(word => word.replaceAll('ſ', 'f')),
            'Pafchz',
            'Ecclefix',
            'Defun&torum',
            'San&torum',
        ].filter(word => text.includes(word));
        expect(misread).toEqual([]);
    }, 300_000);

    it('opens the OCR dialog only in the view that opened it', async () => {
        const session = await sessionFixture.restart({
            clean: true,
            hard: true,
            sessionName: () => `e2e-ocr-dialog-per-view-${Date.now()}`,
        });
        const {page} = session;
        const sourcePath = await createScannedPagesFixturePdf('ocr-dialog-per-view-scan.pdf', 3);
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
        const dialogIsOpen = () => page.$$eval('[role="dialog"]', dialogs => dialogs.some(dialog => dialog.getBoundingClientRect().width > 0));
        const settleFrames = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

        // The dialog is modal, so the other view is activated the way a shortcut or
        // an agent does it, not with a click on the tab.
        const activateByScript = async (paneId: string) => {
            await page.evaluate((id: string) => {
                document.querySelector<HTMLElement>(`.editor-pane[data-editor-pane-id="${id}"] .tab.is-active[data-tab-id]`)?.click();
            }, paneId);
            await waitForFunctionInPage(page, (id: string) => (
                document.querySelector<HTMLElement>('.editor-pane.is-active')?.dataset.editorPaneId === id
            ), {timeout: 20_000}, paneId);
            await settleFrames();
        };

        await activatePaneByTab(page, rightPane!);
        await clickVisibleButton(page, '#editor-global-toolbar-host', 'OCR');
        await page.waitForSelector('[role="dialog"]', {visible: true});

        await activateByScript(leftPane!);
        expect(await dialogIsOpen(), 'the left view shows no OCR dialog it was never asked to open').toBe(false);

        await activateByScript(rightPane!);
        expect(await dialogIsOpen(), 'the right view still has the dialog the user left open').toBe(true);
    }, 200_000);

    // #1018: a healthy retry may finish after two minutes. Use real model
    // bytes and real attempt deadlines; only the transport is controlled.
    it('finishes model preparation after a stalled attempt and a slow healthy retry', async () => {
        const scratch = await mkdtemp(join(tmpdir(), 'ocr-model-preparation-'));
        console.info(`Model preparation evidence: ${scratch}`);
        const modelPath = join(process.cwd(), 'resources/tesseract/tessdata/deu.traineddata');
        const backupPath = join(scratch, 'deu-original.traineddata');
        const modelBytes = await readFile(modelPath);
        expect(createHash('sha256').update(modelBytes).digest('hex')).toBe(OCR_LANGUAGE_MODEL_SHA256.deu);
        const transportEvents: Array<{
            at: number;
            event: string;
            method: string | undefined
        }> = [];
        let firstAttempt = true;
        const transport = createServer((request, response) => {
            transportEvents.push({
                at: Date.now(),
                event: 'request',
                method: request.method,
            });
            response.once('close', () => transportEvents.push({
                at: Date.now(),
                event: 'close',
                method: request.method,
            }));
            response.writeHead(200, {'Content-Length': modelBytes.length});
            if (request.method === 'HEAD') {
                response.end();
                return;
            }
            if (firstAttempt) {
                firstAttempt = false;
                response.write(modelBytes.subarray(0, 1024));
                return;
            }
            // Model bytes arrive at 200 KiB/s, rather than adding a wait to
            // the test or changing the owner's 90-second attempt deadline.
            let offset = 0;
            const stream = setInterval(() => {
                response.write(modelBytes.subarray(offset, offset + 65_536));
                offset += 65_536;
                if (offset >= modelBytes.length) response.end();
            }, 320);
            response.once('close', () => clearInterval(stream));
        });
        await sessionFixture.stop({preserveArtifacts: true});
        await rename(modelPath, backupPath);
        try {
            await new Promise<void>(resolve => transport.listen(0, '127.0.0.1', resolve));
            const address = transport.address();
            if (!address || typeof address === 'string') throw new Error('Model transport has no TCP address');
            const transportUrl = `http://127.0.0.1:${address.port}/deu.traineddata`;
            const sourceUrl = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/e12c65a915945e4c28e237a9b52bc4a8f39a0cec/deu.traineddata';
            const hookPath = join(scratch, 'model-transport.cjs');
            await writeFile(hookPath, `
if (process.versions.electron && process.type === 'browser') {
    const fetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
        if (!String(url).endsWith('/deu.traineddata')) return fetch(url, options);
        if (String(url) !== ${JSON.stringify(sourceUrl)}) throw new Error('Unexpected model source');
        return fetch(${JSON.stringify(transportUrl)}, options);
    };
}
`);
            const session = await sessionFixture.start({
                sessionName: () => `e2e-ocr-model-preparation-${Date.now()}`,
                extraEnv: {NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${hookPath}`},
            });
            const {page} = session;
            const doc = await PDFDocument.create();
            doc.setCreationDate(new Date('2026-10-07T00:00:00Z'));
            doc.setModificationDate(new Date('2026-10-07T00:00:00Z'));
            const font = await doc.embedFont(StandardFonts.Helvetica);
            doc.addPage([
                612,
                792,
            ]).drawText('Hafen Laterne Signal. Dieser Text bleibt unveraendert.', {
                x: 60,
                y: 400,
                size: 24,
                font,
            });
            const sourcePath = join(scratch, 'native-text.pdf');
            await writeFile(sourcePath, await doc.save());
            await openPdfInApp(page, sourcePath, 90_000);
            await waitForViewerInteractive(page, 90_000);
            await session.command('windowResize', [
                1440,
                900,
            ]);
            await clickVisibleButton(page, '#editor-global-toolbar-host', 'OCR');
            await page.waitForSelector('[role="dialog"]', {visible: true});
            const german = await page.waitForFunction(() => (
                Array.from(document.querySelectorAll('[role="dialog"] .chip-code'))
                    .find(code => code.textContent?.trim() === 'deu')?.closest('label')
            ), {timeout: 30_000});
            await clickAsUser(page, german.asElement() as ElementHandle<HTMLLabelElement>);
            await page.screenshot({path: join(scratch, 'before.png')});
            const startedAt = Date.now();
            await clickVisibleButton(page, '[role="dialog"]', 'Download and start OCR');
            await waitForFunctionInPage(page, () => (
                document.body.innerText.includes('No pages needed OCR')
                || document.body.innerText.includes('operation was aborted due to timeout')
            ), {timeout: OCR_TIMEOUT_MS});
            const text = await page.$eval('body', body => body.innerText);
            await page.screenshot({path: join(scratch, 'terminal.png')});
            await writeFile(join(scratch, 'result.json'), JSON.stringify({
                session: session.name,
                elapsedMs: Date.now() - startedAt,
                text,
            }, null, 2));
            expect(text).toContain('No pages needed OCR');
            expect(text).toContain('Page 1: existing text was preserved.');
            expect(text).toContain('Hafen Laterne Signal.');
            expect((await readFile(modelPath)).equals(modelBytes)).toBe(true);
        } finally {
            try {
                await sessionFixture.stop({preserveArtifacts: true});
            } finally {
                try {
                    transport.closeAllConnections();
                    if (transport.listening) {
                        await new Promise<void>((resolve, reject) => transport.close(error => error ? reject(error) : resolve()));
                    }
                    await writeFile(join(scratch, 'transport.json'), JSON.stringify(transportEvents, null, 2));
                } finally {
                    await rename(backupPath, modelPath);
                }
                await sessionFixture.start({sessionName: () => `e2e-ocr-journey-restored-${Date.now()}`});
            }
        }
    }, 300_000);
});
