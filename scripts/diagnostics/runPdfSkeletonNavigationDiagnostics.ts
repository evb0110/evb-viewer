import { getErrorMessage } from '@contracts/getErrorMessage';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { delay } from 'es-toolkit/promise';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    callWorkspaceCommand,
    getWorkspaceToolbarSnapshot,
    waitForWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import type {
    IPdfNavLogEntry,
    IPdfRenderTraceEntry,
} from '@contracts/pdfDiagnostics';
import {
    toPdfNavLogEntries,
    toPdfRenderTraceEntries,
} from '@scripts/diagnostics/pdfTraceEntryGuards';
import {
    type IPdfDiagnosticsContext,
    runPdfDiagnosticScenario,
} from '@scripts/diagnostics/runPdfDiagnosticScenario';

const TARGET_PDF_PATH = [
    process.env.EVB_E2E_NAVIGATION_PDF_PATH,
    process.env.EVB_DIAGNOSTIC_PDF_PATH,
].find(value => typeof value === 'string' && value.length > 0)
    ?? resolve(process.cwd(), '.devkit', 'manual-pdf-fixtures', 'navigation-source.pdf');
const DIAGNOSTIC_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'girgas-page-navigation-skeleton-diagnostics.json',
);
const DIRECT_JUMP_DIAGNOSTIC_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'girgas-page-500-input-skeleton-diagnostics.json',
);
const RAPID_NEXT_TO_LAST_DIAGNOSTIC_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'girgas-rapid-next-to-last-skeleton-diagnostics.json',
);

interface INavigationSample {
    sampledAtMs: number;
    currentPageText: string | null;
    skeletonPages: number[];
    renderedPages: number[];
    canvasPages: number[];
}

interface IVisiblePageDiagnostics {
    page: number;
    className: string;
    rendered: boolean;
    buffered: boolean;
    hasSkeleton: boolean;
    hasCanvas: boolean;
    hasPreview: boolean;
    canvasCount: number;
    previewCount: number;
    textSpanCount: number;
    rectTop: number;
    rectBottom: number;
    rectHeight: number;
}

interface INavigationDiagnosticsSnapshot {
    pageControlsText: string;
    scrollTop: number | null;
    visibleRangeText: string | null;
    toolbarSnapshot: INavigationToolbarSnapshot | null;
    visiblePages: IVisiblePageDiagnostics[];
}

interface INavigationToolbarSnapshot {
    currentPage?: number;
    fitMode: string;
    totalPages?: number;
}

interface INavigationZoomToolbarSnapshot {
    continuousScroll?: boolean;
    effectiveZoom?: number;
}

interface INavigationEffectiveZoomSnapshot {effectiveZoom?: number;}

function summarizeNavigationArtifacts(
    samples: INavigationSample[],
    navLog: IPdfNavLogEntry[],
    renderTrace: IPdfRenderTraceEntry[],
) {
    return {
        samples,
        navLog,
        renderTrace,
        skeletonSamples: samples.filter(sample => sample.skeletonPages.length > 0),
        canvasSamples: samples.filter(sample => sample.canvasPages.length > 0),
        lastSample: samples.at(-1) ?? null,
        skeletonLogEntries: navLog.filter(entry => entry.message.includes('page skeleton visible')),
    };
}

async function setContinuousScrollMode(
    session: IElectronE2ESession,
    continuousScroll: boolean,
) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const snapshot = await getWorkspaceToolbarSnapshot(session.page, {requiredMethods: [
            'getToolbarSnapshot',
            'handleToggleContinuousScroll',
        ]}) as INavigationZoomToolbarSnapshot | null;
        if (snapshot?.continuousScroll === continuousScroll) {
            return;
        }

        await callWorkspaceCommand(session.page, 'handleToggleContinuousScroll', [], {requiredMethods: [
            'getToolbarSnapshot',
            'handleToggleContinuousScroll',
        ]});
        await waitForWorkspaceToolbarSnapshot(
            session.page,
            { continuousScroll },
            { timeoutMs: 3_000 },
        ).catch(() => {});
        await delay(100);
    }

    const snapshot = await getWorkspaceToolbarSnapshot(session.page, {requiredMethods: ['getToolbarSnapshot']}) as INavigationZoomToolbarSnapshot | null;
    throw new Error(`Unable to set continuous scroll mode to ${String(continuousScroll)}; current=${String(snapshot?.continuousScroll)}`);
}

