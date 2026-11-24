import type {
    IPdfDocumentPageLease,
    IPdfPage,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
// @vitest-environment happy-dom
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import { ref } from 'vue';
import type { MaybeRefOrGetter } from 'vue';

import {
    requirePageIndex,
    requirePageNumber,
} from '@contracts/pageNumbers';
import type { IPdfSearchMatch } from '@app/types/pdfUi';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { cast } from '@tests/helpers/cast';
import { usePdfRendererTextLayerController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererTextLayerController';
import { usePdfTextLayerRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer';
import {
    createPdfViewportScrollActivityTracker,
    type IPdfViewportScrollActivity,
} from '@app/modules/pdf-viewer/runtime/composables/pdf/pdfViewportScrollActivity';

const pdfjsStructure = vi.hoisted(() => ({
    holds: [] as Array<{
        resolve: () => void;
        promise: Promise<void>;
    }>,
    renderStructElement: false,
}));

// PDF.js layers need a real worker and font metrics; these stand-ins mount
// each text item as a span and hold the optional structure tree until the
// test releases it.
vi.mock('@app/services/pdfjs/pdfViewerFacade', () => ({
    createPdfjsTextLayer: (options: {
        textContentSource: {items: Array<{str: string}>};
        container: HTMLElement;
    }) => {
        const textDivs: HTMLElement[] = [];
        return {
            textDivs,
            textContentItemsStr: options.textContentSource.items.map(item => item.str),
            async render() {
                for (const item of options.textContentSource.items) {
                    const span = document.createElement('span');
                    span.textContent = item.str;
                    textDivs.push(span);
                    options.container.append(span);
                }
            },
            update() {},
            cancel() {},
        };
    },
    createPdfjsStructTreeLayer: async (options: {page: {pageNumber: number}}) => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => {
            resolve = done;
        });
        pdfjsStructure.holds.push({
            resolve,
            promise,
        });
        return {
            render: () => promise.then(() => {
                if (!pdfjsStructure.renderStructElement) {
                    return null;
                }
                const tree = document.createElement('span');
                tree.className = 'structTree';
                tree.dataset.structPage = String(options.page.pageNumber);
                return tree;
            }),
            updateTextLayer() {},
        };
    },
}));

const STAGE_FAILURE_RECEIPT = cast<FailureReceipt>({errorId: 'text-layer-receipt'});

function createPage(text: string, withStructure = false, pageNumber = 1) {
    const getTextContent = vi.fn(async () => ({
        items: [{str: text}],
        styles: {},
    }));
    return cast<IPdfPage>({
        pageNumber,
        getTextContent,
        ...(withStructure ? {getStructTree: vi.fn(async () => null)} : {}),
    });
}

function createHarness(options: {
    scrollActivity?: IPdfViewportScrollActivity;
    currentSearchMatch?: MaybeRefOrGetter<IPdfSearchMatch | null>;
    viewportContainer?: MaybeRefOrGetter<HTMLElement | null>;
    leasePage?: (pageNumber: number) => Promise<IPdfDocumentPageLease>;
} = {}) {
    const viewport = document.createElement('div');
    viewport.className = 'pdfViewer';
    const container = document.createElement('div');
    container.className = 'page_container';
    container.dataset.page = '1';
    const renderLayer = document.createElement('div');
    renderLayer.className = 'page_canvas__render-layer';
    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'text-layer';
    container.append(renderLayer, textLayerDiv);
    viewport.append(container);
    document.body.append(viewport);
    const textLayerRenderer = usePdfTextLayerRenderer({
        searchPageMatches: new Map(),
        currentSearchMatch: options.currentSearchMatch ?? null,
        workingCopyPath: null,
        documentRevisionToken: null,
        ...(options.viewportContainer !== undefined ? {viewportContainer: options.viewportContainer} : {}),
        ...(options.leasePage ? {leasePage: options.leasePage} : {}),
        ...(options.scrollActivity ? {scrollActivity: options.scrollActivity} : {}),
    });
    const renderTextLayer = vi.spyOn(textLayerRenderer, 'renderTextLayer');
    const renderTextLayerForPage = usePdfRendererTextLayerController({
        textLayerRenderer,
        logNonCriticalStageError: vi.fn(() => STAGE_FAILURE_RECEIPT),
    });
    // The page's layer owner: a newer render replaces and aborts the older one.
    let owner: AbortController | null = null;
    const render = (
        pdfPage: IPdfPage,
        scale: number,
        publish: () => boolean = vi.fn(() => true),
        targetDiv: HTMLDivElement = textLayerDiv,
    ) => {
        const controller = new AbortController();
        const previous = owner;
        owner = controller;
        previous?.abort();
        return renderTextLayerForPage(
            requirePageNumber(pdfPage.pageNumber),
            {
                pdfPage,
                renderResult: cast<Parameters<typeof renderTextLayerForPage>[1]['renderResult']>({
                    viewport: {
                        width: 100 * scale,
                        height: 100 * scale,
                        rawDims: {},
                    },
                }),
                textLayerDiv: targetDiv,
            },
            controller.signal,
            () => owner === controller,
            publish,
        );
    };
    const abortCurrent = () => {
        owner?.abort();
        owner = null;
    };
    const selectText = () => {
        const range = document.createRange();
        range.selectNodeContents(textLayerDiv.querySelector('span')!);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
    };
    return {
        viewport,
        container,
        renderLayer,
        textLayerDiv,
        textLayerRenderer,
        render,
        abortCurrent,
        renderTextLayer,
        selectText,
        dispose: () => {
            window.getSelection()?.removeAllRanges();
            textLayerRenderer.cleanupTextLayerDom(textLayerDiv);
            viewport.remove();
        },
    };
}

describe('usePdfRendererTextLayerController', () => {
    it('keeps the mounted spans, their selection and its sentinel across a scale step', async () => {
        const harness = createHarness();
        const page = createPage('Scale keeps this line');
        try {
            expect(await harness.render(page, 1)).toBe(true);
            const span = harness.textLayerDiv.querySelector('span');
            harness.selectText();

            expect(await harness.render(page, 2)).toBe(true);

            expect(harness.textLayerDiv.querySelector('span')).toBe(span);
            expect(window.getSelection()?.toString()).toBe('Scale keeps this line');
            expect(harness.textLayerDiv.querySelectorAll('.end-of-content')).toHaveLength(1);
        } finally {
            harness.dispose();
        }
    });

    it('rebuilds the spans for new content and ends a selection on the old ones', async () => {
        const harness = createHarness();
        try {
            await harness.render(createPage('First revision'), 1);
            harness.selectText();

            expect(await harness.render(createPage('Second revision'), 1)).toBe(true);

            expect(harness.textLayerDiv.textContent).toBe('Second revision');
            expect(window.getSelection()?.toString()).toBe('');
            expect(harness.textLayerDiv.querySelectorAll('.end-of-content')).toHaveLength(1);
        } finally {
            harness.dispose();
        }
    });

    it('publishes the canvas and reports a text failure, then renders the layer when asked again', async () => {
        const harness = createHarness();
        const page = createPage('Readable after Retry');
        try {
            harness.renderTextLayer.mockRejectedValueOnce(new Error('text extraction failed'));
            const publish = vi.fn(() => true);

            expect(await harness.render(page, 1, publish)).toMatchObject({
                failure: STAGE_FAILURE_RECEIPT,
                error: expect.objectContaining({message: 'text extraction failed'}),
            });
            expect(publish).toHaveBeenCalledOnce();

            expect(await harness.render(page, 1)).toBe(true);
            expect(harness.textLayerDiv.textContent).toBe('Readable after Retry');
        } finally {
            harness.dispose();
        }
    });

    it('clears a text layer that times out and reports the stage', async () => {
        vi.useFakeTimers();
        const harness = createHarness();
        try {
            harness.renderTextLayer.mockImplementationOnce(async (_page, textLayerDiv) => {
                textLayerDiv.append(document.createElement('span'));
                await new Promise<void>(() => {});
            });
            const render = harness.render(createPage('Never drawn'), 1);
            await vi.advanceTimersByTimeAsync(15_000);

            // A receipt lets the page offer Retry for its text.
            await expect(render).resolves.toMatchObject({failure: STAGE_FAILURE_RECEIPT});
        } finally {
            vi.useRealTimers();
            harness.dispose();
        }
    });

    it('keeps the text of a newer render when it cancels one that waits on structure', async () => {
        pdfjsStructure.holds.length = 0;
        const harness = createHarness();
        const page = createPage('Page 1 keeps its line', true);
        try {
            const first = harness.render(page, 1);
            await vi.waitFor(() => expect(pdfjsStructure.holds).toHaveLength(1));

            // A zoom draws the page again while the first text layer still
            // waits on its structure tree.
            const second = harness.render(page, 2);
            await vi.waitFor(() => expect(pdfjsStructure.holds).toHaveLength(2));
            pdfjsStructure.holds[1]!.resolve();

            await expect(first).resolves.toBe(false);
            await expect(second).resolves.toBe(true);
            expect(harness.textLayerDiv.textContent).toBe('Page 1 keeps its line');
        } finally {
            pdfjsStructure.holds.forEach(hold => hold.resolve());
            harness.dispose();
        }
    });

    it('defers text-layer and getStructTree hydration during active scroll and hydrates cleanly once settled', async () => {
        vi.useFakeTimers();
        pdfjsStructure.holds.length = 0;
        pdfjsStructure.renderStructElement = true;
        const scrollActivity = createPdfViewportScrollActivityTracker({settleDelayMs: 120});
        const harness = createHarness({scrollActivity});
        const page = createPage('Settled scroll line', true);
        try {
            scrollActivity.markMotion(harness.viewport);
            const pending = harness.render(page, 1);

            await Promise.resolve();
            expect(page.getTextContent).not.toHaveBeenCalled();
            expect(pdfjsStructure.holds).toHaveLength(0);

            // Another scroll tick extends the active window before settling.
            await vi.advanceTimersByTimeAsync(80);
            scrollActivity.markMotion(harness.viewport);
            await vi.advanceTimersByTimeAsync(80);
            expect(page.getTextContent).not.toHaveBeenCalled();
            expect(pdfjsStructure.holds).toHaveLength(0);

            // Once scroll settles, text extraction and structTree hydration run.
            await vi.advanceTimersByTimeAsync(40);
            expect(page.getTextContent).toHaveBeenCalledOnce();
            await vi.waitFor(() => expect(pdfjsStructure.holds).toHaveLength(1));
            pdfjsStructure.holds[0]!.resolve();

            await expect(pending).resolves.toBe(true);
            expect(harness.textLayerDiv.textContent).toBe('Settled scroll line');
            expect(harness.renderLayer.querySelector('.structTree')?.getAttribute('data-struct-page')).toBe('1');
        } finally {
            pdfjsStructure.renderStructElement = false;
            pdfjsStructure.holds.forEach(hold => hold.resolve());
            scrollActivity.reset();
            vi.useRealTimers();
            harness.dispose();
        }
    });

    it('cancels deferred hydration for scrolled-past pages before touching PDF.js or the DOM', async () => {
        vi.useFakeTimers();
        pdfjsStructure.holds.length = 0;
        const scrollActivity = createPdfViewportScrollActivityTracker({settleDelayMs: 120});
        const harness = createHarness({scrollActivity});
        const page = createPage('Scrolled past line', true);
        try {
            scrollActivity.markMotion(harness.viewport);
            const pending = harness.render(page, 1);

            await Promise.resolve();
            expect(page.getTextContent).not.toHaveBeenCalled();

            // Page scrolls out of viewport and its hydration owner aborts.
            harness.abortCurrent();
            await expect(pending).resolves.toBe(false);

            await vi.advanceTimersByTimeAsync(200);
            expect(page.getTextContent).not.toHaveBeenCalled();
            expect(pdfjsStructure.holds).toHaveLength(0);
            expect(harness.textLayerDiv.textContent).toBe('');
            expect(harness.renderLayer.querySelector('.structTree')).toBeNull();
        } finally {
            scrollActivity.reset();
            vi.useRealTimers();
            harness.dispose();
        }
    });

    it('keeps search target text eager while deferring getStructTree until settled', async () => {
        vi.useFakeTimers();
        pdfjsStructure.holds.length = 0;
        pdfjsStructure.renderStructElement = true;
        const scrollActivity = createPdfViewportScrollActivityTracker({settleDelayMs: 120});
        const harness = createHarness({
            scrollActivity,
            currentSearchMatch: {
                pageIndex: requirePageIndex(0),
                matchIndex: 0,
                startOffset: 0,
                endOffset: 5,
            },
        });
        const page = createPage('Search target line', true);
        try {
            scrollActivity.markMotion(harness.viewport);
            const result = await harness.render(page, 1);

            expect(result).toBe(true);
            expect(harness.textLayerDiv.textContent).toBe('Search target line');
            // StructTree stays deferred while scrolling.
            expect(pdfjsStructure.holds).toHaveLength(0);

            // Once settled, deferred structTree attaches cleanly.
            await vi.advanceTimersByTimeAsync(120);
            await vi.waitFor(() => expect(pdfjsStructure.holds).toHaveLength(1));
            pdfjsStructure.holds[0]!.resolve();
            await vi.waitFor(() => expect(
                harness.renderLayer.querySelector('.structTree')?.getAttribute('data-struct-page'),
            ).toBe('1'));
        } finally {
            pdfjsStructure.renderStructElement = false;
            pdfjsStructure.holds.forEach(hold => hold.resolve());
            scrollActivity.reset();
            vi.useRealTimers();
            harness.dispose();
        }
    });

    it('never mutates an evicted, reused, or rebuilt page container from stale deferred structTree hydration', async () => {
        vi.useFakeTimers();
        pdfjsStructure.holds.length = 0;
        pdfjsStructure.renderStructElement = true;
        const scrollActivity = createPdfViewportScrollActivityTracker({settleDelayMs: 120});
        const harness = createHarness({scrollActivity});
        try {
            // Case 1: Detached commit (canvas mount) defers structTree, then container is reused for page 2.
            const stagedHost = document.createElement('div');
            stagedHost.className = 'page_container';
            stagedHost.dataset.page = '1';
            const incomingText = document.createElement('div');
            incomingText.className = 'text-layer';
            stagedHost.append(incomingText);

            scrollActivity.markMotion(harness.viewport);
            const page1 = createPage('Page 1 text', true, 1);
            await expect(harness.render(page1, 1, () => {
                harness.textLayerDiv.replaceWith(incomingText);
                return true;
            }, incomingText)).resolves.toBe(true);
            expect(incomingText.isConnected).toBe(true);
            expect(pdfjsStructure.holds).toHaveLength(0);

            // Scroll settles -> deferred structTree starts in flight.
            await vi.advanceTimersByTimeAsync(120);
            await vi.waitFor(() => expect(pdfjsStructure.holds).toHaveLength(1));

            // Before structTree resolves, container is reused for page 2.
            harness.container.dataset.page = '2';
            pdfjsStructure.holds[0]!.resolve();
            await Promise.resolve();
            await Promise.resolve();
            expect(harness.renderLayer.querySelector('.structTree')).toBeNull();

            // Case 2: Rebuilt/cleaned up container before settle aborts deferred structTree cleanly.
            harness.container.dataset.page = '1';
            scrollActivity.markMotion(harness.viewport);
            await expect(harness.render(page1, 1, () => true, incomingText)).resolves.toBe(true);
            harness.textLayerRenderer.cleanupTextLayerDom(incomingText);
            await vi.advanceTimersByTimeAsync(120);
            expect(pdfjsStructure.holds).toHaveLength(1);
            expect(harness.renderLayer.querySelector('.structTree')).toBeNull();
        } finally {
            pdfjsStructure.renderStructElement = false;
            pdfjsStructure.holds.forEach(hold => hold.resolve());
            scrollActivity.reset();
            vi.useRealTimers();
            harness.dispose();
        }
    });

    it('acquires a short-lived page lease for deferred getStructTree and skips evicted proxies', async () => {
        vi.useFakeTimers();
        pdfjsStructure.holds.length = 0;
        pdfjsStructure.renderStructElement = true;
        const scrollActivity = createPdfViewportScrollActivityTracker({settleDelayMs: 120});
        const page1 = createPage('Leased page 1', true, 1);
        const releaseFirst = vi.fn();
        const releaseSecond = vi.fn();
        const leasePage = vi.fn()
            .mockResolvedValueOnce({
                page: page1,
                release: releaseFirst,
            })
            .mockResolvedValueOnce({
                page: createPage('Replacement proxy', true, 1),
                release: releaseSecond,
            });
        const harness = createHarness({
            scrollActivity,
            leasePage,
            currentSearchMatch: {
                pageIndex: requirePageIndex(0),
                matchIndex: 0,
                startOffset: 0,
                endOffset: 5,
            },
        });
        try {
            scrollActivity.markMotion(harness.viewport);
            await expect(harness.render(page1, 1)).resolves.toBe(true);
            expect(leasePage).not.toHaveBeenCalled();

            // Once scroll settles, deferred structTree acquires a fresh lease and releases it on finish.
            await vi.advanceTimersByTimeAsync(120);
            await vi.waitFor(() => expect(pdfjsStructure.holds).toHaveLength(1));
            expect(leasePage).toHaveBeenCalledTimes(1);
            expect(releaseFirst).not.toHaveBeenCalled();

            pdfjsStructure.holds[0]!.resolve();
            await vi.waitFor(() => expect(releaseFirst).toHaveBeenCalledOnce());
            expect(harness.renderLayer.querySelector('.structTree')?.getAttribute('data-struct-page')).toBe('1');

            // If the page proxy changed (evicted/reloaded) before settle, deferred structTree releases the lease and skips DOM mutation.
            harness.textLayerRenderer.cleanupTextLayerDom(harness.textLayerDiv);
            scrollActivity.markMotion(harness.viewport);
            await expect(harness.render(page1, 1)).resolves.toBe(true);
            await vi.advanceTimersByTimeAsync(120);
            await vi.waitFor(() => expect(releaseSecond).toHaveBeenCalledOnce());
            expect(pdfjsStructure.holds).toHaveLength(1);
            expect(harness.renderLayer.querySelector('.structTree')).toBeNull();
        } finally {
            pdfjsStructure.renderStructElement = false;
            pdfjsStructure.holds.forEach(hold => hold.resolve());
            scrollActivity.reset();
            vi.useRealTimers();
            harness.dispose();
        }
    });

    it('aborts deferred buildTextLayer without mutating DOM when container dataset.page is reused before settle', async () => {
        vi.useFakeTimers();
        const scrollActivity = createPdfViewportScrollActivityTracker({settleDelayMs: 120});
        const harness = createHarness({scrollActivity});
        const page1 = createPage('Stale page 1', false, 1);
        try {
            scrollActivity.markMotion(harness.viewport);
            const pending = harness.render(page1, 1);
            await Promise.resolve();

            // Container is reused for page 2 while page 1 is waiting to settle.
            harness.container.dataset.page = '2';
            await vi.advanceTimersByTimeAsync(120);

            await expect(pending).resolves.toBe(false);
            expect(page1.getTextContent).not.toHaveBeenCalled();
            expect(harness.textLayerDiv.textContent).toBe('');
            expect(harness.textLayerDiv.querySelectorAll('.end-of-content')).toHaveLength(0);
        } finally {
            scrollActivity.reset();
            vi.useRealTimers();
            harness.dispose();
        }
    });

    it('isolates detached canvas-commit structTree deferral to its owning split-view pane', async () => {
        vi.useFakeTimers();
        pdfjsStructure.holds.length = 0;
        pdfjsStructure.renderStructElement = true;
        const scrollActivity = createPdfViewportScrollActivityTracker({settleDelayMs: 120});
        const otherPane = document.createElement('div');
        otherPane.className = 'pdfViewer';
        document.body.append(otherPane);
        const ownPane = document.createElement('div');
        ownPane.className = 'pdfViewer';
        document.body.append(ownPane);
        const harness = createHarness({
            scrollActivity,
            viewportContainer: ownPane,
        });
        try {
            // Only the OTHER split pane is scrolling; ownPane is idle.
            scrollActivity.markMotion(otherPane);

            const stagedHost = document.createElement('div');
            stagedHost.className = 'page_container';
            stagedHost.dataset.page = '1';
            const stagedRenderLayer = document.createElement('div');
            stagedRenderLayer.className = 'page_canvas__render-layer';
            const incomingText = document.createElement('div');
            incomingText.className = 'text-layer';
            stagedHost.append(stagedRenderLayer, incomingText);

            const page1 = createPage('Idle pane text', true, 1);
            const renderPromise = harness.render(page1, 1, () => true, incomingText);

            // Because ownPane is idle, structTree runs inline instead of being deferred by otherPane's scroll.
            await vi.waitFor(() => expect(pdfjsStructure.holds).toHaveLength(1));
            pdfjsStructure.holds[0]!.resolve();
            await expect(renderPromise).resolves.toBe(true);
            expect(stagedRenderLayer.querySelector('.structTree')).not.toBeNull();
        } finally {
            pdfjsStructure.renderStructElement = false;
            pdfjsStructure.holds.forEach(hold => hold.resolve());
            scrollActivity.reset();
            vi.useRealTimers();
            otherPane.remove();
            ownPane.remove();
            harness.dispose();
        }
    });

    it('wakes an already-deferred text layer immediately when currentSearchMatch targets that page', async () => {
        vi.useFakeTimers();
        const scrollActivity = createPdfViewportScrollActivityTracker({settleDelayMs: 120});
        const currentSearchMatch = ref<IPdfSearchMatch | null>(null);
        const harness = createHarness({
            scrollActivity,
            currentSearchMatch,
            viewportContainer: () => harness.viewport,
        });
        const page1 = createPage('Woken search line', false, 1);
        try {
            scrollActivity.markMotion(harness.viewport);
            const pending = harness.render(page1, 1);
            await Promise.resolve();
            expect(page1.getTextContent).not.toHaveBeenCalled();

            // Search navigation targets page 1 while scroll settle timer has not elapsed.
            currentSearchMatch.value = {
                pageIndex: requirePageIndex(0),
                matchIndex: 0,
                startOffset: 0,
                endOffset: 5,
            };

            await expect(pending).resolves.toBe(true);
            expect(harness.textLayerDiv.textContent).toBe('Woken search line');
        } finally {
            scrollActivity.reset();
            vi.useRealTimers();
            harness.dispose();
        }
    });
});
