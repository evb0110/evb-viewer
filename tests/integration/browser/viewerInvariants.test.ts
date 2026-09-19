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
import type { IViewerBugReport } from '@app/modules/viewer-invariants/buildViewerBugReport';
import type { IViewerUserAction } from '@app/modules/viewer-invariants/viewerActionLog';
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
/** Below the editor pane, so the tab bar never covers the document viewport. */
const TAB_BAR_TOP_PX = TOOLBAR_HEIGHT_PX + VIEWPORT_HEIGHT_PX + 20;
/** A file name no identifier, class or role in the fixture can contain. */
const DISTINCTIVE_FILE_NAME = 'Zhukovsky-Memoirs-1917-private-draft.pdf';
const DISTINCTIVE_FILE_NAME_TOKEN = 'Zhukovsky';
const FIXTURE_APP_VERSION = '0.0.0-fixture';

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
    /** Renders a tab bar labelled the way `TabBar.vue` labels a real tab. */
    tabFileName?: string;
    toolbarPageLabel?: string;
    toolbarPageNumber?: number;
    toolbarTotalPages?: number;
    viewMode?: string;
    workspaceTabId?: string;
    zoomMode?: string;
}

/**
 * The tab bar as the app renders it: the open document's file name reaches the
 * DOM through the tab's `aria-label`, its tooltip `title`, and its own text.
 * The search field carries the name in a `placeholder` for the same reason.
 */
