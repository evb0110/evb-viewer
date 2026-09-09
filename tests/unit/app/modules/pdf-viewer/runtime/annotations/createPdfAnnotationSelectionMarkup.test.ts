// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {createPdfAnnotationSelectionMarkup} from '@app/modules/pdf-viewer/runtime/annotations/createPdfAnnotationSelectionMarkup';

describe('createPdfAnnotationSelectionMarkup', () => {
    it('does not select, report a modification, or complete creation for an empty result', async () => {
        const selectCreated = vi.fn();
        const emitModified = vi.fn();
        const completeCreation = vi.fn();
        const onCreated = vi.fn();
        const create = createPdfAnnotationSelectionMarkup({
            resolveGeometry: async () => ({
                status: 'ready',
                pages: [],
            }),
            createHighlights: () => [],
            selectCreated,
            emitModified,
            completeCreation,
            onCreated,
            getActiveTool: () => 'highlight',
        });
        await expect(create({
            range: document.createRange(),
            tool: 'highlight',
            subtype: 'Highlight',
            style: {
                color: '#ffff00',
                opacity: 0.35,
            },
            withNote: false,
            requireActiveTool: false,
        })).resolves.toEqual({
            status: 'failed',
            reason: 'selection-not-in-text-layer',
        });
        expect(selectCreated).not.toHaveBeenCalled();
        expect(emitModified).not.toHaveBeenCalled();
        expect(completeCreation).not.toHaveBeenCalled();
        expect(onCreated).not.toHaveBeenCalled();
    });

});
