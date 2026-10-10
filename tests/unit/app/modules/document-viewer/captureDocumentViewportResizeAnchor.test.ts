// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
} from 'vitest';
import { captureDocumentViewportResizeAnchor } from '@app/modules/document-viewer/runtime/captureDocumentViewportResizeAnchor';

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
    it('uses the usable viewport centre excluding borders and scrollbar gutters', () => {
        const viewport = document.createElement('div');
        const page = document.createElement('section');
        page.dataset.documentPageNumber = '4';
        viewport.append(page);
        document.body.append(viewport);
        Object.defineProperties(viewport, {
            clientWidth: {value: 780},
            clientHeight: {value: 580},
            clientLeft: {value: 2},
            clientTop: {value: 2},
        });
        viewport.getBoundingClientRect = () => rect(100, 80, 800, 600);
        page.getBoundingClientRect = () => rect(102, 82, 780, 580);
        expect(captureDocumentViewportResizeAnchor(viewport)).toMatchObject({
            pageNumber: 4,
            pageRatioX: 0.5,
            pageRatioY: 0.5,
        });
        expect(captureDocumentViewportResizeAnchor(viewport, {viewportPoint: {
            x: 195,
            y: 435,
        }})).toMatchObject({
            pageRatioX: 0.25,
            pageRatioY: 0.75,
            viewportRatioX: 0.25,
            viewportRatioY: 0.75,
        });
    });

    it('chooses the nearest page when the viewport centre is in a page gap', () => {
        const viewport = document.createElement('div');
        Object.defineProperties(viewport, {
            clientWidth: {get: () => viewport.getBoundingClientRect().width},
            clientHeight: {get: () => viewport.getBoundingClientRect().height},
        });
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
});
