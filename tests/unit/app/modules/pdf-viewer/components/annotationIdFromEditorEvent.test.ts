// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {annotationIdFromEditorEvent} from '@app/modules/pdf-viewer/engine/annotations/annotationIdFromEditorEvent';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

describe('annotation editor SVG event ownership', () => {
    afterEach(() => {
        document.body.replaceChildren();
    });

    it('bubbles pointer and click events from an SVG rect to the editor layer without losing identity', () => {
        const viewer = document.createElement('div');
        const layer = document.createElement('div');
        const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
        const entity = document.createElementNS(SVG_NAMESPACE, 'g');
        const rect = document.createElementNS(SVG_NAMESPACE, 'rect');
        entity.dataset.annotationId = 'reopened-markup';
        entity.append(rect);
        svg.append(entity);
        layer.append(svg);
        viewer.append(layer);
        document.body.append(viewer);

        const received: string[] = [];
        layer.addEventListener('pointerdown', event => {
            received.push(`pointerdown:${annotationIdFromEditorEvent(event)}`);
        });
        layer.addEventListener('click', event => {
            received.push(`click:${annotationIdFromEditorEvent(event)}`);
        });
        viewer.addEventListener('mouseup', () => {
            received.push('viewer-mouseup');
        });

        rect.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
        }));
        rect.dispatchEvent(new MouseEvent('click', {bubbles: true}));
        rect.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));

        expect(received).toEqual([
            'pointerdown:reopened-markup',
            'click:reopened-markup',
            'viewer-mouseup',
        ]);
    });
});