function renderTabBar(fileName: string) {
    return `<div class="tab-list" role="tablist" aria-label="Open documents" data-tab-list
    style="position:fixed;left:0;top:${String(TAB_BAR_TOP_PX)}px;height:${String(TOOLBAR_HEIGHT_PX)}px">
    <div class="tab is-active" data-tab-id="tab-1" role="tab" aria-label="${fileName}" title="${fileName}"
        style="display:inline-block;width:220px;height:100%">
        <span class="tab-label">${fileName}</span>
        <button type="button" class="tab-close" aria-label="Close tab"
            style="width:20px;height:20px"><span>x</span></button>
    </div>
    <input class="tab-search" type="search" placeholder="${fileName}" title="${fileName}"
        style="width:120px;height:20px">
</div>`;
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
        data-user-placement="0"
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
    <div class="workspace-host" data-workspace-active="true"
        data-workspace-tab-id="${options.workspaceTabId ?? 'tab-1'}" style="width:100%;height:100%">
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
${options.tabFileName ? renderTabBar(options.tabFileName) : ''}
</body></html>`;
}

declare global {
    /* The bundled entry installs these on the page. */
    var __evbBuildViewerBugReport: (appVersion: string) => IViewerBugReport;
    var __evbCheckViewerInvariants: (options?: IViewerInvariantOptions) => IViewerInvariantReport;
    var __evbDisposeViewerActionLog: () => void;
    var __evbInstallViewerActionLog: () => void;
    var __evbReadViewerUserActions: () => readonly IViewerUserAction[];
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

            // A2 one observation, known bad: with its anchor page on screen
            // the note window sits over the toolbar.
            await loadFixture(page, buildFixtureMarkup({noteWindows: [{
                annotationId: 'note-1',
                leftPx: 60,
                pageNumber: 1,
                topPx: 10,
            }]}));
            const overChrome = await page.evaluate(() => globalThis.__evbCheckViewerInvariants());
            expect(violationIds(overChrome)).toEqual(['A2-note-window-over-chrome']);
            expect(overChrome.unresolved).toEqual([]);

            // A2 one observation, known bad: the window is nowhere near the
            // pane it belongs to while that pane shows its anchor page.
            await loadFixture(page, buildFixtureMarkup({noteWindows: [{
                annotationId: 'note-1',
                leftPx: 60,
                pageNumber: 1,
                topPx: 600,
            }]}));
            expect(violationIds(await page.evaluate(() => globalThis.__evbCheckViewerInvariants())))
                .toEqual(['A2-note-window-over-chrome']);

            // A2 one observation, unresolved: the anchor page has left the
            // viewport. Behavior contract open question 3 has not decided
            // whether the window should hide, dock or stay, so this is
            // recorded and is not a violation.
            await loadFixture(page, buildFixtureMarkup({
                noteWindows: [{
                    annotationId: 'note-1',
                    leftPx: 60,
                    pageNumber: 1,
                    topPx: 10,
                }],
                pages: [
                    {pageNumber: 1},
                    {pageNumber: 2},
                    {pageNumber: 3},
                    {pageNumber: 4},
                ],
                toolbarPageNumber: 2,
            }));
            const anchorOffscreen = await page.evaluate(() => {
                document.querySelector<HTMLElement>('#pdf-viewer')!.scrollTop = 400;
                return globalThis.__evbCheckViewerInvariants();
            });
            expect(anchorOffscreen.violations).toEqual([]);
            expect(anchorOffscreen.unresolved.map(entry => entry.id)).toEqual(['A2-anchor-offscreen']);
            expect(anchorOffscreen.skipped.map(skip => skip.id)).toContain('A2-note-window-over-chrome');
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

            // A1 stateful applicability: a tab switch ends the sequence.
            // Annotation ids are unique inside one document, so the same id in
            // another workspace names a different annotation.
            await loadFixture(page, overlayMarkup);
            const switched = await page.evaluate(() => {
                globalThis.__evbCheckViewerInvariants();
                document.querySelector<HTMLElement>('.workspace-host')!.dataset.workspaceTabId = 'tab-2';
                document.querySelector<HTMLElement>('[data-annotation-id="highlight-1"]')!.style.left = '60%';
                return globalThis.__evbCheckViewerInvariants();
            });
            expect(switched.violations).toEqual([]);
            expect(switched.skipped.map(skip => skip.id)).toContain('A1-annotation-normalized-drift');

            // A1 stateful: a page the viewer virtualized away and mounted
            // again has to bring its annotation back to the same place, so the
            // memory outlives the unmount.
            await loadFixture(page, overlayMarkup);
            const remounted = await page.evaluate(() => {
                globalThis.__evbCheckViewerInvariants();
                const container = document.querySelector<HTMLElement>('.page_container[data-page="1"]')!;
                const track = container.parentElement!;
                container.remove();
                globalThis.__evbCheckViewerInvariants();
                track.prepend(container);
                container.querySelector<HTMLElement>('[data-annotation-id="highlight-1"]')!.style.left = '20%';
                return globalThis.__evbCheckViewerInvariants();
            });
            expect(violationIds(remounted)).toEqual(['A1-annotation-normalized-drift']);

            // A1 stateful applicability: the annotation went away while its
            // own page stayed on screen, so it was deleted rather than
            // virtualized and the next one to claim that id is not it.
            await loadFixture(page, overlayMarkup);
            const deleted = await page.evaluate(() => {
                globalThis.__evbCheckViewerInvariants();
                const overlay = document.querySelector<HTMLElement>('[data-annotation-id="highlight-1"]')!;
                const layer = overlay.parentElement!;
                overlay.remove();
                globalThis.__evbCheckViewerInvariants();
                overlay.style.left = '60%';
                layer.append(overlay);
                return globalThis.__evbCheckViewerInvariants();
            });
            expect(deleted.violations).toEqual([]);
            expect(deleted.skipped.map(skip => skip.id)).toContain('A1-annotation-normalized-drift');

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

            // A2 stateful applicability: the reader dragged the window between
            // the two observations, so the anchor delta is broken on purpose
            // and the viewer suspends following for the duration of the drag.
            await loadFixture(page, noteMarkup);
            const dragged = await page.evaluate(() => {
                globalThis.__evbCheckViewerInvariants();
                document.querySelector<HTMLElement>('#pdf-viewer')!.scrollTop = 80;
                const noteWindow = document.querySelector<HTMLElement>('.note-window')!;
                noteWindow.dataset.userPlacement = '3';
                return globalThis.__evbCheckViewerInvariants();
            });
            expect(dragged.violations).toEqual([]);
            expect(dragged.skipped.map(skip => skip.id)).toContain('A2-note-window-follows-anchor');

            // The placement sequence excuses one comparison, not the next one:
            // a window that stops following after the drag is still a defect.
            const strandedAfterDrag = await page.evaluate(() => {
                document.querySelector<HTMLElement>('#pdf-viewer')!.scrollTop = 160;
                return globalThis.__evbCheckViewerInvariants();
            });
            expect(violationIds(strandedAfterDrag)).toEqual(['A2-note-window-follows-anchor']);
        } finally {
            await browser.close();
        }
    }, BROWSER_TEST_TIMEOUT_MS);

    it('names the control a real click hit without carrying the document file name', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                height: 700,
                width: 900,
            }});
            await loadFixture(page, buildFixtureMarkup({
                tabFileName: DISTINCTIVE_FILE_NAME,
                toolbarPageNumber: 1,
            }));
            await page.evaluate(() => {
                globalThis.__evbInstallViewerActionLog();
            });

            await page.click('.tab-label');
            await page.click('.tab-close');
            await page.click('.tab-search');
            await page.keyboard.press('KeyK');

            const observed = await page.evaluate((appVersion: string) => {
                const actions = globalThis.__evbReadViewerUserActions();
                return {
                    actionsJson: JSON.stringify(actions),
                    reportJson: JSON.stringify(globalThis.__evbBuildViewerBugReport(appVersion)),
                    targets: actions.map(action => action.target),
                };
            }, FIXTURE_APP_VERSION);
            await page.evaluate(() => {
                globalThis.__evbDisposeViewerActionLog();
            });

            // The recorded identity still names what the user hit, so a
            // descriptor reduced to a constant fails here too.
            expect([...new Set(observed.targets)].sort()).toStrictEqual([
                'button',
                'input',
                'tab',
            ]);
            for (const serialized of [
                observed.actionsJson,
                observed.reportJson,
            ]) {
                expect(serialized).not.toContain(DISTINCTIVE_FILE_NAME);
                expect(serialized).not.toContain(DISTINCTIVE_FILE_NAME_TOKEN);
            }
        } finally {
            await browser.close();
        }
    }, BROWSER_TEST_TIMEOUT_MS);

    it('records a wheel gesture without measuring the viewer it is observing', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                height: 700,
                width: 900,
            }});
            await loadFixture(page, buildFixtureMarkup({
                toolbarPageNumber: 1,
                zoomMode: 'fit-width',
            }));

            // The external contract: recording what the user did costs no
            // layout. A recorder that measures perturbs the scroll and zoom
            // behavior the monitor reports on, so the counters are the proof.
            await page.evaluate(() => {
                const counters = {
                    computedStyle: 0,
                    rect: 0,
                };
                Reflect.set(globalThis, '__evbLayoutReadCounters', counters);
                const originalRect = Element.prototype.getBoundingClientRect;
                const originalStyle = window.getComputedStyle.bind(window);
                Element.prototype.getBoundingClientRect = function countedRect(this: Element) {
                    counters.rect += 1;
                    return originalRect.call(this);
                };
                window.getComputedStyle = (element: Element, pseudoElement?: string | null) => {
                    counters.computedStyle += 1;
                    return originalStyle(element, pseudoElement);
                };
                globalThis.__evbInstallViewerActionLog();
            });

            await page.mouse.move(300, 300);
            for (let step = 0; step < 10; step += 1) {
                await page.mouse.wheel(0, 120);
            }
            await page.keyboard.press('ArrowDown');

            const observed = await page.evaluate(() => {
                const actions = globalThis.__evbReadViewerUserActions();
                globalThis.__evbDisposeViewerActionLog();
                return {
                    counters: Reflect.get(globalThis, '__evbLayoutReadCounters') as {
                        computedStyle: number;
                        rect: number;
                    },
                    recordedTypes: [...new Set(actions.map(action => action.type))].sort(),
                    zoomModes: [...new Set(actions.map(action => action.viewerState.zoomMode))],
                };
            });

            expect(observed.recordedTypes).toStrictEqual([
                'keydown',
                'wheel',
            ]);
            expect(observed.zoomModes).toStrictEqual(['fit-width']);
            expect(observed.counters).toStrictEqual({
                computedStyle: 0,
                rect: 0,
            });
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
