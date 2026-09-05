import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {useAnnotationMutationService} from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationMutationService';
import {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {IAnnotationCommentSummary} from '@app/types/annotations';

const comment: IAnnotationCommentSummary = {
    id: 'note-1',
    stableKey: 'ann:0:note-1',
    appAnnotationId: 'note-1',
    annotationId: 'note-1',
    pageIndex: 0,
    pageNumber: 1,
    text: 'old',
    author: null,
    modifiedAt: null,
    color: null,
    uid: null,
    source: 'editor',
};

describe('useAnnotationMutationService', () => {
    it('updates canonical note text through the current mutation contract', () => {
        const setCanonicalNoteText = vi.fn();
        const service = useAnnotationMutationService({
            updateAnnotationComment: vi.fn(() => true),
            deleteAnnotationComment: vi.fn(async () => true),
            updateSelectedTextMarkupAnnotationColor: vi.fn(),
            updateSelectedTextMarkupAnnotationProperties: vi.fn(() => true),
            updateTextMarkupAnnotationColor: vi.fn(),
            markAnnotationLocallyDeleted: vi.fn(),
            restoreAnnotationLocally: vi.fn(),
            removeAnnotationFromInternalCache: vi.fn(),
            clearPendingMarkerMoves: vi.fn(),
            handleMarkerMove: vi.fn(() => true),
            findEditorForComment: vi.fn(() => null),
            markModified: vi.fn(),
            flushAnnotationCommentsForSave: vi.fn(),
            resolveCanonicalAnnotationId: () => asAnnotationId('note-1'),
            setCanonicalNoteText,
            deleteCanonicalAnnotation: vi.fn(),
            moveCanonicalAnchor: vi.fn(),
        });

        expect(service.updateComment({
            comment,
            text: 'new',
        }, {source: 'user'})).toBe(true);
        expect(setCanonicalNoteText).toHaveBeenCalledWith(asAnnotationId('note-1'), 'new');
        expect('effects' in service).toBe(false);
    });
});
