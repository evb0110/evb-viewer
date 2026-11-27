// @vitest-environment happy-dom

import {requirePageNumber} from '@contracts/pageNumbers';
import {describe, expect, it} from 'vitest';
import {isPdfInitialVisualCanvasReady} from '@app/modules/pdf-viewer/runtime/lifecycle/isPdfInitialVisualCanvasReady';

function rect(left: number, top: number, width: number, height: number): DOMRect {
    return {
        bottom: top + height,
        height,
        left,
        right: left + width,
        top,
        width,
        x: left,
        y: top,
        toJSON: () => ({}),
    };
}

function createSurface(canvasRect = rect(20, 20, 200, 300)) {
    const container = document.createElement('div');
    container.innerHTML = '<div class="page_container" data-page="2"><div class="page_canvas"><canvas></canvas></div></div>';
    document.body.append(container);
    container.getBoundingClientRect = () => rect(0, 0, 800, 600);
    const canvas = container.querySelector('canvas')!;
    canvas.getBoundingClientRect = () => canvasRect;
    return {
        canvas,
        container,
    };
}

describe('isPdfInitialVisualCanvasReady', () => {
    it('accepts the connected, painted current-page canvas when it intersects the viewport', () => {
        const {container} = createSurface();

        expect(isPdfInitialVisualCanvasReady(container, requirePageNumber(2), 2)).toBe(true);
    });

    it('rejects a non-current, unpainted, or disconnected canvas', () => {
        const {canvas, container} = createSurface();

        expect(isPdfInitialVisualCanvasReady(container, requirePageNumber(2), 1)).toBe(false);
        canvas.width = 0;
        expect(isPdfInitialVisualCanvasReady(container, requirePageNumber(2), 2)).toBe(false);
        canvas.width = 300;
        container.remove();
        expect(isPdfInitialVisualCanvasReady(container, requirePageNumber(2), 2)).toBe(false);
    });

    it('rejects canvases outside the viewport on either axis', () => {
        expect(isPdfInitialVisualCanvasReady(createSurface(rect(0, 601, 200, 300)).container, requirePageNumber(2), 2)).toBe(false);
        expect(isPdfInitialVisualCanvasReady(createSurface(rect(801, 0, 200, 300)).container, requirePageNumber(2), 2)).toBe(false);
    });
});
