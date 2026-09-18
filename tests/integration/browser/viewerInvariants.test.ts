import {
    mkdir,
    mkdtemp,
    rm,
} from 'node:fs/promises';
import {
    join,
    resolve,
} from 'node:path';
import { build } from 'esbuild';
import {
    chromium,
    type Page,
} from 'playwright';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IViewerInvariantOptions,
    IViewerInvariantReport,
} from '@app/modules/viewer-invariants/viewerInvariantTypes';

/**
 * Known-bad proofs for the viewer invariants. Each fixture is minimal markup
 * built from the selectors and data attributes the app really renders, so a
 * checker weakened until it stops reporting a defect fails here.
 *
 * The fixtures for the stateful invariants are two-observation sequences: the
 * checker compares the second settled observation against the first.
 */
const BROWSER_TEST_TIMEOUT_MS = 120_000;

const VIEWPORT_WIDTH_PX = 600;
const VIEWPORT_HEIGHT_PX = 400;
const TOOLBAR_HEIGHT_PX = 40;
const PAGE_WIDTH_PX = 500;
const PAGE_HEIGHT_PX = 300;
const PAGE_GAP_PX = 20;

interface IFixturePage {
    heightPx?: number;
    overlays?: IFixtureOverlay[];
    pageNumber: number;
    widthPx?: number;
}

interface IFixtureOverlay {
    annotationId: string;
    /** Fractions of the page box, the same space the app normalizes into. */
    height: number;
    kind: string;
    outsidePage?: boolean;
    width: number;
    x: number;
    y: number;
}

interface IFixtureNoteWindow {
    annotationId: string;
    leftPx: number;
    pageNumber: number;
    topPx: number;
}

interface IFixtureOptions {
    continuousScroll?: boolean;
    noteWindows?: IFixtureNoteWindow[];
    pages?: IFixturePage[];
    toolbarPageLabel?: string;
    toolbarPageNumber?: number;
    toolbarTotalPages?: number;
    viewMode?: string;
    zoomMode?: string;
}

function renderOverlay(overlay: IFixtureOverlay) {
    const style = `position:absolute;left:${String(overlay.x * 100)}%;top:${String(overlay.y * 100)}%;`
        + `width:${String(overlay.width * 100)}%;height:${String(overlay.height * 100)}%;`;
    return `<div class="pdf-annotation-editor-entity" data-annotation-id="${overlay.annotationId}"
        data-annotation-kind="${overlay.kind}"
        ${overlay.outsidePage ? 'data-annotation-outside-page=""' : ''}
        style="${style}"><div data-annotation-visual style="width:100%;height:100%"></div></div>`;
}

function renderPage(page: IFixturePage, index: number) {
    const width = page.widthPx ?? PAGE_WIDTH_PX;
    const height = page.heightPx ?? PAGE_HEIGHT_PX;
    const top = index * (height + PAGE_GAP_PX);
    return `<div class="page_container page_container--rendered" data-page="${String(page.pageNumber)}"
        style="position:absolute;left:0;top:${String(top)}px;width:${String(width)}px;height:${String(height)}px">
        <div class="pdf-annotation-editor-layer" data-pdf-annotation-editor-surface data-view-rotation="0"
            style="position:absolute;inset:0">
            ${(page.overlays ?? []).map(renderOverlay).join('')}
        </div>
    </div>`;
}

function renderNoteWindow(noteWindow: IFixtureNoteWindow) {
    return `<div class="note-window" data-annotation-id="${noteWindow.annotationId}"
        data-page-number="${String(noteWindow.pageNumber)}"
        style="position:fixed;left:${String(noteWindow.leftPx)}px;top:${String(noteWindow.topPx)}px;width:200px;height:150px;background:#fff"></div>`;
}

