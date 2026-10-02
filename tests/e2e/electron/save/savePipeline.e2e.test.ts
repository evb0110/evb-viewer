import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {
    chmod,
    mkdir,
    open,
    readFile,
    rm,
    rename,
    writeFile,
} from 'node:fs/promises';
import {
    dirname,
    join,
} from 'node:path';
import {promisify} from 'node:util';
import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {
    PDFDocument,
    PDFHexString,
    PDFName,
} from 'pdf-lib';
import type {Page} from 'puppeteer-core';
import type {ITypedStagedArtifact} from '@contracts/stagedArtifacts';
import {findSessionOwnedElectronPids} from '@scripts/electron-run/electronRunProcessIdentity';
import {
    collectDescendantPidsUnix,
    isProcessAlive,
} from '@scripts/electron-run/electronRunProcessTree';
import {getSessionInfo} from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    createFixturePath,
    createMultiPageTextFixturePdf,
    createScannedTextFixturePdf,
    createPasswordProtectedFixturePdf,
    readPdfAnnotationDetails,
    readPdfHasEncryptDictionary,
    readPdfAnnotationSummary,
    readPdfPageSnapshots,
    readPdfTextAnnotationRecords,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    startElectronE2ESession,
    type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    openAnnotationsTab,
    clickVisibleToolbarButton,
    triggerOpenPathInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    clickLatestVisibleNoteWindowClose,
    clickVisibleAnnotationControl,
    createFreeTextAnnotationWithPointer,
    createStickyNoteWithPointer,
    selectAllFocusedAnnotationText,
    waitForNoOpenNoteWindows,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    assertOcrPdfSemanticOutput,
    consumeOcrResultIntoActiveWorkspace,
    getActiveWorkspaceWorkingCopyPath,
    runOcrSearchablePdf,
} from '@tests/e2e/electron/helpers/electronApiHelpers';
import {
    waitForAnimationFrames,
    waitForVisibleMountedPdfCanvases,
} from '@tests/e2e/electron/helpers/viewerVirtualizationContract';
import {
    installCommittedSurfaceSampler,
    markCommittedSurfaceInteractionCheckpoint,
    stopCommittedSurfaceSampler,
} from '@tests/e2e/electron/helpers/viewerCommittedSurfaceContract';
import {
    callWorkspaceCommand,
    getLatestAutomationEventId,
    readWorkspaceStateValues,
    requireWorkspaceCommand,
    waitForAutomationEvent,
    waitForSaveFrontierReady,
    waitForWorkspaceToolbarIdle,
    waitForWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {getErrorMessage} from '@contracts/getErrorMessage';
import {electronUserDataPath} from '@scripts/electron-run/electronRunSessionPaths';
import {extractTextWithPdfjs} from '@electron/features/search/pdfjsPageTexts';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';

const E2E_TIMEOUT_MS = 180_000;
const SAVE_TIMEOUT_MS = 60_000;
const COMMITTED_FIRST_PAGE_CANVAS_SELECTOR = [
    '.editor-pane.is-active #pdf-viewer',
    '.page_container[data-page="1"].page_container--rendered',
    '.page_canvas__render-layer canvas',
].join(' ');

interface ISaveReceiptProbe {
    barrierFinished: boolean;
    nativeProjectionEngaged: boolean;
    stagedArtifact: ITypedStagedArtifact | null;
}

interface IPdfSourceStateSnapshot {
    hasInMemoryData: boolean;
    reloadKind: 'blob' | 'none' | 'path';
    reloadPath: string | null;
}

interface ICommittedCanvasContinuitySnapshot {
    canvasClassName: string;
    height: number;
    pageContainerClassName: string;
    width: number;
}

type TSaveReceiptProbeWindow = Window & {
    __savedSidebar?: Element;
    __committedCanvasContinuitySnapshot?: ICommittedCanvasContinuitySnapshot;
    __resumeSaveReceiptCommit?: () => void;
    __saveReceiptProbe?: ISaveReceiptProbe;
};

interface ISettingsSnapshot {
    authorName?: string;
    clientDiagnosticsPreference?: 'unknown' | 'denied' | 'granted';
    suppressUnencryptedSaveNotice?: boolean;
}

interface ISettingsApi { get?: () => Promise<ISettingsSnapshot>; }
type ISettingsProbeWindow = Window & { electronAPI?: {settings?: ISettingsApi}; };

function hashBytes(bytes: Uint8Array) {
    return createHash('sha256')
        .update(bytes)
        .digest('hex');
}

async function hashFile(path: string) {
    return hashBytes(await readFile(path));
}

async function waitForOpenedPdf(page: Page, path: string) {
    const results = await Promise.allSettled([
        waitForAutomationEvent(page, 'document-opened', {
            path,
            timeoutMs: SAVE_TIMEOUT_MS,
        }),
        waitForAutomationEvent(page, 'first-page-rendered', {
            path,
            timeoutMs: SAVE_TIMEOUT_MS,
        }),
    ]);
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') {
        throw rejected.reason;
    }
    await waitForPdfLoaded(page, SAVE_TIMEOUT_MS);
    await waitForViewerInteractive(page, SAVE_TIMEOUT_MS);
}

async function openPasswordProtectedPdf(page: Page, path: string) {
    await triggerOpenPathInApp(page, path, SAVE_TIMEOUT_MS);
    await page.waitForSelector('input[type="password"]', {
        timeout: SAVE_TIMEOUT_MS,
        visible: true,
    });
    await page.type('input[type="password"]', 'frame-secret');
    await page.keyboard.press('Enter');
    await waitForOpenedPdf(page, path);
}

async function saveWithUnencryptedNoticeChoice(
    page: Page,
    choice: 'cancel' | 'continue' | 'continue-and-suppress',
) {
    const savePromise = callWorkspaceCommand<boolean>(page, 'handleSave');
    await page.waitForSelector('.unencrypted-save-dialog', {
        timeout: SAVE_TIMEOUT_MS,
        visible: true,
    });
    if (choice === 'continue-and-suppress') {
        await page.click('[data-testid="unencrypted-save-dont-show-again"]');
    }
    await page.click(choice === 'cancel'
        ? '[data-testid="unencrypted-save-cancel"]'
        : '[data-testid="unencrypted-save-continue"]');
    return savePromise;
}

async function waitForPersistedAuthor(page: Page, author: string) {
    await page.waitForFunction((expectedAuthor) => {
        const settings = (window as ISettingsProbeWindow).electronAPI?.settings;
        return settings?.get?.().then(value => value.authorName === expectedAuthor) ?? false;
    }, {timeout: SAVE_TIMEOUT_MS}, author);
}

async function createDirtyStickyNote(page: Page) {
    await openAnnotationsTab(page, 30_000);
    const created = await callWorkspaceCommand<boolean>(page, 'commentAtPoint', [
        1,
        0.72,
        0.24,
        {preferTextAnchor: false},
    ]);
    expect(created).toEqual({
        called: true,
        value: true,
    });
    await page.keyboard.press('Escape');
    await waitForWorkspaceToolbarIdle(page, {timeoutMs: 20_000});
    await waitForSaveFrontierReady(page);
}

const ENABLED_SAVE_BUTTON_SELECTOR = 'button[aria-label="Save"], button[aria-label^="Save ("]';

