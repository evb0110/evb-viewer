import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { cast } from '@tests/helpers/cast';
import { usePdfRendererTextLayerController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererTextLayerController';
import type {
    IActivePdfTextLayerTask,
    TPdfTextLayerCleanup,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';

function createHarness() {
    const container = document.createElement('div');
    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'text-layer';
    container.append(textLayerDiv);

    const clearedSelectionPages: number[] = [];
    const textLayerCleanupFns = new Map<number, TPdfTextLayerCleanup>();
    const teardownInteraction = vi.fn();
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
        if (renderedContentKey === harness.contentKey) {
            return;
        }
        onBeforeRebuild?.();
        renderedContentKey = harness.contentKey;
    });

    const textLayerRenderer = cast<Parameters<typeof usePdfRendererTextLayerController>[0]['textLayerRenderer']>({
        renderTextLayer,
        setupTextLayerInteraction: vi.fn(() => teardownInteraction),
        applyPageSearchHighlights: vi.fn(),
        cleanupTextLayerDom: vi.fn(),
    });

    const renderTextLayerForPage = usePdfRendererTextLayerController({
        textLayerRenderer,
        activeTextLayerAbortControllers: new Map<number, IActivePdfTextLayerTask>(),
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
            1,
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
        textLayerCleanupFns,
    };

    return harness;
}

describe('usePdfRendererTextLayerController', () => {
    it('keeps the selection and the mounted interaction across a scale step', async () => {
        const harness = createHarness();

        expect(await harness.renderAtScale(1)).toBe(true);
        const interactionAfterFirstRender = harness.textLayerCleanupFns.get(1);
        expect(await harness.renderAtScale(2)).toBe(true);

        expect(harness.clearedSelectionPages).toEqual([1]);
        expect(harness.teardownInteraction).not.toHaveBeenCalled();
        expect(harness.textLayerCleanupFns.get(1)).toBe(interactionAfterFirstRender);
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
        expect(harness.textLayerCleanupFns.get(1)).toBeTypeOf('function');
    });
});