function buildFixtureMarkup(options: IFixtureOptions = {}) {
    const pages = options.pages ?? [
        {pageNumber: 1},
        {pageNumber: 2},
    ];
    const trackHeight = pages.reduce(
        (total, page) => total + (page.heightPx ?? PAGE_HEIGHT_PX) + PAGE_GAP_PX,
        0,
    );
    const trackWidth = Math.max(...pages.map(page => page.widthPx ?? PAGE_WIDTH_PX));
    return `<!doctype html>
<html><head><style>body {margin: 0; font: 13px sans-serif}</style></head>
<body>
<div id="editor-global-toolbar-host"
    style="position:fixed;left:0;top:0;width:100%;height:${String(TOOLBAR_HEIGHT_PX)}px">
    <div class="page-controls">
        <button type="button" class="page-controls-display">
            <span class="page-controls-current-primary">${options.toolbarPageLabel ?? String(options.toolbarPageNumber ?? 1)}</span>
            <span class="page-controls-current-secondary"></span>
            <span class="page-controls-slash">/</span>
            <span class="page-controls-total">${String(options.toolbarTotalPages ?? pages.length)}</span>
        </button>
    </div>
</div>
<div class="editor-pane is-active"
    style="position:fixed;left:0;top:${String(TOOLBAR_HEIGHT_PX)}px;width:${String(VIEWPORT_WIDTH_PX)}px;height:${String(VIEWPORT_HEIGHT_PX)}px">
    <div class="workspace-host" data-workspace-active="true" style="width:100%;height:100%">
        <div id="pdf-viewer" data-document-viewer-chassis-viewport
            style="width:100%;height:100%;overflow-y:scroll;overflow-x:auto">
            <div data-pdf-page-track
                data-pdf-view-mode="${options.viewMode ?? 'single'}"
                data-pdf-zoom-mode="${options.zoomMode ?? 'fit-width'}"
                data-pdf-continuous-scroll="${String(options.continuousScroll ?? true)}"
                style="position:relative;width:${String(trackWidth)}px;height:${String(trackHeight)}px">
                ${pages.map(renderPage).join('')}
            </div>
        </div>
    </div>
</div>
${(options.noteWindows ?? []).map(renderNoteWindow).join('')}
</body></html>`;
}

declare global {
    /* The bundled entry installs these on the page. */
    var __evbCheckViewerInvariants: (options?: IViewerInvariantOptions) => IViewerInvariantReport;
    var __evbResetViewerInvariantMemory: () => void;
    var __evbNotifyRendererDiagnosticNotice: (notice: {
        occurredAt: number;
        signature: string;
        source: 'console-error' | 'unhandled-rejection' | 'vue' | 'window';
    }) => void;
}

let bundlePath = '';
let temporaryDirectory = '';

beforeAll(async () => {
    await mkdir(join(process.cwd(), '.devkit'), {recursive: true});
    temporaryDirectory = await mkdtemp(join(process.cwd(), '.devkit/viewer-invariants-'));
    bundlePath = join(temporaryDirectory, 'viewer-invariants.js');
    await build({
        bundle: true,
        entryPoints: [resolve(process.cwd(), 'tests/integration/browser/viewerInvariantsEntry.ts')],
        format: 'iife',
        outfile: bundlePath,
        platform: 'browser',
        sourcemap: false,
        tsconfig: resolve(process.cwd(), 'tsconfig.json'),
    });
});

afterAll(async () => {
    await rm(temporaryDirectory, {
        force: true,
        recursive: true,
    });
});

async function loadFixture(page: Page, markup: string) {
    await page.setContent(markup);
    await page.addScriptTag({path: bundlePath});
    await page.evaluate(() => {
        globalThis.__evbResetViewerInvariantMemory();
    });
}

function violationIds(report: IViewerInvariantReport) {
    return report.violations.map(violation => violation.id);
}

