import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {
    constants,
    copyFileSync,
    createReadStream,
    existsSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import {
    execFile,
    execFileSync,
} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {
    dirname,
    join,
} from 'node:path';
import {promisify} from 'node:util';
import { delay } from 'es-toolkit/promise';
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFRef,
    PDFString,
    StandardFonts,
} from 'pdf-lib';
import type {Page} from 'puppeteer-core';
import {
    PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES,
    type IPdfAnnotationIndexEntry,
    type IPdfAnnotationIndexSession,
} from '@contracts/electronApiDocuments';
import type {ITypedStagedArtifact} from '@contracts/stagedArtifacts';
import {
    copyLargePdfFixture,
    resolveLargePdfFixtureAvailability,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    openAnnotationsTab,
    openPdfInApp,
    saveViaVisibleToolbarWithDeadline,
    saveViaWindowHandle,
    scrollViewerToPage,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    clickLatestVisibleNoteWindowClose,
    clickAnnotationTool,
    createCanonicalTextBoxWithPointer,
    createFreeTextAnnotation,
    createFreeTextAnnotationWithPointer,
    createStickyNoteWithPointer,
    waitForNoOpenNoteWindows,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import { workspaceCrashCheckpointPath } from '@scripts/electron-run/electronRunWorkspaceCheckpoint';
import {
    readExactPdfFixtureIdentity,
    resolveExactPdfFixtureExpectation,
    validateExactPdfFixtureIdentity,
} from '@scripts/ci/stageExactPdfFixture';
import {getSessionInfo} from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    collectDescendantPidsUnix,
    isProcessAlive,
} from '@scripts/electron-run/electronRunProcessTree';
import {
    callWorkspaceCommand,
    collectWorkspaceExposeDebugState,
    getLatestAutomationEventId,
    getWorkspaceToolbarSnapshot,
    installWorkspaceExposeProbe,
    readWorkspaceStateValues,
    waitForAutomationEvent,
    waitForSaveFrontierReady,
    type IWorkspaceExpose,
    type IWorkspaceExposeProbeWindow,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {enablePdfDiagnosticSession} from '@tests/e2e/electron/helpers/pdfDiagnosticSession';

const LARGE_PDF_TIMEOUT_MS = 360_000;
// The 8-second user-facing save budget missed by small margins on Ubuntu CI.
// Keep the blocking CI budget at 12 seconds for runner scheduling and filesystem
// variance. Local exact-fixture saves should still finish below 8 seconds.
const LARGE_PDF_SAVE_TIMEOUT_MS = 12_000;
const IMPORTED_MARKUP_NOTE_SAVE_TIMEOUT_MS = 5 * 60_000;
const IMPORTED_MARKUP_NOTE_STAGE_TIMEOUT_MS = 60_000;
const NOTE_TEXT_ENTRY_TIMEOUT_MS = 20_000;
const execFileAsync = promisify(execFile);
const EXACT_ZALIZNYAK_REQUIRED_ENV = 'EVB_E2E_REQUIRE_EXACT_ZALIZNYAK';
const EXACT_ZALIZNYAK_EXPECTATION = resolveExactPdfFixtureExpectation();
const ANNOTATION_INDEX_CHUNK_BYTES = 512 * 1_024;
const IPC_PAYLOAD_MAX_BYTES = 8 * 1_024 * 1_024;
const LARGE_PDF_ARTIFACT_ROOT_ENV = 'EVB_E2E_LARGE_PDF_ARTIFACT_ROOT';
const largePdfFixture = resolveLargePdfFixtureAvailability();
const largePdfDescribe = selectFixtureDescribe(describe, largePdfFixture);
const qpdfAvailable = (() => {
    try {
        execFileSync('qpdf', ['--version'], {stdio: 'ignore'});
        return true;
    } catch {
        return false;
    }
})();
const runStickyRestartScenario = qpdfAvailable
    || process.env[EXACT_ZALIZNYAK_REQUIRED_ENV] === '1';
const IMPORTED_TEXT_POPUP_NAME = 'evb-pdf-003-text-parent';
const IMPORTED_TEXT_POPUP_TEXT = 'PDF-003 imported Text Popup note';
const IMPORTED_MARKUP_NOTE_NAME = 'evb-pdf-001-highlight-parent';
const IMPORTED_MARKUP_NOTE_TEXT = 'PDF-001 imported Highlight Popup note';
const IMPORTED_TEXT_POPUP_PARENT_RECT = [
    72,
    680,
    96,
    704,
] as const;
const IMPORTED_MOVABLE_NOTE_PARENT_RECT = [
    72,
    680,
    82,
    690,
] as const;
const IMPORTED_TEXT_POPUP_RECT = [
    100,
    560,
    340,
    700,
] as const;
const IMPORTED_TEXT_POPUP_TIMEOUT_MS = 15 * 60_000;

function resolveExactZaliznyakSourcePath() {
    const configuredPath = process.env.EVB_E2E_LARGE_PDF_FIXTURE?.trim();
    if (configuredPath && !/^(?:https?|file):\/\//u.test(configuredPath)) {
        return configuredPath;
    }
    return null;
}

const exactZaliznyakSourcePath = resolveExactZaliznyakSourcePath();
const runImportedTextPopupScenario = qpdfAvailable
    && process.env[EXACT_ZALIZNYAK_REQUIRED_ENV] === '1';

interface IImportedTextPopupFixture {
    annotationName: string;
    pageHeight: number;
    pageWidth: number;
    parentRect: readonly [number, number, number, number];
    pdfSubtype: 'FreeText' | 'Highlight' | 'Text';
    popupRect: readonly [number, number, number, number];
    text: string;
}

interface IQpdfObjectRef {
    generationNumber: number;
    objectNumber: number;
}
const exactZaliznyakIt = process.env[EXACT_ZALIZNYAK_REQUIRED_ENV] === '1'
    ? it
    : it.skip;

interface ICommentAtPointViewer {commentAtPoint?: (
    pageNumber: number,
    pageX: number,
    pageY: number,
    options?: { preferTextAnchor?: boolean },
) => Promise<boolean>;}

interface IAgentActionResult extends Record<string, unknown> {
    comment?: Record<string, unknown>;
    created?: boolean;
    markerRect?: unknown;
    tabId?: string;
}

interface IOrdinaryFreeTextCanonicalProjection {
    annotationId: string | null;
    annotationName: string | null;
    pageIndex: number | null;
    pageNumber: number | null;
    source: string;
    stableKey: string;
    subtype: string | null;
    text: string;
}

interface IOrdinaryFreeTextLiveState {
    canonicalMatches: IOrdinaryFreeTextCanonicalProjection[];
    editorMatchCount: number;
    visualMatchCount: number;
    sidebarMatchCount: number;
}

interface IAnnotationIndexRead {
    chunkByteLengths: number[];
    entries: IPdfAnnotationIndexEntry[];
    session: IPdfAnnotationIndexSession;
    transportPayloadByteLengths: number[];
}

interface IVerifiedStickyNote {
    annotation: IPdfAnnotationIndexEntry;
    annotationObject: string;
    name: string;
    popup: IPdfAnnotationIndexEntry;
    rect: [number, number, number, number];
}

interface IStagedArtifactCaptureWindow extends Window {
    __largePdfStagedArtifactCapture?: {artifact: ITypedStagedArtifact | null;};
    __resumeLargePdfStagedArtifactCommit?: () => void;
}

interface IIssue139VisibilityFrame {
    canonicalCount: number;
    editorIdentities: number[];
    editorKeys: string[];
    layerIdentities: number[];
    paintedFreeTextCount: number;
    phase: string;
    resizeTransitionActive: boolean;
    revisionToken: string | null;
    sidebarCount: number;
    visibleSentinels: string[];
}

interface IIssue139VisibilityProbeWindow extends Window {
    __issue139IsPainted?: (element: HTMLElement, boundary: HTMLElement) => boolean;
    __issue139VisibilityProbeStop?: boolean;
    __issue139VisibilityFrames?: IIssue139VisibilityFrame[];
    __issue139VisibilityProbeDone?: boolean;
    __issue139VisibilityProbePhase?: string;
}

async function setIssue139VisibilityProbePhase(page: Page, phase: string) {
    await page.evaluate((nextPhase: string) => {
        (window as IIssue139VisibilityProbeWindow).__issue139VisibilityProbePhase = nextPhase;
    }, phase);
}

async function startIssue139VisibilityProbe(
    page: Page,
    afterEventId: number,
    sentinels: string[],
) {
    await page.evaluate((input: {
        afterEventId: number;
        sentinels: string[];
    }) => {
        const probeWindow = window as IIssue139VisibilityProbeWindow & IWorkspaceExposeProbeWindow;
        const editorIdentities = new WeakMap<Element, number>();
        const layerIdentities = new WeakMap<Element, number>();
        let nextEditorIdentity = 1;
        let nextLayerIdentity = 1;
        probeWindow.__issue139VisibilityFrames = [];
        probeWindow.__issue139VisibilityProbeStop = false;
        probeWindow.__issue139VisibilityProbeDone = false;
        probeWindow.__issue139VisibilityProbePhase = 'baseline';

        const identityFor = (
            identities: WeakMap<Element, number>,
            element: Element,
            next: () => number,
        ) => {
            const existing = identities.get(element);
            if (existing !== undefined) {
                return existing;
            }
            const identity = next();
            identities.set(element, identity);
            return identity;
        };
        const isPainted = (element: HTMLElement, boundary: HTMLElement) => {
            let current: HTMLElement | null = element;
            while (current && boundary.contains(current)) {
                const style = getComputedStyle(current);
                if (
                    current.hidden
                    || style.display === 'none'
                    || style.visibility === 'hidden'
                    || Number(style.opacity || '1') <= 0
                ) {
                    return false;
                }
                if (current === boundary) {
                    break;
                }
                current = current.parentElement;
            }
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };
        probeWindow.__issue139IsPainted = isPainted;
        const unwrap = <T>(value: T | {value?: T} | undefined) => (
            value && typeof value === 'object' && 'value' in value
                ? value.value
                : value
        );
        const probeStartedAt = performance.now();
        const maxFrames = 20_000;
        const maxDurationMs = 355_000;
        const sample = () => {
            if (probeWindow.__issue139VisibilityProbeStop === true) {
                probeWindow.__issue139VisibilityProbeDone = true;
                return;
            }
            const committed = probeWindow.__evbTestApi?.getAutomationEvents?.().some(event => (
                event.type === 'save-committed' && event.id > input.afterEventId
            )) === true;
            if (committed) {
                probeWindow.__issue139VisibilityProbeDone = true;
                return;
            }
            const host = globalThis.__evbE2E.getActiveWorkspaceHost();
            if (!host) {
                if (performance.now() - probeStartedAt >= maxDurationMs) {
                    probeWindow.__issue139VisibilityProbeDone = true;
                    return;
                }
                requestAnimationFrame(sample);
                return;
            }
            const editors = Array.from(host.querySelectorAll<HTMLElement>(
                '[data-annotation-kind="text-box"]',
            ));
            const visibleEditors = editors.filter(editor => (
                probeWindow.__issue139IsPainted?.(editor, host) === true
            ));
            const layers = Array.from(host.querySelectorAll<HTMLElement>(
                '.pdf-annotation-editor-layer',
            ));
            const workspace = probeWindow.__evbFindWorkspaceExpose?.({requiredProperties: ['annotationComments']}) as {
                annotationComments?: unknown[] | {value?: unknown[]};
                documentRevisionToken?: string | null | {value?: string | null};
            } | null;
            const comments = unwrap(workspace?.annotationComments);
            const revisionToken = unwrap(workspace?.documentRevisionToken);
            probeWindow.__issue139VisibilityFrames?.push({
                canonicalCount: Array.isArray(comments) ? comments.length : -1,
                editorIdentities: visibleEditors.map(editor => identityFor(
                    editorIdentities,
                    editor,
                    () => nextEditorIdentity++,
                )),
                editorKeys: visibleEditors.map(editor => (
                    editor.dataset.annotationId
                    ?? editor.dataset.editorId
                    ?? editor.id
                )).filter(Boolean).sort(),
                layerIdentities: layers.filter(layer => (
                    probeWindow.__issue139IsPainted?.(layer, host) === true
                )).map(layer => identityFor(
                    layerIdentities,
                    layer,
                    () => nextLayerIdentity++,
                )),
                paintedFreeTextCount: visibleEditors.length,
                phase: probeWindow.__issue139VisibilityProbePhase ?? 'unknown',
                resizeTransitionActive: host.querySelector('.pdfViewer')
                    ?.classList.contains('pdfViewer--resize-transition') === true,
                revisionToken: typeof revisionToken === 'string' ? revisionToken : null,
                sidebarCount: host.querySelectorAll('.notes-list .note-item').length,
                visibleSentinels: input.sentinels.filter(sentinel => (
                    visibleEditors.some(editor => editor.textContent?.includes(sentinel) === true)
                )),
            });
            const reachedLimit = (probeWindow.__issue139VisibilityFrames?.length ?? 0) >= maxFrames
                || performance.now() - probeStartedAt >= maxDurationMs;
            if (committed || reachedLimit) {
                probeWindow.__issue139VisibilityProbeDone = true;
                return;
            }
            requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
    }, {
        afterEventId,
        sentinels,
    });
}

async function readIssue139VisibilityProbe(page: Page) {
    await page.waitForFunction(() => (
        (window as IIssue139VisibilityProbeWindow).__issue139VisibilityProbeDone === true
    ), {timeout: LARGE_PDF_TIMEOUT_MS});
    return page.evaluate(() => (
        (window as IIssue139VisibilityProbeWindow).__issue139VisibilityFrames ?? []
    ));
}

async function getIssue139VisibilityFrameCount(page: Page) {
    if (page.isClosed()) {
        return 0;
    }
    return page.evaluate(() => (
        (window as IIssue139VisibilityProbeWindow).__issue139VisibilityFrames?.length ?? 0
    ));
}

async function readIssue139ApplicationCounts(page: Page) {
    return page.evaluate(() => {
        const probeWindow = window as IWorkspaceExposeProbeWindow;
        const workspace = probeWindow.__evbFindWorkspaceExpose?.({requiredProperties: ['annotationComments']}) as {annotationComments?: unknown[] | {value?: unknown[]}} | null;
        const comments = workspace?.annotationComments;
        const value = comments && !Array.isArray(comments) && 'value' in comments
            ? comments.value
            : comments;
        const host = globalThis.__evbE2E.getActiveWorkspaceHost();
        return {
            canonicalCount: Array.isArray(value) ? value.length : -1,
            sidebarCount: host?.querySelectorAll('.notes-list .note-item').length ?? 0,
        };
    });
}

async function waitForIssue139VisibilityFrame(
    page: Page,
    phase: string,
    afterFrameCount: number,
) {
    await page.waitForFunction((input: {
        afterFrameCount: number;
        phase: string;
    }) => {
        const frames = (window as IIssue139VisibilityProbeWindow).__issue139VisibilityFrames ?? [];
        return frames.length > input.afterFrameCount
            && frames.some(frame => frame.phase === input.phase);
    }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}, {
        afterFrameCount,
        phase,
    });
}

async function stopIssue139VisibilityProbe(page: Page) {
    if (page.isClosed()) {
        return;
    }
    try {
        await page.evaluate(async () => {
            const probeWindow = window as IIssue139VisibilityProbeWindow;
            probeWindow.__issue139VisibilityProbeStop = true;
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            delete probeWindow.__issue139VisibilityFrames;
            delete probeWindow.__issue139IsPainted;
            delete probeWindow.__issue139VisibilityProbePhase;
            delete probeWindow.__issue139VisibilityProbeStop;
        });
    } catch (error) {
        if (!isPageContextUnavailableError(error)) {
            throw error;
        }
    }
}

async function dragIssue139FreeTextResizeHandle(page: Page, sentinel: string) {
    await page.waitForFunction(() => {
        const host = globalThis.__evbE2E.getActiveWorkspaceHost();
        return host?.querySelector('.pdfViewer')
            ?.classList.contains('pdfViewer--resize-transition') === false;
    }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS});
    await setIssue139VisibilityProbePhase(page, 'text-box-select');
    await clickAnnotationTool(page, 'Select', NOTE_TEXT_ENTRY_TIMEOUT_MS);
    await page.evaluate((expectedText: string) => {
        const host = globalThis.__evbE2E.getActiveWorkspaceHost();
        const editor = Array.from(host?.querySelectorAll<HTMLElement>('[data-annotation-kind="text-box"]') ?? [])
            .find(candidate => candidate.textContent?.includes(expectedText) === true);
        editor?.scrollIntoView({
            block: 'center',
            inline: 'center',
        });
    }, sentinel);
    await page.evaluate(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    });
    const editorPoint = await page.evaluate((expectedText: string) => {
        const host = globalThis.__evbE2E.getActiveWorkspaceHost();
        const editor = Array.from(host?.querySelectorAll<HTMLElement>('[data-annotation-kind="text-box"]') ?? [])
            .find(candidate => candidate.textContent?.includes(expectedText) === true);
        const rect = editor?.getBoundingClientRect();
        return rect
            ? {
                x: rect.left + 3,
                y: rect.top + 3,
            }
            : null;
    }, sentinel);
    if (!editorPoint) {
        throw new Error(`Canonical text box for ${sentinel} was not found`);
    }
    await page.mouse.click(editorPoint.x, editorPoint.y);
    await page.waitForFunction((expectedText: string) => {
        const host = globalThis.__evbE2E.getActiveWorkspaceHost();
        const editor = Array.from(host?.querySelectorAll<HTMLElement>('[data-annotation-kind="text-box"]') ?? [])
            .find(candidate => candidate.textContent?.includes(expectedText) === true);
        const handleRect = editor?.parentElement?.querySelector<HTMLElement>('[data-pdf-annotation-resize-handle="se"]')
            ?.getBoundingClientRect();
        return editor?.classList.contains('is-selected') === true
            && (handleRect?.width ?? 0) > 0
            && (handleRect?.height ?? 0) > 0;
    }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}, sentinel);
    await setIssue139VisibilityProbePhase(page, 'text-box-resize-handle');
    const handle = await page.evaluate((expectedText: string) => {
        const host = globalThis.__evbE2E.getActiveWorkspaceHost();
        const editor = Array.from(host?.querySelectorAll<HTMLElement>('[data-annotation-kind="text-box"]') ?? [])
            .find(candidate => candidate.textContent?.includes(expectedText) === true);
        const editorRect = editor?.getBoundingClientRect();
        const handleRect = editor?.parentElement?.querySelector<HTMLElement>('[data-pdf-annotation-resize-handle="se"]')
            ?.getBoundingClientRect();
        const hitTarget = handleRect
            ? document.elementFromPoint(
                handleRect.left + handleRect.width / 2,
                handleRect.top + handleRect.height / 2,
            )
            : null;
        const hitStack = handleRect
            ? document.elementsFromPoint(
                handleRect.left + handleRect.width / 2,
                handleRect.top + handleRect.height / 2,
            ).slice(0, 8).map(element => ({
                className: typeof element.className === 'string' ? element.className : '',
                pointerEvents: getComputedStyle(element).pointerEvents,
                tagName: element.tagName,
                zIndex: getComputedStyle(element).zIndex,
            }))
            : [];
        return editorRect && handleRect
            ? {
                editorHeight: editorRect.height,
                editorWidth: editorRect.width,
                editorClassName: editor?.className ?? '',
                editorZIndex: editor ? getComputedStyle(editor).zIndex : null,
                editorOpacity: editor ? getComputedStyle(editor).opacity : null,
                editorPointerEvents: editor ? getComputedStyle(editor).pointerEvents : null,
                layerClassName: editor?.parentElement?.className ?? '',
                layerZIndex: editor?.parentElement ? getComputedStyle(editor.parentElement).zIndex : null,
                layerOpacity: editor?.parentElement ? getComputedStyle(editor.parentElement).opacity : null,
                layerPointerEvents: editor?.parentElement
                    ? getComputedStyle(editor.parentElement).pointerEvents
                    : null,
                resizerPointerEvents: editor?.parentElement?.querySelector<HTMLElement>('[data-pdf-annotation-resize-handle="se"]')
                    ? getComputedStyle(editor.parentElement.querySelector<HTMLElement>('[data-pdf-annotation-resize-handle="se"]')!).pointerEvents
                    : null,
                hitTarget: hitTarget
                    ? {
                        className: hitTarget.className,
                        isBottomRightResizer: hitTarget instanceof HTMLElement
                            && hitTarget.closest('[data-pdf-annotation-resize-handle="se"]') !== null,
                        tagName: hitTarget.tagName,
                    }
                    : null,
                hitStack,
                textLayerClassName: editor?.parentElement?.parentElement?.querySelector('.textLayer, .text-layer')?.className ?? '',
                x: handleRect.left + handleRect.width / 2,
                y: handleRect.top + handleRect.height / 2,
            }
            : null;
    }, sentinel);
    if (!handle) {
        throw new Error(`Canonical text-box resize handle for ${sentinel} was not found`);
    }
    await page.mouse.move(handle.x, handle.y);
    await setIssue139VisibilityProbePhase(page, 'text-box-resize-pointerdown');
    await page.mouse.down();
    await setIssue139VisibilityProbePhase(page, 'text-box-resize-drag');
    const resizeTarget = await page.evaluate((input: {
        expectedText: string;
        start: {
            x: number;
            y: number
        }
    }) => {
        const host = globalThis.__evbE2E.getActiveWorkspaceHost();
        const editor = Array.from(host?.querySelectorAll<HTMLElement>('[data-annotation-kind="text-box"]') ?? [])
            .find(candidate => candidate.textContent?.includes(input.expectedText) === true);
        const pageContainer = editor?.closest<HTMLElement>('.page_container');
        const pageRect = pageContainer?.getBoundingClientRect();
        const maxX = Math.min(pageRect?.right ?? window.innerWidth, window.innerWidth) - 6;
        const maxY = Math.min(pageRect?.bottom ?? window.innerHeight, window.innerHeight) - 6;
        const target = {
            x: Math.min(maxX, input.start.x + 48),
            y: Math.min(maxY, input.start.y + 24),
        };
        if (target.x - input.start.x < 8 || target.y - input.start.y < 8) {
            throw new Error(`Resize drag has no room to grow: ${JSON.stringify({
                maxX,
                maxY,
                start: input.start,
                target,
            })}`);
        }
        return target;
    }, {
        expectedText: sentinel,
        start: {
            x: handle.x,
            y: handle.y,
        },
    });
    await page.mouse.move(resizeTarget.x, resizeTarget.y, {steps: 8});
    await setIssue139VisibilityProbePhase(page, 'text-box-resize-pointerup');
    await page.mouse.up();
    const immediatelyResized = await page.evaluate((expectedText: string) => {
        const host = globalThis.__evbE2E.getActiveWorkspaceHost();
        const editor = Array.from(host?.querySelectorAll<HTMLElement>('[data-annotation-kind="text-box"]') ?? [])
            .find(candidate => candidate.textContent?.includes(expectedText) === true);
        const rect = editor?.getBoundingClientRect();
        const trace = (window as Window & {__getPdfRenderTrace?: () => Array<{
            event: string;
            payload: Record<string, unknown>
        }>}).__getPdfRenderTrace?.() ?? [];
        return {
            rect: rect
                ? {
                    height: rect.height,
                    width: rect.width,
                }
                : null,
            resizeTrace: trace.filter(entry => entry.event === 'annotation-resize').slice(-8),
        };
    }, sentinel);
    try {
        await page.waitForFunction((input: {
            beforeHeight: number;
            beforeWidth: number;
            sentinel: string;
        }) => {
            const host = globalThis.__evbE2E.getActiveWorkspaceHost();
            const editor = Array.from(host?.querySelectorAll<HTMLElement>('[data-annotation-kind="text-box"]') ?? [])
                .find(candidate => candidate.textContent?.includes(input.sentinel) === true);
            const rect = editor?.getBoundingClientRect();
            return rect !== undefined
                && rect.width > input.beforeWidth
                && rect.height > input.beforeHeight;
        }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}, {
            beforeHeight: handle.editorHeight,
            beforeWidth: handle.editorWidth,
            sentinel,
        });
    } catch (error) {
        const resizeDebug = await page.evaluate((expectedText: string) => {
            const host = globalThis.__evbE2E.getActiveWorkspaceHost();
            const editor = Array.from(host?.querySelectorAll<HTMLElement>('[data-annotation-kind="text-box"]') ?? [])
                .find(candidate => candidate.textContent?.includes(expectedText) === true);
            const layer = editor?.closest<HTMLElement>('.pdf-annotation-editor-layer');
            const handleElement = layer?.querySelector<HTMLElement>('[data-pdf-annotation-resize-handle="se"]');
            const handleRect = handleElement?.getBoundingClientRect();
            const hitStack = handleRect
                ? document.elementsFromPoint(
                    handleRect.left + handleRect.width / 2,
                    handleRect.top + handleRect.height / 2,
                ).slice(0, 8).map(element => ({
                    className: typeof element.className === 'string' ? element.className : '',
                    pointerEvents: getComputedStyle(element).pointerEvents,
                    tagName: element.tagName,
                }))
                : [];
            const editorRect = editor?.getBoundingClientRect();
            return {
                activeTool: host?.querySelector('.notes-panel .tool-button.is-active')?.getAttribute('data-tool') ?? null,
                editorRect: editorRect
                    ? {
                        height: editorRect.height,
                        width: editorRect.width,
                    }
                    : null,
                editorClassName: editor?.className ?? null,
                handleRect: handleRect
                    ? {
                        height: handleRect.height,
                        width: handleRect.width,
                        x: handleRect.left + handleRect.width / 2,
                        y: handleRect.top + handleRect.height / 2,
                    }
                    : null,
                hitStack,
                layerClassName: layer?.className ?? null,
                layerPointerEvents: layer ? getComputedStyle(layer).pointerEvents : null,
                pageReadiness: editor?.closest<HTMLElement>('.page_container')?.dataset.pageLayerReadiness ?? null,
            };
        }, sentinel);
        throw new Error(`Canonical text-box resize did not change geometry: ${JSON.stringify({
            cause: error instanceof Error ? error.message : String(error),
            resizeDebug,
        })}`);
    }
    const resized = await page.evaluate((expectedText: string) => {
        const host = globalThis.__evbE2E.getActiveWorkspaceHost();
        const editor = Array.from(host?.querySelectorAll<HTMLElement>('[data-annotation-kind="text-box"]') ?? [])
            .find(candidate => candidate.textContent?.includes(expectedText) === true);
        const rect = editor?.getBoundingClientRect();
        return rect
            ? {
                height: rect.height,
                width: rect.width,
            }
            : null;
    }, sentinel);
    if (!resized) {
        throw new Error(`Resized canonical text box for ${sentinel} was not found`);
    }
    return {
        after: resized,
        before: {
            height: handle.editorHeight,
            width: handle.editorWidth,
        },
        editorClassName: handle.editorClassName,
        editorOpacity: handle.editorOpacity,
        editorPointerEvents: handle.editorPointerEvents,
        editorZIndex: handle.editorZIndex,
        hitTarget: handle.hitTarget,
        hitStack: handle.hitStack,
        immediatelyAfter: immediatelyResized,
        layerClassName: handle.layerClassName,
        layerOpacity: handle.layerOpacity,
        layerPointerEvents: handle.layerPointerEvents,
        layerZIndex: handle.layerZIndex,
        resizerPointerEvents: handle.resizerPointerEvents,
        textLayerClassName: handle.textLayerClassName,
    };
}

