import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
// @vitest-environment happy-dom
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';

import { requirePageNumber } from '@contracts/pageNumbers';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { cast } from '@tests/helpers/cast';
import { usePdfRendererTextLayerController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererTextLayerController';
import { usePdfTextLayerRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer';

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

const STAGE_FAILURE_RECEIPT = cast<FailureReceipt>({errorId: 'text-layer-receipt'});

function createPage(text: string, withStructure = false) {
    return cast<IPdfPage>({
        pageNumber: 1,
        getTextContent: async () => ({
            items: [{str: text}],
            styles: {},
        }),
        ...(withStructure ? {getStructTree: async () => null} : {}),
    });
}

function createHarness() {
    const container = document.createElement('div');
    container.className = 'page_container';
    container.dataset.page = '1';
    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'text-layer';
    container.append(textLayerDiv);
    document.body.append(container);
    const textLayerRenderer = usePdfTextLayerRenderer({
        searchPageMatches: new Map(),
        currentSearchMatch: null,
        workingCopyPath: null,
        documentRevisionToken: null,
        viewportWritePort: cast<Parameters<typeof usePdfTextLayerRenderer>[0]['viewportWritePort']>({}),
    });
    const renderTextLayer = vi.spyOn(textLayerRenderer, 'renderTextLayer');
    const renderTextLayerForPage = usePdfRendererTextLayerController({
        textLayerRenderer,
        logNonCriticalStageError: vi.fn(() => STAGE_FAILURE_RECEIPT),
    });
    // The page's layer owner: a newer render replaces and aborts the older one.
    let owner: AbortController | null = null;
    const render = (pdfPage: IPdfPage, scale: number, publish = vi.fn(() => true)) => {
        const controller = new AbortController();
        const previous = owner;
        owner = controller;
        previous?.abort();
        return renderTextLayerForPage(
            requirePageNumber(1),
            {
                pdfPage,
                renderResult: cast<Parameters<typeof renderTextLayerForPage>[1]['renderResult']>({
                    viewport: {
                        width: 100 * scale,
                        height: 100 * scale,
                        rawDims: {},
                    },
                }),
                textLayerDiv,
            },
            controller.signal,
            () => owner === controller,
            publish,
        );
    };
    const selectText = () => {
        const range = document.createRange();
        range.selectNodeContents(textLayerDiv.querySelector('span')!);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
    };
    return {
        container,
        textLayerDiv,
        render,
        renderTextLayer,
        selectText,
        dispose: () => {
            window.getSelection()?.removeAllRanges();
            textLayerRenderer.cleanupTextLayerDom(textLayerDiv);
            container.remove();
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
});
