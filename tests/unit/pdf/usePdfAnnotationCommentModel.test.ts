import { ref } from 'vue';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { usePdfAnnotationCommentModel } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationCommentModel';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';

function markerRect(overrides: Partial<IAnnotationMarkerRect> = {}): IAnnotationMarkerRect {
    return {
        left: 0.1,
        top: 0.2,
        width: 0.3,
        height: 0.04,
        ...overrides,
    };
}

function comment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: overrides.id ?? 'comment-1',
        stableKey: overrides.stableKey ?? 'ann:0:stable-1',
        pageIndex: overrides.pageIndex ?? 0,
        pageNumber: overrides.pageNumber ?? 1,
        text: overrides.text ?? 'note',
        author: overrides.author ?? null,
        modifiedAt: overrides.modifiedAt ?? null,
        color: overrides.color ?? null,
        uid: overrides.uid ?? null,
        annotationId: overrides.annotationId ?? 'annotation-1',
        source: overrides.source ?? 'pdf',
        hasNote: overrides.hasNote ?? true,
        markerRect: overrides.markerRect ?? markerRect(),
        ...overrides,
    };
}

function createModel() {
    const emitted: IAnnotationCommentSummary[][] = [];
    const annotationProjection = ref<IAnnotationCommentSummary[]>([]);
    const model = usePdfAnnotationCommentModel({
        isAnySaving: ref(false),
        annotationProjection,
        ingestSummaries: comments => { annotationProjection.value = comments.map(value => ({...value})); },
        emitAnnotationComments: comments => emitted.push(comments),
    });
    return {
        emitted,
        model,
    };
}

describe('usePdfAnnotationCommentModel', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-27T00:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not carry text across different annotation identities during reload', () => {
        const { model } = createModel();
        model.handleSourceChanged('next.pdf', 'previous.pdf');
        model.upsertComment(comment({
            annotationId: 'old-highlight',
            displayText: 'selected text',
            hasNote: false,
            stableKey: 'ann:0:old-stable',
            subtype: 'highlight',
            text: '',
        }));

        const merged = model.applyFromSync([comment({
            annotationId: 'new-highlight',
            displayText: null,
            hasNote: false,
            id: 'comment-2',
            stableKey: 'ann:0:new-stable',
            subtype: 'highlight',
            text: '',
            markerRect: markerRect({ left: 0.105 }),
        })]);

        expect(merged).toHaveLength(1);
        expect(merged[0]?.displayText).toBeNull();
    });

    it('promotes an explicitly opened empty editor note into the canonical note projection', () => {
        const {model} = createModel();
        const opened = model.withTransientNoteCreationTimestamp(comment({
            source: 'editor',
            subtype: 'FreeText',
            text: '',
            hasNote: false,
            createdAt: null,
        }));

        expect(opened).toMatchObject({
            hasNote: true,
            createdAt: new Date('2026-05-27T00:00:00Z').getTime(),
        });
    });

    it('updates cached text markup color through normalized annotation ids', () => {
        const { model } = createModel();
        const cached = comment({
            annotationId: '42R',
            color: '#ef4444',
            subtype: 'Underline',
        });
        model.upsertComment(cached);

        model.updateCachedColor(comment({
            id: 'replacement-comment',
            stableKey: 'ann:0:replacement-stable',
            annotationId: '42R0',
            pageIndex: cached.pageIndex,
            subtype: 'Underline',
        }), '#3b82f6');

        expect(model.annotationCommentsCache.value[0]).toMatchObject({
            annotationId: '42R',
            color: '#ef4444',
        });
    });

    it('accepts the canonical color projection during sync without a shadow color cache', () => {
        const { model } = createModel();
        model.upsertComment(comment({
            annotationId: '42R0',
            color: '#3b82f6',
            colorEdited: true,
            id: 'local-comment',
            stableKey: 'ann:0:local-stable',
            subtype: 'StrikeOut',
        }));

        const merged = model.applyFromSync([comment({
            annotationId: '42R',
            color: '#ef4444',
            id: 'incoming-comment',
            stableKey: 'ann:0:incoming-stable',
            subtype: 'StrikeOut',
        })]);

        expect(merged[0]).toMatchObject({
            annotationId: '42R',
            color: '#ef4444',
        });
    });

    it('does not retain a local deletion peer against a new canonical projection', () => {
        const {model} = createModel();
        const deleted = comment();

        model.upsertComment(deleted);
        model.markLocallyDeleted(deleted);
        const merged = model.applyFromSync([deleted]);

        expect(merged).toEqual([deleted]);
        expect(model.annotationCommentsCache.value).toEqual([deleted]);
    });

    it('restores a local deletion by canonical command identity', () => {
        const {model} = createModel();
        const restored = comment();

        model.markLocallyDeleted(restored);
        model.restoreLocally(restored);

        expect(model.annotationCommentsCache.value).toHaveLength(0);
    });

    it('updates the read projection and editor executor state when a marker moves', () => {
        const { model } = createModel();
        const original = comment();
        const editor = {};
        const markModified = vi.fn();
        const movedRect = markerRect({ left: 0.5 });

        model.upsertComment(original);
        const moved = model.handleMarkerMove(original, movedRect, {
            markEditorPending: (updated, previous, rect) => {
                expect(previous).toEqual(original);
                expect(rect).toBe(movedRect);
                Object.assign(editor, {
                    __evbPendingAnchorRect: rect,
                    stableKey: updated.stableKey,
                });
            },
            markModified,
        });

        expect(moved).toBe(true);
        expect(model.annotationCommentsCache.value[0]?.markerRect).toEqual(original.markerRect);
        expect(editor).toMatchObject({
            __evbPendingAnchorRect: movedRect,
            stableKey: 'ann:0:stable-1',
        });
        expect(markModified).toHaveBeenCalledTimes(1);
    });

    it('returns cloned marker rects in snapshots', () => {
        const { model } = createModel();
        model.upsertComment(comment());

        const snapshot = model.getSnapshot();
        snapshot[0]!.markerRect!.left = 9;

        expect(model.annotationCommentsCache.value[0]?.markerRect?.left).toBe(0.1);
    });

    it('clears the canonical projection when the source changes', () => {
        const {
            emitted,
            model,
        } = createModel();
        model.upsertComment(comment());

        model.handleSourceChanged(null, 'previous.pdf');

        expect(model.annotationCommentsCache.value).toEqual([]);
        expect(emitted.at(-1)).toEqual([]);
    });

    it('does not expose annotations from the previous document while the next source syncs', () => {
        const {
            emitted,
            model,
        } = createModel();
        model.upsertComment(comment());

        model.handleSourceChanged('next.pdf', 'previous.pdf');

        expect(model.annotationCommentsCache.value).toEqual([]);
        expect(emitted.at(-1)).toEqual([]);
    });

    it('requests a fresh canonical projection for each source change', () => {
        const { model } = createModel();
        const syncAnnotationComments = vi.fn();

        model.handleSourceChanged('second.pdf', 'first.pdf', { syncAnnotationComments });
        model.handleSourceChanged('third.pdf', 'second.pdf', { syncAnnotationComments });
        vi.advanceTimersByTime(5_101);

        expect(syncAnnotationComments).toHaveBeenCalledTimes(2);
    });
});