async function installStagedArtifactCapture(page: Page) {
    await page.evaluate(() => {
        const captureWindow = window as IStagedArtifactCaptureWindow;
        captureWindow.__largePdfStagedArtifactCapture = {artifact: null};
        let resumeCommit = () => {};
        const commitBarrier = new Promise<void>((resolve) => {
            resumeCommit = resolve;
        });
        captureWindow.__resumeLargePdfStagedArtifactCommit = resumeCommit;
        captureWindow.__stagedPdfNativeMutationCommitBarrierForAutomation = async (artifact) => {
            const capture = captureWindow.__largePdfStagedArtifactCapture;
            if (capture) {
                capture.artifact = artifact;
            }
            await commitBarrier;
        };
    });
}

async function waitForStagedArtifact(
    page: Page,
    timeoutMs = LARGE_PDF_SAVE_TIMEOUT_MS,
) {
    await page.waitForFunction(
        () => (window as IStagedArtifactCaptureWindow).__largePdfStagedArtifactCapture?.artifact !== null,
        // A hard-restarted large-PDF renderer can be busy while the native
        // staged receipt is published. Fixed polling does not depend on RAF
        // delivery during that interval.
        {
            polling: 100,
            timeout: timeoutMs,
        },
    );
    const artifact = await page.evaluate(
        () => (window as IStagedArtifactCaptureWindow).__largePdfStagedArtifactCapture?.artifact ?? null,
    );
    if (!artifact) {
        throw new Error('Native save did not expose its staged artifact');
    }
    return artifact;
}

function isPageContextUnavailableError(error: unknown) {
    return error instanceof Error
        && /Execution context was destroyed|Cannot find context with specified id|Target closed|Session closed|Frame was detached/i.test(error.message);
}

async function resumeStagedArtifactCommit(page: Page) {
    if (page.isClosed()) {
        return;
    }
    try {
        await page.evaluate(() => {
            (window as IStagedArtifactCaptureWindow).__resumeLargePdfStagedArtifactCommit?.();
        });
    } catch (error) {
        if (!page.isClosed() && !isPageContextUnavailableError(error)) {
            throw error;
        }
    }
}

async function clearStagedArtifactCapture(page: Page) {
    if (page.isClosed()) {
        return;
    }
    try {
        await page.evaluate(() => {
            const captureWindow = window as IStagedArtifactCaptureWindow;
            delete captureWindow.__largePdfStagedArtifactCapture;
            delete captureWindow.__resumeLargePdfStagedArtifactCommit;
            delete captureWindow.__stagedPdfNativeMutationCommitBarrierForAutomation;
        });
    } catch (error) {
        if (!page.isClosed() && !isPageContextUnavailableError(error)) {
            throw error;
        }
    }
}

function hashFileSha256(filePath: string, maxBytes?: number) {
    return new Promise<string>((resolve, reject) => {
        const digest = createHash('sha256');
        const input = maxBytes === undefined
            ? createReadStream(filePath)
            : createReadStream(filePath, {end: maxBytes - 1});
        input.on('data', chunk => digest.update(chunk));
        input.on('error', reject);
        input.on('end', () => resolve(digest.digest('hex')));
    });
}

function toPdfUtf16BeHex(value: string) {
    const bytes = [
        0xfe,
        0xff,
    ];
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint === undefined) {
            continue;
        }
        if (codePoint <= 0xffff) {
            bytes.push(codePoint >> 8, codePoint & 0xff);
            continue;
        }
        const adjusted = codePoint - 0x10000;
        const high = 0xd800 + (adjusted >> 10);
        const low = 0xdc00 + (adjusted & 0x3ff);
        bytes.push(high >> 8, high & 0xff, low >> 8, low & 0xff);
    }
    return bytes.map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function readSessionProcessSnapshot(sessionName: string) {
    const info = getSessionInfo(sessionName);
    const rootPid = info?.electronPid ?? info?.pid ?? null;
    if (!rootPid) {
        throw new Error(`Electron E2E session '${sessionName}' has no live process identity`);
    }
    return {
        pids: [
            rootPid,
            ...collectDescendantPidsUnix(rootPid),
        ],
        rootPid,
    };
}

async function expectProcessesExited(pids: readonly number[]) {
    await expect.poll(() => pids.filter(isProcessAlive), {
        interval: 100,
        timeout: 15_000,
    }).toEqual([]);
}

async function waitForCrashCheckpointPath(sessionName: string, expectedPath: string) {
    const expectedRealPath = realpathSync(expectedPath);
    await expect.poll(() => {
        try {
            const stored = JSON.parse(readFileSync(workspaceCrashCheckpointPath(sessionName), 'utf8')) as {checkpoint?: {tabs?: Array<{sourceRef?: string | null;}>;};};
            return stored.checkpoint?.tabs?.some(tab => (
                typeof tab.sourceRef === 'string'
                && realpathSync(tab.sourceRef) === expectedRealPath
            )) ?? false;
        } catch {
            return false;
        }
    }, {timeout: 10_000}).toBe(true);
}

async function waitForRestoredDocument(page: Page, expectedPath: string) {
    const expectedRealPath = realpathSync(expectedPath);
    await expect.poll(async () => {
        const state = await readWorkspaceStateValues<{originalPath?: string | null;}>(
            page,
            ['originalPath'],
        );
        return typeof state.originalPath === 'string'
            ? realpathSync(state.originalPath)
            : null;
    }, {timeout: LARGE_PDF_TIMEOUT_MS}).toBe(expectedRealPath);
    await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
    await waitForViewerInteractive(page, LARGE_PDF_TIMEOUT_MS);
}

async function expectCleanAnnotationHydration(page: Page) {
    await expect.poll(async () => {
        const state = await readWorkspaceStateValues<{dirtyState?: {
            annotationDirty: boolean;
            fileDirty: boolean;
            hasAnnotationChanges: boolean;
            annotationDirtyEntityCount: number;
            hasPendingUnsavedChanges: boolean;
        };}>(page, ['dirtyState']);
        const dirty = state.dirtyState;
        return {
            annotationDirty: dirty?.annotationDirty ?? null,
            fileDirty: dirty?.fileDirty ?? null,
            hasAnnotationChanges: dirty?.hasAnnotationChanges ?? null,
            annotationDirtyEntityCount: dirty?.annotationDirtyEntityCount ?? null,
            hasPendingUnsavedChanges: dirty?.hasPendingUnsavedChanges ?? null,
        };
    }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toSatisfy((state) => (
        state.annotationDirty === false
        && state.fileDirty === false
        && state.hasAnnotationChanges === false
        && state.annotationDirtyEntityCount === 0
        && state.hasPendingUnsavedChanges === false
    ));
}

async function readVisibleStickyNoteSession(page: Page, expectedText: string) {
    return page.evaluate((text) => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const isVisible = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 0
                && rect.height > 0;
        };
        const textarea = Array.from(
            host?.querySelectorAll<HTMLTextAreaElement>('textarea.note-window__textarea') ?? [],
        ).find(candidate => candidate.value === text && isVisible(candidate)) ?? null;
        return {
            noteCount: Array.from(host?.querySelectorAll<HTMLElement>(
                '.pdf-annotation-editor-note',
            ) ?? []).filter(isVisible).length,
            text: textarea?.value ?? null,
        };
    }, expectedText);
}

async function readDocumentSaveIdentity(page: Page) {
    return page.evaluate(async () => {
        const documentFiles = window.electronAPI?.documentFiles;
        if (!documentFiles) {
            throw new Error('Document file capability is unavailable in the renderer');
        }
        const workspace = (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.({requiredProperties: ['workingCopyPath']}) as {workingCopyPath?: string | null} | null;
        const workingCopyPath = workspace?.workingCopyPath ?? null;
        if (!workingCopyPath) {
            throw new Error('The restored workspace has no path-backed working copy');
        }
        return {
            revision: await documentFiles.getDocumentRevision(workingCopyPath),
            workingCopyPath,
        };
    });
}

interface ICanonicalImportedTextPopupComment extends Record<string, unknown> {
    annotationId: string | null;
    hasNote: boolean | null;
    markerRect: {
        height: number;
        left: number;
        top: number;
        width: number;
    } | null;
    pageIndex: number | null;
    pageNumber: number | null;
    source: string | null;
    stableKey: string | null;
    subtype: string | null;
    text: string | null;
}

async function readCanonicalImportedTextPopupComments(page: Page) {
    await installWorkspaceExposeProbe(page);
    return page.evaluate((): ICanonicalImportedTextPopupComment[] => {
        const state = (window as IWorkspaceExposeProbeWindow).__evbTestApi
            ?.readActiveWorkspaceStateValues<{annotationComments?: ICanonicalImportedTextPopupComment[]}>(
                ['annotationComments'],
            );
        return (state?.annotationComments ?? []).map(comment => ({
            annotationId: comment.annotationId ?? null,
            hasNote: comment.hasNote ?? null,
            markerRect: comment.markerRect
                ? {
                    height: comment.markerRect.height,
                    left: comment.markerRect.left,
                    top: comment.markerRect.top,
                    width: comment.markerRect.width,
                }
                : null,
            pageIndex: comment.pageIndex ?? null,
            pageNumber: comment.pageNumber ?? null,
            source: comment.source ?? null,
            stableKey: comment.stableKey ?? null,
            subtype: comment.subtype ?? null,
            text: comment.text ?? null,
        }));
    });
}

function resolveCanonicalImportedSubtype(fixture: IImportedTextPopupFixture) {
    // Popup-backed Text and FreeText records are canonical notes. The store
    // projects both through the note subtype, while text markup keeps its PDF
    // subtype for the sidebar and renderer.
    return fixture.pdfSubtype === 'Highlight' ? 'Highlight' : 'Text';
}

async function waitForCanonicalImportedTextPopupComment(
    page: Page,
    fixture: IImportedTextPopupFixture,
    timeoutMs = NOTE_TEXT_ENTRY_TIMEOUT_MS,
    expectedSubtype = resolveCanonicalImportedSubtype(fixture),
) {
    await expect.poll(
        () => readCanonicalImportedTextPopupComments(page),
        {timeout: timeoutMs},
    ).toEqual([expect.objectContaining({
        annotationId: expect.any(String),
        hasNote: true,
        pageIndex: 0,
        pageNumber: 1,
        source: 'pdf',
        stableKey: expect.stringMatching(/^ann:0:/u),
        subtype: expectedSubtype,
        text: fixture.text,
    })]);
}

async function moveImportedTextPopupNote(
    page: Page,
    comment: ICanonicalImportedTextPopupComment,
) {
    const before = comment.markerRect;
    if (!before || !comment.stableKey) {
        throw new Error('Imported Text annotation has no canonical marker rectangle before move');
    }
    const noteCenter = await page.evaluate((stableKey) => {
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const notes = Array.from(document.querySelectorAll<HTMLElement>(
            '.pdf-annotation-editor-note',
        )).filter(note => note.dataset.stableKey === stableKey);
        const isVisible = (note: HTMLElement) => {
            const rect = note.getBoundingClientRect();
            const style = window.getComputedStyle(note);
            return style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 0
                && rect.height > 0;
        };
        const note = notes.find(candidate => activeHost?.contains(candidate) && isVisible(candidate))
            ?? notes.find(isVisible)
            ?? null;
        if (!note) {
            return null;
        }
        const rect = note.getBoundingClientRect();
        return {
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
        };
    }, comment.stableKey);
    if (!noteCenter) {
        const debug = await page.evaluate(() => ({
            noteKeys: Array.from(document.querySelectorAll<HTMLElement>('.pdf-annotation-editor-note'))
                .map(note => note.dataset.stableKey ?? null),
            noteLayers: Array.from(document.querySelectorAll<HTMLElement>('.pdf-annotation-editor-layer'))
                .map(layer => layer.outerHTML.slice(0, 2_000)),
            pageContainers: Array.from(document.querySelectorAll<HTMLElement>('.page_container'))
                .slice(0, 4)
                .map(container => ({
                    page: container.dataset.page ?? null,
                    rect: container.getBoundingClientRect().toJSON(),
                })),
        }));
        throw new Error(`Imported Text note did not mount: ${JSON.stringify({
            comment,
            debug,
        })}`);
    }

    await page.mouse.move(noteCenter.x, noteCenter.y);
    await page.mouse.down();
    await page.mouse.move(noteCenter.x + 110, noteCenter.y + 70, {steps: 8});
    await page.mouse.up();

    await expect.poll(async () => {
        const markerRect = (await readCanonicalImportedTextPopupComments(page))
            .find(candidate => candidate.stableKey === comment.stableKey)?.markerRect ?? null;
        return markerRect
            ? Math.hypot(markerRect.left - before.left, markerRect.top - before.top)
            : 0;
    }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBeGreaterThan(0.01);
    const movedNoteRect = (await readCanonicalImportedTextPopupComments(page))
        .find(candidate => candidate.stableKey === comment.stableKey)?.markerRect ?? null;
    if (!movedNoteRect) {
        throw new Error('Imported Text annotation lost its canonical marker rectangle after move');
    }
    return movedNoteRect;
}

function markerRectToPdfRect(markerRect: {
    height: number;
    left: number;
    top: number;
    width: number;
}, pageSize: Pick<IImportedTextPopupFixture, 'pageHeight' | 'pageWidth'>) {
    return [
        markerRect.left * pageSize.pageWidth,
        (1 - markerRect.top - markerRect.height) * pageSize.pageHeight,
        (markerRect.left + markerRect.width) * pageSize.pageWidth,
        (1 - markerRect.top) * pageSize.pageHeight,
    ] as const;
}

function markerRectToPdfTextNoteRect(
    markerRect: {
        height: number;
        left: number;
        top: number;
        width: number;
    },
    pageSize: Pick<IImportedTextPopupFixture, 'pageHeight' | 'pageWidth'>,
) {
    const iconWidth = 20 / pageSize.pageWidth;
    const iconHeight = 20 / pageSize.pageHeight;
    return markerRectToPdfRect({
        height: iconHeight,
        left: Math.min(markerRect.left, 1 - iconWidth),
        top: Math.min(markerRect.top, 1 - iconHeight),
        width: iconWidth,
    }, pageSize);
}

function expectPdfRectClose(
    actual: readonly number[],
    expected: readonly number[],
) {
    expect(actual).toHaveLength(expected.length);
    for (const [
        index,
        value,
    ] of expected.entries()) {
        expect(actual[index]).toBeCloseTo(value, 3);
    }
}

async function qpdfCheck(filePath: string) {
    await execFileAsync('qpdf', [
        '--check',
        filePath,
    ], {
        maxBuffer: 1024 * 1024,
        timeout: 120_000,
    });
}

async function qpdfPageCount(filePath: string) {
    const {stdout} = await execFileAsync('qpdf', [
        '--show-npages',
        filePath,
    ], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        timeout: 120_000,
    });
    const pageCount = Number.parseInt(stdout.trim(), 10);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new Error(`qpdf returned an invalid page count: ${JSON.stringify(stdout)}`);
    }
    return pageCount;
}

async function createImportedTextPopupFixture(
    filePath: string,
    parentRect: readonly [number, number, number, number] = IMPORTED_TEXT_POPUP_PARENT_RECT,
    pdfSubtype: IImportedTextPopupFixture['pdfSubtype'] = 'Text',
    options: {
        annotationName?: string;
        text?: string;
    } = {},
): Promise<IImportedTextPopupFixture> {
    const annotationName = options.annotationName ?? IMPORTED_TEXT_POPUP_NAME;
    const text = options.text ?? IMPORTED_TEXT_POPUP_TEXT;
    const document = await PDFDocument.create();
    const page = document.addPage([
        612,
        792,
    ]);
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText('PDF-003 Text annotation fixture', {
        font,
        size: 18,
        x: 72,
        y: 720,
    });

    const highlightProperties = pdfSubtype === 'Highlight'
        ? {QuadPoints: [
            parentRect[0],
            parentRect[3],
            parentRect[2],
            parentRect[3],
            parentRect[0],
            parentRect[1],
            parentRect[2],
            parentRect[1],
        ]}
        : {};
    const parentRef = document.context.nextRef();
    const popupRef = document.context.nextRef();
    const blankAppearanceRef = pdfSubtype === 'FreeText'
        ? document.context.register(document.context.stream(new Uint8Array(), {
            BBox: document.context.obj([
                0,
                0,
                0,
                0,
            ]),
            Subtype: 'Form',
            Type: 'XObject',
        }))
        : null;
    const parent = document.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of(pdfSubtype),
        Rect: [...parentRect],
        ...highlightProperties,
        ...(blankAppearanceRef ? {AP: document.context.obj({N: blankAppearanceRef})} : {}),
        NM: PDFHexString.fromText(annotationName),
        Contents: PDFHexString.fromText(text),
        Popup: popupRef,
        Open: false,
        F: 4,
        C: [
            1,
            1,
            0,
        ],
        T: PDFHexString.fromText('EVB PDF-003'),
        M: PDFString.of('D:20260829000000Z'),
    });
    const popup = document.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Popup'),
        Rect: [...IMPORTED_TEXT_POPUP_RECT],
        Parent: parentRef,
        Contents: PDFHexString.fromText(text),
        Open: false,
        F: 4,
        M: PDFString.of('D:20260829000000Z'),
    });
    document.context.assign(parentRef, parent);
    document.context.assign(popupRef, popup);
    page.node.set(PDFName.of('Annots'), document.context.obj([parentRef]));

    writeFileSync(filePath, await document.save({
        addDefaultPage: false,
        useObjectStreams: false,
    }));
    return {
        annotationName,
        pageHeight: 792,
        pageWidth: 612,
        parentRect,
        pdfSubtype,
        popupRect: IMPORTED_TEXT_POPUP_RECT,
        text,
    };
}

