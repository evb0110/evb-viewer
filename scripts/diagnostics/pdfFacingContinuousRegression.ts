import {
    mkdirSync,
    writeFileSync,
} from 'node:fs';
import {resolve} from 'node:path';
import {delay} from 'es-toolkit/promise';
import { getErrorMessage } from '@contracts/getErrorMessage';
import {readSessionLogTail} from '@scripts/electron-run/electronRunSessionArtifacts';
import {startHostVisiblePdfDiagnosticsElectronSession} from '@scripts/diagnostics/startPdfDiagnosticsElectronSession';
import {openPdfInApp} from '@tests/e2e/electron/helpers/viewerCore';
import {openNewPane} from '@tests/e2e/electron/helpers/workspaceTabs';
import {
    callWorkspaceCommand,
    getWorkspaceToolbarSnapshot,
    waitForWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';

function readNonEmptyEnv(name: string, fallback?: string) {
    const value = process.env[name]?.trim();
    return value && value.length > 0 ? value : fallback;
}

const pdfPath = readNonEmptyEnv('EVB_E2E_PDF_FACING_FIXTURE');
const outputDir = resolve(readNonEmptyEnv(
    'EVB_E2E_PDF_FACING_OUTPUT',
    '.devkit/pdf-facing-continuous',
)!);
const phase = readNonEmptyEnv('EVB_E2E_PDF_FACING_PHASE', 'diagnostic')!;

if (!pdfPath) {
    throw new Error('EVB_E2E_PDF_FACING_FIXTURE is required');
}

interface IPageState {
    bottom: number;
    canvasHeight: number;
    canvasWidth: number;
    completeVertical: boolean;
    hasCanvas: boolean;
    hasSkeleton: boolean;
    left: number;
    page: number;
    rendered: boolean;
    right: number;
    top: number;
}

interface IViewportState {
    clientHeight: number;
    clientWidth: number;
    pages: IPageState[];
    scrollHeight: number;
    scrollLeft: number;
    scrollTop: number;
    scrollWidth: number;
    track: null | {
        computedWidth: string;
        gridTemplateColumns: string;
        left: number;
        placeContent: string;
        right: number;
        width: number;
    };
    viewport: {
        bottom: number;
        left: number;
        right: number;
        top: number;
    };
}

async function selectActivePdfViewport() {
    return page.evaluate(() => {
        const visible = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const candidates = Array.from(document.querySelectorAll<HTMLElement>('[data-document-viewer-chassis-viewport], #pdf-viewer'))
            .filter(element => visible(element) && element.querySelector('.pdf-viewer-page-track'));
        const activePane = document.querySelector<HTMLElement>('.editor-pane.is-active, .editor-pane[data-active="true"]');
        const active = candidates.find(element => activePane?.contains(element)) ?? candidates.at(-1) ?? null;
        if (!active) {
            return false;
        }
        active.dataset.pdfFacingRegressionTarget = 'true';
        return true;
    });
}

async function collectViewportState(): Promise<IViewportState> {
    return page.evaluate(() => {
        const viewer = document.querySelector<HTMLElement>('[data-pdf-facing-regression-target="true"]');
        if (!viewer) throw new Error('Active PDF viewport target is unavailable');
        const viewport = viewer.getBoundingClientRect();
        const track = viewer.querySelector<HTMLElement>('.pdf-viewer-page-track');
        const trackRect = track?.getBoundingClientRect() ?? null;
        const trackStyle = track ? getComputedStyle(track) : null;
        return {
            clientHeight: viewer.clientHeight,
            clientWidth: viewer.clientWidth,
            pages: Array.from(viewer.querySelectorAll<HTMLElement>('.page_container')).map((container) => {
                const rect = container.getBoundingClientRect();
                const canvas = container.querySelector<HTMLCanvasElement>('.page_canvas canvas');
                return {
                    bottom: rect.bottom,
                    canvasHeight: canvas?.height ?? 0,
                    canvasWidth: canvas?.width ?? 0,
                    completeVertical: rect.top >= viewport.top - 0.5 && rect.bottom <= viewport.bottom + 0.5,
                    hasCanvas: Boolean(canvas?.isConnected && canvas.width > 0 && canvas.height > 0),
                    hasSkeleton: Boolean(container.querySelector('.document-page-skeleton')),
                    left: rect.left,
                    page: Number(container.dataset.page) || 0,
                    rendered: container.classList.contains('page_container--rendered'),
                    right: rect.right,
                    top: rect.top,
                };
            }).filter(item => item.bottom > viewport.top && item.top < viewport.bottom),
            scrollHeight: viewer.scrollHeight,
            scrollLeft: viewer.scrollLeft,
            scrollTop: viewer.scrollTop,
            scrollWidth: viewer.scrollWidth,
            track: trackRect && trackStyle ? {
                computedWidth: trackStyle.width,
                gridTemplateColumns: trackStyle.gridTemplateColumns,
                left: trackRect.left,
                placeContent: trackStyle.placeContent,
                right: trackRect.right,
                width: trackRect.width,
            } : null,
            viewport: {
                bottom: viewport.bottom,
                left: viewport.left,
                right: viewport.right,
                top: viewport.top,
            },
        };
    });
}

async function command(name: Parameters<typeof callWorkspaceCommand>[1], args: unknown[] = []) {
    const result = await callWorkspaceCommand(page, name, args, {requireVisible: true});
    if (!result.called) throw new Error(`Workspace command ${String(name)} was not called`);
}

async function setContinuous(value: boolean) {
    const state = await getWorkspaceToolbarSnapshot(page, {requireVisible: true});
    if (state?.continuousScroll !== value) await command('handleToggleContinuousScroll');
}

async function configureFacing(pageNumber: number, zoom: number) {
    await command('handleViewModeFacing');
    await setContinuous(true);
    await command('setCustomZoomFromDisplay', [zoom]);
    await command('handleGoToPage', [pageNumber]);
    await waitForWorkspaceToolbarSnapshot(page, {currentPage: pageNumber}, {timeoutMs: 20_000});
    await delay(1_500);
    if (!await selectActivePdfViewport()) throw new Error('Unable to select active PDF viewport');
}

async function captureHorizontal(zoom: number) {
    await command('setCustomZoomFromDisplay', [zoom]);
    await delay(1_500);
    await page.evaluate(() => {
        const viewer = document.querySelector<HTMLElement>('[data-pdf-facing-regression-target="true"]');
        if (viewer) viewer.scrollLeft = 0;
    });
    await delay(250);
    const minimum = await collectViewportState();
    await page.screenshot({path: resolve(outputDir, `horizontal-${Math.round(zoom * 100)}-min.png`)});
    await page.evaluate(() => {
        const viewer = document.querySelector<HTMLElement>('[data-pdf-facing-regression-target="true"]');
        if (viewer) viewer.scrollLeft = viewer.scrollWidth;
    });
    await delay(250);
    const maximum = await collectViewportState();
    await page.screenshot({path: resolve(outputDir, `horizontal-${Math.round(zoom * 100)}-max.png`)});
    return {
        maximum,
        minimum,
        zoom,
    };
}

mkdirSync(outputDir, {recursive: true});
const consoleLines: string[] = [];
// This diagnostic measures a real, host-visible viewport. It is an explicit
// operator opt-in and is not part of any Vitest Electron E2E project.
const session = await startHostVisiblePdfDiagnosticsElectronSession(`pdf-facing-${phase}`);
const {page} = session;
await page.setViewport({
    deviceScaleFactor: 1,
    height: 1079,
    width: 1882,
});
page.on('console', message => consoleLines.push(`[${message.type()}] ${message.text()}`));
page.on('pageerror', (error: unknown) => consoleLines.push(
    `[pageerror] ${error instanceof Error ? error.stack ?? getErrorMessage(error) : getErrorMessage(error)}`,
));

try {
    await openPdfInApp(page, pdfPath, 90_000);
    await openNewPane(page, 'right', 15_000);
    await delay(1_000);
    await openPdfInApp(page, pdfPath, 90_000);

    await configureFacing(9, 0.54);
    const skeletonSamples: Array<{
        elapsedMs: number;
        state: IViewportState;
    }> = [];
    const skeletonStartedAt = Date.now();
    for (const waitMs of [
        0,
        2_000,
        5_000,
        10_000,
        20_000,
    ]) {
        const remaining = skeletonStartedAt + waitMs - Date.now();
        if (remaining > 0) await delay(remaining);
        skeletonSamples.push({
            elapsedMs: Date.now() - skeletonStartedAt,
            state: await collectViewportState(),
        });
    }
    await page.screenshot({path: resolve(outputDir, 'skeleton-facing-page-9-zoom-54.png')});

    await command('handleGoToPage', [3]);
    await waitForWorkspaceToolbarSnapshot(page, {currentPage: 3}, {timeoutMs: 20_000});
    await command('setCustomZoomFromDisplay', [1]);
    await delay(750);
    const zoom100Before = await collectViewportState();
    await delay(1_000);
    const horizontal = [
        await captureHorizontal(1.29),
        await captureHorizontal(1.79),
    ];

    await command('setCustomZoomFromDisplay', [1]);
    await delay(750);
    const zoom100After = await collectViewportState();
    await command('handleViewModeFacingFirstSingle');
    await command('handleGoToPage', [1]);
    await waitForWorkspaceToolbarSnapshot(page, {currentPage: 1}, {timeoutMs: 20_000});
    await delay(750);
    const facingFirstSingle = await collectViewportState();
    await command('handleViewModeFacing');
    await command('handleGoToPage', [3]);
    await delay(750);
    await command('setCustomZoomFromDisplay', [0.54]);
    await delay(750);
    const wideViewport = await collectViewportState();
    await page.screenshot({path: resolve(outputDir, 'wide-centered-54.png')});

    if (phase === 'post-fix') {
        const finalSkeletonState = skeletonSamples.at(-1)!.state;
        const intersectingPages = finalSkeletonState.pages.filter(item => (
            item.bottom > finalSkeletonState.viewport.top
            && item.top < finalSkeletonState.viewport.bottom
        ));
        const intersectingPageNumbers = intersectingPages.map(item => item.page);
        if (![
            9,
            10,
            11,
            12,
            13,
            14,
        ].every(pageNumber => intersectingPageNumbers.includes(pageNumber))
            || intersectingPages.some(item => !item.hasCanvas || item.hasSkeleton || !item.rendered)) {
            throw new Error(`Intersecting facing rows did not converge: ${JSON.stringify(intersectingPages)}`);
        }
        const partialFacingRow = intersectingPages.filter(item => item.page === 13 || item.page === 14);
        if (partialFacingRow.length !== 2 || partialFacingRow.some(item => item.completeVertical)) {
            throw new Error(`Expected pages 13-14 to remain a partially visible facing row: ${JSON.stringify(partialFacingRow)}`);
        }
        for (const sample of horizontal) {
            const minPages = sample.minimum.pages.filter(item => item.page === 3 || item.page === 4);
            const maxPages = sample.maximum.pages.filter(item => item.page === 3 || item.page === 4);
            const outerLeft = Math.min(...minPages.map(item => item.left));
            const outerRight = Math.max(...maxPages.map(item => item.right));
            if (outerLeft < sample.minimum.viewport.left - 1.5) {
                throw new Error(`Left spread edge is unreachable at ${String(sample.zoom)}: ${String(outerLeft)}`);
            }
            if (outerRight > sample.maximum.viewport.right + 1.5) {
                throw new Error(`Right spread edge is unreachable at ${String(sample.zoom)}: ${String(outerRight)}`);
            }
        }
        const widePages = wideViewport.pages.filter(item => item.page === 3 || item.page === 4);
        const wideLeft = Math.min(...widePages.map(item => item.left));
        const wideRight = Math.max(...widePages.map(item => item.right));
        const leftInset = wideLeft - wideViewport.viewport.left;
        const rightInset = wideViewport.viewport.right - wideRight;
        if (Math.abs(leftInset - rightInset) > 1.5 || wideViewport.scrollWidth !== wideViewport.clientWidth) {
            throw new Error(`Wide spread is not centered: ${JSON.stringify({
                leftInset,
                rightInset,
                wideViewport,
            })}`);
        }
        const firstPage = facingFirstSingle.pages.find(item => item.page === 1);
        if (!firstPage?.hasCanvas || firstPage.hasSkeleton || !firstPage.rendered) {
            throw new Error(`Facing-first-single page did not remain rendered: ${JSON.stringify(firstPage)}`);
        }
    }

    writeFileSync(resolve(outputDir, 'state.json'), `${JSON.stringify({
        capturedAt: new Date().toISOString(),
        fixture: pdfPath,
        horizontal,
        phase,
        skeletonSamples,
        toolbar: await getWorkspaceToolbarSnapshot(page, {requireVisible: true}),
        wideViewport,
        zoomSequence: {
            facingFirstSingle,
            zoom100After,
            zoom100Before,
        },
    }, null, 2)}\n`);
    writeFileSync(resolve(outputDir, 'app.log'), `${consoleLines.join('\n')}\n\n--- session log tail ---\n${readSessionLogTail(2_000)}\n`);
} finally {
    await session.stop();
}