async function findEnabledSaveButton(page: Page) {
    for (const button of await page.$$(ENABLED_SAVE_BUTTON_SELECTOR)) {
        const enabled = await button.evaluate((candidate) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return !candidate.hasAttribute('disabled')
                && candidate.getAttribute('aria-disabled') !== 'true'
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 0
                && rect.height > 0;
        });
        if (enabled) {
            return button;
        }
    }
    return null;
}

async function isSaveButtonEnabled(page: Page) {
    return await findEnabledSaveButton(page) !== null;
}

// Clicks the visible toolbar Save control with a trusted pointer event.
async function clickEnabledSaveButton(page: Page) {
    const deadline = Date.now() + SAVE_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const button = await findEnabledSaveButton(page);
        if (button) {
            await button.click();
            return;
        }
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    }
    throw new Error('The toolbar Save button did not become enabled');
}

async function saveFromWorkspace(page: Page, path: string) {
    const afterEventId = await getLatestAutomationEventId(page);
    await clickEnabledSaveButton(page);
    await waitForAutomationEvent(page, 'save-committed', {
        afterEventId,
        path,
        timeoutMs: SAVE_TIMEOUT_MS,
    });
}

async function clickSaveAndAwaitOutcome(page: Page, path: string) {
    const afterEventId = await getLatestAutomationEventId(page);
    await clickEnabledSaveButton(page);
    return Promise.race([
        waitForAutomationEvent(page, 'save-committed', {
            afterEventId,
            path,
            timeoutMs: SAVE_TIMEOUT_MS,
        }).then(() => 'saved' as const),
        page.waitForSelector('[aria-label="Last save failed"]', {
            timeout: SAVE_TIMEOUT_MS,
            visible: true,
        }).then(() => 'refused' as const),
    ]);
}

const GENERATED_TEXT_FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'electron', 'generated-text.pdf');
// Appends a revision whose /Prev link points past the end of the file. The
// base is first written with a classic table and no object streams, so that
// qpdf can rebuild its cross-reference table and the file still opens.
async function appendRevisionWithBrokenPrev(source: Buffer) {
    const document = await PDFDocument.load(source, {updateMetadata: false});
    const pdf = Buffer.from(await document.save({useObjectStreams: false}));
    const text = pdf.toString('latin1');
    const root = /\/Root\s+(\d+\s+\d+\s+R)/u.exec(text)?.[1];
    const size = /\/Size\s+(\d+)/u.exec(text)?.[1];
    if (!root || !size) {
        throw new Error('The fixture trailer has no /Root or /Size');
    }
    const revision = [
        'xref',
        '0 1',
        '0000000000 65535 f ',
        'trailer',
        `<< /Size ${size} /Root ${root} /Prev 999999999 >>`,
        'startxref',
        String(pdf.length + 1),
        '%%EOF',
        '',
    ].join('\n');
    return Buffer.concat([
        pdf,
        Buffer.from(`\n${revision}`, 'latin1'),
    ]);
}

// Issue #893: qpdf can reach these files only by rebuilding their
// cross-reference table, so an append has no revision it can extend.
const DAMAGED_XREF_CASES = [
    [
        'a trailer past the startxref search window',
        (pdf: Buffer) => Buffer.concat([
            pdf,
            Buffer.alloc(4096, 'x'),
        ]),
    ],
    [
        'a startxref comment after the final EOF',
        (pdf: Buffer) => Buffer.concat([
            pdf,
            Buffer.from('\n% startxref\n1\n', 'latin1'),
        ]),
    ],
    [
        'a revision whose /Prev points past the file',
        appendRevisionWithBrokenPrev,
    ],
] as const;
const NAMED_FOREIGN_NOTE_NAME = 'damaged-xref-named-note';
const NAMED_FOREIGN_NOTE_TEXT = 'Named foreign note';
const UNNAMED_FOREIGN_NOTE_TEXT = 'Unnamed foreign note';

async function createGeneratedTextPdfWithForeignNotes() {
    const document = await PDFDocument.load(await readFile(GENERATED_TEXT_FIXTURE), {updateMetadata: false});
    const page = document.getPage(0);
    const {context} = document;
    const note = (rect: number[], contents: string, name?: string) => context.register(context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Text'),
        Rect: rect,
        Contents: PDFHexString.fromText(contents),
        ...(name === undefined ? {} : {NM: PDFHexString.fromText(name)}),
        T: PDFHexString.fromText('Foreign author'),
        P: page.ref,
    }));
    const {
        height, width,
    } = page.getSize();
    page.node.set(PDFName.of('Annots'), context.obj([
        note([
            width * 0.55,
            height * 0.8,
            width * 0.55 + 24,
            height * 0.8 + 24,
        ], NAMED_FOREIGN_NOTE_TEXT, NAMED_FOREIGN_NOTE_NAME),
        note([
            width * 0.75,
            height * 0.8,
            width * 0.75 + 24,
            height * 0.8 + 24,
        ], UNNAMED_FOREIGN_NOTE_TEXT),
    ]));
    return Buffer.from(await document.save({useObjectStreams: false}));
}

// The saved file must be structurally clean, not merely recoverable, and carry
// every page's original text.
async function expectSavedPdfKeepsGeneratedText(path: string) {
    await execFileAsync(getPdfNativeToolPaths().qpdf, [
        '--check',
        path,
    ], {maxBuffer: 1024 * 1024});
    expect(await extractTextWithPdfjs(path)).toEqual(await extractTextWithPdfjs(GENERATED_TEXT_FIXTURE));
}

async function waitForVisibleSidebarNoteText(page: Page, text: string) {
    await openAnnotationsTab(page, 30_000);
    await page.waitForFunction((expectedText: string) => Array.from(
        document.querySelectorAll<HTMLElement>('.editor-pane.is-active .notes-list .note-item'),
    ).some((item) => {
        const rect = item.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && item.textContent?.includes(expectedText);
    }), {timeout: SAVE_TIMEOUT_MS}, text);
}

async function installReceiptProbe(page: Page, pauseCommit: boolean) {
    const installed = await page.evaluate((shouldPause) => {
        const probe: ISaveReceiptProbe = {
            barrierFinished: false,
            nativeProjectionEngaged: false,
            stagedArtifact: null,
        };
        const probeWindow = window as TSaveReceiptProbeWindow;
        probeWindow.__saveReceiptProbe = probe;
        let resumeCommit = () => {};
        const commitBarrier = shouldPause
            ? new Promise<void>((resolve) => {
                resumeCommit = resolve;
            })
            : Promise.resolve();
        probeWindow.__resumeSaveReceiptCommit = () => resumeCommit();
        const barrier = async (stagedArtifact: ITypedStagedArtifact) => {
            probe.nativeProjectionEngaged = true;
            probe.stagedArtifact = stagedArtifact;
            await commitBarrier;
            probe.barrierFinished = true;
        };
        probeWindow.__stagedPdfNativeMutationCommitBarrierForAutomation = barrier;
        return probeWindow.__stagedPdfNativeMutationCommitBarrierForAutomation === barrier;
    }, pauseCommit);
    expect(installed).toBe(true);
}

async function waitForStagedArtifact(page: Page) {
    await page.waitForFunction(
        () => (window as TSaveReceiptProbeWindow).__saveReceiptProbe?.stagedArtifact !== null,
        {timeout: SAVE_TIMEOUT_MS},
    );
    const artifact = await page.evaluate(
        () => (window as TSaveReceiptProbeWindow).__saveReceiptProbe?.stagedArtifact ?? null,
    );
    if (!artifact) {
        throw new Error('Native save did not expose a staged artifact to the receipt probe');
    }
    return artifact;
}