describe('viewer invariant checker against real Chromium layout', () => {
    it('reports nothing on a conforming viewer and exactly one violation on each known-bad fixture', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                height: 700,
                width: 900,
            }});

            const conformingMarkup = buildFixtureMarkup({
                noteWindows: [{
                    annotationId: 'note-1',
                    leftPx: 60,
                    pageNumber: 1,
                    topPx: 120,
                }],
                pages: [
                    {
                        overlays: [{
                            annotationId: 'highlight-1',
                            height: 0.05,
                            kind: 'text-markup',
                            width: 0.3,
                            x: 0.1,
                            y: 0.2,
                        }],
                        pageNumber: 1,
                    },
                    {pageNumber: 2},
                ],
                toolbarPageNumber: 1,
            });
            await loadFixture(page, conformingMarkup);
            const conforming = await page.evaluate(() => globalThis.__evbCheckViewerInvariants());
            expect(conforming.violations).toEqual([]);
            expect(conforming.skipped.map(skip => skip.id)).toContain('C2-renderer-diagnostics-clean');

            // R1: the counter names a page nothing on screen shows.
            await loadFixture(page, buildFixtureMarkup({toolbarPageNumber: 9}));
            expect(violationIds(await page.evaluate(() => globalThis.__evbCheckViewerInvariants())))
                .toEqual(['R1-toolbar-page-visible']);

            // R1 applicability: a logical page label is not a physical number.
            await loadFixture(page, buildFixtureMarkup({toolbarPageLabel: 'iv'}));
            const labelled = await page.evaluate(() => globalThis.__evbCheckViewerInvariants());
            expect(labelled.violations).toEqual([]);
            expect(labelled.skipped.map(skip => skip.id)).toContain('R1-toolbar-page-visible');

            // L1: fit-width leaves a horizontal range although nothing visible
            // is wider than the current page.
            await loadFixture(page, buildFixtureMarkup({pages: [
                {
                    pageNumber: 1,
                    widthPx: 900,
                },
                {
                    pageNumber: 2,
                    widthPx: 900,
                },
            ]}));
            expect(violationIds(await page.evaluate(() => globalThis.__evbCheckViewerInvariants())))
                .toEqual(['L1-fit-mode-scroll-range']);

            // L1 applicability: a wider visible page explains the range.
            await loadFixture(page, buildFixtureMarkup({
                pages: [
                    {pageNumber: 1},
                    {
                        pageNumber: 2,
                        widthPx: 900,
                    },
                ],
                toolbarPageNumber: 1,
            }));
            const mixedWidths = await page.evaluate(() => globalThis.__evbCheckViewerInvariants());
            expect(mixedWidths.violations).toEqual([]);
            expect(mixedWidths.skipped.map(skip => skip.id)).toContain('L1-fit-mode-scroll-range');

            // L1: fit-height in paged mode leaves a vertical range.
            await loadFixture(page, buildFixtureMarkup({
                continuousScroll: false,
                pages: [{
                    heightPx: 900,
                    pageNumber: 1,
                }],
                zoomMode: 'fit-height',
            }));
            expect(violationIds(await page.evaluate(() => globalThis.__evbCheckViewerInvariants())))
                .toEqual(['L1-fit-mode-scroll-range']);

            // A1 stateless: an overlay that is not on its page box.
            await loadFixture(page, buildFixtureMarkup({pages: [
                {
                    overlays: [{
                        annotationId: 'stray-1',
                        height: 0.05,
                        kind: 'shape',
                        width: 0.2,
                        x: 0.1,
                        y: 2,
                    }],
                    pageNumber: 1,
                },
                {pageNumber: 2},
            ]}));
            expect(violationIds(await page.evaluate(() => globalThis.__evbCheckViewerInvariants())))
                .toEqual(['A1-annotation-page-containment']);

            // A1 applicability: the app marked that shape as drawn past the edge.
            await loadFixture(page, buildFixtureMarkup({pages: [
                {
                    overlays: [{
                        annotationId: 'stray-1',
                        height: 0.05,
                        kind: 'shape',
                        outsidePage: true,
                        width: 0.2,
                        x: 0.1,
                        y: 2,
                    }],
                    pageNumber: 1,
                },
                {pageNumber: 2},
            ]}));
            const exempted = await page.evaluate(() => globalThis.__evbCheckViewerInvariants());
            expect(exempted.violations).toEqual([]);
            expect(exempted.skipped.map(skip => skip.id)).toContain('A1-annotation-page-containment');

            // A2 stateless: an open note window outside the visible pane.
            await loadFixture(page, buildFixtureMarkup({noteWindows: [{
                annotationId: 'note-1',
                leftPx: 60,
                pageNumber: 1,
                topPx: 600,
            }]}));
            expect(violationIds(await page.evaluate(() => globalThis.__evbCheckViewerInvariants())))
                .toEqual(['A2-note-window-inside-pane']);
        } finally {
            await browser.close();
        }
    }, BROWSER_TEST_TIMEOUT_MS);

    it('compares two settled observations for the stateful invariants', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                height: 700,
                width: 900,
            }});

            const overlayMarkup = buildFixtureMarkup({pages: [
                {
                    overlays: [{
                        annotationId: 'highlight-1',
                        height: 0.05,
                        kind: 'text-markup',
                        width: 0.3,
                        x: 0.1,
                        y: 0.2,
                    }],
                    pageNumber: 1,
                },
                {pageNumber: 2},
            ]});

            // A1 stateful, conforming: the page box changes with zoom but the
            // overlay's normalized position does not.
            await loadFixture(page, overlayMarkup);
            const zoomed = await page.evaluate(() => {
                globalThis.__evbCheckViewerInvariants();
                const container = document.querySelector<HTMLElement>('.page_container[data-page="1"]')!;
                container.style.width = '400px';
                container.style.height = '240px';
                return globalThis.__evbCheckViewerInvariants();
            });
            expect(zoomed.violations).toEqual([]);

            // A1 stateful, known bad: the overlay drifts inside its own page.
            await loadFixture(page, overlayMarkup);
            const drifted = await page.evaluate(() => {
                globalThis.__evbCheckViewerInvariants();
                const overlay = document.querySelector<HTMLElement>('[data-annotation-id="highlight-1"]')!;
                overlay.style.left = '20%';
                return globalThis.__evbCheckViewerInvariants();
            });
            expect(violationIds(drifted)).toEqual(['A1-annotation-normalized-drift']);

            const noteMarkup = buildFixtureMarkup({noteWindows: [{
                annotationId: 'note-1',
                leftPx: 60,
                pageNumber: 1,
                topPx: 150,
            }]});

            // A2 stateful, conforming: the window moves with its anchor page.
            await loadFixture(page, noteMarkup);
            const followed = await page.evaluate(() => {
                globalThis.__evbCheckViewerInvariants();
                document.querySelector<HTMLElement>('#pdf-viewer')!.scrollTop = 80;
                const noteWindow = document.querySelector<HTMLElement>('.note-window')!;
                noteWindow.style.top = '70px';
                return globalThis.__evbCheckViewerInvariants();
            });
            expect(followed.violations).toEqual([]);

            // A2 stateful, known bad: the page scrolled away and the window
            // stayed exactly where it was. This is the defect found by hand.
            await loadFixture(page, noteMarkup);
            const stranded = await page.evaluate(() => {
                globalThis.__evbCheckViewerInvariants();
                document.querySelector<HTMLElement>('#pdf-viewer')!.scrollTop = 80;
                return globalThis.__evbCheckViewerInvariants();
            });
            expect(violationIds(stranded)).toEqual(['A2-note-window-follows-anchor']);
        } finally {
            await browser.close();
        }
    }, BROWSER_TEST_TIMEOUT_MS);

    it('reports a renderer diagnostic only for a well-formed document and honours a reasoned allowlist', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                height: 700,
                width: 900,
            }});
            await loadFixture(page, buildFixtureMarkup());

            const undeclared = await page.evaluate(() => {
                globalThis.__evbCheckViewerInvariants();
                globalThis.__evbNotifyRendererDiagnosticNotice({
                    occurredAt: 1,
                    signature: 'Window error: TypeError: broken',
                    source: 'window',
                });
                return globalThis.__evbCheckViewerInvariants();
            });
            expect(undeclared.violations).toEqual([]);
            expect(undeclared.skipped.map(skip => skip.id)).toContain('C2-renderer-diagnostics-clean');

            const declared = await page.evaluate(() => (
                globalThis.__evbCheckViewerInvariants({documentWellFormed: true})
            ));
            expect(violationIds(declared)).toEqual(['C2-renderer-diagnostics-clean']);

            const allowlisted = await page.evaluate(() => {
                globalThis.__evbNotifyRendererDiagnosticNotice({
                    occurredAt: 2,
                    signature: 'Window error: TypeError: broken',
                    source: 'window',
                });
                return globalThis.__evbCheckViewerInvariants({
                    consoleAllowlist: [{
                        pattern: 'Window error: TypeError: broken',
                        reason: 'the fixture raises it on purpose to prove the allowlist is consulted',
                    }],
                    documentWellFormed: true,
                });
            });
            expect(allowlisted.violations).toEqual([]);
        } finally {
            await browser.close();
        }
    }, BROWSER_TEST_TIMEOUT_MS);
});
