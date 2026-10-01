import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
// @vitest-environment happy-dom

import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { cast } from '@tests/helpers/cast';
import { usePdfRendererTextLayerController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererTextLayerController';
import { usePdfTextLayerRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer';
import type {
    IActivePdfTextLayerTask,
    TPdfTextLayerCleanup,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';

const pdfjsStructure = vi.hoisted(() => ({holds: [] as Array<{
    resolve: () => void;
    promise: Promise<void>;
}>}));

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
    createPdfjsStructTreeLayer: async () => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => {
            resolve = done;
        });
        pdfjsStructure.holds.push({
            resolve,
            promise,
        });
        return {
            render: () => promise.then(() => null),
            updateTextLayer() {},
        };
    },
}));

function createHarness() {
    const container = document.createElement('div');
    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'text-layer';
    container.append(textLayerDiv);

    const clearedSelectionPages: number[] = [];
    const textLayerCleanupFns = new Map<TPageNumber, TPdfTextLayerCleanup>();
    const teardownInteraction = vi.fn();
    let renderTextLayerError: Error | null = null;
    let pendingTextLayer: Promise<void> | null = null;
    // Mirrors the renderer contract: the text layer is torn down and rebuilt
    // only when its content key changes, and relayouted otherwise.
    let renderedContentKey: string | null = null;
    const renderTextLayer = vi.fn(async (
        _pdfPage: IPdfPage,
        _textLayerDiv: HTMLElement,
        _viewport: unknown,
        _scale: number,
        _userUnit: number,
        _totalScaleFactor: number,
        _signal?: AbortSignal,
        onBeforeRebuild?: () => void,
    ) => {
        if (renderTextLayerError) {
            const error = renderTextLayerError;
            renderTextLayerError = null;
            throw error;
        }
        if (pendingTextLayer) {
            await pendingTextLayer;
            pendingTextLayer = null;
        }
        if (renderedContentKey === harness.contentKey) {
            return;
        }
        onBeforeRebuild?.();
        renderedContentKey = harness.contentKey;
    });

    const setupTextLayerInteraction = vi.fn(() => teardownInteraction);
    const cleanupTextLayerDom = vi.fn();
    const textLayerRenderer = cast<Parameters<typeof usePdfRendererTextLayerController>[0]['textLayerRenderer']>({
        renderTextLayer,
        setupTextLayerInteraction,
        applyPageSearchHighlights: vi.fn(),
        cleanupTextLayerDom,
    });

    const renderTextLayerForPage = usePdfRendererTextLayerController({
        textLayerRenderer,
        activeTextLayerAbortControllers: new Map<TPageNumber, IActivePdfTextLayerTask>(),
        textLayerCleanupFns,
        getRenderVersion: () => 1,
        cleanupTextLayer: (pageNumber) => {
            textLayerCleanupFns.get(pageNumber)?.();
            textLayerCleanupFns.delete(pageNumber);
        },
        cleanupPageIfCurrentRender: vi.fn(),
        cancelActiveTextLayerRender: vi.fn(),
        cancelActiveTextLayerRenderIfCurrent: vi.fn(),
        clearSelectionBeforePageLayerTeardown: (pageNumber) => {
            clearedSelectionPages.push(pageNumber);
            return true;
        },
        logNonCriticalStageError: vi.fn(),
    });

    const harness = {
        clearedSelectionPages,
        contentKey: 'revision-1',
        renderAtScale: (scale: number) => renderTextLayerForPage(
            requirePageNumber(1),
            1,
            1,
            {
                container,
                pdfPage: cast<IPdfPage>({pageNumber: 1}),
                renderResult: cast<Parameters<typeof renderTextLayerForPage>[3]['renderResult']>({
                    canvas: document.createElement('canvas'),
                    viewport: {
                        width: 100 * scale,
                        height: 100 * scale,
                    },
                    scaleX: scale,
                    scaleY: scale,
                    rawDims: {
                        pageWidth: 100,
                        pageHeight: 100,
                    },
                    userUnit: 1,
                    totalScaleFactor: scale,
                }),
                textLayerDiv,
            },
            scale,
            () => true,
        ),
        teardownInteraction,
        setupTextLayerInteraction,
        cleanupTextLayerDom,
        failNextTextLayer: (error: Error) => {
            renderTextLayerError = error;
        },
        holdNextTextLayer: () => {
            pendingTextLayer = new Promise<void>(() => {});
        },
        textLayerCleanupFns,
    };

    return harness;
}