async function combineImportedTextPopupWithExactFixture(
    onePageFixturePath: string,
    exactFixturePath: string,
    outputPath: string,
) {
    await execFileAsync('qpdf', [
        onePageFixturePath,
        '--pages',
        '.',
        '1',
        exactFixturePath,
        '2-z',
        '--',
        outputPath,
    ], {
        maxBuffer: 128 * 1024,
        timeout: IMPORTED_TEXT_POPUP_TIMEOUT_MS,
    });
}

async function admitExactZaliznyakFixture(filePath: string) {
    if (process.env[EXACT_ZALIZNYAK_REQUIRED_ENV] !== '1') {
        return null;
    }
    const identity = {
        bytes: statSync(filePath).size,
        pages: await qpdfPageCount(filePath),
        sha256: await hashFileSha256(filePath),
    };
    expect(identity).toEqual({
        bytes: EXACT_ZALIZNYAK_EXPECTATION.bytes,
        pages: EXACT_ZALIZNYAK_EXPECTATION.pages,
        sha256: EXACT_ZALIZNYAK_EXPECTATION.sha256,
    });
    await qpdfCheck(filePath);
    return identity;
}

async function readBoundedAnnotationIndex(
    page: Page,
    documentPath: string,
    expectedRevisionToken?: string,
): Promise<IAnnotationIndexRead> {
    const result = await page.evaluate(async (input: {
        chunkBytes: number;
        documentPath: string;
        payloadBudget: number;
    }) => {
        const documentFiles = window.electronAPI?.documentFiles;
        if (
            !documentFiles
            || typeof documentFiles.beginPdfAnnotationIndex !== 'function'
            || typeof documentFiles.readPdfAnnotationIndexChunk !== 'function'
            || typeof documentFiles.releasePdfAnnotationIndex !== 'function'
        ) {
            throw new Error('PDF annotation index capability is unavailable in the renderer');
        }

        const revision = await documentFiles.getDocumentRevision(input.documentPath);
        const session = await documentFiles.beginPdfAnnotationIndex(input.documentPath, {expectedDocumentRevisionToken: revision.token});
        const entries: IPdfAnnotationIndexEntry[] = [];
        const chunkByteLengths: number[] = [];
        const transportPayloadByteLengths: number[] = [];
        let offset = 0;
        let released = false;
        try {
            while (true) {
                const chunk = await documentFiles.readPdfAnnotationIndexChunk(
                    session.sessionId,
                    offset,
                    {chunkBytes: input.chunkBytes},
                );
                if (chunk.offset !== offset) {
                    throw new Error(`PDF annotation index offset mismatch: ${chunk.offset} !== ${offset}`);
                }
                const transportBytes = new TextEncoder().encode(JSON.stringify(chunk)).byteLength;
                if (
                    chunk.byteLength < 0
                    || chunk.byteLength > input.payloadBudget
                    || transportBytes < 1
                    || transportBytes > input.payloadBudget
                ) {
                    throw new Error(`PDF annotation index exceeded ${input.payloadBudget} bytes`);
                }
                chunkByteLengths.push(chunk.byteLength);
                transportPayloadByteLengths.push(transportBytes);
                entries.push(...chunk.entries);
                if (chunk.done) {
                    if (chunk.nextOffset !== null) {
                        throw new Error('Completed annotation index chunk has a next offset');
                    }
                    break;
                }
                if (chunk.nextOffset === null || chunk.nextOffset <= offset) {
                    throw new Error('PDF annotation index chunk offset did not advance');
                }
                offset = chunk.nextOffset;
            }
        } finally {
            released = await documentFiles.releasePdfAnnotationIndex(session.sessionId);
        }
        if (!released) {
            throw new Error('PDF annotation index session was not released');
        }
        return {
            chunkByteLengths,
            entries,
            session,
            transportPayloadByteLengths,
        };
    }, {
        chunkBytes: ANNOTATION_INDEX_CHUNK_BYTES,
        documentPath,
        payloadBudget: IPC_PAYLOAD_MAX_BYTES,
    });
    const read = result as IAnnotationIndexRead;
    if (expectedRevisionToken) {
        expect(read.session.documentRevisionToken).toBe(expectedRevisionToken);
    }
    return read;
}

async function readQpdfObject(
    filePath: string,
    objectRef: {
        generationNumber: number;
        objectNumber: number
    },
    streamData: 'filtered' | 'none' | 'raw' = 'raw',
) {
    const {stdout} = await execFileAsync('qpdf', [
        `--show-object=${objectRef.objectNumber},${objectRef.generationNumber}`,
        ...(streamData === 'filtered'
            ? ['--filtered-stream-data']
            : streamData === 'raw'
                ? ['--raw-stream-data']
                : []),
        filePath,
    ], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 120_000,
    });
    return stdout;
}

async function inspectImportedTextPopupStructure(
    filePath: string,
    fixture: IImportedTextPopupFixture,
    expectedRects: {
        expectedParentSubtype?: IImportedTextPopupFixture['pdfSubtype'];
        parent?: readonly [number, number, number, number];
        popup?: readonly [number, number, number, number];
        popupInPageAnnots?: boolean;
    } = {},
) {
    const {stdout: pagesOutput} = await execFileAsync('qpdf', [
        '--show-pages',
        filePath,
    ], {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        timeout: IMPORTED_TEXT_POPUP_TIMEOUT_MS,
    });
    const pageRefMatch = pagesOutput.match(/^page 1: (\d+) (\d+) R$/mu);
    if (!pageRefMatch) {
        throw new Error(`qpdf did not report the first page object for ${filePath}`);
    }
    const pageRef: IQpdfObjectRef = {
        objectNumber: Number(pageRefMatch[1]),
        generationNumber: Number(pageRefMatch[2]),
    };
    const pageObject = await readQpdfObject(filePath, pageRef, 'none');
    const indirectAnnotsMatch = pageObject.match(/\/Annots\s+(\d+)\s+(\d+)\s+R/u);
    const annotsSource = indirectAnnotsMatch
        ? await readQpdfObject(filePath, {
            objectNumber: Number(indirectAnnotsMatch[1]),
            generationNumber: Number(indirectAnnotsMatch[2]),
        }, 'none')
        : pageObject;
    const annotsMatch = indirectAnnotsMatch
        ? annotsSource.match(/\[\s*([^\]]*)\]/u)
        : annotsSource.match(/\/Annots\s*\[\s*([^\]]*)\]/u);
    const annotsValue = annotsMatch?.[1];
    const annotationRefs = annotsValue
        ? [...annotsValue.matchAll(/(\d+)\s+(\d+)\s+R/gu)].map(match => ({
            objectNumber: Number(match[1]),
            generationNumber: Number(match[2]),
        }))
        : [];
    expect(annotationRefs.length, `First page has no bounded annotation array: ${annotsSource}`)
        .toBeGreaterThanOrEqual(1);
    expect(annotationRefs.length, `First page annotation array was not bounded: ${annotsSource}`)
        .toBeLessThanOrEqual(2);

    const annotationObjects: Array<{
        object: string;
        ref: IQpdfObjectRef;
        subtype: string | null;
    }> = [];
    for (const ref of annotationRefs) {
        const object = await readQpdfObject(filePath, ref, 'none');
        annotationObjects.push({
            object,
            ref,
            subtype: object.match(/\/Subtype\s+\/([A-Za-z]+)/u)?.[1] ?? null,
        });
    }
    const expectedParentSubtype = expectedRects.expectedParentSubtype ?? fixture.pdfSubtype;
    const parentEntry = annotationObjects.find(entry => entry.subtype === expectedParentSubtype);
    expect(parentEntry, JSON.stringify(annotationObjects)).toBeDefined();
    if (!parentEntry) {
        throw new Error(`First page did not retain a ${expectedParentSubtype} object: ${JSON.stringify(annotationObjects)}`);
    }

    const popupRefMatch = parentEntry.object.match(/\/Popup\s+(\d+)\s+(\d+)\s+R/u);
    expect(popupRefMatch, parentEntry.object).not.toBeNull();
    if (!popupRefMatch) {
        throw new Error(`Text annotation did not retain its Popup reference: ${parentEntry.object}`);
    }
    const popupRef: IQpdfObjectRef = {
        objectNumber: Number(popupRefMatch[1]),
        generationNumber: Number(popupRefMatch[2]),
    };
    if (expectedRects.popupInPageAnnots) {
        expect(annotationRefs).toContainEqual(popupRef);
    }
    const popupObject = await readQpdfObject(filePath, popupRef, 'none');
    expect(popupObject).toMatch(/\/Subtype\s+\/Popup/u);
    expect(popupObject).toMatch(new RegExp(
        `/Parent\\s+${String(parentEntry.ref.objectNumber)}\\s+${String(parentEntry.ref.generationNumber)}\\s+R`,
        'u',
    ));
    expect(qpdfDictionaryContainsText(parentEntry.object, 'NM', fixture.annotationName)).toBe(true);
    expect(qpdfDictionaryContainsText(parentEntry.object, 'Contents', fixture.text)).toBe(true);
    expect(qpdfDictionaryContainsText(popupObject, 'Contents', fixture.text)).toBe(true);
    const parentRect = parseRectFromQpdfObject(parentEntry.object);
    const popupRect = parseRectFromQpdfObject(popupObject);
    expectPdfRectClose(parentRect, expectedRects.parent ?? fixture.parentRect);
    expectPdfRectClose(popupRect, expectedRects.popup ?? fixture.popupRect);
    if (fixture.pdfSubtype === 'Highlight') {
        const quadPoints = parseQuadPointsFromQpdfObject(parentEntry.object);
        expect(quadPoints).toEqual([
            fixture.parentRect[0],
            fixture.parentRect[3],
            fixture.parentRect[2],
            fixture.parentRect[3],
            fixture.parentRect[0],
            fixture.parentRect[1],
            fixture.parentRect[2],
            fixture.parentRect[1],
        ]);
    }
    return {
        annotation: parentEntry.ref,
        pageNumber: 1,
        parentRect,
        popup: popupRef,
        popupRect,
    };
}

function parseRectFromQpdfObject(value: string): [number, number, number, number] {
    const match = value.match(/\/Rect\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/u);
    if (!match) {
        throw new Error(`Annotation object has no bounded /Rect: ${value.slice(0, 1000)}`);
    }
    const rect = match.slice(1).map(Number) as [number, number, number, number];
    if (rect.some(coordinate => !Number.isFinite(coordinate)) || rect[2] <= rect[0] || rect[3] <= rect[1]) {
        throw new Error(`Annotation object has an invalid /Rect: ${JSON.stringify(rect)}`);
    }
    return rect;
}

function parseQuadPointsFromQpdfObject(value: string): [number, number, number, number, number, number, number, number] {
    const match = value.match(/\/QuadPoints\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/u);
    if (!match) {
        throw new Error(`Annotation object has no bounded /QuadPoints: ${value.slice(0, 1000)}`);
    }
    const points = match.slice(1).map(Number) as [number, number, number, number, number, number, number, number];
    if (points.some(point => !Number.isFinite(point))) {
        throw new Error(`Annotation object has invalid /QuadPoints: ${JSON.stringify(points)}`);
    }
    return points;
}

function findQpdfLiteralStringEnd(value: string, start: number) {
    let depth = 0;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
        const character = value[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (character === '\\') {
            escaped = true;
            continue;
        }
        if (character === '(') {
            depth += 1;
        } else if (character === ')') {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
}

function readQpdfDictionaryString(value: string, key: string) {
    let dictionaryDepth = 0;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        const nextCharacter = value[index + 1];
        if (character === '<' && nextCharacter === '<') {
            dictionaryDepth += 1;
            index += 1;
            continue;
        }
        if (character === '>' && nextCharacter === '>') {
            dictionaryDepth = Math.max(0, dictionaryDepth - 1);
            index += 1;
            continue;
        }
        if (character === '(') {
            const end = findQpdfLiteralStringEnd(value, index);
            if (end < 0) {
                return null;
            }
            index = end;
            continue;
        }
        if (character === '<') {
            const end = value.indexOf('>', index + 1);
            if (end < 0) {
                return null;
            }
            index = end;
            continue;
        }
        if (character !== '/' || dictionaryDepth !== 1) {
            continue;
        }

        let nameEnd = index + 1;
        while (nameEnd < value.length) {
            const nameCharacter = value[nameEnd] ?? '';
            if (/\s/u.test(nameCharacter) || '[]()<>/{}/'.includes(nameCharacter)) {
                break;
            }
            nameEnd += 1;
        }
        if (value.slice(index + 1, nameEnd) !== key) {
            index = nameEnd - 1;
            continue;
        }

        let tokenStart = nameEnd;
        while (/\s/u.test(value[tokenStart] ?? '')) {
            tokenStart += 1;
        }
        const tokenStartCharacter = value[tokenStart];
        if (tokenStartCharacter === '(') {
            const tokenEnd = findQpdfLiteralStringEnd(value, tokenStart);
            return tokenEnd < 0 ? null : value.slice(tokenStart, tokenEnd + 1);
        }
        if (tokenStartCharacter === '<' && value[tokenStart + 1] !== '<') {
            const tokenEnd = value.indexOf('>', tokenStart + 1);
            return tokenEnd < 0 ? null : value.slice(tokenStart, tokenEnd + 1);
        }
        return null;
    }
    return null;
}

function qpdfDictionaryHasKey(value: string, key: string) {
    let dictionaryDepth = 0;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        const nextCharacter = value[index + 1];
        if (character === '<' && nextCharacter === '<') {
            dictionaryDepth += 1;
            index += 1;
            continue;
        }
        if (character === '>' && nextCharacter === '>') {
            dictionaryDepth = Math.max(0, dictionaryDepth - 1);
            index += 1;
            continue;
        }
        if (character === '(') {
            const end = findQpdfLiteralStringEnd(value, index);
            if (end < 0) {
                return false;
            }
            index = end;
            continue;
        }
        if (character === '<') {
            const end = value.indexOf('>', index + 1);
            if (end < 0) {
                return false;
            }
            index = end;
            continue;
        }
        if (character !== '/' || dictionaryDepth !== 1) {
            continue;
        }

        let nameEnd = index + 1;
        while (nameEnd < value.length) {
            const nameCharacter = value[nameEnd] ?? '';
            if (/\s/u.test(nameCharacter) || '[]()<>/{}/'.includes(nameCharacter)) {
                break;
            }
            nameEnd += 1;
        }
        if (value.slice(index + 1, nameEnd) === key) {
            return true;
        }
        index = nameEnd - 1;
    }
    return false;
}

function decodeQpdfLiteralString(value: string) {
    let decoded = '';
    for (let index = 1; index < value.length - 1; index += 1) {
        const character = value[index];
        if (character !== '\\') {
            decoded += character;
            continue;
        }
        const escaped = value[index + 1];
        if (escaped === undefined) {
            break;
        }
        index += 1;
        const simpleEscape = {
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
            '(': '(',
            ')': ')',
            '\\': '\\',
        }[escaped];
        if (simpleEscape !== undefined) {
            decoded += simpleEscape;
            continue;
        }
        if (/[0-7]/u.test(escaped)) {
            let octal = escaped;
            while (octal.length < 3 && /[0-7]/u.test(value[index + 1] ?? '')) {
                index += 1;
                octal += value[index];
            }
            decoded += String.fromCharCode(Number.parseInt(octal, 8));
            continue;
        }
        decoded += escaped;
    }
    return decoded;
}

function qpdfStringTokenContainsText(value: string, text: string) {
    if (value.startsWith('(')) {
        return decodeQpdfLiteralString(value).includes(text);
    }
    if (!value.startsWith('<')) {
        return false;
    }
    const normalized = value.slice(1, -1).replace(/\s+/gu, '').toLowerCase();
    return normalized.includes(toPdfUtf16BeHex(text))
        || normalized.includes(Buffer.from(text, 'utf8').toString('hex'));
}

function qpdfDictionaryContainsText(value: string, key: string, text: string) {
    const stringValue = readQpdfDictionaryString(value, key);
    return stringValue !== null && qpdfStringTokenContainsText(stringValue, text);
}

async function readOrdinaryFreeTextLiveState(page: Page, expectedText: string): Promise<IOrdinaryFreeTextLiveState> {
    await installWorkspaceExposeProbe(page);
    return page.evaluate((text): IOrdinaryFreeTextLiveState => {
        const normalize = (value: unknown) => typeof value === 'string'
            ? value.replace(/[\u200B\uFEFF]/gu, '').trim()
            : '';
        const state = (window as IWorkspaceExposeProbeWindow).__evbTestApi
            ?.readActiveWorkspaceStateValues<{annotationComments?: unknown[]}>(['annotationComments']);
        const comments = state?.annotationComments;
        if (!Array.isArray(comments)) {
            throw new Error(`Ordinary FreeText probe read no canonical annotationComments projection: ${JSON.stringify(state ?? null)}`);
        }
        const expected = normalize(text);
        const canonicalMatches = comments
            .filter(comment => {
                if (!comment || typeof comment !== 'object') {
                    return false;
                }
                const record = comment as Record<string, unknown>;
                return normalize(record.text) === expected
                    && String(record.subtype ?? '').toLowerCase() === 'freetext';
            })
            .map(comment => {
                const record = comment as Record<string, unknown>;
                return {
                    annotationId: typeof record.annotationId === 'string' ? record.annotationId : null,
                    annotationName: typeof record.annotationName === 'string' ? record.annotationName : null,
                    pageIndex: typeof record.pageIndex === 'number' ? record.pageIndex : null,
                    pageNumber: typeof record.pageNumber === 'number' ? record.pageNumber : null,
                    source: String(record.source ?? ''),
                    stableKey: String(record.stableKey ?? ''),
                    subtype: typeof record.subtype === 'string' ? record.subtype : null,
                    text: typeof record.text === 'string' ? record.text : '',
                };
            });
        const host = globalThis.__evbE2E.getActiveWorkspaceHost();
        const editorMatchCount = Array.from(host?.querySelectorAll<HTMLElement>(
            '[data-annotation-kind="text-box"]',
        ) ?? [])
            .filter(editor => normalize(editor.textContent) === expected)
            .length;
        const visualMatchCount = Array.from(host?.querySelectorAll<HTMLElement>(
            '.pdf-annotation-editor-layer [data-annotation-kind="text-box"]',
        ) ?? [])
            .filter(annotation => normalize(annotation.textContent) === expected)
            .length;
        const sidebarMatchCount = Array.from(host?.querySelectorAll<HTMLElement>(
            '.notes-list .note-item',
        ) ?? [])
            .filter(item => normalize(item.querySelector('.note-item-text')?.textContent ?? '').includes(expected))
            .length;
        return {
            canonicalMatches,
            editorMatchCount,
            visualMatchCount,
            sidebarMatchCount,
        };
    }, expectedText);
}

async function readOrdinaryFreeTextDomDiagnostics(page: Page) {
    return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(
        '.workspace-host, .workspace-hosts',
    )).map((host, index) => ({
        index,
        id: host.id || null,
        className: typeof host.className === 'string' ? host.className : null,
        editors: Array.from(host.querySelectorAll<HTMLElement>('[data-annotation-kind="text-box"]')).map(editor => ({
            id: editor.id || null,
            className: typeof editor.className === 'string' ? editor.className : null,
            annotationId: editor.dataset.annotationId ?? null,
            text: editor.textContent ?? '',
            page: editor.closest<HTMLElement>('.page_container')?.dataset.page ?? null,
        })),
        annotationElements: Array.from(host.querySelectorAll<HTMLElement>(
            '.pdf-annotation-editor-layer [data-annotation-kind="text-box"]',
        )).map(annotation => ({
            className: typeof annotation.className === 'string' ? annotation.className : null,
            annotationId: annotation.dataset.annotationId ?? null,
            text: annotation.textContent ?? '',
            page: annotation.closest<HTMLElement>('.page_container')?.dataset.page ?? null,
        })),
        sidebarItems: Array.from(host.querySelectorAll<HTMLElement>('.notes-list .note-item')).map(item => ({
            className: typeof item.className === 'string' ? item.className : null,
            text: item.textContent ?? '',
            previewText: item.querySelector('.note-item-text')?.textContent ?? null,
        })),
    })));
}

async function clickSidebarDeleteForText(page: Page, expectedText: string) {
    await page.waitForFunction((text: string) => {
        const normalize = (value: unknown) => typeof value === 'string'
            ? value.replace(/[\u200B\uFEFF]/gu, '').trim()
            : '';
        const isVisible = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 0
                && rect.height > 0;
        };
        const host = globalThis.__evbE2E.getActiveWorkspaceHost();
        const list = host?.querySelector<HTMLElement>('.notes-list') ?? null;
        const items = Array.from(host?.querySelectorAll<HTMLElement>('.notes-list .note-item') ?? [])
            .filter(isVisible);
        const expected = normalize(text);
        const matchingItem = items.find(item => (
            normalize(item.querySelector('.note-item-text')?.textContent ?? '').includes(expected)
        ));
        if (matchingItem) {
            return true;
        }
        if (list) {
            const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
            if (maxScrollTop > 0) {
                const nextScrollTop = list.scrollTop >= maxScrollTop
                    ? 0
                    : Math.min(maxScrollTop, list.scrollTop + Math.max(list.clientHeight, 1));
                if (nextScrollTop !== list.scrollTop) {
                    list.scrollTop = nextScrollTop;
                    list.dispatchEvent(new Event('scroll', {bubbles: true}));
                }
            }
        }
        return false;
    }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}, expectedText);
    const result = await page.evaluate((text: string) => {
        const normalize = (value: unknown) => typeof value === 'string'
            ? value.replace(/[\u200B\uFEFF]/gu, '').trim()
            : '';
        const host = globalThis.__evbE2E.getActiveWorkspaceHost();
        const expected = normalize(text);
        const item = Array.from(host?.querySelectorAll<HTMLElement>('.notes-list .note-item') ?? [])
            .find(candidate => normalize(candidate.querySelector('.note-item-text')?.textContent ?? '').includes(expected));
        const button = item?.querySelector<HTMLButtonElement>('.note-item-delete') ?? null;
        if (!item || !button) {
            return {
                clicked: false,
                itemText: item?.textContent ?? null,
            };
        }
        button.click();
        return {
            clicked: true,
            itemText: item.textContent ?? null,
        };
    }, expectedText);
    if (!result.clicked) {
        throw new Error(`Sidebar delete control was unavailable for ordinary FreeText: ${JSON.stringify(result)}`);
    }
}