async function collectPdfNavLog(context: IPdfDiagnosticsContext) {
    return toPdfNavLogEntries(await context.trace.collectNavigation());
}

async function collectPdfRenderTrace(context: IPdfDiagnosticsContext) {
    return toPdfRenderTraceEntries(await context.trace.collectRender());
}

async function goToPageViaWorkspace(session: IElectronE2ESession, pageNumber: number) {
    const navigationResult = await callWorkspaceCommand(session.page, 'handleGoToPage', [pageNumber], {
        requiredMethods: ['getToolbarSnapshot'],
        requireVisible: true,
    });

    if (navigationResult.called) {
        const reachedTarget = await waitForWorkspaceToolbarSnapshot(
            session.page,
            { currentPage: pageNumber },
            { timeoutMs: 3_000 },
        ).then(
            () => true,
            () => false,
        );
        if (reachedTarget) {
            return;
        }
    }

    await enterPageInToolbar(session, String(pageNumber));
}

async function collectNavigationDiagnosticsSnapshot(session: IElectronE2ESession) {
    const rawSnapshot: unknown = await session.page.evaluate(() => {
        const isVisibleElement = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        };

        const viewer = document.querySelector<HTMLElement>('#pdf-viewer');
        const viewportRect = viewer?.getBoundingClientRect() ?? {
            top: 0,
            bottom: window.innerHeight,
        };
        const visiblePageControls = Array.from(document.querySelectorAll<HTMLElement>('.page-controls'))
            .find(isVisibleElement);
        const visibleCurrentPageLabel = Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current-primary'))
            .find(isVisibleElement);
        const visiblePages = Array.from(document.querySelectorAll<HTMLElement>('.page_container'))
            .map((container): IVisiblePageDiagnostics => {
                const rect = container.getBoundingClientRect();
                const canvasCount = container.querySelectorAll('.page_canvas canvas').length;
                const previewCount = container.querySelectorAll('.page_preview canvas').length;
                return {
                    page: Number(container.dataset.page) || 0,
                    className: container.className,
                    rendered: container.classList.contains('page_container--rendered'),
                    buffered: container.classList.contains('page_container--buffered'),
                    hasSkeleton: Boolean(container.querySelector('.document-page-skeleton')),
                    hasCanvas: canvasCount + previewCount > 0,
                    hasPreview: previewCount > 0,
                    canvasCount,
                    previewCount,
                    textSpanCount: container.querySelectorAll('.text-layer span, .textLayer span').length,
                    rectTop: rect.top,
                    rectBottom: rect.bottom,
                    rectHeight: rect.height,
                };
            })
            .filter(page => page.rectBottom >= viewportRect.top && page.rectTop <= viewportRect.bottom);

        return {
            pageControlsText: visiblePageControls?.innerText ?? '',
            scrollTop: viewer?.scrollTop ?? null,
            visibleRangeText: visibleCurrentPageLabel?.textContent.trim() ?? null,
            visiblePages,
        };
    });
    const snapshot = rawSnapshot as Omit<INavigationDiagnosticsSnapshot, 'toolbarSnapshot'>;
    const rawToolbarSnapshot: unknown = await getWorkspaceToolbarSnapshot(session.page, {requireVisible: true});
    const toolbarSnapshot = rawToolbarSnapshot as INavigationToolbarSnapshot | null;
    return {
        ...snapshot,
        toolbarSnapshot,
    };
}

async function getToolbarTotalPages(session: IElectronE2ESession) {
    const snapshot = await getWorkspaceToolbarSnapshot(session.page, {requireVisible: true});
    const totalPages = Number(snapshot?.totalPages);
    if (!Number.isFinite(totalPages) || totalPages < 2) {
        throw new Error(`PDF navigation diagnostic requires at least 2 pages; got ${String(snapshot?.totalPages ?? null)}`);
    }
    return Math.trunc(totalPages);
}

