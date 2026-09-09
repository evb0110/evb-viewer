import {ref} from 'vue';
import {vi} from 'vitest';
import type {IAnnotationCommentSummary} from '@app/types/annotations';
import type {AnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {useAnnotationNoteWindows} from '@app/modules/workspace-shell/composables/useAnnotationNoteWindows';

export function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    const comment: IAnnotationCommentSummary = {
        id: 'note-1',
        stableKey: 'ann:0:note-1:0',
        pageIndex: 0,
        pageNumber: 1,
        text: 'Initial note',
        author: null,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId: 'ann-1',
        source: 'editor',
        hasNote: true,
        ...overrides,
    };
    return {
        ...comment,
        appAnnotationId: overrides.appAnnotationId ?? comment.stableKey,
    };
}

export function createHarness(comment = createComment()) {
    const deps = {
        annotationComments: ref<IAnnotationCommentSummary[]>([comment]),
        markAnnotationDirty: vi.fn(),
        updateAnnotationCommentInViewer: vi.fn<
            (annotationId: AnnotationId, text: string) => boolean
        >(() => true),
        isAnnotationCommentSyncReady: vi.fn(() => true),
    };

    return {
        deps,
        windows: useAnnotationNoteWindows(deps),
    };
}