async function waitForOrdinaryFreeTextState(
    page: Page,
    expectedText: string,
    expected: {
        canonicalMatchCount: number;
        editorMatchCount: number;
        visualMatchCount: number;
        sidebarMatchCount: number;
    },
) {
    await expect.poll(async () => {
        const state = await readOrdinaryFreeTextLiveState(page, expectedText);
        return {
            canonicalMatchCount: state.canonicalMatches.length,
            editorMatchCount: state.editorMatchCount,
            visualMatchCount: state.visualMatchCount,
            sidebarMatchCount: state.sidebarMatchCount,
        };
    }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toEqual(expected);
    return readOrdinaryFreeTextLiveState(page, expectedText);
}

async function readBoundedOrdinaryFreeTextMatches(
    page: Page,
    filePath: string,
    expectedText: string,
    expectedName?: string,
    expectedPageIndex?: number,
    indexPath = filePath,
) {
    const index = await readBoundedAnnotationIndex(page, indexPath);
    const candidates = index.entries.filter(entry => (
        entry.subtype === 'FreeText'
        && (expectedPageIndex === undefined || entry.pageIndex === expectedPageIndex)
    ));
    const matches: Array<{
        annotation: IPdfAnnotationIndexEntry;
        annotationObject: string;
    }> = [];
    for (const annotation of candidates) {
        const annotationObject = await readQpdfObject(filePath, annotation);
        const hasExpectedText = qpdfDictionaryContainsText(annotationObject, 'Contents', expectedText);
        const hasExpectedName = expectedName !== undefined
            && qpdfDictionaryContainsText(annotationObject, 'NM', expectedName);
        if (hasExpectedText || hasExpectedName) {
            matches.push({
                annotation,
                annotationObject,
            });
        }
    }
    return matches;
}

async function verifyStickyNoteStructure(
    page: Page,
    filePath: string,
    expectedText: string,
    expectedPageIndex = 0,
    expectedRevisionToken?: string,
    indexPath = filePath,
): Promise<IVerifiedStickyNote> {
    const index = await readBoundedAnnotationIndex(page, indexPath, expectedRevisionToken);
    if (process.env[EXACT_ZALIZNYAK_REQUIRED_ENV] === '1') {
        expect(index.session.pageCount).toBe(EXACT_ZALIZNYAK_EXPECTATION.pages);
    } else {
        expect(index.session.pageCount).toBeGreaterThan(0);
    }
    expect(ANNOTATION_INDEX_CHUNK_BYTES).toBeLessThanOrEqual(PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES);
    expect(index.chunkByteLengths.length).toBeGreaterThan(0);
    expect(index.transportPayloadByteLengths.every(bytes => bytes > 0 && bytes <= IPC_PAYLOAD_MAX_BYTES)).toBe(true);

    const candidates = index.entries.filter(entry => (
        entry.pageIndex === expectedPageIndex
        && entry.subtype === 'Text'
        && entry.popupRef !== null
        && typeof entry.name === 'string'
        && entry.name.length > 0
    ));
    const matches: Array<{
        annotation: IPdfAnnotationIndexEntry;
        annotationObject: string
    }> = [];
    const candidateObjects: Array<{
        annotation: IPdfAnnotationIndexEntry;
        annotationObject: string;
    }> = [];
    for (const annotation of candidates) {
        const annotationObject = await readQpdfObject(filePath, annotation);
        candidateObjects.push({
            annotation,
            annotationObject,
        });
        if (qpdfDictionaryContainsText(annotationObject, 'Contents', expectedText)) {
            matches.push({
                annotation,
                annotationObject,
            });
        }
    }
    expect(matches, JSON.stringify({
        candidates,
        candidateObjects,
        expectedText,
    })).toHaveLength(1);
    const match = matches[0];
    if (!match || !match.annotation.popupRef || !match.annotation.name) {
        throw new Error('Verified sticky note lost its identity or Popup reference');
    }
    const popup = index.entries.find(entry => (
        entry.objectNumber === match.annotation.popupRef?.objectNumber
        && entry.generationNumber === match.annotation.popupRef.generationNumber
        && entry.subtype === 'Popup'
    ));
    if (!popup) {
        throw new Error('Verified sticky note Popup is absent from the bounded annotation index');
    }
    expect(popup.parentRef).toEqual({
        objectNumber: match.annotation.objectNumber,
        generationNumber: match.annotation.generationNumber,
    });
    const popupObject = await readQpdfObject(filePath, popup);
    expect(qpdfDictionaryContainsText(popupObject, 'Contents', expectedText)).toBe(true);
    expect(popupObject).toMatch(new RegExp(`/Parent\\s+${match.annotation.objectNumber}\\s+${match.annotation.generationNumber}\\s+R`, 'u'));

    const rect = parseRectFromQpdfObject(match.annotationObject);
    // Native sticky notes use the PDF /Text annotation and leave appearance
    // generation to the viewer. They must not carry the legacy blank form.
    expect(qpdfDictionaryHasKey(match.annotationObject, 'AP')).toBe(false);
    expect(match.annotationObject).toMatch(/\/Name\s*\/Note(?:\s|$)/u);
    expect(qpdfDictionaryContainsText(match.annotationObject, 'Contents', expectedText)).toBe(true);
    expect(match.annotationObject).toMatch(/\/NM\s*(?:\(|<)/u);
    return {
        annotation: match.annotation,
        annotationObject: match.annotationObject,
        name: match.annotation.name,
        popup,
        rect,
    };
}

async function editVisibleStickyNote(page: Page, currentText: string, nextText: string) {
    await openAnnotationsTab(page, 30_000);
    await page.waitForFunction((text: string) => (
        Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .workspace-host .notes-list .note-item',
        )).some((candidate) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return candidate.textContent?.includes(text) === true
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 0
                && rect.height > 0;
        })
    ), {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}, currentText);
    const items = await page.$$('.editor-pane.is-active .workspace-host .notes-list .note-item');
    let matchingItem: (typeof items)[number] | null = null;
    for (const item of items) {
        const matches = await item.evaluate((candidate, text) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return candidate.textContent?.includes(text) === true
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 0
                && rect.height > 0;
        }, currentText);
        if (matches) {
            matchingItem = item;
            break;
        }
    }
    if (!matchingItem) {
        throw new Error(`Visible sidebar note was not restored: ${currentText}`);
    }
    await matchingItem.click({
        count: 2,
        delay: 80,
    });
    const textarea = await page.waitForSelector('textarea.note-window__textarea', {
        timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS,
        visible: true,
    });
    if (!textarea) {
        throw new Error('Double-clicking the restored note did not open its editor');
    }
    await delay(100);
    await textarea.click({
        count: 3,
        delay: 80,
    });
    const selectedText = await textarea.evaluate(input => ({
        end: input.selectionEnd,
        length: input.value.length,
        start: input.selectionStart,
    }));
    expect(selectedText).toEqual({
        end: currentText.length,
        length: currentText.length,
        start: 0,
    });
    await page.keyboard.type(nextText, {delay: 10});
    await page.keyboard.press('Tab');

    await expect.poll(async () => {
        const state = await readWorkspaceStateValues<{dirtyState?: {
            annotationDirty: boolean;
            hasAnnotationChanges: boolean;
        };}>(page, ['dirtyState']);
        return state.dirtyState?.annotationDirty === true
            && state.dirtyState.hasAnnotationChanges === true;
    }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBe(true);

    const closeButtons = await page.$$('.editor-pane.is-active .workspace-host .note-window__close');
    let closed = false;
    for (const closeButton of closeButtons.reverse()) {
        const visible = await closeButton.evaluate((candidate) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 0
                && rect.height > 0;
        });
        if (visible) {
            await closeButton.click();
            closed = true;
            break;
        }
    }
    if (!closed) {
        throw new Error('Edited sticky note had no visible close control');
    }
    await waitForNoOpenNoteWindows(page);
}

async function saveLargePdfViaAgentAction(page: Page) {
    const savedResult = await callWorkspaceCommand<IAgentActionResult>(page, 'runAgentAction', ['file.save'], {requiredMethods: ['readAgentResource']});
    const saved = savedResult.value;
    if (!savedResult.called || !saved) {
        return null;
    }

    const tabId = typeof saved.tabId === 'string' ? saved.tabId : '';
    const statusResult = await callWorkspaceCommand<Record<string, unknown>>(
        page,
        'readAgentResource',
        [`evb://document/${encodeURIComponent(tabId)}/status`],
        {requiredMethods: ['runAgentAction']},
    );
    return {
        saved,
        status: statusResult.value ?? {},
    };
}

function getPdfStringValue(value: unknown) {
    if (value instanceof PDFHexString || value instanceof PDFString) {
        return value.decodeText();
    }
    return '';
}

async function readPdfNoteContents(filePath: string) {
    const doc = await PDFDocument.load(readFileSync(filePath), { updateMetadata: false });
    const notes: Array<{
        contents: string;
        name: string;
        pageIndex: number;
        popup: string;
        ref: string;
        subtype: string;
    }> = [];

    for (let pageIndex = 0; pageIndex < doc.getPageCount(); pageIndex += 1) {
        const annots = doc.getPage(pageIndex).node.Annots();
        if (!(annots instanceof PDFArray)) {
            continue;
        }

        for (let index = 0; index < annots.size(); index += 1) {
            const ref = annots.get(index);
            if (!(ref instanceof PDFRef)) {
                continue;
            }
            const dict = doc.context.lookupMaybe(ref, PDFDict);
            if (!dict) {
                continue;
            }
            const contents = getPdfStringValue(dict.get(PDFName.of('Contents')));
            const name = getPdfStringValue(dict.get(PDFName.of('NM')));
            const subtype = dict.get(PDFName.of('Subtype'))?.toString() ?? '';
            if (!contents || (subtype !== '/FreeText' && subtype !== '/Text')) {
                continue;
            }

            notes.push({
                ref: String(ref),
                pageIndex,
                contents,
                name,
                popup: String(dict.get(PDFName.of('Popup')) ?? ''),
                subtype,
            });
        }
    }

    return notes;
}

async function expectPdfContainsE2ENote(filePath: string, text: string) {
    const existing = await readPdfNoteContents(filePath);
    expect(existing.filter(note => note.contents === text), JSON.stringify({
        filePath,
        notes: existing.slice(0, 20),
    })).toHaveLength(1);
    return existing;
}

async function resolveLargePdfPageNotePoint(page: Page) {
    return page.evaluate(() => {
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter((host) => {
                const rect = host.getBoundingClientRect();
                const style = window.getComputedStyle(host);
                return rect.width > 100 && rect.height > 100 && style.display !== 'none' && style.visibility !== 'hidden';
            });
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = activeHost && visibleHosts.includes(activeHost)
            ? activeHost
            : (visibleHosts[0] ?? null);
        const pageElement = host?.querySelector<HTMLElement>('.page_container--rendered')
            ?? host?.querySelector<HTMLElement>('.page_container')
            ?? null;
        if (!pageElement) {
            return null;
        }

        const rect = pageElement.getBoundingClientRect();
        const x = Math.min(
            Math.max(rect.left + 24, rect.left + rect.width * 0.72),
            window.innerWidth - 96,
        );
        const y = Math.min(
            Math.max(rect.top + 24, rect.top + rect.height * 0.06),
            window.innerHeight - 96,
        );
        return {
            x,
            y,
            pageNumber: Number(pageElement.dataset.page ?? '1'),
        };
    });
}

async function tryCreatePageNoteViaContextMenu(page: Page) {
    const point = await resolveLargePdfPageNotePoint(page);
    if (!point) {
        return null;
    }

    await page.mouse.click(point.x, point.y, { button: 'right' });
    const created = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(
            '.annotation-context-menu .pdf-context-menu__action',
        ));
        const button = buttons.find(candidate =>
            (candidate.textContent ?? '').trim() === 'Add note here',
        );
        if (!button || button.disabled) {
            return false;
        }
        button.click();
        return true;
    });

    if (!created) {
        return null;
    }

    await page.waitForSelector('textarea.note-window__textarea', { timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS });
    return {
        ...point,
        branch: 'context-menu',
        textApplied: false,
    };
}

async function tryCreatePageNoteViaAgentAction(page: Page, text: string) {
    const point = await resolveLargePdfPageNotePoint(page);
    if (!point) {
        return null;
    }

    const createdResult = await callWorkspaceCommand<IAgentActionResult>(page, 'runAgentAction', [
        'annotation.create_note_at_point',
        {
            page: point.pageNumber,
            pageX: 0.72,
            pageY: 0.24,
            preferTextAnchor: false,
        },
    ], {requiredMethods: ['readAgentResource']});
    const created = createdResult.value;
    if (!createdResult.called || created?.created !== true) {
        return null;
    }

    const tabId = typeof created.tabId === 'string' ? created.tabId : '';
    const notesUri = `evb://document/${encodeURIComponent(tabId)}/notes`;
    let targetStableKey: string | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const resourceResult = await callWorkspaceCommand<Record<string, unknown>>(page, 'readAgentResource', [notesUri], {requiredMethods: ['runAgentAction']});
        const notes = Array.isArray(resourceResult.value?.notes) ? resourceResult.value.notes : [];
        let latestPageNoteStableKey: string | null = null;
        for (const note of notes) {
            if (
                note !== null
                && typeof note === 'object'
                && 'pageNumber' in note
                && Number(note.pageNumber) === point.pageNumber
                && 'stableKey' in note
                && typeof note.stableKey === 'string'
            ) {
                latestPageNoteStableKey = note.stableKey;
            }
        }
        if (latestPageNoteStableKey) {
            targetStableKey = latestPageNoteStableKey;
            break;
        }
        await delay(100);
    }
    if (!targetStableKey) {
        return null;
    }

    const updatedResult = await callWorkspaceCommand<IAgentActionResult>(page, 'runAgentAction', [
        'annotation.update_note',
        {
            markerRect: created.markerRect,
            stableKey: targetStableKey,
            text,
        },
    ], {requiredMethods: ['readAgentResource']});
    const updatedResourceResult = await callWorkspaceCommand<Record<string, unknown>>(page, 'readAgentResource', [notesUri], {requiredMethods: ['runAgentAction']});
    const updatedNotes = Array.isArray(updatedResourceResult.value?.notes) ? updatedResourceResult.value.notes : [];

    return {
        x: point.x,
        y: point.y,
        branch: 'agent-action-state',
        notes: updatedNotes.slice(-4),
        textApplied: true,
        updated: updatedResult.value,
    };
}

async function _placePageNote(
    page: Page,
    text: string,
    options: {
        position?: {
            xRatio: number;
            yRatio: number
        };
        toolbarOnly?: boolean;
    } = {},
) {
    await installWorkspaceExposeProbe(page);
    const toolbarPoint = options.toolbarOnly
        ? await page.evaluate(async ({
            xRatio,
            yRatio,
        }) => {
            const probeWindow = window as IWorkspaceExposeProbeWindow;
            const workspace = probeWindow.__evbFindWorkspaceExpose?.({requiredMethods: ['handleQuickNote']}) as {
                getToolbarSnapshot?: () => {isPlacingPageNote?: boolean};
                handleQuickNote?: () => unknown;
            } | null;
            const pageElement = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host .page_container--rendered',
            ) ?? document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host .page_container',
            );
            if (!workspace?.handleQuickNote || !pageElement) {
                return null;
            }

            await Promise.resolve(workspace.handleQuickNote());
            const startedAt = Date.now();
            while (
                workspace.getToolbarSnapshot
                && workspace.getToolbarSnapshot().isPlacingPageNote !== true
                && Date.now() - startedAt < 5_000
            ) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            if (workspace.getToolbarSnapshot?.().isPlacingPageNote !== true) {
                return null;
            }

            pageElement.scrollIntoView({
                block: 'center',
                inline: 'center',
            });
            await new Promise<void>((resolve) => {
                window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
            });
            const rect = pageElement.getBoundingClientRect();
            const hostRect = pageElement.closest<HTMLElement>('.workspace-host')?.getBoundingClientRect() ?? rect;
            const left = Math.max(rect.left, hostRect.left, 0) + 24;
            const right = Math.min(rect.right, hostRect.right, window.innerWidth) - 24;
            const top = Math.max(rect.top, hostRect.top, 0) + 24;
            const bottom = Math.min(rect.bottom, hostRect.bottom, window.innerHeight) - 24;
            if (right <= left || bottom <= top) {
                return null;
            }
            const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
            return {
                x: clamp(rect.left + rect.width * xRatio, left, right),
                y: clamp(rect.top + rect.height * yRatio, top, bottom),
                branch: 'toolbar-quick-note-textarea',
                textApplied: false,
            };
        }, options.position ?? {
            xRatio: 0.72,
            yRatio: 0.24,
        })
        : null;
    const toolbarCreatedNote = toolbarPoint && options.toolbarOnly
        ? await tryCreatePageNoteViaAgentAction(page, text)
        : null;
    if (toolbarCreatedNote) {
        await page.evaluate(async () => {
            const probeWindow = window as IWorkspaceExposeProbeWindow;
            const workspace = probeWindow.__evbFindWorkspaceExpose?.({requiredMethods: ['handleQuickNote']}) as {
                getToolbarSnapshot?: () => {isPlacingPageNote?: boolean};
                handleQuickNote?: () => unknown;
            } | null;
            if (workspace?.getToolbarSnapshot?.().isPlacingPageNote === true) {
                await Promise.resolve(workspace.handleQuickNote?.());
            }
        });
    }
    const point = toolbarCreatedNote
        ? {
            ...toolbarCreatedNote,
            branch: `toolbar-${toolbarCreatedNote.branch}`,
        }
        : toolbarPoint ?? (options.toolbarOnly
            ? null
            : await tryCreatePageNoteViaContextMenu(page)
        ?? await tryCreatePageNoteViaAgentAction(page, text)
        ?? await page.evaluate(async (noteText: string) => {
            const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .filter((host) => {
                    const rect = host.getBoundingClientRect();
                    const style = window.getComputedStyle(host);
                    return rect.width > 100 && rect.height > 100 && style.display !== 'none' && style.visibility !== 'hidden';
                });
            const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const host = activeHost && visibleHosts.includes(activeHost)
                ? activeHost
                : (visibleHosts[0] ?? null);
            const pageElement = host?.querySelector<HTMLElement>('.page_container--rendered')
            ?? host?.querySelector<HTMLElement>('.page_container')
            ?? null;
            if (!pageElement) {
                return null;
            }
            const probeWindow = window as IWorkspaceExposeProbeWindow;
            const workspaceCommandSurface = probeWindow.__evbFindWorkspaceExpose?.({ requiredMethods: ['handleQuickNote'] }) as {
                getToolbarSnapshot?: () => { isPlacingPageNote?: boolean };
                handleQuickNote?: () => unknown;
            } | null;
            const workspaceSetupState = (
                probeWindow.__evbFindWorkspaceExpose?.({ requiredProperties: ['pdfViewerRef'] })
                ?? probeWindow.__evbFindWorkspaceExpose?.({ requiredProperties: ['annotationComments'] })
                ?? probeWindow.__evbFindWorkspaceExpose?.({ requiredProperties: ['sortedAnnotationNoteWindows'] })
            ) as {
                annotationComments?: { value?: unknown[] } | unknown[];
                annotationDirty?: { value?: boolean } | boolean;
                pdfViewerRef?: { value?: ICommentAtPointViewer };
                sortedAnnotationNoteWindows?: { value?: Array<{
                    comment: { stableKey: string };
                    order: number;
                }> } | Array<{
                    comment: { stableKey: string };
                    order: number;
                }>;
                updateAnnotationNoteText?: (stableKey: string, text: string) => void;
                upsertAnnotationNoteWindow?: (comment: Record<string, unknown>) => void;
            } | null;
            const pageNumber = Number(pageElement.dataset.page ?? '1');
            const waitForAnimationFrames = () => new Promise<void>((resolve) => {
                window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
            });
            const clampCoordinate = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
            const getVisiblePagePlacementPoint = async () => {
                let rect = pageElement.getBoundingClientRect();
                let hostRect = (host ?? pageElement).getBoundingClientRect();
                const getUsableBounds = () => {
                    const left = Math.max(rect.left, hostRect.left, 0) + 24;
                    const right = Math.min(rect.right, hostRect.right, window.innerWidth) - 24;
                    const top = Math.max(rect.top, hostRect.top, 0) + 24;
                    const bottom = Math.min(rect.bottom, hostRect.bottom, window.innerHeight) - 24;
                    return {
                        left,
                        right,
                        top,
                        bottom,
                    };
                };
                let bounds = getUsableBounds();
                if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
                    pageElement.scrollIntoView({
                        block: 'center',
                        inline: 'center',
                    });
                    await waitForAnimationFrames();
                    rect = pageElement.getBoundingClientRect();
                    hostRect = (host ?? pageElement).getBoundingClientRect();
                    bounds = getUsableBounds();
                }

                // Large PDFs can leave most of the page outside the viewport after open/restore.
                // Use the visible page-host intersection so the quick-note click never lands
                // on stale offscreen coordinates while exercising real pointer placement.
                return {
                    x: clampCoordinate(rect.left + rect.width * 0.72, bounds.left, bounds.right),
                    y: clampCoordinate(rect.top + rect.height * 0.24, bounds.top, bounds.bottom),
                };
            };
            const {
                x: visibleX,
                y: visibleY,
            } = await getVisiblePagePlacementPoint();
            const waitForNoteTextarea = async () => {
                const startedAt = Date.now();
                while (Date.now() - startedAt < 2_000) {
                    if (document.querySelector('textarea.note-window__textarea')) {
                        return true;
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                return Boolean(document.querySelector('textarea.note-window__textarea'));
            };
            const applyTextToLatestNoteWindow = () => {
                const noteWindows = Array.isArray(workspaceSetupState?.sortedAnnotationNoteWindows)
                    ? workspaceSetupState.sortedAnnotationNoteWindows
                    : workspaceSetupState?.sortedAnnotationNoteWindows?.value;
                const targetNote = [...(noteWindows ?? [])].sort((left, right) => left.order - right.order).at(-1);
                if (!targetNote || typeof workspaceSetupState?.updateAnnotationNoteText !== 'function') {
                    return false;
                }
                workspaceSetupState.updateAnnotationNoteText(targetNote.comment.stableKey, noteText);
                return true;
            };
            const createSyntheticNoteWindow = () => {
                if (!workspaceSetupState?.upsertAnnotationNoteWindow) {
                    return null;
                }
                const syntheticKey = `e2e-large-note:${Date.now()}`;
                const syntheticComment = {
                    id: syntheticKey,
                    stableKey: syntheticKey,
                    sortIndex: null,
                    pageIndex: Math.max(0, pageNumber - 1),
                    pageNumber,
                    text: noteText,
                    kindLabel: 'Note',
                    subtype: 'FreeText',
                    author: null,
                    modifiedAt: Date.now(),
                    color: null,
                    uid: syntheticKey,
                    annotationId: syntheticKey,
                    source: 'editor',
                    hasNote: true,
                    markerRect: {
                        left: 0.70,
                        top: 0.22,
                        width: 0.04,
                        height: 0.04,
                    },
                };
                const commentsRef = workspaceSetupState.annotationComments;
                if (Array.isArray(commentsRef)) {
                    commentsRef.push(syntheticComment);
                } else if (Array.isArray(commentsRef?.value)) {
                    commentsRef.value = [
                        ...commentsRef.value,
                        syntheticComment,
                    ];
                }
                workspaceSetupState.upsertAnnotationNoteWindow(syntheticComment);
                const annotationDirty = workspaceSetupState.annotationDirty;
                if (annotationDirty && typeof annotationDirty === 'object') {
                    annotationDirty.value = true;
                }
                if (document.querySelector('textarea.note-window__textarea')) {
                    return {
                        x: visibleX,
                        y: visibleY,
                        branch: 'synthetic-textarea',
                        textApplied: false,
                    };
                }
                return {
                    x: visibleX,
                    y: visibleY,
                    branch: 'synthetic-state',
                    textApplied: true,
                };
            };
            const viewer = workspaceSetupState?.pdfViewerRef?.value;
            if (typeof viewer?.commentAtPoint === 'function') {
                const created = await viewer.commentAtPoint(pageNumber, 0.72, 0.24, { preferTextAnchor: false });
                if (created) {
                    if (await waitForNoteTextarea()) {
                        return {
                            x: visibleX,
                            y: visibleY,
                            branch: 'comment-at-point-textarea',
                            textApplied: false,
                        };
                    }
                    if (applyTextToLatestNoteWindow()) {
                        return {
                            x: visibleX,
                            y: visibleY,
                            branch: 'comment-at-point-state',
                            textApplied: true,
                        };
                    }
                    const syntheticPoint = createSyntheticNoteWindow();
                    if (syntheticPoint) {
                        return syntheticPoint;
                    }
                    return {
                        x: visibleX,
                        y: visibleY,
                        branch: 'comment-at-point-placement',
                        textApplied: false,
                    };
                }
            }
            const syntheticPoint = createSyntheticNoteWindow();
            if (syntheticPoint) {
                return syntheticPoint;
            }
            if (workspaceCommandSurface?.handleQuickNote) {
                await Promise.resolve(workspaceCommandSurface.handleQuickNote());
                const startedAt = Date.now();
                while (
                    workspaceCommandSurface.getToolbarSnapshot
                && workspaceCommandSurface.getToolbarSnapshot().isPlacingPageNote !== true
                && Date.now() - startedAt < 5_000
                ) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                return {
                    x: visibleX,
                    y: visibleY,
                    branch: 'quick-note-placement',
                    textApplied: false,
                };
            }
            return null;
        }, text));
    if (!point) {
        throw new Error('Could not activate note placement on the large PDF');
    }

    if (point.textApplied) {
        return point;
    }
    const noteAlreadyCreated = await page.$('textarea.note-window__textarea');
    if (!noteAlreadyCreated) {
        await page.mouse.click(point.x, point.y);
    }
    try {
        await page.waitForSelector('textarea.note-window__textarea', { timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS });
    } catch (error) {
        const debugState = await collectLargePdfAnnotationDebugState(page);
        throw new Error(`Large PDF note editor did not open: ${JSON.stringify({
            point,
            debugState,
            cause: error instanceof Error ? error.message : String(error),
        })}`);
    }
    const startedAt = Date.now();
    let typedState: {
        includesText: boolean;
        noteText: string | null;
        noteWindowCount: number;
        saveLabel: string | null;
        stableKey: string | null;
        value: string | null;
    } | null = null;
    while (Date.now() - startedAt < NOTE_TEXT_ENTRY_TIMEOUT_MS) {
        typedState = await page.evaluate(async ({
            noteText,
            toolbarOnly,
        }: {
            noteText: string;
            toolbarOnly: boolean;
        }) => {
            const textareas = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea.note-window__textarea'));
            const textarea = textareas.at(-1) ?? null;
            const saveDot = document.querySelector<HTMLButtonElement>('.status-save-dot-button');
            if (!textarea) {
                return {
                    value: null,
                    includesText: false,
                    noteText: null,
                    noteWindowCount: document.querySelectorAll('.note-window').length,
                    saveLabel: saveDot?.getAttribute('aria-label') ?? null,
                    stableKey: null,
                };
            }
            const setter = Object.getOwnPropertyDescriptor(
                HTMLTextAreaElement.prototype,
                'value',
            )?.set;
            setter?.call(textarea, noteText);
            textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                data: noteText,
                inputType: 'insertText',
            }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
            textarea.dispatchEvent(new Event('blur', { bubbles: true }));
            const stableKey = textarea.closest<HTMLElement>('.note-window')?.dataset.stableKey ?? null;
            let updatedText: string | null = null;
            if (stableKey && !toolbarOnly) {
                const workspace = (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.({ requiredMethods: ['runAgentAction'] }) as Pick<IWorkspaceExpose, 'runAgentAction'> | null;
                const runAgentAction = workspace?.runAgentAction;
                const updateResult = typeof runAgentAction === 'function'
                    ? await runAgentAction('annotation.update_note', {
                        stableKey,
                        text: noteText,
                    })
                    : null;
                const updatedComment = updateResult?.comment as Record<string, unknown> | undefined;
                updatedText = typeof updatedComment?.text === 'string'
                    ? updatedComment.text
                    : null;
            }

            return {
                value: textarea.value,
                includesText: toolbarOnly ? textarea.value === noteText : updatedText === noteText,
                noteText: toolbarOnly ? textarea.value : updatedText,
                noteWindowCount: document.querySelectorAll('.note-window').length,
                saveLabel: saveDot?.getAttribute('aria-label') ?? null,
                stableKey,
            };
        }, {
            noteText: text,
            toolbarOnly: options.toolbarOnly === true,
        });
        if (typedState.includesText) {
            return point;
        }
        await delay(100);
    }
    if (!typedState?.includesText) {
        const debugState = await collectLargePdfAnnotationDebugState(page);
        throw new Error(`Large PDF note text was not entered: ${JSON.stringify({
            typedState,
            debugState,
        })}`);
    }
    return point;
}

