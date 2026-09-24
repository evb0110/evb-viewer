import { getErrorMessage } from '@contracts/getErrorMessage';
import assert from 'node:assert/strict';
import {
    existsSync,
    readFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
    ConsoleMessage,
    Page,
} from 'puppeteer-core';
import { delay } from 'es-toolkit/promise';
import { evaluateInPage } from '@tests/e2e/electron/helpers/pageRuntime';
import {
    callWorkspaceCommand,
    getWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import { sessionLogFilePath } from '@scripts/electron-run/electronRunSessionPaths';
import {
    toPdfNavLogEntries,
    toPdfRenderTraceEntries,
} from '@scripts/diagnostics/pdfTraceEntryGuards';
import {
    type IPdfDiagnosticsContext,
    runPdfDiagnosticScenario,
} from '@scripts/diagnostics/runPdfDiagnosticScenario';
import {
    installCommittedSurfaceSampler,
    stopCommittedSurfaceSampler,
    summarizeCommittedSurfaceTiming,
} from '@tests/e2e/electron/helpers/viewerCommittedSurfaceContract';
import {summarizeArnoldOpenTrace} from '@scripts/diagnostics/summarizeArnoldOpenTrace';
export {summarizeArnoldOpenTrace} from '@scripts/diagnostics/summarizeArnoldOpenTrace';

const TARGET_PDF_PATH = process.env.EVB_E2E_ARNOLD_PDF_PATH?.length
    ? process.env.EVB_E2E_ARNOLD_PDF_PATH
    : resolve(process.cwd(), '.devkit', 'manual-pdf-fixtures', 'arnold-grammar.pdf');
const DIAGNOSTIC_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'arnold-pdf-open-diagnostics.json',
);
const CONSOLE_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'arnold-pdf-open-console.log',
);
const CONSOLE_MESSAGE_LIMIT = 2_000;
const ARNOLD_FIRST_OWNED_PAGE_FRAME_BUDGET_MS = 500;
const ARNOLD_FIRST_MEANINGFUL_PIXELS_BUDGET_MS = 1_500;
const ARNOLD_SETTLED_GEOMETRY_TOLERANCE_PX = 2;
const ARNOLD_PLACEHOLDER_TRANSITION_TOLERANCE_PX = 8;
const ARNOLD_HIGH_ZOOM = 5.03;
const SAMPLE_OFFSETS_MS = [
    0,
    250,
    500,
    1_000,
    1_500,
    2_000,
    3_000,
    4_000,
    4_500,
    5_000,
    7_000,
    10_000,
    15_000,
    20_000,
    25_000,
    30_000,
];
const ARNOLD_WORKING_PATH_TRACE_EVENTS = new Set([
    'pdf-open-source-ready',
    'pdf-document-range-preload-start',
    'pdf-document-options-start',
    'pdf-document-get-document-submit',
]);

interface IConsoleLogEntry {
    receivedAtMs: number;
    type: string;
    text: string;
    location: {
        url?: string;
        lineNumber?: number;
        columnNumber?: number;
    };
    args: unknown[];
}

export function isExpectedArnoldDiagnosticWarning(text: string) {
    return text.includes('[pdf-render-trace]')
        || text.includes('[pdf-nav]')
        || text.includes('[pdf-zoom-debug]');
}