async function captureCommittedCanvasForSaveContinuity(page: Page) {
    await waitForVisibleMountedPdfCanvases(page, SAVE_TIMEOUT_MS);
    await page.waitForFunction((selector) => {
        const canvas = document.querySelector<HTMLCanvasElement>(selector);
        return Boolean(canvas && canvas.width > 0 && canvas.height > 0);
    }, {timeout: SAVE_TIMEOUT_MS}, COMMITTED_FIRST_PAGE_CANVAS_SELECTOR);
    return page.evaluate((selector) => {
        const canvas = document.querySelector<HTMLCanvasElement>(selector);
        const pageContainer = canvas?.closest<HTMLElement>('.page_container');
        if (!pageContainer || !canvas || canvas.width <= 0 || canvas.height <= 0) {
            throw new Error('No committed PDF canvas was available before save');
        }
        const snapshot: ICommittedCanvasContinuitySnapshot = {
            canvasClassName: canvas.className,
            height: canvas.height,
            pageContainerClassName: pageContainer.className,
            width: canvas.width,
        };
        (window as TSaveReceiptProbeWindow).__committedCanvasContinuitySnapshot = snapshot;
        return {
            canvasClassName: snapshot.canvasClassName,
            height: snapshot.height,
            pageContainerClassName: snapshot.pageContainerClassName,
            rendered: pageContainer.classList.contains('page_container--rendered'),
            width: snapshot.width,
        };
    }, COMMITTED_FIRST_PAGE_CANVAS_SELECTOR);
}

function expectVisiblePdfPagesStayedPainted(
    trace: Awaited<ReturnType<typeof stopCommittedSurfaceSampler>>,
) {
    expect(trace.errors ?? []).toEqual([]);
    expect(trace.frames.length).toBeGreaterThan(0);
    expect(trace.frames.some(frame => frame.interactionCheckpoint === 'save-committed')).toBe(true);
    const failures = trace.frames.flatMap((frame) => {
        const visiblePages = frame.visiblePdfPageVisuals ?? [];
        const stayedPainted = ![
            'blank',
            'loader',
        ].includes(frame.kind)
            && frame.outOfFrameSkeletonCount === 0
            && visiblePages.length > 0
            && visiblePages.every(pageVisual => (
                !pageVisual.skeletonVisible
                && pageVisual.canonicalCanvasVisible
                && pageVisual.canonicalCanvasNonblank
            ));
        return stayedPainted
            ? []
            : [{
                elapsedMs: frame.elapsedMs,
                frame: frame.frame,
                kind: frame.kind,
                visiblePages,
            }];
    });
    expect(failures).toEqual([]);
}

async function stopSaveVisualContinuitySampler(page: Page) {
    await markCommittedSurfaceInteractionCheckpoint(page, 'save-committed');
    await waitForAnimationFrames(page, 2);
    return stopCommittedSurfaceSampler(page);
}

async function expectCommittedCanvasSurvivedSave(
    page: Page,
) {
    await waitForVisibleMountedPdfCanvases(page, SAVE_TIMEOUT_MS);
    await page.waitForFunction((selector) => {
        const canvas = document.querySelector<HTMLCanvasElement>(selector);
        return Boolean(canvas && canvas.width > 0 && canvas.height > 0);
    }, {timeout: SAVE_TIMEOUT_MS}, COMMITTED_FIRST_PAGE_CANVAS_SELECTOR);
    const continuity = await page.evaluate((selector) => {
        const snapshot = (window as TSaveReceiptProbeWindow).__committedCanvasContinuitySnapshot;
        if (!snapshot) {
            throw new Error('No committed PDF canvas continuity snapshot was captured before save');
        }
        const canvas = document.querySelector<HTMLCanvasElement>(selector);
        const pageContainer = canvas?.closest<HTMLElement>('.page_container');
        if (!pageContainer || !canvas) {
            throw new Error('No committed PDF canvas was available after save');
        }
        return {
            height: canvas.height,
            rendered: pageContainer.classList.contains('page_container--rendered'),
            sameCanvasClassName: canvas.className === snapshot.canvasClassName,
            sameHeight: canvas.height === snapshot.height,
            samePageContainerClassName: pageContainer.className === snapshot.pageContainerClassName,
            sameWidth: canvas.width === snapshot.width,
            width: canvas.width,
        };
    }, COMMITTED_FIRST_PAGE_CANVAS_SELECTOR);
    expect(continuity).toEqual({
        height: expect.any(Number),
        rendered: true,
        sameCanvasClassName: true,
        sameHeight: true,
        samePageContainerClassName: true,
        sameWidth: true,
        width: expect.any(Number),
    });
    expect(continuity.height).toBeGreaterThan(0);
    expect(continuity.width).toBeGreaterThan(0);
}

const execFileAsync = promisify(execFile);

function readSessionProcessTree(sessionName: string) {
    const info = getSessionInfo(sessionName);
    if (!info) {
        throw new Error(`Electron E2E session '${sessionName}' has no session metadata`);
    }
    const roots = [
        info.pid,
        ...(info.electronPid ? [info.electronPid] : []),
    ];
    return [...new Set(roots.flatMap(pid => [
        pid,
        ...collectDescendantPidsUnix(pid),
    ]))];
}

// `lsof -t` exits 1 when no process holds any of the paths.
async function readOpenHandlePids(paths: readonly string[]) {
    try {
        const {stdout} = await execFileAsync('lsof', [
            '-t',
            '--',
            ...paths,
        ]);
        return stdout.split('\n').map(Number).filter(pid => Number.isInteger(pid) && pid > 0);
    } catch (error) {
        const failure = error as {
            code?: number | string;
            stdout?: string;
        };
        if (Number(failure.code) === 1 && !failure.stdout?.trim()) {
            return [];
        }
        throw error;
    }
}

