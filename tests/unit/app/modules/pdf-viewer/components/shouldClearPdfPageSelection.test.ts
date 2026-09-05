// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
} from 'vitest';
import { shouldClearPdfPageSelection } from '@app/modules/pdf-viewer/engine/annotations/shouldClearPdfPageSelection';

describe('pdf page selection policy', () => {
    it('keeps captured annotation clicks inside the editor layer', () => {
        const layer = document.createElement('div');
        layer.className = 'pdf-annotation-editor-layer';
        const child = document.createElement('div');
        layer.append(child);

        expect(shouldClearPdfPageSelection(layer)).toBe(false);
        expect(shouldClearPdfPageSelection(child)).toBe(false);
    });

    it('clears selection for page background clicks', () => {
        const page = document.createElement('div');
        const annotation = document.createElement('div');
        annotation.dataset.annotationId = 'annotation';
        page.append(annotation);

        expect(shouldClearPdfPageSelection(page)).toBe(true);
        expect(shouldClearPdfPageSelection(annotation)).toBe(false);
        expect(shouldClearPdfPageSelection(null)).toBe(true);
    });
});