async function configureHighZoom(session: IElectronE2ESession, options: { continuousScroll: boolean } = { continuousScroll: false }) {
    await session.page.waitForFunction(() => Boolean(document.querySelector('#pdf-viewer')), { timeout: 20_000 });
    const initialSnapshot = await getWorkspaceToolbarSnapshot(session.page, {requiredMethods: ['handleZoomIn']}) as INavigationZoomToolbarSnapshot | null;

    if (!initialSnapshot) {
        throw new Error('Unable to configure workspace zoom/page state');
    }

    await callWorkspaceCommand(session.page, 'handleViewModeSingle', [], {requiredMethods: [
        'getToolbarSnapshot',
        'handleZoomIn',
    ]});
    await setContinuousScrollMode(session, options.continuousScroll);
    await callWorkspaceCommand(session.page, 'handleActualSize', [], {requiredMethods: [
        'getToolbarSnapshot',
        'handleZoomIn',
    ]});
    for (let index = 0; index < 30; index += 1) {
        const snapshot = await getWorkspaceToolbarSnapshot(session.page, {requiredMethods: ['handleZoomIn']}) as INavigationEffectiveZoomSnapshot | null;
        if ((snapshot?.effectiveZoom ?? 0) >= 3.4) {
            break;
        }
        await callWorkspaceCommand(session.page, 'handleZoomIn', [], {requiredMethods: ['getToolbarSnapshot']});
    }
    await delay(500);
}

async function configureSinglePagedFitHeightMode(session: IElectronE2ESession) {
    await session.page.waitForFunction(() => Boolean(document.querySelector('#pdf-viewer')), { timeout: 20_000 });
    const initialSnapshot = await getWorkspaceToolbarSnapshot(session.page, {requiredMethods: [
        'handleFitHeight',
        'handleViewModeSingle',
    ]}) as { continuousScroll?: boolean } | null;

    if (!initialSnapshot) {
        throw new Error('Unable to configure single-page paged fit-height mode');
    }

    await callWorkspaceCommand(session.page, 'handleViewModeSingle', [], {requiredMethods: [
        'getToolbarSnapshot',
        'handleFitHeight',
    ]});
    await setContinuousScrollMode(session, false);
    await callWorkspaceCommand(session.page, 'handleFitHeight', [], {requiredMethods: ['getToolbarSnapshot']});
    await delay(500);
}

async function waitForToolbarPage(session: IElectronE2ESession, pageNumber: number) {
    try {
        await Promise.any([
            waitForWorkspaceToolbarSnapshot(session.page, { currentPage: pageNumber }, { timeoutMs: 15_000 }),
            session.page.waitForFunction((targetPage: number) => {
                const isVisibleElement = (element: HTMLElement) => {
                    const rect = element.getBoundingClientRect();
                    const style = window.getComputedStyle(element);
                    return rect.width > 0
                        && rect.height > 0
                        && style.display !== 'none'
                        && style.visibility !== 'hidden';
                };
                return Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current-primary'))
                    .some((element) => {
                        return element.textContent.trim() === String(targetPage)
                            && isVisibleElement(element);
                    });
            }, { timeout: 15_000 }, pageNumber),
        ]);
    } catch (error) {
        const snapshot = await collectNavigationDiagnosticsSnapshot(session).catch(() => null);
        const waitErrors = error instanceof AggregateError
            ? error.errors.map((entry: unknown) => getErrorMessage(entry))
            : [getErrorMessage(error)];
        throw new Error(`Timed out waiting for toolbar page ${pageNumber}: ${JSON.stringify({
            currentPage: snapshot?.toolbarSnapshot?.currentPage ?? null,
            pageControlsText: snapshot?.pageControlsText ?? null,
            totalPages: snapshot?.toolbarSnapshot?.totalPages ?? null,
            visibleRangeText: snapshot?.visibleRangeText ?? null,
            waitErrors,
        })}`);
    }
}