describe('Electron E2E - save pipeline diagnostics', () => {
    let session: IElectronE2ESession | null = null;

    afterEach(async () => {
        await session?.page.evaluate(() => {
            const probeWindow = window as TSaveReceiptProbeWindow;
            probeWindow.__resumeSaveReceiptCommit?.();
            delete probeWindow.__stagedPdfNativeMutationCommitBarrierForAutomation;
        }).catch(() => undefined);
        if (session) {
            await stopCommittedSurfaceSampler(session.page).catch(() => undefined);
        }
        if (session) {
            await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: SAVE_TIMEOUT_MS})
                .catch(() => undefined);
        }
        await session?.stop();
        session = null;
    });

    it('warns once for encrypted saves, leaves Cancel untouched, and persists suppression', async () => {
        const cancelledPath = await createPasswordProtectedFixturePdf(
            `save-unencrypted-cancel-${Date.now()}.pdf`,
        );
        const suppressedPath = await createPasswordProtectedFixturePdf(
            `save-unencrypted-suppressed-${Date.now()}.pdf`,
        );
        const cancelledBeforeBytes = await readFile(cancelledPath);
        session = await startElectronE2ESession(`e2e-save-unencrypted-${Date.now()}`, {clean: true});
        await openPasswordProtectedPdf(session.page, cancelledPath);
        expect(await readPdfHasEncryptDictionary(cancelledPath)).toBe(true);

        await createDirtyStickyNote(session.page);
        const cancelledSave = saveWithUnencryptedNoticeChoice(
            session.page,
            'cancel',
        );
        await expect(cancelledSave).resolves.toEqual({
            called: true,
            value: false,
        });
        expect(await readFile(cancelledPath)).toEqual(cancelledBeforeBytes);
        expect(await readPdfHasEncryptDictionary(cancelledPath)).toBe(true);

        const continuedSave = saveWithUnencryptedNoticeChoice(
            session.page,
            'continue-and-suppress',
        );
        const continuedSaveResult = await continuedSave;
        expect(continuedSaveResult).toEqual({
            called: true,
            value: true,
        });
        await waitForAutomationEvent(session.page, 'save-committed', {
            path: cancelledPath,
            timeoutMs: SAVE_TIMEOUT_MS,
        });
        expect(await readPdfHasEncryptDictionary(cancelledPath)).toBe(false);
        await session.page.waitForFunction(async () => {
            const settings = (window as ISettingsProbeWindow).electronAPI?.settings;
            return (await settings?.get?.())?.suppressUnencryptedSaveNotice === true;
        }, {timeout: SAVE_TIMEOUT_MS});

        await openPasswordProtectedPdf(session.page, suppressedPath);
        await createDirtyStickyNote(session.page);
        const silentSave = callWorkspaceCommand<boolean>(session.page, 'handleSave');
        await expect(silentSave).resolves.toEqual({
            called: true,
            value: true,
        });
        await waitForAutomationEvent(session.page, 'save-committed', {
            path: suppressedPath,
            timeoutMs: SAVE_TIMEOUT_MS,
        });
        expect(await readPdfHasEncryptDictionary(suppressedPath)).toBe(false);
    }, E2E_TIMEOUT_MS);

    it('writes Optimize As Copy to the chosen destination without changing the source', async () => {
        const sourcePath = await createMultiPageTextFixturePdf(
            `optimize-as-copy-source-${Date.now()}.pdf`,
            2,
        );
        const destinationPath = sourcePath.replace(
            '-source.pdf',
            '-destination.pdf',
        );
        const sourceBeforeBytes = await readFile(sourcePath);
        const sourceBeforeHash = hashBytes(sourceBeforeBytes);
        session = await startElectronE2ESession(`e2e-optimize-as-copy-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_E2E_SAVE_DIALOG_PATH: destinationPath},
            initialOpenPaths: [sourcePath],
        });
        await waitForOpenedPdf(session.page, sourcePath);

        await expect(callWorkspaceCommand<boolean>(
            session.page,
            'handleOptimizePdfForInteraction',
        )).resolves.toEqual({
            called: true,
            value: true,
        });
        await session.page.waitForFunction(
            () => Array.from(document.querySelectorAll('button'))
                .some(button => button.textContent?.trim() === 'Save Optimized Copy'),
            {timeout: SAVE_TIMEOUT_MS},
        );
        await session.page.evaluate(() => Array.from(document.querySelectorAll('button'))
            .find(button => button.textContent?.trim() === 'Save Optimized Copy')
            ?.click());

        await expect.poll(() => existsSync(destinationPath), {timeout: SAVE_TIMEOUT_MS}).toBe(true);
        const destinationBytes = await readFile(destinationPath);
        expect(destinationBytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
        expect(await readPdfPageSnapshots(destinationPath)).toEqual(
            await readPdfPageSnapshots(sourcePath),
        );
        expect(await hashFile(sourcePath)).toBe(sourceBeforeHash);
        await expect(readFile(sourcePath)).resolves.toEqual(sourceBeforeBytes);
    }, E2E_TIMEOUT_MS);

    it('reports a refused Save As once and leaves the open document unmarked', async () => {
        const sourcePath = await createMultiPageTextFixturePdf(
            `save-as-refused-source-${Date.now()}.pdf`,
            2,
        );
        const refusalDirectory = join(dirname(sourcePath), `save-as-refused-${Date.now()}`);
        const destinationPath = join(refusalDirectory, 'refused.pdf');
        await mkdir(refusalDirectory, {recursive: true});
        let heldFileReadyPath: string | null = null;
        let heldFileError: unknown = null;
        let heldFileDone: Promise<void> | null = null;
        const releaseHeldFile = async () => {
            if (heldFileReadyPath === null) return;
            const readyPath = heldFileReadyPath;
            heldFileReadyPath = null;
            await writeFile(`${readyPath}.release`, 'release').catch(() => undefined);
            await heldFileDone;
            if (heldFileError) throw heldFileError;
        };
        if (process.platform === 'win32') {
            const refusedBytes = await readFile(sourcePath);
            await writeFile(destinationPath, refusedBytes);
            const readyPath = join(refusalDirectory, 'refused.ready');
            heldFileReadyPath = readyPath;
            heldFileDone = execFileAsync('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                join(process.cwd(), 'tests', 'integration', 'native', 'hold-file-handle.ps1'),
                '-Path',
                destinationPath,
                '-DurationSeconds',
                '120',
                '-ReadyFile',
                readyPath,
            ], {windowsHide: true}).then(() => undefined, error => {
                heldFileError = error;
            });
            onTestFinished(releaseHeldFile);
            await expect.poll(() => existsSync(readyPath), {timeout: SAVE_TIMEOUT_MS}).toBe(true);
        } else {
            await chmod(refusalDirectory, 0o555);
            onTestFinished(() => chmod(refusalDirectory, 0o755).catch(() => undefined));
        }
        session = await startElectronE2ESession(`e2e-save-as-refused-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_E2E_SAVE_DIALOG_PATH: destinationPath},
            initialOpenPaths: [sourcePath],
        });
        await waitForOpenedPdf(session.page, sourcePath);

        // A notification can close before the command resolves, so every one
        // shown while Save As runs is recorded as it appears.
        await session.page.evaluate(() => {
            const shown: string[] = [];
            const seen = new WeakSet<Element>();
            const selector = '[role="status"], [role="alert"]';
            Reflect.set(window, '__refusedSaveAsNotifications', shown);
            new MutationObserver(() => {
                for (const notification of document.querySelectorAll(selector)) {
                    // One notification nests several live regions; count the
                    // outermost element once, however often its text changes.
                    if (seen.has(notification) || notification.parentElement?.closest(selector)) continue;
                    const text = notification.textContent?.replace(/\s+/gu, ' ').trim() ?? '';
                    if (!text) continue;
                    seen.add(notification);
                    shown.push(text);
                }
            }).observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true,
            });
        });
        await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: SAVE_TIMEOUT_MS});
        const saveAsTriggerPoint = await session.page.evaluate(() => {
            const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.save-split-trigger'))
                .find((candidate) => {
                    const rect = candidate.getBoundingClientRect();
                    const style = window.getComputedStyle(candidate);
                    return !candidate.disabled
                        && style.display !== 'none'
                        && style.visibility !== 'hidden'
                        && rect.width > 8
                        && rect.height > 8;
                });
            if (!button) return null;
            const rect = button.getBoundingClientRect();
            return {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
            };
        });
        if (!saveAsTriggerPoint) throw new Error('The visible Save options button is not enabled');
        await session.page.mouse.click(saveAsTriggerPoint.x, saveAsTriggerPoint.y);
        await session.page.waitForSelector('.save-split-menu', {visible: true});
        const saveAsMenuItemPoint = await session.page.evaluate(() => {
            const item = Array.from(document.querySelectorAll<HTMLElement>('.save-split-item'))
                .find((candidate) => {
                    const rect = candidate.getBoundingClientRect();
                    const style = window.getComputedStyle(candidate);
                    return candidate.textContent?.trim().startsWith('Save As') === true
                        && !candidate.hasAttribute('disabled')
                        && candidate.getAttribute('aria-disabled') !== 'true'
                        && style.display !== 'none'
                        && style.visibility !== 'hidden'
                        && rect.width > 8
                        && rect.height > 8;
                });
            if (!item) return null;
            const rect = item.getBoundingClientRect();
            return {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
            };
        });
        if (!saveAsMenuItemPoint) throw new Error('The visible Save As menu item is not enabled');
        await session.page.mouse.click(saveAsMenuItemPoint.x, saveAsMenuItemPoint.y);
        // The refusal is told once, as a save failure in the user's language
        // (contract I4). The document is still open and intact, so it must not
        // also carry the raw IPC text as an open failure (#837).
        await session.page.waitForFunction(() => (
            (Reflect.get(window, '__refusedSaveAsNotifications') as string[])
                .some(text => text.includes('Failed to save file'))
        ), {timeout: SAVE_TIMEOUT_MS});
        await releaseHeldFile();
        await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: SAVE_TIMEOUT_MS});
        expect((await session.page.evaluate(() => (
            Reflect.get(window, '__refusedSaveAsNotifications') as string[]
        ))).filter(text => text.includes('Failed to save file'))).toHaveLength(1);
        expect(await session.page.evaluate(() => (
            document.querySelector('.app-toast-failure:not([data-state="closed"])')?.textContent?.includes('Failed to open file') ? 'open failure' : null
        ))).toBeNull();
        expect(existsSync(destinationPath)).toBe(process.platform === 'win32');
        if (process.platform === 'win32') {
            await expect(readFile(destinationPath)).resolves.toEqual(await readFile(sourcePath));
        }
    }, E2E_TIMEOUT_MS);

    it('refuses to overwrite a PDF another program replaced after changing one byte', async () => {
        const pdfPath = await createMultiPageTextFixturePdf(`save-external-replace-${Date.now()}.pdf`, 2);
        session = await startElectronE2ESession(`e2e-save-external-replace-${Date.now()}`, {
            clean: true,
            initialOpenPaths: [pdfPath],
        });
        const {page} = session;
        await waitForOpenedPdf(page, pdfPath);
        await openAnnotationsTab(page, 30_000);
        await createFreeTextAnnotationWithPointer(page, `Unsaved edit ${Date.now()}`, {
            x: 0.4,
            y: 0.3,
        });
        await waitForSaveFrontierReady(page);

        // Another program edits the same document and saves it the way editors
        // usually do: write a sibling, then rename it into place.
        const externalBytes = Buffer.from(await readFile(pdfPath));
        const binaryCommentStart = externalBytes.indexOf(Buffer.from([
            0x25,
            0x81,
        ]));
        if (binaryCommentStart < 0) {
            throw new Error('The PDF fixture has no binary comment byte to change');
        }
        const originalCommentByte = externalBytes[binaryCommentStart + 1];
        if (originalCommentByte === undefined) {
            throw new Error('The PDF binary comment is incomplete');
        }
        externalBytes[binaryCommentStart + 1] = originalCommentByte ^ 1;
        const stagedExternalPath = `${pdfPath}.external`;
        await writeFile(stagedExternalPath, externalBytes);
        await rename(stagedExternalPath, pdfPath);

        const baselineEventId = await getLatestAutomationEventId(page);
        await clickEnabledSaveButton(page);

        // The user is told the save did not happen, the other program's file
        // survives byte for byte, and the edit is still waiting to be saved.
        await page.waitForFunction(
            () => Array.from(document.querySelectorAll('[role="status"], [role="alert"]'))
                .some(notification => notification.textContent?.includes('Failed to save file')),
            {timeout: SAVE_TIMEOUT_MS},
        );
        await page.waitForSelector('[aria-label="Last save failed"]', {
            timeout: SAVE_TIMEOUT_MS,
            visible: true,
        });
        await waitForWorkspaceToolbarIdle(page, {timeoutMs: SAVE_TIMEOUT_MS});
        await expect(readFile(pdfPath)).resolves.toEqual(externalBytes);
        expect(await waitForAutomationEvent(page, 'save-committed', {
            afterEventId: baselineEventId,
            path: pdfPath,
            timeoutMs: 1_000,
        }).catch(() => null)).toBeNull();
        expect(await isSaveButtonEnabled(page)).toBe(true);
    }, E2E_TIMEOUT_MS);

    it('saves after another program atomically replaces the original with identical bytes', async () => {
        const pdfPath = await createMultiPageTextFixturePdf(`save-identical-replace-${Date.now()}.pdf`, 2);
        const originalBytes = await readFile(pdfPath);
        session = await startElectronE2ESession(`e2e-save-identical-replace-${Date.now()}`, {
            clean: true,
            initialOpenPaths: [pdfPath],
        });
        await waitForOpenedPdf(session.page, pdfPath);
        await openAnnotationsTab(session.page, 30_000);
        await createFreeTextAnnotationWithPointer(session.page, `Preserved edit ${Date.now()}`, {
            x: 0.4,
            y: 0.3,
        });
        await waitForSaveFrontierReady(session.page);

        const stagedExternalPath = `${pdfPath}.external`;
        await writeFile(stagedExternalPath, originalBytes);
        await rename(stagedExternalPath, pdfPath);

        expect(await clickSaveAndAwaitOutcome(session.page, pdfPath)).toBe('saved');
        expect((await readPdfTextAnnotationRecords(pdfPath)).some(annotation => (
            annotation.contents.startsWith('Preserved edit ')
        ))).toBe(true);

        await session.stop();
        session = await startElectronE2ESession(`e2e-save-identical-replace-reopen-${Date.now()}`, {
            clean: true,
            initialOpenPaths: [pdfPath],
        });
        await waitForOpenedPdf(session.page, pdfPath);
        await session.page.waitForFunction(() => {
            const expose = (window as Window & {__evbFindWorkspaceExpose?: (options: {requiredProperties: string[]}) => {annotationComments?: unknown[] | {value?: unknown[]};} | null;}).__evbFindWorkspaceExpose?.({requiredProperties: ['annotationComments']});
            const comments = Array.isArray(expose?.annotationComments)
                ? expose.annotationComments
                : expose?.annotationComments?.value;
            return comments?.some(comment => (
                typeof comment === 'object'
                && comment !== null
                && 'text' in comment
                && typeof comment.text === 'string'
                && comment.text.startsWith('Preserved edit ')
            )) ?? false;
        }, {timeout: SAVE_TIMEOUT_MS});
    }, E2E_TIMEOUT_MS);


    it.each(DAMAGED_XREF_CASES)(
        'damaged xref admission: saves a typed sticky note into a PDF with %s',
        async (_damage, damage) => {
            const pdfPath = createFixturePath(`save-damaged-xref-new-note-${Date.now()}.pdf`);
            await writeFile(pdfPath, await damage(await readFile(GENERATED_TEXT_FIXTURE)));
            const damagedHash = await hashFile(pdfPath);
            const noteText = `Damaged xref note ${Date.now()}`;
            session = await startElectronE2ESession(`e2e-save-damaged-xref-${Date.now()}`, {
                clean: true,
                initialOpenPaths: [pdfPath],
            });
            await waitForOpenedPdf(session.page, pdfPath);
            await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: SAVE_TIMEOUT_MS});
            // Opening alone writes nothing and leaves nothing to save.
            expect(await isSaveButtonEnabled(session.page)).toBe(false);
            expect(await hashFile(pdfPath)).toBe(damagedHash);

            await createStickyNoteWithPointer(session.page, noteText, {
                x: 0.62,
                y: 0.3,
            });
            await clickLatestVisibleNoteWindowClose(session.page);
            await waitForNoOpenNoteWindows(session.page);
            await waitForSaveFrontierReady(session.page);
            expect(await clickSaveAndAwaitOutcome(session.page, pdfPath)).toBe('saved');

            await expectSavedPdfKeepsGeneratedText(pdfPath);
            const savedNotes = (await readPdfTextAnnotationRecords(pdfPath))
                .filter(note => note.contents === noteText);
            expect(savedNotes).toEqual([expect.objectContaining({subtype: '/Text'})]);
            expect(savedNotes[0]?.popup).not.toBeNull();

            await session.stop();
            session = await startElectronE2ESession(`e2e-save-damaged-xref-reopen-${Date.now()}`, {
                clean: true,
                initialOpenPaths: [pdfPath],
            });
            await waitForOpenedPdf(session.page, pdfPath);
            await waitForVisibleSidebarNoteText(session.page, noteText);
        },
        E2E_TIMEOUT_MS,
    );

    it.each(DAMAGED_XREF_CASES.slice(0, 2))(
        'damaged xref admission: saves an edit to an unnamed existing note in a PDF with %s',
        async (_damage, damage) => {
            const pdfPath = createFixturePath(`save-damaged-xref-existing-note-${Date.now()}.pdf`);
            await writeFile(pdfPath, await damage(await createGeneratedTextPdfWithForeignNotes()));
            const editedText = `Edited unnamed note ${Date.now()}`;
            session = await startElectronE2ESession(`e2e-save-damaged-xref-existing-${Date.now()}`, {
                clean: true,
                initialOpenPaths: [pdfPath],
            });
            await waitForOpenedPdf(session.page, pdfPath);
            await openAnnotationsTab(session.page, 30_000);
            await waitForVisibleSidebarNoteText(session.page, NAMED_FOREIGN_NOTE_TEXT);
            await waitForVisibleSidebarNoteText(session.page, UNNAMED_FOREIGN_NOTE_TEXT);

            const cardId = await session.page.evaluate((expectedText: string) => Array.from(
                document.querySelectorAll<HTMLElement>('.editor-pane.is-active .notes-list .note-item'),
            ).find(item => item.querySelector('.note-item-text')?.textContent?.includes(expectedText))
                ?.dataset.annotationId, UNNAMED_FOREIGN_NOTE_TEXT);
            if (!cardId) {
                throw new Error('The unnamed foreign note has no sidebar card');
            }
            await clickVisibleAnnotationControl(
                session.page,
                `.editor-pane.is-active .note-item[data-annotation-id="${cardId}"] .note-item-content`,
                2,
            );
            const textarea = await session.page.waitForSelector('textarea.note-window__textarea', {
                timeout: SAVE_TIMEOUT_MS,
                visible: true,
            });
            await textarea?.click();
            await selectAllFocusedAnnotationText(session.page);
            await session.page.keyboard.type(editedText, {delay: 10});
            await session.page.keyboard.press('Tab');
            await clickLatestVisibleNoteWindowClose(session.page);
            await waitForNoOpenNoteWindows(session.page);
            await waitForVisibleSidebarNoteText(session.page, editedText);
            await waitForSaveFrontierReady(session.page);
            expect(await clickSaveAndAwaitOutcome(session.page, pdfPath)).toBe('saved');

            await expectSavedPdfKeepsGeneratedText(pdfPath);
            const savedNotes = await readPdfTextAnnotationRecords(pdfPath);
            expect(savedNotes.map(note => note.contents).sort()).toEqual([
                editedText,
                NAMED_FOREIGN_NOTE_TEXT,
            ].sort());
            expect(savedNotes.find(note => note.contents === NAMED_FOREIGN_NOTE_TEXT)?.name)
                .toBe(NAMED_FOREIGN_NOTE_NAME);

            await session.stop();
            session = await startElectronE2ESession(`e2e-save-damaged-xref-existing-reopen-${Date.now()}`, {
                clean: true,
                initialOpenPaths: [pdfPath],
            });
            await waitForOpenedPdf(session.page, pdfPath);
            await waitForVisibleSidebarNoteText(session.page, editedText);
            await waitForVisibleSidebarNoteText(session.page, NAMED_FOREIGN_NOTE_TEXT);
        },
        E2E_TIMEOUT_MS,
    );

    it('uses the configured Unicode display name as the native annotation author', async () => {
        const pdfPath = await createMultiPageTextFixturePdf(`save-author-${Date.now()}.pdf`, 1);
        const author = `E2E Автор café ${Date.now()}`;
        session = await startElectronE2ESession(`e2e-save-author-${Date.now()}`, {
            clean: true,
            initialOpenPaths: [pdfPath],
        });
        await waitForOpenedPdf(session.page, pdfPath);

        await clickVisibleToolbarButton(session.page, 'Settings');
        await session.page.waitForSelector('#settings-author', {
            timeout: SAVE_TIMEOUT_MS,
            visible: true,
        });
        const defaultAuthor = await session.page.$eval(
            '#settings-author',
            element => (element as HTMLInputElement).value.trim(),
        );
        expect(defaultAuthor.length).toBeGreaterThan(0);
        await session.page.click('#settings-author');
        await session.page.$eval(
            '#settings-author',
            element => (element as HTMLInputElement).select(),
        );
        await session.page.keyboard.type(author);
        await waitForPersistedAuthor(session.page, author);
        // Settings opens in a separate empty tab from the shell toolbar. Its
        // start-page variant intentionally has no Back button, so close that
        // tab to return to the already-open PDF.
        await session.page.click('button.tab-close.is-visible');
        await waitForViewerInteractive(session.page, SAVE_TIMEOUT_MS);

        await createDirtyStickyNote(session.page);
        await saveFromWorkspace(session.page, pdfPath);
        const annotations = await readPdfAnnotationDetails(pdfPath);
        expect(annotations.some(annotation => annotation.author === author)).toBe(true);

        await session.stop();
        session = await startElectronE2ESession(`e2e-save-author-reopen-${Date.now()}`, {
            clean: true,
            initialOpenPaths: [pdfPath],
        });
        await waitForOpenedPdf(session.page, pdfPath);
        await session.page.waitForFunction((expectedAuthor) => {
            const expose = (window as Window & {__evbFindWorkspaceExpose?: (options: {requiredProperties: string[]}) => {annotationComments?: unknown[] | {value?: unknown[]};} | null;}).__evbFindWorkspaceExpose?.({requiredProperties: ['annotationComments']});
            const comments = Array.isArray(expose?.annotationComments)
                ? expose.annotationComments
                : expose?.annotationComments?.value;
            return comments?.some(comment => (
                typeof comment === 'object'
                && comment !== null
                && 'author' in comment
                && comment.author === expectedAuthor
            )) ?? false;
        }, {timeout: SAVE_TIMEOUT_MS}, author);

        const secondAuthor = `E2E Второй café ${Date.now()}`;
        await clickVisibleToolbarButton(session.page, 'Settings');
        await session.page.waitForSelector('#settings-author', {
            timeout: SAVE_TIMEOUT_MS,
            visible: true,
        });
        await session.page.click('#settings-author');
        await session.page.$eval(
            '#settings-author',
            element => (element as HTMLInputElement).select(),
        );
        await session.page.keyboard.type(secondAuthor);
        await waitForPersistedAuthor(session.page, secondAuthor);
        await session.page.click('button.tab-close.is-visible');
        await waitForViewerInteractive(session.page, SAVE_TIMEOUT_MS);
        await createDirtyStickyNote(session.page);
        await saveFromWorkspace(session.page, pdfPath);

        const annotationsAfterSecondSave = await readPdfAnnotationDetails(pdfPath);
        expect(annotationsAfterSecondSave.filter(annotation => annotation.author === author)).toHaveLength(2);
        expect(annotationsAfterSecondSave.filter(annotation => annotation.author === secondAuthor)).toHaveLength(2);

        await session.stop();
        session = await startElectronE2ESession(`e2e-save-author-final-reopen-${Date.now()}`, {
            clean: true,
            initialOpenPaths: [pdfPath],
        });
        await waitForOpenedPdf(session.page, pdfPath);
        await session.page.waitForFunction((expectedAuthors) => {
            const expose = (window as Window & {__evbFindWorkspaceExpose?: (options: {requiredProperties: string[]}) => {annotationComments?: unknown[] | {value?: unknown[]};} | null;}).__evbFindWorkspaceExpose?.({requiredProperties: ['annotationComments']});
            const comments = Array.isArray(expose?.annotationComments)
                ? expose.annotationComments
                : expose?.annotationComments?.value;
            const authors = new Set(comments?.flatMap(comment => (
                typeof comment === 'object'
                && comment !== null
                && 'author' in comment
                && typeof comment.author === 'string'
                    ? [comment.author]
                    : []
            )) ?? []);
            return expectedAuthors.every(authorName => authors.has(authorName));
        }, {timeout: SAVE_TIMEOUT_MS}, [
            author,
            secondAuthor,
        ]);
    }, E2E_TIMEOUT_MS);

    it.skipIf(process.platform === 'win32')('does not persist a failed diagnostics grant after an unrelated settings save', async () => {
        const sessionName = `e2e-save-diagnostics-consent-${Date.now()}`;
        session = await startElectronE2ESession(sessionName, {clean: true});
        const userDataPath = electronUserDataPath(session.name);
        await clickVisibleToolbarButton(session.page, 'Settings');
        await session.page.waitForSelector('#settings-author', {
            timeout: SAVE_TIMEOUT_MS,
            visible: true,
        });

        const switchSelector = '[role="switch"][aria-label="Send privacy-sanitized error diagnostics"]';
        const initial = await session.page.$eval(switchSelector, element => element.getAttribute('aria-checked'));
        expect(initial).toBe('false');

        const seedAuthor = `Consent seed ${Date.now()}`;
        await session.page.click('#settings-author');
        await session.page.$eval('#settings-author', element => (element as HTMLInputElement).select());
        await session.page.keyboard.type(seedAuthor);
        await waitForPersistedAuthor(session.page, seedAuthor);
        const settingsPath = join(userDataPath, 'settings.json');
        const backupPath = `${settingsPath}.e2e-backup`;
        await rename(settingsPath, backupPath);
        await mkdir(settingsPath);
        try {
            await session.page.click(switchSelector);
            // The failed save is told in the failure toast, with Retry.
            await session.page.waitForFunction(() => [...document.querySelectorAll('.app-toast-failure')]
                .some(toast => toast.textContent?.includes('Last save failed') && toast.textContent.includes('Retry')), {timeout: SAVE_TIMEOUT_MS});
            const checkedAfterFailure = await session.page.$eval(switchSelector, element => element.getAttribute('aria-checked'));
            expect(checkedAfterFailure).toBe('false');
        } finally {
            await rm(settingsPath, {
                recursive: true,
                force: true,
            });
            await rename(backupPath, settingsPath);
        }

        const author = `Consent recovery ${Date.now()}`;
        await session.page.click('#settings-author');
        await session.page.$eval('#settings-author', element => (element as HTMLInputElement).select());
        await session.page.keyboard.type(author);
        await waitForPersistedAuthor(session.page, author);
        const persisted = JSON.parse(await readFile(settingsPath, 'utf8')) as ISettingsSnapshot;
        expect(persisted.clientDiagnosticsPreference).not.toBe('granted');
        expect(persisted.authorName).toBe(author);
    }, E2E_TIMEOUT_MS);

    it('keeps the rendered page and annotation sidebar mounted while saving applied OCR', async () => {
        const expectedText = 'Searchable document after recognition';
        const pdfPath = await createScannedTextFixturePdf(`save-applied-ocr-${Date.now()}.pdf`, expectedText);
        session = await startElectronE2ESession(`e2e-save-applied-ocr-${Date.now()}`, {
            clean: true,
            initialOpenPaths: [pdfPath],
        });
        await waitForOpenedPdf(session.page, pdfPath);
        const workingPath = await getActiveWorkspaceWorkingCopyPath(session.page);
        const requestId = `save-applied-ocr-${Date.now()}`;
        const ocr = await runOcrSearchablePdf(session.page, workingPath, requestId, expectedText);
        expect(ocr.success).toBe(true);
        await consumeOcrResultIntoActiveWorkspace(session.page, requestId, ocr.pdfPath!, ocr.sourceDocumentRevisionToken!);
        await waitForViewerInteractive(session.page, SAVE_TIMEOUT_MS);
        await openAnnotationsTab(session.page);
        expect((await captureCommittedCanvasForSaveContinuity(session.page)).rendered).toBe(true);
        await session.page.evaluate(() => {
            const sidebar = document.querySelector('.workspace-host[data-workspace-active="true"] .pdf-sidebar');
            if (!sidebar || sidebar.getBoundingClientRect().width === 0) throw new Error('Annotation sidebar is not visible');
            (window as TSaveReceiptProbeWindow).__savedSidebar = sidebar;
        });
        await installCommittedSurfaceSampler(session.page);
        const afterEventId = await getLatestAutomationEventId(session.page);
        await clickVisibleToolbarButton(session.page, 'Save');
        await waitForAutomationEvent(session.page, 'save-committed', {
            afterEventId,
            path: pdfPath,
            timeoutMs: SAVE_TIMEOUT_MS,
        });
        expectVisiblePdfPagesStayedPainted(await stopSaveVisualContinuitySampler(session.page));
        await expectCommittedCanvasSurvivedSave(session.page);
        expect(await session.page.evaluate(() => {
            const original = (window as TSaveReceiptProbeWindow).__savedSidebar;
            return original?.isConnected && original === document.querySelector('.workspace-host[data-workspace-active="true"] .pdf-sidebar');
        })).toBe(true);
        expect(await assertOcrPdfSemanticOutput(pdfPath, expectedText)).toContain(expectedText);
    }, E2E_TIMEOUT_MS);

    it('reuses an unchanged staged receipt and keeps the native save path-backed and live', async () => {
        const pdfPath = await createMultiPageTextFixturePdf(`save-receipt-reuse-${Date.now()}.pdf`, 2);
        session = await startElectronE2ESession(`e2e-save-receipt-reuse-${Date.now()}`, {
            clean: true,
            initialOpenPaths: [pdfPath],
        });
        await waitForOpenedPdf(session.page, pdfPath);
        await installReceiptProbe(session.page, false);
        await createDirtyStickyNote(session.page);
        expect((await captureCommittedCanvasForSaveContinuity(session.page)).rendered).toBe(true);

        await installCommittedSurfaceSampler(session.page);
        await saveFromWorkspace(session.page, pdfPath);
        const firstSaveVisualTrace = await stopSaveVisualContinuitySampler(session.page);
        expectVisiblePdfPagesStayedPainted(firstSaveVisualTrace);
        await expectCommittedCanvasSurvivedSave(session.page);

        const probe = await session.page.evaluate(
            () => (window as TSaveReceiptProbeWindow).__saveReceiptProbe ?? null,
        );
        expect(probe?.stagedArtifact).toMatchObject({
            artifactKind: 'pdf',
            receiptVersion: 2,
        });
        expect(probe?.nativeProjectionEngaged).toBe(true);
        expect(probe?.barrierFinished).toBe(true);
        const sourceState = await readWorkspaceStateValues<{
            pdfSourceState?: IPdfSourceStateSnapshot;
            workingCopyPath?: string | null;
        }>(session.page, [
            'pdfSourceState',
            'workingCopyPath',
        ]);
        expect(sourceState.pdfSourceState).toEqual({
            hasInMemoryData: false,
            reloadKind: 'path',
            reloadPath: sourceState.workingCopyPath,
        });
        expect((await readPdfAnnotationSummary(pdfPath)).bySubtype.Text ?? 0).toBeGreaterThan(0);

        await createDirtyStickyNote(session.page);
        expect((await captureCommittedCanvasForSaveContinuity(session.page)).rendered).toBe(true);
        await installCommittedSurfaceSampler(session.page);
        await saveFromWorkspace(session.page, pdfPath);
        await waitForViewerInteractive(session.page, SAVE_TIMEOUT_MS);
        const secondSaveVisualTrace = await stopSaveVisualContinuitySampler(session.page);
        expectVisiblePdfPagesStayedPainted(secondSaveVisualTrace);
        await expectCommittedCanvasSurvivedSave(session.page);
        expect((await readPdfAnnotationSummary(pdfPath)).bySubtype.Text ?? 0).toBeGreaterThan(1);

        await requireWorkspaceCommand(session.page, 'handleGoToPage', [2]);
        await waitForWorkspaceToolbarSnapshot(session.page, {currentPage: 2}, {timeoutMs: 20_000});
        await waitForViewerInteractive(session.page, 20_000);
    }, E2E_TIMEOUT_MS);

    it.runIf(process.platform !== 'win32')(
        'leaves no process, handle, or partial write behind when the app is stopped hard mid-save',
        async () => {
            const pdfPath = await createMultiPageTextFixturePdf(`save-interrupt-residue-${Date.now()}.pdf`, 1);
            const beforeHash = await hashFile(pdfPath);
            session = await startElectronE2ESession(`e2e-save-interrupt-${Date.now()}`, {
                clean: true,
                initialOpenPaths: [pdfPath],
            });
            await waitForOpenedPdf(session.page, pdfPath);
            await installReceiptProbe(session.page, true);
            await createDirtyStickyNote(session.page);

            // The commit barrier holds the save with its staged artifact and
            // lease live, which is the state a hard stop must not leak.
            const savePromise = callWorkspaceCommand<boolean>(session.page, 'handleSave').then(
                value => ({
                    error: null,
                    value,
                }),
                (error: unknown) => ({
                    error,
                    value: null,
                }),
            );
            const stagedArtifact = await waitForStagedArtifact(session.page);
            expect(existsSync(stagedArtifact.path)).toBe(true);
            const processTree = readSessionProcessTree(session.name);
            expect(processTree.length).toBeGreaterThan(1);

            const interrupted = session;
            session = null;
            await interrupted.browser.disconnect();
            await interrupted.stop({crashElectronBeforeStop: true});
            const saveOutcome = await savePromise;

            const survivors = processTree.filter(isProcessAlive);
            const sessionOwned = findSessionOwnedElectronPids({
                kind: 'electron',
                sessionName: interrupted.name,
            });
            const openHandles = await readOpenHandlePids([
                pdfPath,
                stagedArtifact.path,
            ]);
            const afterHash = await hashFile(pdfPath);
            const diagnostics = JSON.stringify({
                afterHash,
                beforeHash,
                openHandles,
                processTree,
                saveOutcome: saveOutcome.error instanceof Error ? getErrorMessage(saveOutcome.error) : saveOutcome,
                sessionOwned,
                stagedArtifactPath: stagedArtifact.path,
                stagedArtifactRemains: existsSync(stagedArtifact.path),
                survivors,
            }, null, 2);
            expect(survivors, diagnostics).toEqual([]);
            expect(sessionOwned, diagnostics).toEqual([]);
            expect(openHandles, diagnostics).toEqual([]);
            expect(afterHash, diagnostics).toBe(beforeHash);

            session = await startElectronE2ESession(`e2e-save-interrupt-reopen-${Date.now()}`, {
                clean: true,
                initialOpenPaths: [pdfPath],
            });
            await waitForOpenedPdf(session.page, pdfPath);
            expect((await readPdfAnnotationSummary(pdfPath)).bySubtype.Text ?? 0).toBe(0);
        },
        E2E_TIMEOUT_MS,
    );

    it('invalidates a same-size drifted staged artifact before commit', async () => {
        const pdfPath = await createMultiPageTextFixturePdf(`save-receipt-drift-${Date.now()}.pdf`, 1);
        const beforeHash = await hashFile(pdfPath);
        session = await startElectronE2ESession(`e2e-save-receipt-drift-${Date.now()}`, {
            clean: true,
            initialOpenPaths: [pdfPath],
        });
        await waitForOpenedPdf(session.page, pdfPath);
        await installReceiptProbe(session.page, true);
        await createDirtyStickyNote(session.page);

        await clickEnabledSaveButton(session.page);
        let receiptProbeError: unknown = null;
        try {
            const stagedArtifact = await waitForStagedArtifact(session.page);
            const handle = await open(stagedArtifact.path, 'r+');
            try {
                const byte = Buffer.alloc(1);
                await handle.read(byte, 0, 1, 8);
                byte[0] = (byte[0] ?? 0) ^ 1;
                await handle.write(byte, 0, 1, 8);
                await handle.sync();
            } finally {
                await handle.close();
            }
        } catch (error) {
            receiptProbeError = error;
        }
        await session.page.evaluate(
            () => (window as TSaveReceiptProbeWindow).__resumeSaveReceiptCommit?.(),
        );
        if (receiptProbeError) {
            throw receiptProbeError;
        }
        await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: SAVE_TIMEOUT_MS});
        await session.page.waitForSelector('[aria-label="Last save failed"]', {
            timeout: SAVE_TIMEOUT_MS,
            visible: true,
        });
        const probe = await session.page.evaluate(
            () => (window as TSaveReceiptProbeWindow).__saveReceiptProbe ?? null,
        );
        expect(probe?.nativeProjectionEngaged).toBe(true);
        expect(probe?.barrierFinished).toBe(true);
        expect(probe?.stagedArtifact).toMatchObject({
            artifactKind: 'pdf',
            receiptVersion: 2,
        });
        expect(await hashFile(pdfPath)).toBe(beforeHash);
    }, E2E_TIMEOUT_MS);

});