export function collectArnoldWorkingCopyPaths(
    renderTrace: ReadonlyArray<{
        event: string;
        payload: Record<string, unknown>;
    }>,
) {
    return renderTrace
        .filter(entry => ARNOLD_WORKING_PATH_TRACE_EVENTS.has(entry.event))
        .map(entry => entry.payload.path)
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export function collectArnoldConsoleRenderTrace(
    consoleEntries: ReadonlyArray<Pick<IConsoleLogEntry, 'args' | 'text'>>,
) {
    return toPdfRenderTraceEntries(consoleEntries.flatMap((entry) => {
        const match = entry.text.match(/\[pdf-render-trace\]\s+([^\s[]+)/u);
        const payload = entry.args.find((value, index) => index > 0 && isRecord(value));
        if (!match?.[1] || !payload) {
            return [];
        }
        return [{
            event: match[1],
            payload,
        }];
    }));
}

export function collectArnoldConsoleNavLog(
    consoleEntries: ReadonlyArray<Pick<IConsoleLogEntry, 'args' | 'receivedAtMs' | 'text'>>,
) {
    return toPdfNavLogEntries(consoleEntries.flatMap((entry) => {
        const marker = '[pdf-nav] ';
        const markerIndex = entry.text.indexOf(marker);
        if (markerIndex < 0) {
            return [];
        }
        const data = entry.args[1];
        return [{
            message: entry.text.slice(markerIndex + marker.length).replace(/\s+\[object Object\]$/u, ''),
            args: Array.isArray(data) ? data : data === undefined ? [] : [data],
            loggedAtMs: entry.receivedAtMs,
        }];
    }));
}

export function isArnoldOwnedFrameWithinBudget(firstPageShellMs: number) {
    return firstPageShellMs <= ARNOLD_FIRST_OWNED_PAGE_FRAME_BUDGET_MS;
}

interface IConsoleCollector {
    entries: IConsoleLogEntry[];
    drain: () => Promise<void>;
    dispose: () => void;
}

interface IOpenTriggerResult {
    status: 'resolved' | 'failed';
    opened: boolean;
    elapsedMs: number;
    attempts: IOpenAttempt[];
    error?: string;
}

interface IOpenAttempt {
    startedAtMs: number;
    finishedAtMs?: number;
    opened?: boolean;
    error?: string;
}

interface IOpenProgress {
    status: 'pending' | 'retrying' | 'resolved' | 'failed';
    attempts: IOpenAttempt[];
    startedAtMs: number;
    finishedAtMs?: number;
    error?: string;
}

interface IArnoldSnapshot {
    label: string;
    sampledAtMs: number;
    toolbarSampleStartedAtMs: number;
    toolbarSampleFinishedAtMs: number;
    url: string;
    openResult: unknown;
    counts: Record<string, number>;
    workspace: {
        toolbarSnapshot: unknown;
        loadingText: string | null;
        hostClassName: string | null;
        hostRect: unknown;
        openingSkeletonRect: unknown;
    };
    viewer: {
        className: string | null;
        rect: unknown;
        scrollTop: number | null;
        scrollHeight: number | null;
        clientHeight: number | null;
        scrollWidth: number | null;
        clientWidth: number | null;
        computed: Record<string, string> | null;
    };
    initialPlaceholderPageRect: unknown;
    ownedPageFrameRect: unknown;
    ownedPageFrameHasSkeleton: boolean;
    pages: unknown[];
}

type TArnoldSnapshotWithoutToolbar = Omit<IArnoldSnapshot, 'workspace'> & {workspace: Omit<IArnoldSnapshot['workspace'], 'toolbarSnapshot'>;};

function safeJson(value: unknown) {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

async function serializeConsoleMessage(message: ConsoleMessage, startedAtMs: number): Promise<IConsoleLogEntry> {
    const args = await Promise.all(message.args().slice(0, 8).map(async (handle) => {
        try {
            return await handle.jsonValue();
        } catch (error) {
            return {unserializable: getErrorMessage(error)};
        }
    }));
    const location = message.location();
    const serializedLocation: IConsoleLogEntry['location'] = {};
    if (location.url !== undefined) {
        serializedLocation.url = location.url;
    }
    if (location.lineNumber !== undefined) {
        serializedLocation.lineNumber = location.lineNumber;
    }
    if (location.columnNumber !== undefined) {
        serializedLocation.columnNumber = location.columnNumber;
    }

    return {
        receivedAtMs: Date.now() - startedAtMs,
        type: message.type(),
        text: message.text(),
        location: serializedLocation,
        args,
    };
}

function installConsoleCollector(page: Page): IConsoleCollector {
    const startedAtMs = Date.now();
    const entries: IConsoleLogEntry[] = [];
    const pending = new Set<Promise<void>>();
    const pushEntry = (entry: IConsoleLogEntry) => {
        entries.push(entry);
        if (entries.length > CONSOLE_MESSAGE_LIMIT) {
            entries.splice(0, entries.length - CONSOLE_MESSAGE_LIMIT);
        }
    };
    const consoleHandler = (message: ConsoleMessage) => {
        const task = serializeConsoleMessage(message, startedAtMs)
            .then(pushEntry)
            .catch(error => pushEntry({
                receivedAtMs: Date.now() - startedAtMs,
                type: 'console-serialization-error',
                text: getErrorMessage(error),
                location: {},
                args: [],
            }))
            .finally(() => pending.delete(task));
        pending.add(task);
    };
    const pageErrorHandler = (event: unknown) => {
        const error = event instanceof Error ? event : new Error(String(event));
        pushEntry({
            receivedAtMs: Date.now() - startedAtMs,
            type: 'pageerror',
            text: getErrorMessage(error),
            location: {},
            args: [{
                name: error.name,
                stack: error.stack,
            }],
        });
    };

    page.on('console', consoleHandler);
    page.on('pageerror', pageErrorHandler);

    return {
        entries,
        drain: async () => {
            while (pending.size > 0) {
                await Promise.all([...pending]);
            }
        },
        dispose: () => {
            page.off('console', consoleHandler);
            page.off('pageerror', pageErrorHandler);
        },
    };
}

function formatConsoleEntry(entry: IConsoleLogEntry) {
    const location = entry.location.url
        ? ` ${entry.location.url}:${entry.location.lineNumber ?? 0}:${entry.location.columnNumber ?? 0}`
        : '';
    const args = entry.args.length > 0 ? ` ${safeJson(entry.args)}` : '';
    return `[${entry.receivedAtMs}ms] ${entry.type}${location} ${entry.text}${args}`;
}

async function promoteDiagnosticConsoleWarnings(page: Page) {
    await evaluateInPage(page, () => {
        const diagnosticWindow = window as Window & {__diagnosticWarnAsWarn?: boolean;};
        diagnosticWindow.__diagnosticWarnAsWarn = true;
    });
}

async function waitForStableWorkspace(page: Page) {
    await page.waitForFunction(() => {
        const diagnosticWindow = window as Window & {__openFileDirect?: unknown;};
        const host = document.querySelector<HTMLElement>('.workspace-host');
        const hostRect = host?.getBoundingClientRect();
        return typeof diagnosticWindow.__openFileDirect === 'function'
            // The real Recent UI is intentionally non-actionable until the
            // canonical chassis owner is mounted. Do not charge cold dev
            // chunk compilation to the document-open transition by bypassing
            // that same readiness fence through the diagnostic hook.
            && host?.dataset.recentOpenOwnerReady === 'true'
            && Boolean(hostRect && hostRect.width > 100 && hostRect.height > 100);
    }, { timeout: 30_000 });
    await delay(1_000);
}

function isExecutionContextReset(error: unknown) {
    if (!(error instanceof Error)) {
        return false;
    }

    return /Execution context was destroyed|Cannot find context with specified id|Target closed|Session closed|Frame was detached/i.test(getErrorMessage(error));
}

async function openPathDirectOnce(page: Page, pdfPath: string) {
    return page.evaluate(async (path: string) => {
        const diagnosticWindow = window as Window & {
            __allowRendererFileOpenForAutomation?: unknown;
            __openFileDirect?: unknown;
        };
        const isPathHandler = (value: unknown): value is (path: string) => Promise<boolean> => typeof value === 'function';

        const automationGrant = diagnosticWindow.__allowRendererFileOpenForAutomation;
        if (isPathHandler(automationGrant)) {
            await automationGrant(path);
        }

        const openFileDirect = diagnosticWindow.__openFileDirect;
        if (!isPathHandler(openFileDirect)) {
            throw new Error('window.__openFileDirect is not available');
        }

        return openFileDirect(path);
    }, pdfPath);
}

async function openPathDirectWithRetry(
    page: Page,
    pdfPath: string,
    progress: IOpenProgress,
): Promise<IOpenTriggerResult> {
    const timeoutMs = 45_000;
    const startedAtMs = Date.now();
    let lastError: string | undefined;

    while (Date.now() - startedAtMs < timeoutMs) {
        const attempt: IOpenAttempt = {startedAtMs: Date.now() - startedAtMs};
        progress.attempts.push(attempt);
        try {
            const opened = await openPathDirectOnce(page, pdfPath);
            attempt.finishedAtMs = Date.now() - startedAtMs;
            attempt.opened = Boolean(opened);
            progress.status = 'resolved';
            progress.finishedAtMs = Date.now();
            return {
                status: 'resolved',
                opened: Boolean(opened),
                elapsedMs: Date.now() - startedAtMs,
                attempts: progress.attempts,
            };
        } catch (error) {
            lastError = getErrorMessage(error);
            attempt.finishedAtMs = Date.now() - startedAtMs;
            attempt.error = lastError;
            progress.status = 'retrying';
            progress.error = lastError;
            if (!isExecutionContextReset(error)) {
                break;
            }
            await delay(500);
        }
    }

    progress.status = 'failed';
    progress.finishedAtMs = Date.now();
    if (lastError !== undefined) {
        progress.error = lastError;
    }
    const result: IOpenTriggerResult = {
        status: 'failed',
        opened: false,
        elapsedMs: Date.now() - startedAtMs,
        attempts: progress.attempts,
    };
    if (lastError !== undefined) {
        result.error = lastError;
    }
    return result;
}

async function collectOpenSnapshot(page: Page, label: string, startedAtMs: number): Promise<IArnoldSnapshot> {
    const rawSnapshot: unknown = await evaluateInPage(page, (snapshotLabel: string, nodeStartedAtMs: number) => {
        const diagnosticWindow = window as Window & {__arnoldDiagnosticOpenResult?: unknown;};

        const rectSnapshot = (element: Element | null) => {
            if (!element) {
                return null;
            }
            const rect = element.getBoundingClientRect();
            return {
                top: Math.round(rect.top),
                right: Math.round(rect.right),
                bottom: Math.round(rect.bottom),
                left: Math.round(rect.left),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
            };
        };

        const styleSnapshot = (element: Element | null) => {
            if (!element) {
                return null;
            }
            const style = window.getComputedStyle(element);
            return {
                display: style.display,
                visibility: style.visibility,
                opacity: style.opacity,
                overflow: style.overflow,
                overflowY: style.overflowY,
                position: style.position,
            };
        };

        const isVisibleElement = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0;
        };

        const intersectsViewport = (element: HTMLElement) => {
            if (!isVisibleElement(element)) {
                return false;
            }
            const rect = element.getBoundingClientRect();
            return rect.bottom > 0
                && rect.right > 0
                && rect.top < window.innerHeight
                && rect.left < window.innerWidth;
        };

        const sampleVisual = (visual: HTMLCanvasElement | HTMLImageElement | null) => {
            if (!visual) {
                return null;
            }
            const intrinsicWidth = visual instanceof HTMLCanvasElement ? visual.width : visual.naturalWidth;
            const intrinsicHeight = visual instanceof HTMLCanvasElement ? visual.height : visual.naturalHeight;
            const rect = visual.getBoundingClientRect();
            const result = {
                width: intrinsicWidth,
                height: intrinsicHeight,
                cssWidth: Math.round(rect.width),
                cssHeight: Math.round(rect.height),
                sampleCount: 0,
                nonWhitePixelCount: 0,
                whitePixelCount: 0,
                transparentPixelCount: 0,
                stride: 0,
                likelyBlankWhite: false,
                luminanceRange: 0,
                error: null as string | null,
            };

            try {
                if (intrinsicWidth <= 0 || intrinsicHeight <= 0) {
                    result.error = 'visual source unavailable or empty';
                    return result;
                }

                const sampleSize = 48;
                const sampleCanvas = document.createElement('canvas');
                sampleCanvas.width = sampleSize;
                sampleCanvas.height = sampleSize;
                const sampleContext = sampleCanvas.getContext('2d', {willReadFrequently: true});
                if (!sampleContext) {
                    result.error = 'bounded sample canvas context unavailable';
                    return result;
                }
                sampleContext.drawImage(visual, 0, 0, sampleSize, sampleSize);
                const pixels = sampleContext.getImageData(0, 0, sampleSize, sampleSize).data;
                result.stride = Math.max(intrinsicWidth, intrinsicHeight) / sampleSize;
                let minLuminance = 255;
                let maxLuminance = 0;
                for (let y = 0; y < sampleSize; y += 1) {
                    for (let x = 0; x < sampleSize; x += 1) {
                        const offset = ((y * sampleSize) + x) * 4;
                        const red = pixels[offset] ?? 0;
                        const green = pixels[offset + 1] ?? 0;
                        const blue = pixels[offset + 2] ?? 0;
                        const alpha = pixels[offset + 3] ?? 0;
                        const luminance = (red * 0.2126) + (green * 0.7152) + (blue * 0.0722);
                        if (alpha > 0) {
                            minLuminance = Math.min(minLuminance, luminance);
                            maxLuminance = Math.max(maxLuminance, luminance);
                        }
                        result.sampleCount += 1;
                        if (alpha === 0) {
                            result.transparentPixelCount += 1;
                        } else if (red >= 248 && green >= 248 && blue >= 248) {
                            result.whitePixelCount += 1;
                        } else {
                            result.nonWhitePixelCount += 1;
                        }
                    }
                }
                result.likelyBlankWhite = result.sampleCount > 0
                    && result.nonWhitePixelCount === 0
                    && result.transparentPixelCount === 0;
                result.luminanceRange = Math.round(maxLuminance - minLuminance);
            } catch (error) {
                result.error = getErrorMessage(error);
            }

            return result;
        };

        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host')
            ?? Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).find(isVisibleElement)
            ?? null;
        const visibleViewers = Array.from(document.querySelectorAll<HTMLElement>('#pdf-viewer')).filter(isVisibleElement);
        const activeViewer = document.querySelector<HTMLElement>('.editor-pane.is-active #pdf-viewer');
        const viewer = activeViewer && isVisibleElement(activeViewer)
            ? activeViewer
            : (visibleViewers[0] ?? null);
        const pageContainers = Array.from(viewer?.querySelectorAll<HTMLElement>('.page_container') ?? []);
        const visiblePages = pageContainers.filter((container) => {
            const rect = container.getBoundingClientRect();
            return rect.bottom > 0 && rect.top < window.innerHeight;
        });
        const firstPage = pageContainers[0] ?? null;
        const pagesToSample = Array.from(new Set([
            firstPage,
            ...visiblePages,
        ].flatMap(element => element ? [element] : []))).slice(0, 5);
        const legacyInitialPageFrame = document.querySelector<HTMLElement>(
            '[data-evb-initial-visual-placeholder="true"] .pdf-initial-surface-placeholder__page-shell',
        );
        const ownedPageFrame = [
            document.querySelector<HTMLElement>('.document-viewer-chassis__opening-page'),
            legacyInitialPageFrame,
            firstPage?.querySelector<HTMLElement>('.page_canvas.canvasWrapper') ?? null,
        ].find((candidate): candidate is HTMLElement => Boolean(candidate && isVisibleElement(candidate))) ?? null;

        return {
            label: snapshotLabel,
            sampledAtMs: Date.now() - nodeStartedAtMs,
            url: window.location.href,
            openResult: diagnosticWindow.__arnoldDiagnosticOpenResult ?? null,
            counts: {
                workspaceHosts: document.querySelectorAll('.workspace-host').length,
                visibleViewers: visibleViewers.length,
                pageContainers: pageContainers.length,
                renderedPages: viewer?.querySelectorAll('.page_container--rendered').length ?? 0,
                pageSkeletons: viewer?.querySelectorAll('.document-page-skeleton').length ?? 0,
                visiblePageSkeletons: Array.from(
                    viewer?.querySelectorAll<HTMLElement>('.document-page-skeleton') ?? [],
                ).filter(intersectsViewport).length,
                canvases: viewer?.querySelectorAll('.page_canvas canvas').length ?? 0,
                textSpans: viewer?.querySelectorAll('.text-layer span, .textLayer span').length ?? 0,
                loadingStates: document.querySelectorAll('.pdf-loading, .pdf-loading-overlay, [data-loading="true"]').length,
                errorStates: document.querySelectorAll('.pdf-error, .viewer-error, [data-error="true"]').length,
                visibleLoadingStates: Array.from(document.querySelectorAll<HTMLElement>(
                    '.document-loading, .pdf-loading, .pdf-loading-overlay, [data-loading="true"]',
                )).filter(intersectsViewport).length,
                visibleOpeningFallbacks: Array.from(document.querySelectorAll<HTMLElement>(
                    '.workspace-host-document-open-fallback',
                )).filter(intersectsViewport).length,
            },
            workspace: {
                loadingText: document.querySelector<HTMLElement>('.document-loading, .pdf-loading, .pdf-loading-overlay')?.textContent.trim() ?? null,
                hostClassName: activeHost?.className ?? null,
                hostRect: rectSnapshot(activeHost),
                openingSkeletonRect: rectSnapshot(document.querySelector('.workspace-host-document-open-fallback')),
            },
            viewer: {
                className: viewer?.className ?? null,
                rect: rectSnapshot(viewer),
                scrollTop: viewer?.scrollTop ?? null,
                scrollHeight: viewer?.scrollHeight ?? null,
                clientHeight: viewer?.clientHeight ?? null,
                scrollWidth: viewer?.scrollWidth ?? null,
                clientWidth: viewer?.clientWidth ?? null,
                computed: styleSnapshot(viewer),
            },
            // Opening ownership is independent of whether the debounced
            // skeleton is currently visible. Measure the chassis/legacy/live
            // page frame itself and record skeleton presence separately.
            initialPlaceholderPageRect: rectSnapshot(legacyInitialPageFrame),
            ownedPageFrameRect: rectSnapshot(ownedPageFrame),
            ownedPageFrameHasSkeleton: Boolean(ownedPageFrame?.querySelector('.document-page-skeleton')),
            pages: pagesToSample.map((pageContainer) => {
                const canvas = pageContainer.querySelector<HTMLCanvasElement>('.page_canvas canvas');
                const skeleton = pageContainer.querySelector<HTMLElement>('.document-page-skeleton');
                const pageCanvas = pageContainer.querySelector<HTMLElement>('.page_canvas');
                return {
                    page: Number(pageContainer.dataset.page ?? pageContainer.getAttribute('data-page-number') ?? 0),
                    className: pageContainer.className,
                    rect: rectSnapshot(pageContainer),
                    computed: styleSnapshot(pageContainer),
                    hasRenderedClass: pageContainer.classList.contains('page_container--rendered'),
                    skeletonRect: rectSnapshot(skeleton),
                    skeletonComputed: styleSnapshot(skeleton),
                    pageCanvasRect: rectSnapshot(pageCanvas),
                    pageCanvasComputed: styleSnapshot(pageCanvas),
                    canvasCount: pageContainer.querySelectorAll('.page_canvas canvas').length,
                    canvasIntersectsViewport: canvas ? intersectsViewport(canvas) : false,
                    textSpanCount: pageContainer.querySelectorAll('.text-layer span, .textLayer span').length,
                    canvas: sampleVisual(canvas),
                };
            }),
        };
    }, label, startedAtMs);
    const snapshot = rawSnapshot as TArnoldSnapshotWithoutToolbar;
    const toolbarSampleStartedAtMs = Date.now() - startedAtMs;
    const rawToolbarSnapshot: unknown = await getWorkspaceToolbarSnapshot(page, {requireVisible: true});
    const toolbarSampleFinishedAtMs = Date.now() - startedAtMs;
    const toolbarSnapshot = rawToolbarSnapshot;
    return {
        ...snapshot,
        toolbarSampleStartedAtMs,
        toolbarSampleFinishedAtMs,
        workspace: {
            ...snapshot.workspace,
            toolbarSnapshot,
        },
    };
}

function readFiniteNumber(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readSnapshotCanvasNonWhitePixels(snapshot: IArnoldSnapshot) {
    if (!Array.isArray(snapshot.pages)) {
        return 0;
    }
    let total = 0;
    for (const page of snapshot.pages) {
        if (!page || typeof page !== 'object') {
            continue;
        }
        const canvas = (page as Record<string, unknown>).canvas;
        if ((page as Record<string, unknown>).canvasIntersectsViewport !== true) {
            continue;
        }
        if (!canvas || typeof canvas !== 'object') {
            continue;
        }
        total += (
            readFiniteNumber((canvas as Record<string, unknown>).nonWhitePixelCount) ?? 0
        );
    }
    return total;
}

function readSnapshotCanvasLuminanceRange(snapshot: IArnoldSnapshot) {
    let maximum = 0;
    for (const page of snapshot.pages) {
        if (!page || typeof page !== 'object') {
            continue;
        }
        const record = page as Record<string, unknown>;
        const canvas = record.canvas;
        if (record.canvasIntersectsViewport !== true || !canvas || typeof canvas !== 'object') {
            continue;
        }
        maximum = Math.max(
            maximum,
            readFiniteNumber((canvas as Record<string, unknown>).luminanceRange) ?? 0,
        );
    }
    return maximum;
}

function hasMeaningfulPagePixels(snapshot: IArnoldSnapshot) {
    return readSnapshotCanvasNonWhitePixels(snapshot) > 0
        && readSnapshotCanvasLuminanceRange(snapshot) > 8;
}

function readSnapshotPageRect(snapshot: IArnoldSnapshot) {
    const page = snapshot.pages.find(value => (
        value
        && typeof value === 'object'
        && (value as Record<string, unknown>).canvasIntersectsViewport === true
    ));
    const rect = page && typeof page === 'object'
        ? (page as Record<string, unknown>).rect
        : null;
    return readRect(rect);
}

function readSnapshotCanvasRect(snapshot: IArnoldSnapshot) {
    const page = snapshot.pages.find(value => (
        value
        && typeof value === 'object'
        && (value as Record<string, unknown>).canvasIntersectsViewport === true
    ));
    return readRect(page && typeof page === 'object'
        ? (page as Record<string, unknown>).pageCanvasRect
        : null);
}

function readRect(value: unknown) {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const top = readFiniteNumber(Reflect.get(value, 'top'));
    const width = readFiniteNumber(Reflect.get(value, 'width'));
    const height = readFiniteNumber(Reflect.get(value, 'height'));
    const right = readFiniteNumber(Reflect.get(value, 'right'));
    return top === null || width === null || height === null
        ? null
        : {
            top,
            width,
            height,
            right,
        };
}

function readSnapshotRect(snapshot: IArnoldSnapshot, owner: 'host' | 'viewer') {
    const value = owner === 'host' ? snapshot.workspace.hostRect : snapshot.viewer.rect;
    return readRect(value);
}

interface IHighZoomEvidence {
    bodyHorizontalOverflow: number;
    documentHorizontalOverflow: number;
    hostRight: number | null;
    viewerRight: number | null;
    viewerHorizontalOverflow: number;
    viewerScrollLeftAfter: number;
    viewerScrollLeftBefore: number;
}

function assertArnoldAcceptance(input: {
    triggerResult: IOpenTriggerResult;
    snapshots: readonly IArnoldSnapshot[];
    beforeScroll: IArnoldSnapshot;
    afterScroll: IArnoldSnapshot;
    renderTrace: ReturnType<typeof toPdfRenderTraceEntries>;
    consoleEntries: readonly IConsoleLogEntry[];
    recentOpenWarnings: readonly IConsoleLogEntry[];
    highZoom: IHighZoomEvidence;
    mainProcessLog: string;
    scrollResult: Awaited<ReturnType<typeof scrollActiveViewer>>;
    surfaceTrace: Awaited<ReturnType<typeof stopCommittedSurfaceSampler>>;
}) {
    const allSnapshots = [
        ...input.snapshots,
        input.beforeScroll,
        input.afterScroll,
    ];
    const evidence = () => safeJson({
        triggerResult: input.triggerResult,
        snapshots: allSnapshots.map(snapshot => ({
            label: snapshot.label,
            sampledAtMs: snapshot.sampledAtMs,
            counts: snapshot.counts,
            hostRect: snapshot.workspace.hostRect,
            viewer: snapshot.viewer,
            ownedPageFrameRect: snapshot.ownedPageFrameRect,
            ownedPageFrameHasSkeleton: snapshot.ownedPageFrameHasSkeleton,
            nonWhitePixels: readSnapshotCanvasNonWhitePixels(snapshot),
            luminanceRange: readSnapshotCanvasLuminanceRange(snapshot),
        })),
    });

    assert.equal(input.triggerResult.status, 'resolved', evidence());
    assert.equal(input.triggerResult.opened, true, evidence());
    assert.equal(input.triggerResult.attempts.length, 1, evidence());

    const firstMeaningfulPixels = input.snapshots.find(hasMeaningfulPagePixels);
    assert.ok(firstMeaningfulPixels, evidence());
    assert.ok(
        firstMeaningfulPixels.sampledAtMs <= ARNOLD_FIRST_MEANINGFUL_PIXELS_BUDGET_MS,
        evidence(),
    );

    const firstNonblank = input.snapshots.find(snapshot => (
        (snapshot.counts.visibleViewers ?? 0) === 1
        && (snapshot.counts.canvases ?? 0) > 0
        && readSnapshotCanvasNonWhitePixels(snapshot) > 0
        && readSnapshotCanvasLuminanceRange(snapshot) > 8
    ));
    assert.ok(firstNonblank, evidence());

    const visuallySettled = allSnapshots.filter(snapshot => snapshot.sampledAtMs >= firstNonblank.sampledAtMs);
    assert.ok(visuallySettled.length > 0, evidence());
    for (const snapshot of visuallySettled) {
        assert.equal(snapshot.counts.workspaceHosts, 1, evidence());
        assert.equal(snapshot.counts.visibleViewers, 1, evidence());
        assert.equal(snapshot.counts.visiblePageSkeletons, 0, evidence());
        assert.equal(snapshot.counts.visibleOpeningFallbacks, 0, evidence());
        assert.equal(snapshot.counts.visibleLoadingStates, 0, evidence());
        assert.equal(snapshot.counts.errorStates, 0, evidence());
        if (snapshot.viewer.scrollWidth !== null && snapshot.viewer.clientWidth !== null) {
            assert.ok(snapshot.viewer.scrollWidth <= snapshot.viewer.clientWidth + 1, evidence());
        }
    }

    const stableHostRects = visuallySettled
        .map(snapshot => readSnapshotRect(snapshot, 'host'))
        .filter((value): value is NonNullable<typeof value> => value !== null);
    const stablePageRects = input.snapshots
        .filter(snapshot => snapshot.sampledAtMs >= firstNonblank.sampledAtMs)
        .map(readSnapshotPageRect)
        .filter((value): value is NonNullable<typeof value> => value !== null);
    const stableCanvasRects = input.snapshots
        .filter(snapshot => snapshot.sampledAtMs >= firstNonblank.sampledAtMs)
        .map(readSnapshotCanvasRect)
        .filter((value): value is NonNullable<typeof value> => value !== null);

    const stableViewerRects = visuallySettled
        .map(snapshot => readSnapshotRect(snapshot, 'viewer'))
        .filter((value): value is NonNullable<typeof value> => value !== null);
    assert.ok(stableViewerRects.length > 0, evidence());
    const firstViewerRect = stableViewerRects[0];
    assert.ok(firstViewerRect, evidence());
    for (const rect of stableViewerRects) {
        assert.ok(Math.abs(rect.top - firstViewerRect.top) <= ARNOLD_SETTLED_GEOMETRY_TOLERANCE_PX, evidence());
        assert.ok(Math.abs(rect.width - firstViewerRect.width) <= ARNOLD_SETTLED_GEOMETRY_TOLERANCE_PX, evidence());
        assert.ok(Math.abs(rect.height - firstViewerRect.height) <= ARNOLD_SETTLED_GEOMETRY_TOLERANCE_PX, evidence());
    }
    for (const rects of [
        stableHostRects,
        stablePageRects,
        stableCanvasRects,
    ]) {
        assert.ok(rects.length > 0, evidence());
        const baseline = rects[0];
        assert.ok(baseline, evidence());
        for (const rect of rects) {
            assert.ok(Math.abs(rect.top - baseline.top) <= ARNOLD_SETTLED_GEOMETRY_TOLERANCE_PX, evidence());
            assert.ok(Math.abs(rect.width - baseline.width) <= ARNOLD_SETTLED_GEOMETRY_TOLERANCE_PX, evidence());
            assert.ok(Math.abs(rect.height - baseline.height) <= ARNOLD_SETTLED_GEOMETRY_TOLERANCE_PX, evidence());
        }
    }
    const ownedFrameSnapshots = input.snapshots.filter(snapshot => (
        snapshot.sampledAtMs <= firstNonblank.sampledAtMs
        && readRect(snapshot.ownedPageFrameRect) !== null
    ));
    const firstOwnedFrameSnapshot = ownedFrameSnapshots[0];
    const firstOwnedFrameRect = firstOwnedFrameSnapshot
        ? readRect(firstOwnedFrameSnapshot.ownedPageFrameRect)
        : null;
    const firstPageRect = readSnapshotPageRect(firstNonblank);
    assert.ok(firstOwnedFrameSnapshot && firstOwnedFrameRect && firstPageRect, evidence());
    const surfaceTiming = summarizeCommittedSurfaceTiming(input.surfaceTrace);
    assert.ok(
        surfaceTiming.firstPageShellMs !== null
        && isArnoldOwnedFrameWithinBudget(surfaceTiming.firstPageShellMs),
        evidence(),
    );
    assert.deepEqual(input.surfaceTrace.errors ?? [], [], evidence());
    assert.ok(Math.abs(firstOwnedFrameRect.top - firstPageRect.top) <= ARNOLD_PLACEHOLDER_TRANSITION_TOLERANCE_PX, evidence());
    assert.ok(Math.abs(firstOwnedFrameRect.width - firstPageRect.width) <= ARNOLD_PLACEHOLDER_TRANSITION_TOLERANCE_PX, evidence());
    assert.ok(Math.abs(firstOwnedFrameRect.height - firstPageRect.height) <= ARNOLD_PLACEHOLDER_TRANSITION_TOLERANCE_PX, evidence());
    for (const snapshot of ownedFrameSnapshots) {
        const rect = readRect(snapshot.ownedPageFrameRect);
        assert.ok(rect, evidence());
        assert.ok(Math.abs(rect.top - firstOwnedFrameRect.top) <= ARNOLD_SETTLED_GEOMETRY_TOLERANCE_PX, evidence());
        assert.ok(Math.abs(rect.width - firstOwnedFrameRect.width) <= ARNOLD_SETTLED_GEOMETRY_TOLERANCE_PX, evidence());
        assert.ok(Math.abs(rect.height - firstOwnedFrameRect.height) <= ARNOLD_SETTLED_GEOMETRY_TOLERANCE_PX, evidence());
    }

    const countTraceEvent = (event: string) => input.renderTrace.filter(entry => entry.event === event).length;
    const sourceReadyEntries = input.renderTrace.filter(entry => entry.event === 'pdf-open-source-ready');
    assert.equal(sourceReadyEntries.length, 1, evidence());
    assert.equal(countTraceEvent('pdf-document-get-document-submit'), 1, evidence());
    assert.equal(countTraceEvent('managed-shapes-import-start'), 1, evidence());
    assert.equal(countTraceEvent('managed-shapes-import-end'), 1, evidence());
    const firstCanvasIndex = input.renderTrace.findIndex(entry => entry.event === 'renderer-canvas-mounted');
    const importStartIndex = input.renderTrace.findIndex(entry => entry.event === 'managed-shapes-import-start');
    const importEndIndex = input.renderTrace.findIndex(entry => entry.event === 'managed-shapes-import-end');
    assert.ok(firstCanvasIndex >= 0 && importStartIndex > firstCanvasIndex && importEndIndex > importStartIndex, evidence());
    const workingPaths = collectArnoldWorkingCopyPaths(input.renderTrace);
    assert.ok(workingPaths.length > 0, evidence());
    assert.equal(new Set(workingPaths).size, 1, evidence());
    assert.equal(sourceReadyEntries[0]?.payload.path, workingPaths[0], evidence());
    for (const [
        index,
        entry,
    ] of input.renderTrace.entries()) {
        if (entry.event !== 'renderer-canvas-prepare-stale') {
            continue;
        }
        const recovered = input.renderTrace.slice(index + 1).some(candidate => (
            candidate.event === 'renderer-finalize-page'
            && candidate.payload.pageNumber === entry.payload.pageNumber
        ));
        assert.equal(recovered, true, evidence());
    }
    assert.equal(input.recentOpenWarnings.length, 0, evidence());
    const unexpectedConsoleFailures = input.consoleEntries.filter(entry => (
        entry.type === 'pageerror'
        || entry.type === 'error'
        || (entry.type === 'warn' && !isExpectedArnoldDiagnosticWarning(entry.text))
    ));
    assert.deepEqual(unexpectedConsoleFailures, [], evidence());
    assert.doesNotMatch(input.mainProcessLog, /(?:uncaught|unhandled promise|fatal|renderer process (?:crashed|gone)|error:)/iu, evidence());
    assert.equal(input.scrollResult.scrolled, true, evidence());
    assert.equal(input.scrollResult.target, 'pdf-viewer', evidence());
    assert.ok(input.scrollResult.afterScrollTop > input.scrollResult.beforeScrollTop, evidence());
    assert.ok(input.highZoom.viewerHorizontalOverflow > 0, evidence());
    assert.ok(input.highZoom.viewerScrollLeftAfter > input.highZoom.viewerScrollLeftBefore, evidence());
    assert.ok(input.highZoom.documentHorizontalOverflow <= 1, evidence());
    assert.ok(input.highZoom.bodyHorizontalOverflow <= 1, evidence());
    assert.ok(
        input.highZoom.hostRight !== null
        && input.highZoom.viewerRight !== null
        && Math.abs(input.highZoom.hostRight - input.highZoom.viewerRight) <= 2,
        evidence(),
    );
}

async function scrollActiveViewer(page: Page) {
    return evaluateInPage(page, () => {
        const activeViewer = document.querySelector<HTMLElement>('.editor-pane.is-active #pdf-viewer');
        const visibleViewer = Array.from(document.querySelectorAll<HTMLElement>('#pdf-viewer')).find((candidate) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return rect.width > 0
                && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        });
        const scroller = activeViewer ?? visibleViewer ?? document.scrollingElement;
        if (!scroller) {
            return {
                scrolled: false,
                reason: 'no scroll target',
            };
        }

        const beforeScrollTop = scroller.scrollTop;
        scroller.scrollTop = beforeScrollTop + 96;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        window.dispatchEvent(new Event('scroll'));
        return {
            scrolled: true,
            target: scroller === document.scrollingElement ? 'document' : 'pdf-viewer',
            beforeScrollTop,
            afterScrollTop: scroller.scrollTop,
        };
    });
}

async function collectHighZoomEvidence(page: Page): Promise<IHighZoomEvidence> {
    const zoomResult = await callWorkspaceCommand(page, 'setCustomZoomFromDisplay', [ARNOLD_HIGH_ZOOM]);
    assert.equal(zoomResult.called, true);
    await page.waitForFunction(() => {
        const viewer = document.querySelector<HTMLElement>('.editor-pane.is-active #pdf-viewer');
        return Boolean(viewer && viewer.scrollWidth > viewer.clientWidth + 20);
    }, {timeout: 10_000});
    return evaluateInPage(page, () => {
        const viewer = document.querySelector<HTMLElement>('.editor-pane.is-active #pdf-viewer');
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        if (!viewer) {
            throw new Error('Active PDF viewer unavailable for high-zoom evidence');
        }
        const viewerRect = viewer.getBoundingClientRect();
        const hostRect = host?.getBoundingClientRect() ?? null;
        const viewerScrollLeftBefore = viewer.scrollLeft;
        viewer.scrollLeft = Math.min(
            viewer.scrollWidth - viewer.clientWidth,
            viewerScrollLeftBefore + 96,
        );
        viewer.dispatchEvent(new Event('scroll', {bubbles: true}));
        return {
            bodyHorizontalOverflow: Math.max(0, document.body.scrollWidth - document.body.clientWidth),
            documentHorizontalOverflow: Math.max(
                0,
                document.documentElement.scrollWidth - document.documentElement.clientWidth,
            ),
            hostRight: hostRect?.right ?? null,
            viewerRight: viewerRect.right,
            viewerHorizontalOverflow: viewer.scrollWidth - viewer.clientWidth,
            viewerScrollLeftAfter: viewer.scrollLeft,
            viewerScrollLeftBefore,
        };
    });
}

function readMainProcessLog(sessionName: string) {
    try {
        return readFileSync(sessionLogFilePath(sessionName), 'utf8');
    } catch {
        return '';
    }
}

export const arnoldPdfOpenScenario = {
    name: 'diagnostic-arnold-pdf-open',
    pdfPath: TARGET_PDF_PATH,
    fixtureError: [
        `Arnold PDF diagnostic fixture not found: ${TARGET_PDF_PATH}`,
        'Set EVB_E2E_ARNOLD_PDF_PATH to a local Arnold lexicon PDF before running this diagnostic.',
    ].join('\n'),
    diagnostics: {
        console: true,
        navigation: true,
        render: true,
    },
    skipDefaultOpen: true,
    prepare: (context: IPdfDiagnosticsContext) => installConsoleCollector(context.page),
    afterDiagnosticsEnabled: async (context: IPdfDiagnosticsContext) => (
        promoteDiagnosticConsoleWarnings(context.page)
    ),
    run: async (
        context: IPdfDiagnosticsContext,
        consoleCollector: IConsoleCollector,
    ) => {
        const {
            page,
            session,
        } = context;
        await waitForStableWorkspace(page);
        await installCommittedSurfaceSampler(page);
        const diagnosticStartedAtMs = Date.now();
        const openProgress: IOpenProgress = {
            status: 'pending',
            attempts: [],
            startedAtMs: diagnosticStartedAtMs,
        };
        const openPromise = openPathDirectWithRetry(page, TARGET_PDF_PATH, openProgress);
        const snapshots = await context.sampling.atOffsets(
            diagnosticStartedAtMs,
            SAMPLE_OFFSETS_MS,
            offsetMs => collectOpenSnapshot(page, `open+${offsetMs}ms`, diagnosticStartedAtMs),
        );
        const triggerResult = await openPromise;
        const beforeScroll = await collectOpenSnapshot(page, 'before-scroll', diagnosticStartedAtMs);
        const scrollResult = await scrollActiveViewer(page);
        await delay(1_000);
        const afterScroll = await collectOpenSnapshot(page, 'after-scroll+1000ms', diagnosticStartedAtMs);
        const highZoom = await collectHighZoomEvidence(page);
        const surfaceTrace = await stopCommittedSurfaceSampler(page);
        const surfaceTiming = summarizeCommittedSurfaceTiming(surfaceTrace);
        const bufferedNavLog = toPdfNavLogEntries(await context.trace.collectNavigation());
        const bufferedRenderTrace = toPdfRenderTraceEntries(await context.trace.collectRender());
        await consoleCollector.drain();
        const consoleEntries = [...consoleCollector.entries];
        // Renderer diagnostics are also emitted to the console. Use that independent
        // channel only if a dev reload or execution-context replacement orphaned the
        // window-scoped reader installed at session start.
        const navLog = bufferedNavLog.length > 0
            ? bufferedNavLog
            : collectArnoldConsoleNavLog(consoleEntries);
        const renderTrace = bufferedRenderTrace.length > 0
            ? bufferedRenderTrace
            : collectArnoldConsoleRenderTrace(consoleEntries);
        const mainProcessLog = readMainProcessLog(session.name);

        const recentOpenWarnings = consoleEntries.filter(
            entry => entry.text.includes('Document open visual settle timed out'),
        );
        const diagnostic = {
            pdfPath: TARGET_PDF_PATH,
            capturedAt: new Date().toISOString(),
            triggerResult,
            openProgress,
            snapshots,
            beforeScroll,
            scrollResult,
            afterScroll,
            highZoom,
            surfaceTiming,
            surfaceTraceErrors: surfaceTrace.errors ?? [],
            navLog,
            renderTrace,
            openTraceSummary: summarizeArnoldOpenTrace(renderTrace),
            consoleEntries,
            mainProcessLog,
            recentOpenWarnings,
            renderTracePageOne: renderTrace.filter(entry => {
                const pageNumber = entry.payload.pageNumber ?? entry.payload.page;
                return pageNumber === 1;
            }),
        };
        context.artifacts.writeJson(DIAGNOSTIC_OUTPUT_PATH, diagnostic);
        context.artifacts.writeText(
            CONSOLE_OUTPUT_PATH,
            `${consoleEntries.map(formatConsoleEntry).join('\n')}\n`,
        );

        assertArnoldAcceptance({
            triggerResult,
            snapshots,
            beforeScroll,
            afterScroll,
            renderTrace,
            consoleEntries,
            recentOpenWarnings,
            highZoom,
            mainProcessLog,
            scrollResult,
            surfaceTrace,
        });
        assert.equal(existsSync(DIAGNOSTIC_OUTPUT_PATH), true);
        assert.equal(existsSync(CONSOLE_OUTPUT_PATH), true);
    },
    cleanup: async (
        context: IPdfDiagnosticsContext,
        consoleCollector: IConsoleCollector,
    ) => {
        await evaluateInPage(context.page, () => {
            delete (window as Window & {__diagnosticWarnAsWarn?: boolean;}).__diagnosticWarnAsWarn;
        }).catch(() => {});
        await stopCommittedSurfaceSampler(context.page).catch(() => ({
            errors: [],
            frames: [],
        }));
        consoleCollector.dispose();
    },
};

export const runArnoldPdfOpenDiagnostics = () => (
    runPdfDiagnosticScenario(arnoldPdfOpenScenario)
);

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await runArnoldPdfOpenDiagnostics().catch((error: unknown) => {
        console.error(getErrorMessage(error));
        process.exitCode = 1;
    });
}