async function waitForToolbarPageAtLeast(session: IElectronE2ESession, pageNumber: number) {
    try {
        await session.page.waitForFunction((targetPage: number) => {
            const isVisibleElement = (element: HTMLElement) => {
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return rect.width > 0
                    && rect.height > 0
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            };
            const visibleCurrentPageLabel = Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current-primary'))
                .find(isVisibleElement);
            const currentPage = Number.parseInt(visibleCurrentPageLabel?.textContent.trim() ?? '', 10);
            return Number.isFinite(currentPage) && currentPage >= targetPage;
        }, { timeout: 15_000 }, pageNumber);
    } catch (error) {
        const snapshot = await collectNavigationDiagnosticsSnapshot(session).catch(() => null);
        throw new Error(`Timed out waiting for toolbar page >= ${pageNumber}: ${JSON.stringify({
            currentPage: snapshot?.toolbarSnapshot?.currentPage ?? null,
            pageControlsText: snapshot?.pageControlsText ?? null,
            totalPages: snapshot?.toolbarSnapshot?.totalPages ?? null,
            visibleRangeText: snapshot?.visibleRangeText ?? null,
            waitError: getErrorMessage(error),
        })}`);
    }
}

async function rapidClickNextPages(context: IPdfDiagnosticsContext, count: number) {
    for (let index = 0; index < count; index += 1) {
        await context.navigation.clickToolbarButton('Next Page');
    }
}

async function enterPageInToolbar(session: IElectronE2ESession, pageInput: string) {
    await session.page.waitForFunction(() => {
        return Array.from(document.querySelectorAll<HTMLButtonElement>('.page-controls-display'))
            .some(button => {
                const rect = button.getBoundingClientRect();
                const style = window.getComputedStyle(button);
                return !button.disabled
                    && rect.width > 8
                    && rect.height > 8
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            });
    }, { timeout: 30_000 });

    const clicked = await session.page.evaluate(() => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.page-controls-display'))
            .find((candidate) => {
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return !candidate.disabled
                    && rect.width > 8
                    && rect.height > 8
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            });
        button?.click();
        return Boolean(button);
    });
    if (!clicked) {
        throw new Error('Unable to click the page display');
    }

    await session.page.waitForFunction(() => {
        return Array.from(document.querySelectorAll<HTMLInputElement>('.page-controls-inline-input'))
            .some(input => {
                const rect = input.getBoundingClientRect();
                const style = window.getComputedStyle(input);
                return rect.width > 8
                    && rect.height > 8
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            });
    }, { timeout: 10_000 });

    const selected = await session.page.evaluate(() => {
        const input = Array.from(document.querySelectorAll<HTMLInputElement>('.page-controls-inline-input'))
            .find((candidate) => {
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return rect.width > 8
                    && rect.height > 8
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            });
        input?.focus();
        input?.select();
        return Boolean(input);
    });
    if (!selected) {
        throw new Error('Unable to select the page input');
    }

    await session.page.keyboard.type(pageInput);
    await session.page.keyboard.press('Enter');
}

async function navigateForwardWithNextButton(context: IPdfDiagnosticsContext, steps: number) {
    const { session } = context;
    for (let step = 0; step < steps; step += 1) {
        const currentPage = await session.page.evaluate(() => {
            const text = document.querySelector<HTMLElement>('.page-controls-current-primary')?.textContent.trim() ?? '';
            return Number.parseInt(text, 10);
        });
        await context.navigation.clickToolbarButton('Next Page', {nextButtonFallback: true});
        if (Number.isFinite(currentPage)) {
            await waitForToolbarPageAtLeast(session, currentPage + 1);
        }
    }
}

async function sampleNavigation(
    context: IPdfDiagnosticsContext,
    options: {
        count?: number;
        delayMs?: number;
    } = {},
) {
    const count = options.count ?? 180;
    const delayMs = options.delayMs ?? 10;
    return context.sampling.repeat({
        count,
        delayMs,
    }, async startedAtMs => context.page.evaluate((sampleStartedAtMs: number): INavigationSample => {
        const pageContainers = Array.from(document.querySelectorAll<HTMLElement>('.page_container'));
        const visiblePageContainers = pageContainers.filter((container) => {
            const rect = container.getBoundingClientRect();
            return rect.bottom > 0 && rect.top < window.innerHeight;
        });
        const pageNumber = (container: HTMLElement) => Number(container.dataset.page) || 0;
        const skeletonPages = visiblePageContainers
            .filter(container => Boolean(container.querySelector('.document-page-skeleton')))
            .map(pageNumber);
        const renderedPages = visiblePageContainers
            .filter(container => container.classList.contains('page_container--rendered'))
            .map(pageNumber);
        const canvasPages = visiblePageContainers
            .filter(container => Boolean(container.querySelector('.page_canvas canvas, .page_preview canvas')))
            .map(pageNumber);
        const visibleCurrentPageLabel = Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current-primary'))
            .find((element) => {
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return rect.width > 0
                        && rect.height > 0
                        && style.display !== 'none'
                        && style.visibility !== 'hidden';
            });
        return {
            sampledAtMs: Date.now() - sampleStartedAtMs,
            currentPageText: visibleCurrentPageLabel?.textContent.trim() ?? null,
            skeletonPages,
            renderedPages,
            canvasPages,
        };
    }, startedAtMs));
}