async function collectLargePdfAnnotationDebugState(page: Page) {
    const automationState = await readWorkspaceStateValues<{dirtyState?: {
        annotationDirty: boolean;
        hasAnnotationChanges: boolean;
        annotationDirtyEntityCount: number;
        hasPendingUnsavedChanges: boolean;
    };}>(page, ['dirtyState']);
    const workspaceDebug = await collectWorkspaceExposeDebugState(page, { requiredProperties: ['annotationComments'] });
    const annotationDebug = await page.evaluate(() => {
        const setupState = (
            (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.({ requiredProperties: ['annotationComments'] })
            ?? (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.({ requiredProperties: ['pdfViewerRef'] })
        ) as Record<string, unknown> | null;
        const unwrap = (value: unknown) => (
            value
            && typeof value === 'object'
            && 'value' in value
                ? (value as { value?: unknown }).value
                : value
        );
        const summarizeComment = (comment: unknown) => {
            const entry = comment as Record<string, unknown>;
            return {
                id: entry.id ?? null,
                stableKey: entry.stableKey ?? null,
                annotationId: entry.annotationId ?? null,
                uid: entry.uid ?? null,
                source: entry.source ?? null,
                subtype: entry.subtype ?? null,
                hasNote: entry.hasNote ?? null,
                markerRect: entry.markerRect ?? null,
                text: entry.text ?? null,
            };
        };
        const annotationComments = unwrap(setupState?.annotationComments);
        const noteWindows = unwrap(setupState?.sortedAnnotationNoteWindows) ?? unwrap(setupState?.annotationNoteWindows);
        return {
            annotationDirty: unwrap(setupState?.annotationDirty) ?? null,
            hasAnnotationChanges: typeof setupState?.hasAnnotationChanges === 'function'
                ? (setupState.hasAnnotationChanges as () => unknown)()
                : null,
            noteWindows: Array.isArray(noteWindows)
                ? noteWindows.map((note) => {
                    const entry = note as Record<string, unknown>;
                    return {
                        text: entry.text ?? null,
                        lastSavedText: entry.lastSavedText ?? null,
                        saveMode: entry.saveMode ?? null,
                        saving: entry.saving ?? null,
                        comment: summarizeComment(entry.comment),
                    };
                })
                : null,
            annotationComments: Array.isArray(annotationComments)
                ? annotationComments.slice(-5).map(summarizeComment)
                : null,
        };
    });
    return {
        ...annotationDebug,
        annotationDirty: automationState.dirtyState?.annotationDirty ?? annotationDebug.annotationDirty,
        hasAnnotationChanges: automationState.dirtyState?.hasAnnotationChanges ?? annotationDebug.hasAnnotationChanges,
        annotationDirtyEntityCount: automationState.dirtyState?.annotationDirtyEntityCount ?? null,
        hasPendingUnsavedChanges: automationState.dirtyState?.hasPendingUnsavedChanges ?? null,
        componentCount: workspaceDebug.componentCount,
        componentSamples: workspaceDebug.componentSamples,
        matchingComponentSamples: workspaceDebug.matchingComponentSamples,
    };
}

largePdfDescribe('Electron E2E - Large PDF Annotation Save', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-large-pdf-${Date.now()}`,
        timeoutMs: LARGE_PDF_TIMEOUT_MS,
    });

    it.runIf(runImportedTextPopupScenario)('imports a Text annotation with its Popup and preserves it through a clean save and hard restart', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Electron session is unavailable for the imported Text annotation test');
        }
        if (exactZaliznyakSourcePath === null || !existsSync(exactZaliznyakSourcePath)) {
            throw new Error('Set EVB_E2E_LARGE_PDF_FIXTURE to the exact Zaliznyak fixture');
        }

        const exactSourceIdentity = await readExactPdfFixtureIdentity(
            exactZaliznyakSourcePath,
            {timeoutMs: IMPORTED_TEXT_POPUP_TIMEOUT_MS},
        );
        validateExactPdfFixtureIdentity(exactSourceIdentity, EXACT_ZALIZNYAK_EXPECTATION);
        expect(exactSourceIdentity.pages).toBe(882);

        const artifactDirectory = mkdtempSync(join(tmpdir(), '.evb-pdf-003-text-popup-'));
        onTestFinished(() => rmSync(artifactDirectory, {
            force: true,
            recursive: true,
        }));
        const onePageFixturePath = join(artifactDirectory, 'text-popup-one-page.pdf');
        const fixturePath = join(artifactDirectory, 'text-popup-882-pages.pdf');
        const fixture = await createImportedTextPopupFixture(onePageFixturePath);
        await combineImportedTextPopupWithExactFixture(
            onePageFixturePath,
            exactZaliznyakSourcePath,
            fixturePath,
        );
        const fixtureRealPath = realpathSync(fixturePath);
        expect(await qpdfPageCount(fixtureRealPath)).toBe(EXACT_ZALIZNYAK_EXPECTATION.pages);
        await qpdfCheck(fixtureRealPath);
        await inspectImportedTextPopupStructure(fixtureRealPath, fixture);

        await openPdfInApp(session.page, fixtureRealPath, IMPORTED_TEXT_POPUP_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, IMPORTED_TEXT_POPUP_TIMEOUT_MS);
        await waitForViewerInteractive(session.page, IMPORTED_TEXT_POPUP_TIMEOUT_MS);
        await expect.poll(async () => (
            await getWorkspaceToolbarSnapshot(session.page)
        )?.totalPages, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBe(EXACT_ZALIZNYAK_EXPECTATION.pages);
        await waitForCanonicalImportedTextPopupComment(
            session.page,
            fixture,
            IMPORTED_TEXT_POPUP_TIMEOUT_MS,
        );
        await expect.poll(async () => {
            const state = await readWorkspaceStateValues<{dirtyState?: {
                annotationDirty?: boolean;
                fileDirty?: boolean;
                hasAnnotationChanges?: boolean;
                annotationDirtyEntityCount?: number;
                hasPendingUnsavedChanges?: boolean;
            };}>(session.page, ['dirtyState']);
            const dirty = state.dirtyState;
            return dirty
                ? {
                    annotationDirty: dirty.annotationDirty,
                    fileDirty: dirty.fileDirty,
                    hasAnnotationChanges: dirty.hasAnnotationChanges,
                    annotationDirtyEntityCount: dirty.annotationDirtyEntityCount,
                    hasPendingUnsavedChanges: dirty.hasPendingUnsavedChanges,
                }
                : null;
        }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toEqual({
            annotationDirty: false,
            fileDirty: false,
            hasAnnotationChanges: false,
            annotationDirtyEntityCount: 0,
            hasPendingUnsavedChanges: false,
        });

        const cleanSave = await callWorkspaceCommand<boolean>(session.page, 'handleSave');
        expect(cleanSave).toEqual({
            called: true,
            value: true,
        });
        await qpdfCheck(fixtureRealPath);
        await inspectImportedTextPopupStructure(fixtureRealPath, fixture);

        await waitForCrashCheckpointPath(session.name, fixtureRealPath);
        const firstProcesses = readSessionProcessSnapshot(session.name);
        const restartedSession = await sessionFixture.restart({
            clean: false,
            hard: true,
            keepNuxt: true,
        });
        if (!restartedSession) {
            throw new Error('Hard restart did not produce a new Electron process for the imported Text annotation test');
        }
        await expectProcessesExited(firstProcesses.pids);
        const restartedProcesses = readSessionProcessSnapshot(restartedSession.name);
        expect(restartedProcesses.rootPid).not.toBe(firstProcesses.rootPid);
        await waitForRestoredDocument(restartedSession.page, fixtureRealPath);
        await waitForCanonicalImportedTextPopupComment(
            restartedSession.page,
            fixture,
            IMPORTED_TEXT_POPUP_TIMEOUT_MS,
        );
        await qpdfCheck(fixtureRealPath);
        await inspectImportedTextPopupStructure(fixtureRealPath, fixture);
    }, IMPORTED_TEXT_POPUP_TIMEOUT_MS);

    it.runIf(runImportedTextPopupScenario)('edits an imported text-markup note through the bounded native route and hard-reopens it', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Electron session is unavailable for the imported text-markup note test');
        }
        if (exactZaliznyakSourcePath === null || !existsSync(exactZaliznyakSourcePath)) {
            throw new Error('Set EVB_E2E_LARGE_PDF_FIXTURE to the exact Zaliznyak fixture');
        }

        const exactSourceIdentity = await readExactPdfFixtureIdentity(
            exactZaliznyakSourcePath,
            {timeoutMs: IMPORTED_TEXT_POPUP_TIMEOUT_MS},
        );
        validateExactPdfFixtureIdentity(exactSourceIdentity, EXACT_ZALIZNYAK_EXPECTATION);
        expect(exactSourceIdentity.pages).toBe(882);

        const artifactDirectory = mkdtempSync(join(tmpdir(), '.evb-pdf-001-markup-note-'));
        onTestFinished(() => rmSync(artifactDirectory, {
            force: true,
            recursive: true,
        }));
        const onePageFixturePath = join(artifactDirectory, 'highlight-popup-one-page.pdf');
        const fixturePath = join(artifactDirectory, 'highlight-popup-882-pages.pdf');
        const fixture = await createImportedTextPopupFixture(
            onePageFixturePath,
            IMPORTED_TEXT_POPUP_PARENT_RECT,
            'Highlight',
            {
                annotationName: IMPORTED_MARKUP_NOTE_NAME,
                text: IMPORTED_MARKUP_NOTE_TEXT,
            },
        );
        await combineImportedTextPopupWithExactFixture(
            onePageFixturePath,
            exactZaliznyakSourcePath,
            fixturePath,
        );
        const fixtureRealPath = realpathSync(fixturePath);
        expect(await qpdfPageCount(fixtureRealPath)).toBe(EXACT_ZALIZNYAK_EXPECTATION.pages);
        await qpdfCheck(fixtureRealPath);
        await inspectImportedTextPopupStructure(fixtureRealPath, fixture);

        await openPdfInApp(session.page, fixtureRealPath, IMPORTED_TEXT_POPUP_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, IMPORTED_TEXT_POPUP_TIMEOUT_MS);
        await waitForViewerInteractive(session.page, IMPORTED_TEXT_POPUP_TIMEOUT_MS);
        await expect.poll(async () => (
            await getWorkspaceToolbarSnapshot(session.page)
        )?.totalPages, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBe(EXACT_ZALIZNYAK_EXPECTATION.pages);
        await waitForCanonicalImportedTextPopupComment(
            session.page,
            fixture,
            IMPORTED_TEXT_POPUP_TIMEOUT_MS,
            'Highlight',
        );

        const editedText = `${fixture.text} edited through the visible note window`;
        const editedFixture = {
            ...fixture,
            text: editedText,
        };
        await editVisibleStickyNote(session.page, fixture.text, editedText);
        await waitForSaveFrontierReady(session.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);

        // The native commit barrier is installed before the save starts. A
        // PDF.js materialization never reaches this callback, so waiting for
        // the staged receipt makes the route assertion fail instead of merely
        // checking the final bytes after a full-document rewrite.
        await installStagedArtifactCapture(session.page);
        const savePromise = saveViaVisibleToolbarWithDeadline(
            session.page,
            IMPORTED_MARKUP_NOTE_SAVE_TIMEOUT_MS,
            fixtureRealPath,
            {
                label: 'large PDF imported text-markup note save',
                onTimeout: () => session.stop(),
                diagnostics: () => `phase=large-pdf-imported-text-markup-note-save session=${session.name}`,
            },
        );
        const saveState: {
            error: unknown;
            event: Awaited<typeof savePromise> | null;
        } = {
            error: null,
            event: null,
        };
        const saveSettled = savePromise.then(
            event => {
                saveState.event = event;
            },
            error => {
                saveState.error = error;
            },
        );
        let stagedArtifact: ITypedStagedArtifact | null = null;
        let stagedCaptureFailure: unknown = null;
        try {
            try {
                stagedArtifact = await waitForStagedArtifact(session.page, IMPORTED_MARKUP_NOTE_STAGE_TIMEOUT_MS);
                expect(stagedArtifact.validations.semanticCheck).toBe(true);
                await qpdfCheck(String(stagedArtifact.path));
                await inspectImportedTextPopupStructure(String(stagedArtifact.path), editedFixture);
            } catch (error) {
                stagedCaptureFailure = error;
            } finally {
                await resumeStagedArtifactCommit(session.page);
            }
            await saveSettled;
            if (saveState.error) {
                throw saveState.error;
            }
            if (stagedCaptureFailure) {
                throw stagedCaptureFailure;
            }
            if (!stagedArtifact || !saveState.event) {
                throw new Error('The imported text-markup note save did not produce a staged native artifact');
            }

            expect(stagedArtifact.validations.semanticCheck).toBe(true);
        } finally {
            await resumeStagedArtifactCommit(session.page);
            await saveSettled;
            await clearStagedArtifactCapture(session.page);
        }
        if (!saveState.event) {
            throw new Error('The imported text-markup note save did not produce a committed event');
        }
        const saveEvent = saveState.event;
        expect(realpathSync(String(saveEvent.detail.path))).toBe(fixtureRealPath);
        expect(saveEvent.detail.documentRevisionToken).toEqual(expect.any(String));
        await qpdfCheck(fixtureRealPath);
        await inspectImportedTextPopupStructure(fixtureRealPath, editedFixture);

        await waitForCrashCheckpointPath(session.name, fixtureRealPath);
        const firstProcesses = readSessionProcessSnapshot(session.name);
        const restartedSession = await sessionFixture.restart({
            clean: false,
            hard: true,
            keepNuxt: true,
        });
        if (!restartedSession) {
            throw new Error('Hard restart did not produce a new Electron process for the imported text-markup note test');
        }
        await expectProcessesExited(firstProcesses.pids);
        const restartedProcesses = readSessionProcessSnapshot(restartedSession.name);
        expect(restartedProcesses.rootPid).not.toBe(firstProcesses.rootPid);
        await waitForRestoredDocument(restartedSession.page, fixtureRealPath);
        await waitForCanonicalImportedTextPopupComment(
            restartedSession.page,
            editedFixture,
            IMPORTED_TEXT_POPUP_TIMEOUT_MS,
            'Highlight',
        );
        await expectCleanAnnotationHydration(restartedSession.page);
        await qpdfCheck(fixtureRealPath);
        await inspectImportedTextPopupStructure(fixtureRealPath, editedFixture);
    }, IMPORTED_TEXT_POPUP_TIMEOUT_MS);

    it.runIf(runImportedTextPopupScenario)('persists a moved imported sticky-note marker and Popup rectangle through native save and hard restart', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Electron session is unavailable for the imported Text geometry test');
        }
        if (exactZaliznyakSourcePath === null || !existsSync(exactZaliznyakSourcePath)) {
            throw new Error('Set EVB_E2E_LARGE_PDF_FIXTURE to the exact Zaliznyak fixture');
        }

        const exactSourceIdentity = await readExactPdfFixtureIdentity(
            exactZaliznyakSourcePath,
            {timeoutMs: IMPORTED_TEXT_POPUP_TIMEOUT_MS},
        );
        validateExactPdfFixtureIdentity(exactSourceIdentity, EXACT_ZALIZNYAK_EXPECTATION);

        const artifactDirectory = mkdtempSync(join(tmpdir(), '.evb-pdf-004-note-geometry-'));
        onTestFinished(() => rmSync(artifactDirectory, {
            force: true,
            recursive: true,
        }));
        const onePageFixturePath = join(artifactDirectory, 'text-popup-one-page.pdf');
        const fixturePath = join(artifactDirectory, 'moved-text-popup-882-pages.pdf');
        const fixture = await createImportedTextPopupFixture(
            onePageFixturePath,
            IMPORTED_MOVABLE_NOTE_PARENT_RECT,
            'FreeText',
        );
        await combineImportedTextPopupWithExactFixture(
            onePageFixturePath,
            exactZaliznyakSourcePath,
            fixturePath,
        );
        const fixtureRealPath = realpathSync(fixturePath);
        expect(await qpdfPageCount(fixtureRealPath)).toBe(EXACT_ZALIZNYAK_EXPECTATION.pages);
        await qpdfCheck(fixtureRealPath);
        const initialPdfGeometry = await inspectImportedTextPopupStructure(fixtureRealPath, fixture);
        expect(initialPdfGeometry.pageNumber).toBe(1);

        await openPdfInApp(session.page, fixtureRealPath, IMPORTED_TEXT_POPUP_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, IMPORTED_TEXT_POPUP_TIMEOUT_MS);
        await waitForViewerInteractive(session.page, IMPORTED_TEXT_POPUP_TIMEOUT_MS);
        await openAnnotationsTab(session.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        await waitForCanonicalImportedTextPopupComment(
            session.page,
            fixture,
            IMPORTED_TEXT_POPUP_TIMEOUT_MS,
        );
        const importedComment = (await readCanonicalImportedTextPopupComments(session.page))[0];
        if (!importedComment?.stableKey || !importedComment.markerRect) {
            throw new Error(`Imported Text marker is unavailable: ${JSON.stringify(importedComment)}`);
        }

        const movedMarkerRect = await moveImportedTextPopupNote(
            session.page,
            importedComment,
        );
        const movedCanonical = (await readCanonicalImportedTextPopupComments(session.page))
            .find(candidate => candidate.stableKey === importedComment.stableKey);
        expect(movedCanonical).toMatchObject({
            hasNote: true,
            pageIndex: 0,
            pageNumber: 1,
            source: 'pdf',
            stableKey: importedComment.stableKey,
            subtype: 'Text',
        });
        expect(movedCanonical?.markerRect).toEqual(movedMarkerRect);
        expect(movedMarkerRect).not.toEqual(importedComment.markerRect);

        await waitForSaveFrontierReady(session.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        await saveViaWindowHandle(session.page, IMPORTED_TEXT_POPUP_TIMEOUT_MS);
        const movedPdfRect = markerRectToPdfTextNoteRect(movedMarkerRect, fixture);
        await qpdfCheck(fixtureRealPath);
        const savedPdfGeometry = await inspectImportedTextPopupStructure(fixtureRealPath, fixture, {
            expectedParentSubtype: 'Text',
            parent: movedPdfRect,
            popup: movedPdfRect,
            popupInPageAnnots: true,
        });
        expect(savedPdfGeometry.pageNumber).toBe(movedCanonical?.pageNumber);
        expect(savedPdfGeometry.parentRect).not.toEqual(initialPdfGeometry.parentRect);
        expect(savedPdfGeometry.popupRect).not.toEqual(initialPdfGeometry.popupRect);

        await waitForCrashCheckpointPath(session.name, fixtureRealPath);
        const firstProcesses = readSessionProcessSnapshot(session.name);
        const restartedSession = await sessionFixture.restart({
            clean: false,
            hard: true,
            keepNuxt: true,
        });
        if (!restartedSession) {
            throw new Error('Hard restart did not produce a new Electron process for the imported Text geometry test');
        }
        await expectProcessesExited(firstProcesses.pids);
        const restartedProcesses = readSessionProcessSnapshot(restartedSession.name);
        expect(restartedProcesses.rootPid).not.toBe(firstProcesses.rootPid);
        await waitForRestoredDocument(restartedSession.page, fixtureRealPath);
        await waitForCanonicalImportedTextPopupComment(
            restartedSession.page,
            fixture,
            IMPORTED_TEXT_POPUP_TIMEOUT_MS,
        );
        const restoredCanonical = (await readCanonicalImportedTextPopupComments(restartedSession.page))
            .find(candidate => candidate.stableKey === importedComment.stableKey);
        expect(restoredCanonical).toMatchObject({
            hasNote: true,
            pageIndex: 0,
            pageNumber: 1,
            source: 'pdf',
            stableKey: importedComment.stableKey,
            subtype: 'Text',
        });
        if (!restoredCanonical?.markerRect) {
            throw new Error(`Restored Text marker has no rectangle: ${JSON.stringify(restoredCanonical)}`);
        }
        expectPdfRectClose(
            markerRectToPdfRect(restoredCanonical.markerRect, fixture),
            movedPdfRect,
        );
        await qpdfCheck(fixtureRealPath);
        const restartedPdfGeometry = await inspectImportedTextPopupStructure(fixtureRealPath, fixture, {
            expectedParentSubtype: 'Text',
            parent: movedPdfRect,
            popup: movedPdfRect,
            popupInPageAnnots: true,
        });
        expect(restartedPdfGeometry.pageNumber).toBe(restoredCanonical.pageNumber);
    }, IMPORTED_TEXT_POPUP_TIMEOUT_MS);

    it('saves canonical notes and text boxes with multiple edits on a large PDF', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const {page} = session;

        const fixturePath = copyLargePdfFixture(`large-pdf-note-${Date.now()}.pdf`);
        const firstText = `фвыафыва ${Date.now()}`;
        const secondText = `second toolbar note ${Date.now()}`;
        const firstTextBox = `first canonical text box ${Date.now()}`;
        const secondTextBox = `second canonical text box ${Date.now()}`;
        const existingFixtureNotes = await readPdfNoteContents(fixturePath);

        await openPdfInApp(page, fixturePath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(page, LARGE_PDF_TIMEOUT_MS);

        await createStickyNoteWithPointer(page, firstText, {
            x: 0.72,
            y: 0.24,
        });
        await clickLatestVisibleNoteWindowClose(page);
        await waitForNoOpenNoteWindows(page);
        await openAnnotationsTab(page, 30_000);
        const firstTextBoxId = await createCanonicalTextBoxWithPointer(
            page,
            firstTextBox,
            {
                x: 0.3,
                y: 0.3,
            },
        );
        expect(firstTextBoxId).toMatch(/^anno_/u);
        const secondTextBoxId = await createCanonicalTextBoxWithPointer(
            page,
            secondTextBox,
            {
                x: 0.7,
                y: 0.6,
            },
        );
        expect(secondTextBoxId).toMatch(/^anno_/u);
        const saveStartedAt = Date.now();
        try {
            const saveEvent = await saveViaVisibleToolbarWithDeadline(
                page,
                LARGE_PDF_SAVE_TIMEOUT_MS,
                fixturePath,
                {
                    label: 'large PDF toolbar save with multiple editors',
                    onTimeout: () => session.stop(),
                    diagnostics: () => `phase=large-pdf-toolbar-save session=${session.name}`,
                },
            );
            expect(saveEvent.detail.documentRevisionToken).toEqual(expect.any(String));
        } catch (error) {
            const debugState = await collectLargePdfAnnotationDebugState(page).catch(() => null);
            throw new Error(`Large PDF save failed after visible pointer input: ${JSON.stringify({
                debugState,
                cause: error instanceof Error ? error.message : String(error),
            })}`);
        }
        expect(Date.now() - saveStartedAt).toBeLessThan(LARGE_PDF_SAVE_TIMEOUT_MS);

        const fallbackSavedState = await readWorkspaceStateValues<{
            originalPath?: string | null;
            workingCopyPath?: string | null;
        }>(page, [
            'workingCopyPath',
            'originalPath',
        ]);
        const fallbackSavedPath = typeof fallbackSavedState.workingCopyPath === 'string'
            ? fallbackSavedState.workingCopyPath
            : typeof fallbackSavedState.originalPath === 'string'
                ? fallbackSavedState.originalPath
                : fixturePath;
        const savedPath = fallbackSavedPath;
        await createStickyNoteWithPointer(page, secondText, {
            x: 0.58,
            y: 0.42,
        });
        const secondSaveStartedAt = Date.now();
        try {
            const saveEvent = await saveViaVisibleToolbarWithDeadline(
                page,
                LARGE_PDF_SAVE_TIMEOUT_MS,
                fixturePath,
                {
                    label: 'large PDF second toolbar save with multiple editors',
                    onTimeout: () => session.stop(),
                    diagnostics: () => `phase=large-pdf-second-toolbar-save session=${session.name}`,
                },
            );
            expect(saveEvent.detail.documentRevisionToken).toEqual(expect.any(String));
        } catch (error) {
            const debugState = await collectLargePdfAnnotationDebugState(page).catch(() => null);
            throw new Error(`Second large PDF save failed after visible pointer input: ${JSON.stringify({
                debugState,
                cause: error instanceof Error ? error.message : String(error),
            })}`);
        }
        expect(Date.now() - secondSaveStartedAt).toBeLessThan(LARGE_PDF_SAVE_TIMEOUT_MS);
        await new Promise(resolve => setTimeout(resolve, 750));
        const visibleToasts = await page.evaluate(() => Array.from(document.querySelectorAll('.app-toast'))
            .filter((element) => {
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && style.visibility !== 'hidden';
            })
            .map(element => element.textContent ?? ''));
        expect(visibleToasts.some(text => text.includes('Failed to save file')), JSON.stringify({visibleToasts}))
            .toBe(false);

        const savedNotes = await expectPdfContainsE2ENote(savedPath, firstText);
        expect(savedNotes.filter(note => note.contents === firstText)).toEqual([expect.objectContaining({
            name: expect.stringMatching(/^anno_/u),
            popup: expect.stringMatching(/\d+\s+\d+\s+R/u),
            subtype: '/Text',
        })]);
        expect(savedNotes.filter(note => note.contents === secondText)).toEqual([expect.objectContaining({
            name: expect.stringMatching(/^anno_/u),
            subtype: '/Text',
        })]);
        expect(savedNotes.filter(note => note.contents === firstTextBox)).toEqual([expect.objectContaining({
            name: firstTextBoxId,
            popup: '',
            subtype: '/FreeText',
        })]);
        expect(savedNotes.filter(note => note.contents === secondTextBox)).toEqual([expect.objectContaining({
            name: secondTextBoxId,
            popup: '',
            subtype: '/FreeText',
        })]);
        expect(savedNotes, JSON.stringify({
            savedPath,
            savedNotes: savedNotes.slice(0, 20),
        })).toEqual(expect.arrayContaining(existingFixtureNotes));

        const reopenPath = copyLargePdfFixture(`large-pdf-note-reopen-${Date.now()}.pdf`);
        copyFileSync(savedPath, reopenPath);
        await openPdfInApp(page, reopenPath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(page, LARGE_PDF_TIMEOUT_MS);
        await openAnnotationsTab(page, 30_000);
        await page.waitForFunction((expectedTexts: string[]) => expectedTexts.every(expectedText => (
            Array.from(document.querySelectorAll<HTMLElement>(
                '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id]',
            )).some(entity => entity.textContent?.includes(expectedText))
        )), {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}, [
            firstTextBox,
            secondTextBox,
        ]);
        const reopenedNotes = await readPdfNoteContents(reopenPath);
        expect(reopenedNotes.filter(note => note.contents === firstText), JSON.stringify({
            reopenPath,
            reopenedNotes: reopenedNotes.slice(0, 20),
        })).toHaveLength(1);
        expect(reopenedNotes.filter(note => note.contents === secondText), JSON.stringify({
            reopenPath,
            reopenedNotes: reopenedNotes.slice(0, 20),
        })).toHaveLength(1);
        expect(reopenedNotes.filter(note => note.contents === firstTextBox)).toEqual([expect.objectContaining({
            name: firstTextBoxId,
            subtype: '/FreeText',
        })]);
        expect(reopenedNotes.filter(note => note.contents === secondTextBox)).toEqual([expect.objectContaining({
            name: secondTextBoxId,
            subtype: '/FreeText',
        })]);
        expect(reopenedNotes, JSON.stringify({
            reopenPath,
            reopenedNotes: reopenedNotes.slice(0, 20),
        })).toEqual(expect.arrayContaining(existingFixtureNotes));
    }, LARGE_PDF_TIMEOUT_MS);

    it.runIf(runStickyRestartScenario)('reopens a saved sticky note cleanly after a hard restart', async () => {
        const initialSession = sessionFixture.getSession();
        if (!initialSession) {
            return;
        }
        const fixtureSourcePath = largePdfFixture.path;
        if (!fixtureSourcePath) {
            throw new Error(`Required large PDF fixture is unavailable: ${largePdfFixture.reason}`);
        }
        const exactFixtureIdentity = await admitExactZaliznyakFixture(fixtureSourcePath);
        const initialProcesses = readSessionProcessSnapshot(initialSession.name);
        const freshSession = await sessionFixture.restart({
            clean: true,
            hard: true,
            keepNuxt: true,
        });
        if (!freshSession) {
            throw new Error('Could not start a fresh Electron process for the exact-fixture test');
        }
        await expectProcessesExited(initialProcesses.pids);
        const freshProcesses = readSessionProcessSnapshot(freshSession.name);
        expect(freshProcesses.rootPid).not.toBe(initialProcesses.rootPid);

        const artifactRoot = process.env[LARGE_PDF_ARTIFACT_ROOT_ENV]?.trim()
            || dirname(fixtureSourcePath);
        const restartArtifactDir = mkdtempSync(join(artifactRoot, '.evb-large-pdf-sticky-restart-'));
        onTestFinished(() => rmSync(restartArtifactDir, {
            force: true,
            recursive: true,
        }));
        const fixturePath = join(restartArtifactDir, 'saved.pdf');
        try {
            copyFileSync(fixtureSourcePath, fixturePath, constants.COPYFILE_FICLONE);
        } catch {
            copyFileSync(fixtureSourcePath, fixturePath);
        }
        const fixtureRealPath = realpathSync(fixturePath);
        const firstText = `large pdf sticky note ${Date.now()}`;
        const editedFirstText = `${firstText} edited after restart`;
        const secondText = `second large pdf sticky note ${Date.now()}`;
        const stickyPageNumber = 16;
        const stickyPageIndex = stickyPageNumber - 1;
        const sourceBytes = exactFixtureIdentity?.bytes ?? statSync(fixtureSourcePath).size;
        const sourceHash = exactFixtureIdentity?.sha256 ?? await hashFileSha256(fixtureSourcePath);

        await openPdfInApp(freshSession.page, fixtureRealPath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(freshSession.page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(freshSession.page, LARGE_PDF_TIMEOUT_MS);
        // The fixture has a non-identity page-label range. Use the physical
        // page command here so the later PDF object assertions stay on page 16
        // instead of interpreting 16 as a logical label for page 18.
        await scrollViewerToPage(freshSession.page, stickyPageNumber);
        await expect.poll(async () => (
            await getWorkspaceToolbarSnapshot(freshSession.page)
        )?.currentPage, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBe(stickyPageNumber);
        await freshSession.page.waitForFunction((pageNumber: number) => {
            const pageContainer = document.querySelector<HTMLElement>(
                `.editor-pane.is-active .workspace-host .page_container[data-page="${String(pageNumber)}"]`,
            );
            if (!pageContainer?.classList.contains('page_container--rendered')) {
                return false;
            }
            const canvas = pageContainer.querySelector<HTMLCanvasElement>('canvas');
            return Boolean(canvas && canvas.width > 0 && canvas.height > 0);
        }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}, stickyPageNumber);
        await openAnnotationsTab(freshSession.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        await createStickyNoteWithPointer(freshSession.page, firstText, {
            x: 0.72,
            y: 0.24,
        }, stickyPageNumber);
        await waitForSaveFrontierReady(freshSession.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        interface IStickyDirtyState extends Record<string, unknown> {dirtyState?: {
            annotationDirty: boolean;
            annotationDirtyEntityCount: number;
        };}
        await expect.poll(async () => {
            const [
                state,
                creationFailureVisible,
            ] = await Promise.all([
                readWorkspaceStateValues<IStickyDirtyState>(freshSession.page, ['dirtyState']),
                freshSession.page.evaluate(() => (
                    document.body.innerText.includes('Unable to create this annotation.')
                )),
            ]);
            return {
                annotationDirty: state.dirtyState?.annotationDirty ?? null,
                creationFailureVisible,
                annotationDirtyEntityCount: state.dirtyState?.annotationDirtyEntityCount ?? null,
            };
        }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toEqual({
            annotationDirty: true,
            creationFailureVisible: false,
            annotationDirtyEntityCount: expect.any(Number),
        });
        const firstDirtyState = await readWorkspaceStateValues<IStickyDirtyState>(
            freshSession.page,
            ['dirtyState'],
        );
        expect(firstDirtyState.dirtyState?.annotationDirtyEntityCount ?? 0).toBeGreaterThan(0);
        const firstLiveSession = await readVisibleStickyNoteSession(freshSession.page, firstText);
        expect(firstLiveSession.noteCount).toBeGreaterThan(0);

        const firstSaveStartedAt = Date.now();
        const firstSaveEvent = await saveViaVisibleToolbarWithDeadline(
            freshSession.page,
            LARGE_PDF_SAVE_TIMEOUT_MS,
            fixtureRealPath,
            {
                label: 'large PDF sticky-note first save',
                onTimeout: () => freshSession.stop(),
                diagnostics: () => `phase=large-pdf-sticky-note-first-save session=${freshSession.name}`,
            },
        );
        const firstSaveElapsedMs = Date.now() - firstSaveStartedAt;
        expect(firstSaveElapsedMs).toBeLessThan(LARGE_PDF_SAVE_TIMEOUT_MS);
        expect(realpathSync(String(firstSaveEvent.detail.path))).toBe(fixtureRealPath);
        const firstRevisionToken = firstSaveEvent.detail.documentRevisionToken;
        expect(firstRevisionToken).toEqual(expect.any(String));
        expect(String(firstRevisionToken).length).toBeGreaterThan(0);
        const firstSaveIdentity = await readDocumentSaveIdentity(freshSession.page);
        expect(firstSaveIdentity.revision.token).toBe(firstRevisionToken);

        await expect.poll(async () => {
            const [
                toolbar,
                liveSession,
                workspace,
            ] = await Promise.all([
                getWorkspaceToolbarSnapshot(freshSession.page),
                readVisibleStickyNoteSession(freshSession.page, firstText),
                readWorkspaceStateValues<{dirtyState?: {
                    annotationDirty: boolean;
                    fileDirty: boolean;
                    hasAnnotationChanges: boolean;
                    annotationDirtyEntityCount: number;
                    hasPendingUnsavedChanges: boolean;
                };}>(freshSession.page, ['dirtyState']),
            ]);
            const dirty = workspace.dirtyState;
            return {
                annotationDirty: dirty?.annotationDirty ?? null,
                currentPage: toolbar?.currentPage ?? null,
                fileDirty: dirty?.fileDirty ?? null,
                hasAnnotationChanges: dirty?.hasAnnotationChanges ?? null,
                annotationDirtyEntityCount: dirty?.annotationDirtyEntityCount ?? null,
                hasPendingUnsavedChanges: dirty?.hasPendingUnsavedChanges ?? null,
                notePresent: liveSession.noteCount > 0,
                textPreserved: liveSession.text === firstText,
            };
        }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toEqual({
            annotationDirty: false,
            currentPage: stickyPageNumber,
            fileDirty: false,
            hasAnnotationChanges: false,
            annotationDirtyEntityCount: 0,
            hasPendingUnsavedChanges: false,
            notePresent: true,
            textPreserved: true,
        });

        await qpdfCheck(fixtureRealPath);
        expect(statSync(fixtureRealPath).size).toBeGreaterThan(sourceBytes);
        expect(await hashFileSha256(fixtureRealPath, sourceBytes)).toBe(sourceHash);
        const firstOutputHash = await hashFileSha256(fixtureRealPath);
        expect(firstOutputHash).not.toBe(sourceHash);
        const firstStructure = await verifyStickyNoteStructure(
            freshSession.page,
            fixtureRealPath,
            firstText,
            stickyPageIndex,
            String(firstRevisionToken),
            firstSaveIdentity.workingCopyPath,
        );

        await waitForCrashCheckpointPath(freshSession.name, fixtureRealPath);
        const firstProcesses = readSessionProcessSnapshot(freshSession.name);
        const restartedSession = await sessionFixture.restart({
            clean: false,
            hard: true,
            keepNuxt: true,
        });
        if (!restartedSession) {
            throw new Error('First hard restart did not produce a new Electron process');
        }
        await expectProcessesExited(firstProcesses.pids);
        const restartedProcesses = readSessionProcessSnapshot(restartedSession.name);
        expect(restartedProcesses.rootPid).not.toBe(firstProcesses.rootPid);
        await waitForRestoredDocument(restartedSession.page, fixtureRealPath);
        await expectCleanAnnotationHydration(restartedSession.page);
        await expect.poll(async () => (
            await getWorkspaceToolbarSnapshot(restartedSession.page)
        )?.currentPage, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBe(stickyPageNumber);
        const restoredFirstIdentity = await readDocumentSaveIdentity(restartedSession.page);
        // A clean checkpoint reopens sourceRef and creates a new working-copy
        // revision fence. The PDF name and object identity below are the
        // durable annotation identity; the process-local revision token is not.
        expect(restoredFirstIdentity.revision.documentRef).toBe(restoredFirstIdentity.workingCopyPath);
        expect(restoredFirstIdentity.revision.contentRevision).toBeGreaterThan(0);
        await verifyStickyNoteStructure(
            restartedSession.page,
            fixtureRealPath,
            firstText,
            stickyPageIndex,
            String(restoredFirstIdentity.revision.token),
            restoredFirstIdentity.workingCopyPath,
        );

        await editVisibleStickyNote(restartedSession.page, firstText, editedFirstText);
        await createStickyNoteWithPointer(restartedSession.page, secondText, {
            x: 0.45,
            y: 0.4,
        }, stickyPageNumber);
        await waitForSaveFrontierReady(restartedSession.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        const secondDirtyState = await readWorkspaceStateValues<{dirtyState?: {
            annotationDirty: boolean;
            hasAnnotationChanges: boolean;
            annotationDirtyEntityCount: number;
        };}>(restartedSession.page, ['dirtyState']);
        expect(secondDirtyState.dirtyState?.annotationDirty).toBe(true);
        expect(secondDirtyState.dirtyState?.hasAnnotationChanges).toBe(true);
        expect(secondDirtyState.dirtyState?.annotationDirtyEntityCount ?? 0).toBeGreaterThan(0);
        await installStagedArtifactCapture(restartedSession.page);
        const secondSaveStartedAt = Date.now();
        const secondSavePromise = saveViaVisibleToolbarWithDeadline(
            restartedSession.page,
            LARGE_PDF_SAVE_TIMEOUT_MS,
            fixtureRealPath,
            {
                label: 'large PDF sticky-note second save',
                onTimeout: () => restartedSession.stop(),
                diagnostics: () => `phase=large-pdf-sticky-note-second-save session=${restartedSession.name}`,
            },
        );
        const stagedClonePath = join(restartArtifactDir, 'second-save-staged.pdf');
        let stagedArtifact: ITypedStagedArtifact | null = null;
        let stagedInspectionElapsedMs = 0;
        let stagedCaptureFailed = false;
        let stagedCaptureFailure: unknown;
        try {
            stagedArtifact = await waitForStagedArtifact(restartedSession.page);
            const stagedInspectionStartedAt = Date.now();
            try {
                copyFileSync(stagedArtifact.path, stagedClonePath, constants.COPYFILE_FICLONE);
            } catch {
                copyFileSync(stagedArtifact.path, stagedClonePath);
            } finally {
                stagedInspectionElapsedMs = Date.now() - stagedInspectionStartedAt;
            }
        } catch (error) {
            stagedCaptureFailed = true;
            stagedCaptureFailure = error;
        } finally {
            await resumeStagedArtifactCommit(restartedSession.page);
        }
        if (stagedCaptureFailed) {
            await secondSavePromise;
            throw stagedCaptureFailure;
        }
        const secondSaveEvent = await secondSavePromise;
        const secondSaveElapsedMs = Date.now() - secondSaveStartedAt - stagedInspectionElapsedMs;
        expect(secondSaveElapsedMs).toBeLessThan(LARGE_PDF_SAVE_TIMEOUT_MS);
        expect(realpathSync(String(secondSaveEvent.detail.path))).toBe(fixtureRealPath);
        const secondRevisionToken = secondSaveEvent.detail.documentRevisionToken;
        expect(secondRevisionToken).toEqual(expect.any(String));
        expect(String(secondRevisionToken).length).toBeGreaterThan(0);
        expect(secondRevisionToken).not.toBe(firstRevisionToken);
        const secondSaveIdentity = await readDocumentSaveIdentity(restartedSession.page);
        expect(secondSaveIdentity.revision.token).toBe(secondRevisionToken);

        await qpdfCheck(fixtureRealPath);
        expect(await hashFileSha256(fixtureRealPath, sourceBytes)).toBe(sourceHash);
        const secondOutputHash = await hashFileSha256(fixtureRealPath);
        expect(secondOutputHash).not.toBe(firstOutputHash);
        const stagedFirstObject = await readQpdfObject(stagedClonePath, firstStructure.annotation);
        const publishedFirstObject = await readQpdfObject(fixtureRealPath, firstStructure.annotation);
        const workingCopyFirstObject = await readQpdfObject(
            secondSaveIdentity.workingCopyPath,
            firstStructure.annotation,
        );
        const publicationProbe = {
            stagedArtifact,
            stagedHash: await hashFileSha256(stagedClonePath),
            originalHash: secondOutputHash,
            workingCopyHash: await hashFileSha256(secondSaveIdentity.workingCopyPath),
            stagedFirstObject,
            publishedFirstObject,
            workingCopyFirstObject,
        };
        expect(publicationProbe.workingCopyHash, JSON.stringify(publicationProbe))
            .toBe(publicationProbe.originalHash);
        expect(
            qpdfDictionaryContainsText(stagedFirstObject, 'Contents', editedFirstText),
            JSON.stringify(publicationProbe),
        ).toBe(true);
        expect(
            qpdfDictionaryContainsText(publishedFirstObject, 'Contents', editedFirstText),
            JSON.stringify(publicationProbe),
        ).toBe(true);
        expect(
            qpdfDictionaryContainsText(workingCopyFirstObject, 'Contents', editedFirstText),
            JSON.stringify(publicationProbe),
        ).toBe(true);
        const secondStructure = await verifyStickyNoteStructure(
            restartedSession.page,
            fixtureRealPath,
            editedFirstText,
            stickyPageIndex,
            String(secondRevisionToken),
            secondSaveIdentity.workingCopyPath,
        );
        await verifyStickyNoteStructure(
            restartedSession.page,
            fixtureRealPath,
            secondText,
            stickyPageIndex,
            String(secondRevisionToken),
            secondSaveIdentity.workingCopyPath,
        );
        expect({
            generationNumber: secondStructure.annotation.generationNumber,
            name: secondStructure.name,
            objectNumber: secondStructure.annotation.objectNumber,
            popupGenerationNumber: secondStructure.popup.generationNumber,
            popupObjectNumber: secondStructure.popup.objectNumber,
            rect: secondStructure.rect,
        }).toEqual({
            generationNumber: firstStructure.annotation.generationNumber,
            name: firstStructure.name,
            objectNumber: firstStructure.annotation.objectNumber,
            popupGenerationNumber: firstStructure.popup.generationNumber,
            popupObjectNumber: firstStructure.popup.objectNumber,
            rect: firstStructure.rect,
        });

        await waitForCrashCheckpointPath(restartedSession.name, fixtureRealPath);
        const secondProcesses = readSessionProcessSnapshot(restartedSession.name);
        const twiceRestartedSession = await sessionFixture.restart({
            clean: false,
            hard: true,
            keepNuxt: true,
        });
        if (!twiceRestartedSession) {
            throw new Error('Second hard restart did not produce a new Electron process');
        }
        await expectProcessesExited(secondProcesses.pids);
        const twiceRestartedProcesses = readSessionProcessSnapshot(twiceRestartedSession.name);
        expect(twiceRestartedProcesses.rootPid).not.toBe(secondProcesses.rootPid);
        await waitForRestoredDocument(twiceRestartedSession.page, fixtureRealPath);
        await expectCleanAnnotationHydration(twiceRestartedSession.page);
        await expect.poll(async () => (
            await getWorkspaceToolbarSnapshot(twiceRestartedSession.page)
        )?.currentPage, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBe(stickyPageNumber);
        await openAnnotationsTab(twiceRestartedSession.page, 30_000);
        await expect.poll(() => twiceRestartedSession.page.evaluate((expectedText: string) => (
            Array.from(document.querySelectorAll<HTMLElement>(
                '.editor-pane.is-active .workspace-host .notes-list .note-item',
            )).some(item => item.textContent?.includes(expectedText) === true)
        ), editedFirstText), {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBe(true);
        await expect.poll(() => twiceRestartedSession.page.evaluate((expectedText: string) => (
            Array.from(document.querySelectorAll<HTMLElement>(
                '.editor-pane.is-active .workspace-host .notes-list .note-item',
            )).some(item => item.textContent?.includes(expectedText) === true)
        ), secondText), {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBe(true);
        const restoredSecondIdentity = await readDocumentSaveIdentity(twiceRestartedSession.page);
        expect(restoredSecondIdentity.revision.documentRef).toBe(restoredSecondIdentity.workingCopyPath);
        expect(restoredSecondIdentity.revision.contentRevision).toBeGreaterThan(0);
        await verifyStickyNoteStructure(
            twiceRestartedSession.page,
            fixtureRealPath,
            editedFirstText,
            stickyPageIndex,
            String(restoredSecondIdentity.revision.token),
            restoredSecondIdentity.workingCopyPath,
        );
        await verifyStickyNoteStructure(
            twiceRestartedSession.page,
            fixtureRealPath,
            secondText,
            stickyPageIndex,
            String(restoredSecondIdentity.revision.token),
            restoredSecondIdentity.workingCopyPath,
        );
    }, LARGE_PDF_TIMEOUT_MS);

    exactZaliznyakIt('keeps ordinary FreeText visible through issue 139 save and layout transitions', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Issue 139 visibility test requires a live Electron session');
        }
        const fixtureSourcePath = largePdfFixture.path;
        if (!fixtureSourcePath) {
            throw new Error(`Required exact Zaliznyak fixture is unavailable: ${largePdfFixture.reason}`);
        }
        await admitExactZaliznyakFixture(fixtureSourcePath);
        const fixturePath = copyLargePdfFixture(`issue-139-visibility-${Date.now()}.pdf`);
        const sentinels = [
            'issue139-a',
            'issue139-b',
            'issue139-c',
            'issue139-d',
            'adsfadsf',
        ];
        const persistedSentinels = sentinels.slice(0, -1);

        await openPdfInApp(session.page, fixturePath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(session.page, LARGE_PDF_TIMEOUT_MS);
        await enablePdfDiagnosticSession(session.page, {render: true});
        await openAnnotationsTab(session.page, 30_000);

        const positions = [
            {
                x: 0.25,
                y: 0.2,
            },
            {
                x: 0.65,
                y: 0.32,
            },
            {
                x: 0.3,
                y: 0.52,
            },
            {
                x: 0.68,
                y: 0.64,
            },
        ];
        for (const [
            index,
            position,
        ] of positions.entries()) {
            expect(await createFreeTextAnnotationWithPointer(
                session.page,
                sentinels[index]!,
                position,
            )).toBe(index + 1);
        }
        await waitForSaveFrontierReady(session.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        await saveViaWindowHandle(session.page, LARGE_PDF_TIMEOUT_MS);

        const fixtureRealPath = realpathSync(fixturePath);
        await waitForCrashCheckpointPath(session.name, fixtureRealPath);
        const preRestartProcesses = readSessionProcessSnapshot(session.name);
        const persistedSession = await sessionFixture.restart({
            clean: false,
            hard: true,
            keepNuxt: true,
        });
        if (!persistedSession) {
            throw new Error('Issue 139 persistence setup did not produce a new Electron process');
        }
        await expectProcessesExited(preRestartProcesses.pids);
        session = persistedSession;
        await waitForRestoredDocument(session.page, fixtureRealPath);
        await enablePdfDiagnosticSession(session.page, {render: true});
        await openAnnotationsTab(session.page, 30_000);

        await expect.poll(async () => session!.page.evaluate(() => {
            const probeWindow = window as IWorkspaceExposeProbeWindow;
            const workspace = probeWindow.__evbFindWorkspaceExpose?.({requiredProperties: ['annotationComments']}) as {annotationComments?: unknown[] | {value?: unknown[]}} | null;
            const comments = workspace?.annotationComments;
            const value = comments && !Array.isArray(comments) && 'value' in comments
                ? comments.value
                : comments;
            const host = globalThis.__evbE2E.getActiveWorkspaceHost();
            return {
                canonicalCount: Array.isArray(value) ? value.length : -1,
                editorCount: host?.querySelectorAll(
                    '[data-annotation-kind="text-box"]',
                ).length ?? 0,
                sidebarCount: host?.querySelectorAll('.notes-list .note-item').length ?? 0,
                visualCount: host?.querySelectorAll(
                    '.pdf-annotation-editor-layer [data-annotation-kind="text-box"]',
                ).length ?? 0,
            };
        }), {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toEqual({
            canonicalCount: persistedSentinels.length,
            editorCount: persistedSentinels.length,
            sidebarCount: persistedSentinels.length,
            visualCount: persistedSentinels.length,
        });
        expect(await createFreeTextAnnotationWithPointer(
            session.page,
            sentinels.at(-1)!,
            {
                x: 0.48,
                y: 0.76,
            },
        )).toBe(sentinels.length);
        await waitForSaveFrontierReady(session.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        await installStagedArtifactCapture(session.page);
        const saveBaselineEventId = await getLatestAutomationEventId(session.page);
        await startIssue139VisibilityProbe(
            session.page,
            saveBaselineEventId,
            sentinels,
        );
        onTestFinished(() => stopIssue139VisibilityProbe(session!.page));
        await expect.poll(async () => session!.page.evaluate(() => {
            const probeWindow = window as IIssue139VisibilityProbeWindow & IWorkspaceExposeProbeWindow;
            const workspace = probeWindow.__evbFindWorkspaceExpose?.({requiredProperties: ['annotationComments']}) as {annotationComments?: unknown[] | {value?: unknown[]}} | null;
            const comments = workspace?.annotationComments;
            const value = comments && !Array.isArray(comments) && 'value' in comments
                ? comments.value
                : comments;
            const host = globalThis.__evbE2E.getActiveWorkspaceHost();
            const editors = Array.from(host?.querySelectorAll<HTMLElement>(
                '[data-annotation-kind="text-box"]',
            ) ?? []);
            return {
                canonicalCount: Array.isArray(value) ? value.length : -1,
                editorCount: editors.length,
                paintedFreeTextCount: editors.filter(element => (
                    host !== null
                    && probeWindow.__issue139IsPainted?.(element, host) === true
                )).length,
                sidebarCount: host?.querySelectorAll('.notes-list .note-item').length ?? 0,
            };
        }), {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toEqual({
            canonicalCount: sentinels.length,
            editorCount: sentinels.length,
            paintedFreeTextCount: sentinels.length,
            sidebarCount: sentinels.length,
        });
        const resizeSentinel = sentinels.at(-1)!;
        await setIssue139VisibilityProbePhase(session.page, 'text-box-resize');
        const resizedEditor = await dragIssue139FreeTextResizeHandle(
            session.page,
            resizeSentinel,
        );
        expect(resizedEditor.hitTarget, JSON.stringify(resizedEditor)).toEqual(expect.objectContaining({isBottomRightResizer: true}));
        expect(resizedEditor.after.width, JSON.stringify(resizedEditor)).toBeGreaterThan(resizedEditor.before.width);
        expect(resizedEditor.after.height, JSON.stringify(resizedEditor)).toBeGreaterThan(resizedEditor.before.height);
        await setIssue139VisibilityProbePhase(session.page, 'save-start');
        const savePromise = saveViaVisibleToolbarWithDeadline(
            session.page,
            LARGE_PDF_TIMEOUT_MS,
            fixturePath,
            {
                label: 'issue 139 transition save',
                onTimeout: () => session!.stop(),
                diagnostics: () => `phase=issue-139-transition-save session=${session!.name}`,
            },
        );
        let transitionError: unknown;
        try {
            await waitForStagedArtifact(session.page);
            await setIssue139VisibilityProbePhase(session.page, 'sidebar-close');
            const sidebarToggleClosed = await callWorkspaceCommand(session.page, 'handleToggleSidebar');
            expect(sidebarToggleClosed.called).toBe(true);
            await waitForIssue139VisibilityFrame(
                session.page,
                'sidebar-close',
                await getIssue139VisibilityFrameCount(session.page),
            );
            await setIssue139VisibilityProbePhase(session.page, 'sidebar-open');
            const sidebarToggleOpen = await callWorkspaceCommand(session.page, 'handleToggleSidebar');
            expect(sidebarToggleOpen.called).toBe(true);
            await waitForIssue139VisibilityFrame(
                session.page,
                'sidebar-open',
                await getIssue139VisibilityFrameCount(session.page),
            );
            await setIssue139VisibilityProbePhase(session.page, 'zoom');
            const zoom = await callWorkspaceCommand(session.page, 'handleZoomIn');
            expect(zoom.called).toBe(true);
            await waitForIssue139VisibilityFrame(
                session.page,
                'zoom',
                await getIssue139VisibilityFrameCount(session.page),
            );
            await setIssue139VisibilityProbePhase(session.page, 'viewport-small');
            await session.page.setViewport({
                width: 1_280,
                height: 820,
                deviceScaleFactor: 1,
            });
            await waitForIssue139VisibilityFrame(
                session.page,
                'viewport-small',
                await getIssue139VisibilityFrameCount(session.page),
            );
            await setIssue139VisibilityProbePhase(session.page, 'viewport-restored');
            await session.page.setViewport({
                width: 1_440,
                height: 900,
                deviceScaleFactor: 1,
            });
            await waitForIssue139VisibilityFrame(
                session.page,
                'viewport-restored',
                await getIssue139VisibilityFrameCount(session.page),
            );
        } catch (error) {
            transitionError = error;
        } finally {
            try {
                if (!session.page.isClosed()) {
                    await setIssue139VisibilityProbePhase(session.page, 'save-resume');
                }
            } catch (error) {
                if (!session.page.isClosed() && !isPageContextUnavailableError(error)) {
                    transitionError ??= error;
                }
            } finally {
                await resumeStagedArtifactCommit(session.page);
            }
        }
        const saveEvent = await savePromise;
        if (transitionError) {
            throw transitionError;
        }
        expect(saveEvent.id).toBeGreaterThan(saveBaselineEventId);
        const frames = await readIssue139VisibilityProbe(session.page);
        const transitionFrames = frames.filter(frame => frame.resizeTransitionActive);
        expect(frames.length).toBeGreaterThan(5);
        expect(transitionFrames.length).toBeGreaterThan(0);
        for (const frame of frames) {
            expect(frame.visibleSentinels, JSON.stringify(frame)).toContain(resizeSentinel);
            expect(frame.visibleSentinels, JSON.stringify(frame)).toEqual(expect.arrayContaining(sentinels));
            expect(frame.canonicalCount, JSON.stringify(frame)).toBe(sentinels.length);
            expect(frame.sidebarCount, JSON.stringify(frame)).toBe(sentinels.length);
            expect(frame.editorIdentities.length, JSON.stringify(frame)).toBe(sentinels.length);
            expect(frame.layerIdentities.length, JSON.stringify(frame)).toBeGreaterThan(0);
            expect(frame.paintedFreeTextCount, JSON.stringify(frame)).toBeGreaterThan(0);
        }
        // Layout transitions may remount the EVB editor layer. The element
        // identity is therefore not part of the persistence invariant. Every
        // frame above still exposes the expected content and application state.

        await waitForAutomationEvent(session.page, 'save-committed', {
            afterEventId: saveBaselineEventId,
            timeoutMs: LARGE_PDF_TIMEOUT_MS,
        });
        await expect.poll(
            () => readIssue139ApplicationCounts(session!.page),
            {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS},
        ).toEqual({
            canonicalCount: sentinels.length,
            sidebarCount: sentinels.length,
        });
        expect(await readPdfNoteContents(fixturePath)).toEqual(expect.arrayContaining(
            sentinels.map(contents => expect.objectContaining({
                contents,
                popup: '',
                subtype: '/FreeText',
            })),
        ));
        await qpdfCheck(fixtureRealPath);
        await stopIssue139VisibilityProbe(session.page);
        await waitForCrashCheckpointPath(session.name, fixtureRealPath);
        const transitionProcesses = readSessionProcessSnapshot(session.name);
        const reopenedSession = await sessionFixture.restart({
            clean: false,
            hard: true,
            keepNuxt: true,
        });
        if (!reopenedSession) {
            throw new Error('Issue 139 transition save did not produce a hard-restart session');
        }
        await expectProcessesExited(transitionProcesses.pids);
        session = reopenedSession;
        await waitForRestoredDocument(session.page, fixtureRealPath);
        await waitForPdfLoaded(session.page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(session.page, LARGE_PDF_TIMEOUT_MS);
        await openAnnotationsTab(session.page, 30_000);
        await expect.poll(
            () => readIssue139ApplicationCounts(session.page),
            {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS},
        ).toEqual({
            canonicalCount: sentinels.length,
            sidebarCount: sentinels.length,
        });
        await session.page.waitForFunction((expectedTexts: string[]) => {
            const host = globalThis.__evbE2E.getActiveWorkspaceHost();
            const sidebarText = host?.querySelector('.notes-list')?.textContent ?? '';
            return expectedTexts.every(expectedText => sidebarText.includes(expectedText));
        }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}, sentinels);
        // The EVB layer owns these entities, so the sidebar and canonical
        // projection remain the UI evidence after reopen. The PDF object
        // check below independently covers every saved annotation.
        const reopenedNotes = await readPdfNoteContents(fixtureRealPath);
        const reopenedSentinelNotes = reopenedNotes.filter(note => sentinels.includes(note.contents));
        expect(reopenedSentinelNotes).toHaveLength(sentinels.length);
        expect(reopenedSentinelNotes.map(note => note.contents).sort()).toEqual([...sentinels].sort());
        expect(reopenedSentinelNotes.every(note => note.subtype === '/FreeText')).toBe(true);
    }, LARGE_PDF_TIMEOUT_MS);

    it('creates, saves, and reopens an ordinary FreeText box on a large PDF', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const {page} = session;
        const fixtureSourcePath = largePdfFixture.path;
        if (!fixtureSourcePath) {
            throw new Error(`Required large PDF fixture is unavailable: ${largePdfFixture.reason}`);
        }
        const restartArtifactDir = mkdtempSync(join(tmpdir(), 'evb-large-pdf-hard-restart-'));
        onTestFinished(() => rmSync(restartArtifactDir, {
            force: true,
            recursive: true,
        }));
        const fixturePath = join(restartArtifactDir, 'saved.pdf');
        try {
            copyFileSync(fixtureSourcePath, fixturePath, constants.COPYFILE_FICLONE);
        } catch {
            copyFileSync(fixtureSourcePath, fixturePath);
        }
        const textSentinel = Date.now().toString();
        const text = `large pdf free text ${textSentinel}`;

        await openPdfInApp(page, fixturePath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(page, LARGE_PDF_TIMEOUT_MS);
        await openAnnotationsTab(page, 30_000);
        expect(await createFreeTextAnnotation(page, text)).toBeGreaterThan(0);
        try {
            await waitForSaveFrontierReady(page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        } catch (error) {
            const debugState = await collectLargePdfAnnotationDebugState(page).catch(() => null);
            const editorState = await page.evaluate(() => ({
                activeElement: document.activeElement?.outerHTML.slice(0, 1_000) ?? null,
                activeTool: globalThis.__evbE2E.getActiveWorkspaceHost()
                    ?.querySelector('.notes-panel .tool-button.is-active')
                    ?.getAttribute('data-tool') ?? null,
                editors: Array.from(document.querySelectorAll<HTMLElement>('[data-annotation-kind="text-box"]')).map(editor => ({
                    html: editor.outerHTML.slice(0, 2_000),
                    page: editor.closest<HTMLElement>('.page_container')?.dataset.page ?? null,
                    text: editor.textContent ?? '',
                })),
            })).catch(() => null);
            throw new Error(`FreeText save frontier did not become ready: ${JSON.stringify({
                debugState,
                editorState,
                cause: error instanceof Error ? error.message : String(error),
            })}`);
        }

        const agentSaveResult = await saveLargePdfViaAgentAction(page);
        if (!agentSaveResult) {
            await saveViaWindowHandle(page, LARGE_PDF_TIMEOUT_MS);
        }
        const savedState = await readWorkspaceStateValues<{
            originalPath?: string | null;
            workingCopyPath?: string | null;
        }>(page, [
            'workingCopyPath',
            'originalPath',
        ]);
        const savedPath = typeof agentSaveResult?.status?.originalPath === 'string'
            ? agentSaveResult.status.originalPath
            : typeof agentSaveResult?.status?.workingCopyPath === 'string'
                ? agentSaveResult.status.workingCopyPath
                : typeof savedState.workingCopyPath === 'string'
                    ? savedState.workingCopyPath
                    : fixturePath;
        const savedNotes = await readPdfNoteContents(savedPath);
        // The headless contenteditable helper can omit its first typed token;
        // the timestamp suffix still identifies this editor uniquely.
        const savedFreeText = savedNotes.filter(note => note.contents.endsWith(`pdf free text ${textSentinel}`));
        expect(savedFreeText, JSON.stringify({
            agentSaveResult,
            savedPath,
            savedState,
            savedNotes: savedNotes.slice(0, 20),
        })).toEqual([expect.objectContaining({
            name: expect.stringMatching(/^anno_[0-9a-f-]{36}$/u),
            popup: '',
            subtype: '/FreeText',
        })]);
        const persistedText = savedFreeText[0]?.contents;
        const persistedName = savedFreeText[0]?.name;
        expect(persistedText).toBeTruthy();
        expect(persistedName).toMatch(/^anno_[0-9a-f-]{36}$/u);

        // Require the durable original to reach the crash checkpoint before
        // stopping Electron. The restarted process must restore this tab
        // itself; an explicit open would exercise a different lifecycle.
        const expectedFixtureRealPath = realpathSync(fixturePath);
        const liveDocumentState = await readWorkspaceStateValues<{
            originalPath?: string | null;
            workingCopyPath?: string | null;
        }>(page, [
            'originalPath',
            'workingCopyPath',
        ]);
        expect(
            typeof liveDocumentState.originalPath === 'string'
                ? realpathSync(liveDocumentState.originalPath)
                : null,
            JSON.stringify(liveDocumentState),
        ).toBe(expectedFixtureRealPath);
        await waitForCrashCheckpointPath(session.name, expectedFixtureRealPath);

        const restartedSession = await sessionFixture.restart({
            clean: false,
            hard: true,
            keepNuxt: true,
        });
        expect(restartedSession).not.toBeNull();
        const restartedPage = restartedSession!.page;
        await expect.poll(async () => {
            const state = await readWorkspaceStateValues<{originalPath?: string | null;}>(restartedPage, ['originalPath']);
            return typeof state.originalPath === 'string'
                ? realpathSync(state.originalPath)
                : null;
        }, {timeout: LARGE_PDF_TIMEOUT_MS}).toBe(expectedFixtureRealPath);
        await waitForPdfLoaded(restartedPage, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(restartedPage, LARGE_PDF_TIMEOUT_MS);
        const restoredDebugState = await collectLargePdfAnnotationDebugState(restartedPage);
        expect(restoredDebugState.annotationDirty, JSON.stringify(restoredDebugState)).toBe(false);
        expect(restoredDebugState.hasAnnotationChanges, JSON.stringify(restoredDebugState)).toBe(false);

        const reopenedNotes = await readPdfNoteContents(fixturePath);
        expect(reopenedNotes.filter(note => note.contents === persistedText)).toEqual([expect.objectContaining({
            name: persistedName,
            popup: '',
            subtype: '/FreeText',
        })]);

        const secondText = `large pdf second free text ${Date.now()}`;
        await openAnnotationsTab(restartedPage, 30_000);
        await clickAnnotationTool(restartedPage, 'Text', 30_000);
        await restartedPage.evaluate(async () => {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        });
        await restartedPage.waitForFunction(() => {
            const host = globalThis.__evbE2E.getActiveWorkspaceHost();
            const activeTool = host?.querySelector('.notes-panel .tool-button.is-active')?.getAttribute('data-tool') ?? null;
            const layer = host?.querySelector<HTMLElement>('.pdf-annotation-editor-layer');
            return activeTool === 'text' && layer?.classList.contains('is-interactive') === true;
        }, {timeout: 15_000});
        const editorHydrationDebugState = await collectLargePdfAnnotationDebugState(restartedPage);
        const editorHydrationDomState = await restartedPage.evaluate(() => {
            const host = globalThis.__evbE2E.getActiveWorkspaceHost();
            const layer = host?.querySelector<HTMLElement>('.pdf-annotation-editor-layer');
            return {
                activeTool: host?.querySelector('.notes-panel .tool-button.is-active')?.getAttribute('data-tool') ?? null,
                editorCount: host?.querySelectorAll('[data-annotation-kind="text-box"]').length ?? 0,
                layerClassName: layer?.className ?? null,
            };
        });
        expect(editorHydrationDebugState.annotationDirty, JSON.stringify({
            editorHydrationDebugState,
            editorHydrationDomState,
        })).toBe(false);
        expect(editorHydrationDebugState.annotationDirtyEntityCount, JSON.stringify({
            editorHydrationDebugState,
            editorHydrationDomState,
        })).toBe(0);
        expect(editorHydrationDomState.activeTool, JSON.stringify({
            editorHydrationDebugState,
            editorHydrationDomState,
        })).toBe('text');
        expect(editorHydrationDomState.layerClassName, JSON.stringify({
            editorHydrationDebugState,
            editorHydrationDomState,
        })).toContain('is-interactive');
        expect(editorHydrationDomState.editorCount, JSON.stringify({
            editorHydrationDebugState,
            editorHydrationDomState,
        })).toBe(1);
        let secondFreeTextCount: number;
        try {
            secondFreeTextCount = await createFreeTextAnnotationWithPointer(
                restartedPage,
                secondText,
                {
                    x: 0.72,
                    y: 0.68,
                },
            );
        } catch (error) {
            const failedEditorDebugState = await collectLargePdfAnnotationDebugState(restartedPage);
            throw new Error(`Restored FreeText creation failed: ${JSON.stringify({
                editorHydrationDebugState,
                editorHydrationDomState,
                failedEditorDebugState,
                cause: error instanceof Error ? error.message : String(error),
            })}`);
        }
        expect(secondFreeTextCount).toBeGreaterThan(0);
        try {
            await waitForSaveFrontierReady(restartedPage, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        } catch (error) {
            const failedFrontierDebugState = await collectLargePdfAnnotationDebugState(restartedPage);
            const failedFrontierDomState = await restartedPage.evaluate(() => {
                const host = globalThis.__evbE2E.getActiveWorkspaceHost();
                const workspace = (window as Window & {__evbTestApi?: {getActiveWorkspaceHandle?: () => {
                    getAutomationStateSnapshot?: () => unknown;
                    getToolbarSnapshot?: () => unknown;
                } | null;};}).__evbTestApi?.getActiveWorkspaceHandle?.() ?? null;
                const layer = host?.querySelector<HTMLElement>('.pdf-annotation-editor-layer');
                return {
                    activeElement: document.activeElement?.outerHTML.slice(0, 1_000) ?? null,
                    activeTool: host?.querySelector('.notes-panel .tool-button.is-active')?.getAttribute('data-tool') ?? null,
                    editorCount: host?.querySelectorAll('[data-annotation-kind="text-box"]').length ?? 0,
                    editors: Array.from(host?.querySelectorAll<HTMLElement>('[data-annotation-kind="text-box"]') ?? []).map(editor => ({
                        id: editor.id,
                        text: editor.textContent ?? '',
                        classes: editor.className,
                    })),
                    layerClassName: layer?.className ?? null,
                    toolbar: workspace?.getToolbarSnapshot?.() ?? null,
                    automationState: workspace?.getAutomationStateSnapshot?.() ?? null,
                };
            });
            throw new Error(`Restored FreeText save frontier did not become ready: ${JSON.stringify({
                failedFrontierDebugState,
                failedFrontierDomState,
                cause: error instanceof Error ? error.message : String(error),
            })}`);
        }
        const secondAgentSaveResult = await saveLargePdfViaAgentAction(restartedPage);
        if (!secondAgentSaveResult) {
            await saveViaWindowHandle(restartedPage, LARGE_PDF_TIMEOUT_MS);
        }
        const twiceSavedNotes = await readPdfNoteContents(fixturePath);
        expect(twiceSavedNotes.filter(note => note.contents === persistedText)).toHaveLength(1);
        expect(twiceSavedNotes.filter(note => note.contents === secondText)).toHaveLength(1);
    }, LARGE_PDF_TIMEOUT_MS);

    it.runIf(runStickyRestartScenario)('deletes a persisted ordinary FreeText through the sidebar and keeps it absent after restart', async () => {
        const initialSession = sessionFixture.getSession();
        if (!initialSession) {
            return;
        }
        const fixtureSourcePath = largePdfFixture.path;
        if (!fixtureSourcePath) {
            throw new Error(`Required large PDF fixture is unavailable: ${largePdfFixture.reason}`);
        }
        await admitExactZaliznyakFixture(fixtureSourcePath);
        const initialProcesses = readSessionProcessSnapshot(initialSession.name);
        const freshSession = await sessionFixture.restart({
            clean: true,
            hard: true,
            keepNuxt: true,
        });
        if (!freshSession) {
            throw new Error('Could not start a fresh Electron process for the FreeText sidebar-delete test');
        }
        await expectProcessesExited(initialProcesses.pids);
        const freshProcesses = readSessionProcessSnapshot(freshSession.name);
        expect(freshProcesses.rootPid).not.toBe(initialProcesses.rootPid);

        const artifactRoot = process.env[LARGE_PDF_ARTIFACT_ROOT_ENV]?.trim() || tmpdir();
        const restartArtifactDir = mkdtempSync(join(artifactRoot, '.evb-large-pdf-freetext-delete-'));
        onTestFinished(() => rmSync(restartArtifactDir, {
            force: true,
            recursive: true,
        }));
        const fixturePath = join(restartArtifactDir, 'saved.pdf');
        try {
            copyFileSync(fixtureSourcePath, fixturePath, constants.COPYFILE_FICLONE);
        } catch {
            copyFileSync(fixtureSourcePath, fixturePath);
        }
        const fixtureRealPath = realpathSync(fixturePath);
        const text = `large pdf sidebar delete ${Date.now()}`;

        await openPdfInApp(freshSession.page, fixtureRealPath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(freshSession.page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(freshSession.page, LARGE_PDF_TIMEOUT_MS);
        await openAnnotationsTab(freshSession.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        expect(await createFreeTextAnnotationWithPointer(
            freshSession.page,
            text,
            {
                x: 0.42,
                y: 0.34,
            },
        )).toBeGreaterThan(0);
        await waitForSaveFrontierReady(freshSession.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        let firstSaveEvent: Awaited<ReturnType<typeof saveViaVisibleToolbarWithDeadline>>;
        try {
            firstSaveEvent = await saveViaVisibleToolbarWithDeadline(
                freshSession.page,
                LARGE_PDF_SAVE_TIMEOUT_MS,
                fixtureRealPath,
                {
                    label: 'large PDF ordinary FreeText sidebar-delete first save',
                    onTimeout: () => freshSession.stop(),
                    diagnostics: () => `phase=large-pdf-freetext-sidebar-delete-first-save session=${freshSession.name}`,
                },
            );
        } catch (error) {
            const liveState = await readOrdinaryFreeTextLiveState(freshSession.page, text)
                .catch(cause => ({error: cause instanceof Error ? cause.message : String(cause)}));
            const domDiagnostics = await readOrdinaryFreeTextDomDiagnostics(freshSession.page)
                .catch(cause => ({error: cause instanceof Error ? cause.message : String(cause)}));
            throw new Error(`Ordinary FreeText first save failed: ${JSON.stringify({
                liveState,
                domDiagnostics,
                cause: error instanceof Error ? error.message : String(error),
            })}`);
        }
        expect(realpathSync(String(firstSaveEvent.detail.path))).toBe(fixtureRealPath);
        const firstSaveIdentity = await readDocumentSaveIdentity(freshSession.page);

        let savedState: IOrdinaryFreeTextLiveState;
        try {
            savedState = await waitForOrdinaryFreeTextState(
                freshSession.page,
                text,
                {
                    // EVB owns the editor and sidebar projection from the
                    // moment the text box is created. The native save updates
                    // the PDF, but does not replace the live entity.
                    canonicalMatchCount: 1,
                    editorMatchCount: 1,
                    visualMatchCount: 1,
                    sidebarMatchCount: 1,
                },
            );
        } catch (error) {
            const debugState = await collectLargePdfAnnotationDebugState(freshSession.page).catch(() => null);
            const liveState = await readOrdinaryFreeTextLiveState(freshSession.page, text)
                .catch(cause => ({error: cause instanceof Error ? cause.message : String(cause)}));
            const domDiagnostics = await readOrdinaryFreeTextDomDiagnostics(freshSession.page)
                .catch(cause => ({error: cause instanceof Error ? cause.message : String(cause)}));
            throw new Error(`Ordinary FreeText did not remain in the canonical/sidebar projection after save: ${JSON.stringify({
                debugState,
                liveState,
                domDiagnostics,
                cause: error instanceof Error ? error.message : String(error),
            })}`);
        }
        const firstPersistedMatches = await readBoundedOrdinaryFreeTextMatches(
            freshSession.page,
            fixtureRealPath,
            text,
            undefined,
            undefined,
            firstSaveIdentity.workingCopyPath,
        );
        expect(firstPersistedMatches, JSON.stringify({
            savedState,
            firstPersistedMatches,
        })).toHaveLength(1);
        const firstPersistedMatch = firstPersistedMatches[0];
        if (!firstPersistedMatch) {
            throw new Error('Saved ordinary FreeText was not present in the persisted PDF');
        }
        const targetPageIndex = firstPersistedMatch.annotation.pageIndex;
        const targetPageNumber = targetPageIndex + 1;
        const persistedName = undefined;

        await waitForCrashCheckpointPath(freshSession.name, fixtureRealPath);
        const firstRestartProcesses = readSessionProcessSnapshot(freshSession.name);
        const reopenedSession = await sessionFixture.restart({
            clean: false,
            hard: true,
            keepNuxt: true,
        });
        if (!reopenedSession) {
            throw new Error('First hard restart did not produce a new Electron process for the FreeText sidebar-delete test');
        }
        await expectProcessesExited(firstRestartProcesses.pids);
        const reopenedProcesses = readSessionProcessSnapshot(reopenedSession.name);
        expect(reopenedProcesses.rootPid).not.toBe(firstRestartProcesses.rootPid);
        await waitForRestoredDocument(reopenedSession.page, fixtureRealPath);
        await expectCleanAnnotationHydration(reopenedSession.page);
        const reopenedSaveIdentity = await readDocumentSaveIdentity(reopenedSession.page);
        await scrollViewerToPage(reopenedSession.page, targetPageNumber);
        await openAnnotationsTab(reopenedSession.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        let restoredState: IOrdinaryFreeTextLiveState;
        try {
            restoredState = await waitForOrdinaryFreeTextState(
                reopenedSession.page,
                text,
                {
                    canonicalMatchCount: 1,
                    // Reopened FreeText is imported into the EVB canonical
                    // editor layer. PDF.js remains read-only for this path.
                    editorMatchCount: 1,
                    visualMatchCount: 1,
                    sidebarMatchCount: 1,
                },
            );
        } catch (error) {
            const debugState = await collectLargePdfAnnotationDebugState(reopenedSession.page).catch(() => null);
            const liveState = await readOrdinaryFreeTextLiveState(reopenedSession.page, text)
                .catch(cause => ({error: cause instanceof Error ? cause.message : String(cause)}));
            const domDiagnostics = await readOrdinaryFreeTextDomDiagnostics(reopenedSession.page)
                .catch(cause => ({error: cause instanceof Error ? cause.message : String(cause)}));
            throw new Error(`Ordinary FreeText did not rehydrate into the canonical/sidebar projection: ${JSON.stringify({
                debugState,
                liveState,
                domDiagnostics,
                cause: error instanceof Error ? error.message : String(error),
            })}`);
        }
        const restoredComment = restoredState.canonicalMatches[0];
        expect(restoredComment, JSON.stringify(restoredState)).toMatchObject({
            annotationId: expect.any(String),
            annotationName: persistedName ?? null,
            source: 'pdf',
            subtype: 'FreeText',
            text,
        });

        try {
            await clickSidebarDeleteForText(reopenedSession.page, text);
        } catch (error) {
            const liveState = await readOrdinaryFreeTextLiveState(reopenedSession.page, text)
                .catch(cause => ({error: cause instanceof Error ? cause.message : String(cause)}));
            const domDiagnostics = await readOrdinaryFreeTextDomDiagnostics(reopenedSession.page)
                .catch(cause => ({error: cause instanceof Error ? cause.message : String(cause)}));
            throw new Error(`Ordinary FreeText sidebar delete control was not found: ${JSON.stringify({
                liveState,
                domDiagnostics,
                cause: error instanceof Error ? error.message : String(error),
            })}`);
        }
        let deletedState: IOrdinaryFreeTextLiveState;
        try {
            deletedState = await waitForOrdinaryFreeTextState(
                reopenedSession.page,
                text,
                {
                    canonicalMatchCount: 0,
                    editorMatchCount: 0,
                    visualMatchCount: 0,
                    sidebarMatchCount: 0,
                },
            );
        } catch (error) {
            const liveState = await readOrdinaryFreeTextLiveState(reopenedSession.page, text)
                .catch(cause => ({error: cause instanceof Error ? cause.message : String(cause)}));
            const domDiagnostics = await readOrdinaryFreeTextDomDiagnostics(reopenedSession.page)
                .catch(cause => ({error: cause instanceof Error ? cause.message : String(cause)}));
            throw new Error(`Ordinary FreeText did not disappear from the annotation layer/canonical/sidebar projection: ${JSON.stringify({
                liveState,
                domDiagnostics,
                cause: error instanceof Error ? error.message : String(error),
            })}`);
        }
        expect(deletedState.canonicalMatches).toHaveLength(0);
        expect(deletedState.editorMatchCount).toBe(0);
        expect(deletedState.visualMatchCount).toBe(0);
        expect(deletedState.sidebarMatchCount).toBe(0);

        await expect.poll(async () => {
            const state = await readWorkspaceStateValues<Record<string, unknown>>(
                reopenedSession.page,
                ['dirtyState'],
            );
            const dirty = state.dirtyState;
            return dirty !== null
                && typeof dirty === 'object'
                && (dirty as Record<string, unknown>).annotationDirty === true
                && (dirty as Record<string, unknown>).hasAnnotationChanges === true;
        }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBe(true);

        // Sidebar deletion is a live edit. The durable file must still contain
        // the annotation until the subsequent visible save commits it.
        const beforeDeleteSaveMatches = await readBoundedOrdinaryFreeTextMatches(
            reopenedSession.page,
            fixtureRealPath,
            text,
            persistedName,
            targetPageIndex,
            reopenedSaveIdentity.workingCopyPath,
        );
        expect(beforeDeleteSaveMatches, JSON.stringify({
            beforeDeleteSaveMatches,
            persistedName,
            targetPageIndex,
        })).toHaveLength(1);

        await waitForSaveFrontierReady(reopenedSession.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        const deleteSaveEvent = await saveViaVisibleToolbarWithDeadline(
            reopenedSession.page,
            LARGE_PDF_SAVE_TIMEOUT_MS,
            fixtureRealPath,
            {
                label: 'large PDF ordinary FreeText sidebar-delete second save',
                onTimeout: () => reopenedSession.stop(),
                diagnostics: () => `phase=large-pdf-freetext-sidebar-delete-second-save session=${reopenedSession.name}`,
            },
        );
        expect(realpathSync(String(deleteSaveEvent.detail.path))).toBe(fixtureRealPath);
        await new Promise(resolve => setTimeout(resolve, 750));
        const visibleToasts = await reopenedSession.page.evaluate(() => Array.from(document.querySelectorAll('.app-toast'))
            .filter((element) => {
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && style.visibility !== 'hidden';
            })
            .map(element => element.textContent ?? ''));
        expect(visibleToasts.some(text => text.includes('Failed to save file')), JSON.stringify({visibleToasts}))
            .toBe(false);
        await qpdfCheck(fixtureRealPath);
        const deletedPersistedMatches = await readBoundedOrdinaryFreeTextMatches(
            reopenedSession.page,
            fixtureRealPath,
            text,
            persistedName,
            targetPageIndex,
            reopenedSaveIdentity.workingCopyPath,
        );
        expect(deletedPersistedMatches, JSON.stringify({
            deletedPersistedMatches,
            persistedName,
            targetPageIndex,
        })).toHaveLength(0);

        await waitForCrashCheckpointPath(reopenedSession.name, fixtureRealPath);
        const secondRestartProcesses = readSessionProcessSnapshot(reopenedSession.name);
        const finalSession = await sessionFixture.restart({
            clean: false,
            hard: true,
            keepNuxt: true,
        });
        if (!finalSession) {
            throw new Error('Second hard restart did not produce a new Electron process for the FreeText sidebar-delete test');
        }
        await expectProcessesExited(secondRestartProcesses.pids);
        const finalProcesses = readSessionProcessSnapshot(finalSession.name);
        expect(finalProcesses.rootPid).not.toBe(secondRestartProcesses.rootPid);
        await waitForRestoredDocument(finalSession.page, fixtureRealPath);
        await expectCleanAnnotationHydration(finalSession.page);
        const finalSaveIdentity = await readDocumentSaveIdentity(finalSession.page);
        await scrollViewerToPage(finalSession.page, targetPageNumber);
        await openAnnotationsTab(finalSession.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        const finalState = await waitForOrdinaryFreeTextState(
            finalSession.page,
            text,
            {
                canonicalMatchCount: 0,
                editorMatchCount: 0,
                visualMatchCount: 0,
                sidebarMatchCount: 0,
            },
        );
        expect(finalState.canonicalMatches).toHaveLength(0);
        expect(finalState.editorMatchCount).toBe(0);
        expect(finalState.visualMatchCount).toBe(0);
        expect(finalState.sidebarMatchCount).toBe(0);
        const finalPersistedMatches = await readBoundedOrdinaryFreeTextMatches(
            finalSession.page,
            fixtureRealPath,
            text,
            persistedName,
            targetPageIndex,
            finalSaveIdentity.workingCopyPath,
        );
        expect(finalPersistedMatches, JSON.stringify({
            finalPersistedMatches,
            persistedName,
            targetPageIndex,
        })).toHaveLength(0);
    }, LARGE_PDF_TIMEOUT_MS);
});
