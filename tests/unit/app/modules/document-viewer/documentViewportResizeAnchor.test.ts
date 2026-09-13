// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    captureDocumentViewportResizeAnchor,
    resolveDocumentViewportResizeAnchorPosition,
} from '@app/modules/document-viewer/chassis/documentViewportResizeAnchor';

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

describe('document viewport resize anchor', () => {
    it('retains the semantic page point across page and viewport geometry changes', () => {
        const viewport = document.createElement('div');
        const page = document.createElement('section');
        page.dataset.documentPageNumber = '4';
        viewport.append(page);
        document.body.append(viewport);
        Object.defineProperties(viewport, {
            scrollLeft: {
                value: 20,
                writable: true,
            },
            scrollTop: {
                value: 1_500,
                writable: true,
            },
        });
        viewport.getBoundingClientRect = () => rect(100, 80, 800, 600);
        page.getBoundingClientRect = () => rect(150, 130, 700, 500);

        const anchor = captureDocumentViewportResizeAnchor(viewport);
        expect(anchor).toMatchObject({
            pageNumber: 4,
            pageRatioX: 0.5,
            pageRatioY: 0.5,
        });

        viewport.scrollTop = 0;
        viewport.getBoundingClientRect = () => rect(100, 80, 500, 600);
        page.getBoundingClientRect = () => rect(125, 1_000, 450, 900);
        expect(resolveDocumentViewportResizeAnchorPosition(viewport, anchor!)).toEqual({
            left: 20,
            top: 1_070,
        });
    });

    it('chooses the nearest page when the viewport centre is in a page gap', () => {
        const viewport = document.createElement('div');
        document.body.append(viewport);
        viewport.getBoundingClientRect = () => rect(0, 0, 400, 400);
        const first = document.createElement('section');
        first.dataset.documentPageNumber = '1';
        first.getBoundingClientRect = () => rect(50, -300, 300, 350);
        const second = document.createElement('section');
        second.dataset.documentPageNumber = '2';
        second.getBoundingClientRect = () => rect(50, 230, 300, 350);
        viewport.append(first, second);

        expect(captureDocumentViewportResizeAnchor(viewport)?.pageNumber).toBe(2);
    });

    it('prefers the committed page when it is mounted but not nearest to centre', () => {
        const viewport = document.createElement('div');
        document.body.append(viewport);
        viewport.getBoundingClientRect = () => rect(0, 0, 400, 400);
        const first = document.createElement('section');
        first.dataset.documentPageNumber = '1';
        first.getBoundingClientRect = () => rect(50, -300, 300, 350);
        const second = document.createElement('section');
        second.dataset.documentPageNumber = '2';
        second.getBoundingClientRect = () => rect(50, 230, 300, 350);
        viewport.append(first, second);

        expect(captureDocumentViewportResizeAnchor(viewport, {preferredPageNumber: 1})?.pageNumber).toBe(1);
    });
});
