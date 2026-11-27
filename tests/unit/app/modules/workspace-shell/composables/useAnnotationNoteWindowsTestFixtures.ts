import {
    effectScope,
    ref,
} from 'vue';
import {
    onTestFinished,
    vi,
} from 'vitest';
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

/** The document store's projection: its live summaries and its tombstones. */
export function createHarness(comment = createComment(), options: Pick<Parameters<typeof useAnnotationNoteWindows>[0], 'reportNoteFailure'> = {}) {
    const annotationComments = ref<IAnnotationCommentSummary[]>([comment]);
    const deletedAnnotationIds = ref<ReadonlySet<string>>(new Set());
    const deps = {
        ...options,
        documentAnnotations: {
            comments: annotationComments,
            deletedAnnotationIds,
        },
        annotationComments,
        deletedAnnotationIds,
        updateAnnotationCommentInViewer: vi.fn<
            (annotationId: AnnotationId, text: string) => boolean
        >(() => true),
    };

    const scope = effectScope();
    onTestFinished(() => scope.stop());

    return {
        deps,
        windows: scope.run(() => useAnnotationNoteWindows(deps))!,
    };
}