async function runHighZoomNextPageDiagnostic(context: IPdfDiagnosticsContext) {
    const { session } = context;
    let samples: INavigationSample[] = [];
    let navLog: IPdfNavLogEntry[] = [];
    let renderTrace: IPdfRenderTraceEntry[] = [];
    const totalPages = await getToolbarTotalPages(session);
    const startPage = Math.min(55, totalPages - 1);
    const nextPage = startPage + 1;
    try {
        await configureHighZoom(session);
        await goToPageViaWorkspace(session, startPage);
        await waitForToolbarPage(session, startPage);
        await context.navigation.waitForPageCanvas(startPage, 20_000);
        await delay(500);
        await context.trace.reset();
        await context.navigation.clickToolbarButton('Next Page', {nextButtonFallback: true});
        samples = await sampleNavigation(context);
        navLog = await collectPdfNavLog(context);
        renderTrace = await collectPdfRenderTrace(context);
    } finally {
        if (samples.length === 0) {
            samples = await sampleNavigation(context).catch(() => []);
        }
        if (navLog.length === 0) {
            navLog = await collectPdfNavLog(context).catch(() => []);
        }
        if (renderTrace.length === 0) {
            renderTrace = await collectPdfRenderTrace(context).catch(() => []);
        }
        context.artifacts.writeJson(DIAGNOSTIC_OUTPUT_PATH, {
            pdfPath: TARGET_PDF_PATH,
            scenario: `page-${startPage}-next-to-${nextPage}-zoom-344`,
            samples,
            navLog,
            renderTrace,
            skeletonSamples: samples.filter(sample => sample.skeletonPages.length > 0),
            skeletonLogEntries: navLog.filter(entry => entry.message.includes('page skeleton visible')),
        });
    }

    const skeletonSamples = samples.filter(sample => sample.skeletonPages.length > 0);
    const skeletonLogEntries = navLog.filter(entry => entry.message.includes('page skeleton visible'));

    assert.deepEqual(skeletonSamples, []);
    assert.deepEqual(skeletonLogEntries, []);
}

async function runToolbarPageInputDiagnostic(context: IPdfDiagnosticsContext) {
    const { session } = context;
    let samples: INavigationSample[] = [];
    let navLog: IPdfNavLogEntry[] = [];
    let renderTrace: IPdfRenderTraceEntry[] = [];
    const totalPages = await getToolbarTotalPages(session);
    const targetPage = Math.min(500, totalPages);
    try {
        await navigateForwardWithNextButton(context, 3);
        await configureHighZoom(session, { continuousScroll: true });
        await context.trace.reset();
        await enterPageInToolbar(session, String(targetPage));
        samples = await sampleNavigation(context);
        navLog = await collectPdfNavLog(context);
        renderTrace = await collectPdfRenderTrace(context);
    } finally {
        if (samples.length === 0) {
            samples = await sampleNavigation(context).catch(() => []);
        }
        if (navLog.length === 0) {
            navLog = await collectPdfNavLog(context).catch(() => []);
        }
        if (renderTrace.length === 0) {
            renderTrace = await collectPdfRenderTrace(context).catch(() => []);
        }
        context.artifacts.writeJson(DIRECT_JUMP_DIAGNOSTIC_OUTPUT_PATH, {
            pdfPath: TARGET_PDF_PATH,
            scenario: `toolbar-enter-page-${targetPage}-after-navigation-zoom-344`,
            ...summarizeNavigationArtifacts(samples, navLog, renderTrace),
        });
    }

    const lastSample = samples.at(-1);
    assert.deepEqual(lastSample?.skeletonPages, []);
    assert.ok(lastSample.canvasPages.length > 0);
}