describe('usePdfRendererTextLayerController', () => {
    it('keeps the selection and the mounted interaction across a scale step', async () => {
        const harness = createHarness();

        expect(await harness.renderAtScale(1)).toBe(true);
        const interactionAfterFirstRender = harness.textLayerCleanupFns.get(requirePageNumber(1));
        expect(await harness.renderAtScale(2)).toBe(true);

        expect(harness.clearedSelectionPages).toEqual([1]);
        expect(harness.teardownInteraction).not.toHaveBeenCalled();
        expect(harness.textLayerCleanupFns.get(requirePageNumber(1))).toBe(interactionAfterFirstRender);
    });

    it('tears the selection and the interaction down when the layer content is rebuilt', async () => {
        const harness = createHarness();

        expect(await harness.renderAtScale(1)).toBe(true);
        harness.contentKey = 'revision-2';
        expect(await harness.renderAtScale(1)).toBe(true);

        expect(harness.clearedSelectionPages).toEqual([
            1,
            1,
        ]);
        expect(harness.teardownInteraction).toHaveBeenCalledTimes(1);
        expect(harness.textLayerCleanupFns.get(requirePageNumber(1))).toBeTypeOf('function');
    });

    it('keeps the committed canvas path retryable after text extraction fails', async () => {
        const harness = createHarness();

        harness.failNextTextLayer(new Error('text extraction failed'));
        expect(await harness.renderAtScale(1)).toBe(false);
        expect(harness.setupTextLayerInteraction).not.toHaveBeenCalled();
        expect(harness.cleanupTextLayerDom).toHaveBeenCalledOnce();

        expect(await harness.renderAtScale(1)).toBe(true);
        expect(harness.setupTextLayerInteraction).toHaveBeenCalledOnce();
    });

    it('does not claim text readiness when interaction setup fails', async () => {
        const harness = createHarness();
        harness.setupTextLayerInteraction.mockImplementationOnce(() => {
            throw new Error('interaction setup failed');
        });

        expect(await harness.renderAtScale(1)).toBe(false);
        expect(harness.cleanupTextLayerDom).toHaveBeenCalledOnce();
    });

    it('cleans the text DOM and stays retryable when the text stage times out', async () => {
        vi.useFakeTimers();
        const harness = createHarness();
        try {
            harness.holdNextTextLayer();
            const render = harness.renderAtScale(1);
            await vi.advanceTimersByTimeAsync(15_000);

            await expect(render).resolves.toBe(false);
            expect(harness.cleanupTextLayerDom).toHaveBeenCalledOnce();
            expect(harness.setupTextLayerInteraction).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps the text of a newer render when it cancels one that waits on structure', async () => {
        pdfjsStructure.holds.length = 0;
        const container = document.createElement('div');
        container.className = 'page_container';
        container.dataset.page = '1';
        const textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'text-layer';
        container.append(textLayerDiv);
        document.body.append(container);
        const activeTextLayerAbortControllers = new Map<TPageNumber, IActivePdfTextLayerTask>();
        const textLayerRenderer = usePdfTextLayerRenderer({
            searchPageMatches: new Map(),
            currentSearchMatch: null,
            workingCopyPath: null,
            documentRevisionToken: null,
            effectiveScale: 1,
            viewportWritePort: cast<Parameters<typeof usePdfTextLayerRenderer>[0]['viewportWritePort']>({}),
        });
        const cancelActiveTextLayerRender = (pageNumber: TPageNumber) => {
            const active = activeTextLayerAbortControllers.get(pageNumber);
            activeTextLayerAbortControllers.delete(pageNumber);
            active?.controller.abort();
        };
        const renderTextLayerForPage = usePdfRendererTextLayerController({
            textLayerRenderer,
            activeTextLayerAbortControllers,
            textLayerCleanupFns: new Map<TPageNumber, TPdfTextLayerCleanup>(),
            getRenderVersion: () => 1,
            cleanupTextLayer: vi.fn(),
            cleanupPageIfCurrentRender: vi.fn(),
            cancelActiveTextLayerRender,
            cancelActiveTextLayerRenderIfCurrent: vi.fn(),
            clearSelectionBeforePageLayerTeardown: () => true,
            logNonCriticalStageError: vi.fn(),
        });
        const pdfPage = cast<IPdfPage>({
            pageNumber: 1,
            getTextContent: async () => ({
                items: [{str: 'Page 1 keeps its line'}],
                styles: {},
            }),
            getStructTree: async () => null,
        });
        const render = (requestId: number, scale: number) => renderTextLayerForPage(
            requirePageNumber(1),
            1,
            requestId,
            {
                container,
                pdfPage,
                renderResult: cast<Parameters<typeof renderTextLayerForPage>[3]['renderResult']>({
                    canvas: document.createElement('canvas'),
                    viewport: {
                        width: 100 * scale,
                        height: 100 * scale,
                        rawDims: {},
                    },
                    scaleX: scale,
                    scaleY: scale,
                    rawDims: {
                        pageWidth: 100,
                        pageHeight: 100,
                    },
                    userUnit: 1,
                    totalScaleFactor: scale,
                }),
                textLayerDiv,
                preserveCanvasOnStale: true,
            },
            scale,
            () => true,
        );
        try {
            const first = render(1, 1);
            await vi.waitFor(() => expect(pdfjsStructure.holds).toHaveLength(1));

            // A zoom draws the page again while the first text layer still
            // waits on its structure tree.
            const second = render(2, 2);
            await vi.waitFor(() => expect(pdfjsStructure.holds).toHaveLength(2));
            pdfjsStructure.holds[1]!.resolve();

            await expect(first).resolves.toBe(false);
            await expect(second).resolves.toBe(true);
            expect(textLayerDiv.textContent).toBe('Page 1 keeps its line');
            expect(textLayerDiv.dataset.pdfTextLayerReady).toBe('true');
        } finally {
            pdfjsStructure.holds.forEach(hold => hold.resolve());
            container.remove();
        }
    });
});
