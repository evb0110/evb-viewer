import {
    afterAll, describe, expect, it, onTestFinished,
} from 'vitest';
import {
    copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts,
} from 'pdf-lib';
import type { Page } from 'puppeteer-core';
import type { ITypedStagedArtifact } from '@contracts/stagedArtifacts';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    openAnnotationsTab, openPdfInApp, saveViaVisibleToolbarWithDeadline, saveViaWindowHandle, waitForPdfLoaded, waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    clickAnnotationTool, createFreeTextAnnotationWithPointer,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    callWorkspaceCommand, getLatestAutomationEventId, getWorkspaceToolbarSnapshot, installWorkspaceExposeProbe, readWorkspaceStateValues, requireWorkspaceCommand, type IWorkspaceExposeProbeWindow, waitForAutomationEvent, waitForSaveFrontierReady,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import { enablePdfDiagnosticSession } from '@tests/e2e/electron/helpers/pdfDiagnosticSession';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import type {IStagedArtifactCaptureWindow} from '../large-pdf/largePdfAnnotationSaveShared';
import {
    LARGE_PDF_TIMEOUT_MS,
    NOTE_TEXT_ENTRY_TIMEOUT_MS,
    editVisibleStickyNote,
    execFileAsync,
    expectCleanAnnotationHydration,
    expectProcessesExited,
    installStagedArtifactCapture,
    isPageContextUnavailableError,
    parseRectFromQpdfObject,
    qpdfCheck,
    qpdfDictionaryContainsText,
    readPdfNoteContents,
    readQpdfObject,
    readSessionProcessSnapshot,
    resumeStagedArtifactCommit,
    waitForCrashCheckpointPath,
    waitForRestoredDocument,
    waitForStagedArtifact,
} from '../large-pdf/largePdfAnnotationSaveShared';
import {
    readExactPdfFixtureIdentity,
    resolveExactPdfFixtureExpectation,
    validateExactPdfFixtureIdentity,
} from '@scripts/ci/stageExactPdfFixture';

const EXACT_ZALIZNYAK_EXPECTATION = resolveExactPdfFixtureExpectation();
const exactZaliznyakSourcePath = process.env.EVB_E2E_LARGE_PDF_FIXTURE?.trim() ?? null;

const IMPORTED_MARKUP_NOTE_SAVE_TIMEOUT_MS = 5 * 60_000;

const IMPORTED_MARKUP_NOTE_STAGE_TIMEOUT_MS = 60_000;

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

async function qpdfPageCount(filePath: string) {
    const {stdout} = await execFileAsync(getPdfNativeToolPaths().qpdf, [
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
    await execFileAsync(getPdfNativeToolPaths().qpdf, [
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
    const {stdout: pagesOutput} = await execFileAsync(getPdfNativeToolPaths().qpdf, [
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

describe('Electron E2E - Exact large PDF annotation acceptance', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        sessionName: () => 'e2e-exact-large-pdf-annotations-' + Date.now(),
        timeoutMs: LARGE_PDF_TIMEOUT_MS,
    });
    afterAll(async () => {
        await sessionFixture.stop();
    });

    it('imports a Text annotation with its Popup and preserves it through a clean save and hard restart', async () => {
        const session = sessionFixture.getSession();
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
        });
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

    it('edits an imported text-markup note through the bounded native route and hard-reopens it', async () => {
        const session = sessionFixture.getSession();
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
        });
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

    it('persists a moved imported sticky-note marker and Popup rectangle through native save and hard restart', async () => {
        const session = sessionFixture.getSession();
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
        });
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

    it('keeps ordinary FreeText visible through issue 139 save and layout transitions', async () => {
        let session = sessionFixture.getSession();
        if (exactZaliznyakSourcePath === null || !existsSync(exactZaliznyakSourcePath)) {
            throw new Error('Set EVB_E2E_LARGE_PDF_FIXTURE to the exact Zaliznyak fixture');
        }
        const exactSourceIdentity = await readExactPdfFixtureIdentity(exactZaliznyakSourcePath);
        validateExactPdfFixtureIdentity(exactSourceIdentity, EXACT_ZALIZNYAK_EXPECTATION);
        const artifactDirectory = mkdtempSync(join(tmpdir(), '.evb-issue-139-visibility-'));
        onTestFinished(() => rmSync(artifactDirectory, {
            force: true,
            recursive: true,
        }));
        const fixturePath = join(artifactDirectory, 'issue-139-visibility.pdf');
        copyFileSync(exactZaliznyakSourcePath, fixturePath);
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
        });
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
            await requireWorkspaceCommand(session.page, 'handleToggleSidebar');
            await waitForIssue139VisibilityFrame(
                session.page,
                'sidebar-close',
                await getIssue139VisibilityFrameCount(session.page),
            );
            await setIssue139VisibilityProbePhase(session.page, 'sidebar-open');
            await requireWorkspaceCommand(session.page, 'handleToggleSidebar');
            await waitForIssue139VisibilityFrame(
                session.page,
                'sidebar-open',
                await getIssue139VisibilityFrameCount(session.page),
            );
            await setIssue139VisibilityProbePhase(session.page, 'zoom');
            await requireWorkspaceCommand(session.page, 'handleZoomIn');
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
        });
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
});