async function runRapidNextToLastPageDiagnostic(context: IPdfDiagnosticsContext) {
    const { session } = context;
    let samples: INavigationSample[] = [];
    let navLog: IPdfNavLogEntry[] = [];
    let renderTrace: IPdfRenderTraceEntry[] = [];
    let finalSnapshot: INavigationDiagnosticsSnapshot | null = null;
    const totalPages = await getToolbarTotalPages(session);
    const rapidTargetPage = Math.min(30, totalPages);
    const rapidClickCount = Math.max(0, rapidTargetPage - 1);
    try {
        await delay(2_000);
        await goToPageViaWorkspace(session, 1);
        await waitForToolbarPage(session, 1);
        await configureSinglePagedFitHeightMode(session);
        await waitForToolbarPage(session, 1);
        await delay(500);
        await context.trace.reset();
        await rapidClickNextPages(context, rapidClickCount);
        await waitForToolbarPage(session, rapidTargetPage);
        if (rapidTargetPage < totalPages) {
            await context.navigation.clickToolbarButton('Last Page');
            await waitForToolbarPage(session, totalPages);
        }

        samples = await sampleNavigation(context, {
            count: 500,
            delayMs: 25,
        });
        finalSnapshot = await collectNavigationDiagnosticsSnapshot(session);
        navLog = await collectPdfNavLog(context);
        renderTrace = await collectPdfRenderTrace(context);
    } finally {
        if (samples.length === 0) {
            samples = await sampleNavigation(context, {
                count: 120,
                delayMs: 25,
            }).catch(() => []);
        }
        finalSnapshot ??= await collectNavigationDiagnosticsSnapshot(session).catch(() => null);
        if (navLog.length === 0) {
            navLog = await collectPdfNavLog(context).catch(() => []);
        }
        if (renderTrace.length === 0) {
            renderTrace = await collectPdfRenderTrace(context).catch(() => []);
        }
        context.artifacts.writeJson(RAPID_NEXT_TO_LAST_DIAGNOSTIC_OUTPUT_PATH, {
            pdfPath: TARGET_PDF_PATH,
            scenario: `fit-height-rapid-next-1-to-${rapidTargetPage}-then-page-${totalPages}`,
            finalSnapshot,
            ...summarizeNavigationArtifacts(samples, navLog, renderTrace),
        });
    }

    const lastSample = samples.at(-1);
    assert.deepEqual(lastSample?.skeletonPages, []);
    assert.equal(finalSnapshot?.toolbarSnapshot?.currentPage, totalPages);
    assert.equal(finalSnapshot.toolbarSnapshot.fitMode, 'height');
    assert.equal(finalSnapshot.visiblePages.some(page => page.page === totalPages && page.hasSkeleton), false);
    assert.equal(finalSnapshot.visiblePages.some(page => page.page === totalPages && page.hasCanvas), true);
}

export const pdfSkeletonNavigationScenario = {
    name: 'diagnostic-girgas-skeleton',
    pdfPath: TARGET_PDF_PATH,
    fixtureError: [
        `PDF navigation diagnostic fixture not found: ${TARGET_PDF_PATH}`,
        'Set EVB_E2E_NAVIGATION_PDF_PATH or EVB_DIAGNOSTIC_PDF_PATH to a local PDF before running this diagnostic.',
    ].join('\n'),
    diagnostics: {
        navigation: true,
        render: true,
    },
    run: async (context: IPdfDiagnosticsContext) => {
        await context.trace.reset();
        await runHighZoomNextPageDiagnostic(context);
        await runToolbarPageInputDiagnostic(context);
        await runRapidNextToLastPageDiagnostic(context);
    },
};

export const runPdfSkeletonNavigationDiagnostics = () => (
    runPdfDiagnosticScenario(pdfSkeletonNavigationScenario)
);

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await runPdfSkeletonNavigationDiagnostics().catch((error: unknown) => {
        console.error(getErrorMessage(error));
        process.exitCode = 1;
    });
}
