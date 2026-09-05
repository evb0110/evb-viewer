import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import {
    buildNativeFreeTextNotesForSave,
    isReplayableEditorOnlyFreeTextNote,
    toNativeFreeTextNote,
} from '@app/modules/pdf-viewer/annotations/persistence/nativeFreeTextNoteProjection';
import { buildNativeNoteTextUpdatesForSave } from '@app/modules/pdf-viewer/annotations/persistence/nativeNoteTextUpdateProjection';
import { projectNativeAnnotationDeletes } from '@app/modules/pdf-viewer/annotations/persistence/nativeAnnotationDeleteProjection';
import {
    buildNativeShapesMutationForSave,
    isNativeShapeEligible,
    toNativeShapeAnnotation,
} from '@app/modules/pdf-viewer/runtime/save/nativeShapeMutations';
import {
    buildNativeMarkupMutationForSave,
    toNativeMarkupHint,
} from '@app/modules/pdf-viewer/annotations/persistence/nativeMarkupProjection';
import { PDF_NATIVE_MUTATION_LIMITS } from '@contracts/nativePdfMutations';

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: 'ann-1',
        stableKey: 'ann:0:12R0',
        sortIndex: null,
        pageIndex: 0,
        pageNumber: 1,
        text: 'Original note',
        kindLabel: 'Note',
        subtype: 'Text',
        author: 'Tester',
        createdAt: 1781009077123,
        modifiedAt: null,
        color: '#ffcc00',
        uid: null,
        annotationId: '12R0',
        source: 'pdf',
        hasNote: true,
        markerRect: {
            left: 0.1,
            top: 0.2,
            width: 0.01,
            height: 0.01,
        },
        ...overrides,
    };
}

function createEditorFreeTextComment(overrides: Partial<IAnnotationCommentSummary> = {}) {
    return createComment({
        id: 'editor:0:pdfjs_internal_editor_0',
        stableKey: 'ann:0:pdfjs_internal_editor_0',
        text: 'Editor note',
        subtype: 'FreeText',
        annotationId: null,
        uid: null,
        source: 'editor',
        markerRect: {
            left: 0.1,
            top: 0.2,
            width: 0.2,
            height: 0.2,
        },
        ...overrides,
    });
}

function createShape(overrides: Partial<IShapeAnnotation> = {}): IShapeAnnotation {
    return {
        id: 'shape-1',
        type: 'rectangle',
        pageIndex: 0,
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.4,
        color: '#00aaff',
        opacity: 0.75,
        strokeWidth: 2,
        annotationId: '22R0',
        stableKey: 'ann:0:22R0',
        pdfSubtype: 'Square',
        createdAt: 1781009077123,
        modifiedAt: 1781009077999,
        ...overrides,
    };
}

function createMutationProjectionInput(overrides: Partial<{
    canonicalComments: IAnnotationCommentSummary[];
    pendingTexts: Map<string, string>;
    pendingDeletes: IAnnotationCommentSummary[];
}> = {}) {
    return {
        pendingTexts: new Map(),
        pendingDeletes: [],
        canonicalComments: [],
        ...overrides,
    };
}

describe('native FreeText note builders', () => {
    it('detects replayable editor-only FreeText notes and normalizes native note payloads', () => {
        const comment = createEditorFreeTextComment();

        expect(isReplayableEditorOnlyFreeTextNote(comment)).toBe(true);
        expect(toNativeFreeTextNote(comment)).toEqual({
            pageIndex: 0,
            stableKey: 'ann:0:pdfjs_internal_editor_0',
            text: 'Editor note',
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.0016,
                height: 0.0016,
            },
            author: 'Tester',
            color: '#ffcc00',
            createdAt: 1781009077123,
        });
    });

    it('deduplicates native FreeText notes by stable key', () => {
        const comment = createEditorFreeTextComment();

        const notes = buildNativeFreeTextNotesForSave(createMutationProjectionInput({canonicalComments: [
            comment,
            createEditorFreeTextComment(),
        ]}));

        expect(notes.value).toEqual([expect.objectContaining({stableKey: comment.stableKey})]);
        expect(notes.skipEvents).toEqual([]);
    });

    it('uses the canonical app identity for a new sticky note', () => {
        const comment = createComment({
            appAnnotationId: 'anno_sticky_note',
            id: 'anno_sticky_note',
            stableKey: 'ann:0:editor:anno_sticky_note',
            annotationId: null,
            source: 'editor',
            subtype: 'Text',
        });

        expect(toNativeFreeTextNote(comment)).toEqual(expect.objectContaining({stableKey: 'anno_sticky_note'}));
    });
});

describe('native note text and delete builders', () => {
    it('builds native text updates for PDF-sourced note refs', () => {
        const pendingTexts = new Map([[
            'ann:0:12R0',
            'Updated note',
        ]]);

        const updates = buildNativeNoteTextUpdatesForSave(createMutationProjectionInput({
            pendingTexts,
            canonicalComments: [createComment()],
        }));

        expect(updates.value).toEqual([{
            objectNumber: 12,
            generationNumber: 0,
            text: 'Updated note',
        }]);
        expect(updates.skipEvents).toEqual([]);
    });

    it('builds native text updates for PDF-backed FreeText notes', () => {
        const pendingTexts = new Map([[
            'ann:0:12R0',
            'Updated note',
        ]]);

        const updates = buildNativeNoteTextUpdatesForSave(createMutationProjectionInput({
            pendingTexts,
            canonicalComments: [createComment({subtype: 'FreeText'})],
        }));

        expect(updates.value).toEqual([{
            objectNumber: 12,
            generationNumber: 0,
            text: 'Updated note',
        }]);
        expect(updates.skipEvents).toEqual([]);
    });

    it('builds native deletes for PDF refs and editor-only FreeText stable keys', () => {
        const deletes = projectNativeAnnotationDeletes(createMutationProjectionInput({pendingDeletes: [
            createComment(),
            createEditorFreeTextComment(),
        ]}));

        expect(deletes.value).toEqual([
            {
                pageIndex: 0,
                objectNumber: 12,
                generationNumber: 0,
            },
            {
                pageIndex: 0,
                stableKey: 'ann:0:pdfjs_internal_editor_0',
                createdAt: 1781009077123,
            },
        ]);
        expect(deletes.skipEvents).toEqual([]);
    });
});

describe('native shape builders', () => {
    it('maps eligible shapes to native payloads with copied point arrays', () => {
        const shape = createShape({
            type: 'polyline',
            pdfSubtype: 'PolyLine',
            points: [
                {
                    x: 0.1,
                    y: 0.2,
                },
                {
                    x: 0.3,
                    y: 0.4,
                },
            ],
        });

        expect(isNativeShapeEligible(shape, 2)).toBe(true);
        const nativeShape = toNativeShapeAnnotation(shape);

        expect(nativeShape).toEqual(expect.objectContaining({
            type: 'polyline',
            annotationId: '22R',
            stableKey: 'ann:0:22R0',
            pdfSubtype: 'PolyLine',
        }));
        expect(nativeShape).not.toHaveProperty('id');
        expect(nativeShape.points).toEqual(shape.points);
        expect(nativeShape.points).not.toBe(shape.points);
    });

    it('returns null when any dirty shape is not native-eligible', () => {
        const mutation = buildNativeShapesMutationForSave({
            shapeStateDirty: true,
            rewriteShapeState: true,
            totalPageCount: 1,
            shapes: [
                createShape(),
                createShape({
                    x: 0.9,
                    width: 0.2,
                }),
            ],
            deletedAnnotationIds: [],
            deletedStableKeys: [],
        });

        expect(mutation).toBeNull();
    });

    it('remaps a redrawn Ink shape whose persisted ref was retired by an earlier delete', () => {
        const mutation = buildNativeShapesMutationForSave({
            shapeStateDirty: true,
            rewriteShapeState: true,
            totalPageCount: 1,
            shapes: [createShape({
                type: 'polyline',
                pdfSubtype: 'Ink',
                points: [
                    {
                        x: 0.1,
                        y: 0.2,
                    },
                    {
                        x: 0.3,
                        y: 0.4,
                    },
                ],
            })],
            deletedAnnotationIds: ['22R0'],
            deletedStableKeys: ['ann:0:22R0'],
        });

        expect(mutation).toMatchObject({
            deletedAnnotationIds: ['22R0'],
            deletedStableKeys: ['ann:0:22R0'],
            shapes: [expect.objectContaining({
                annotationId: null,
                stableKey: null,
                pdfSubtype: 'Ink',
            })],
        });
    });
});

describe('native markup builders', () => {
    it('converts eligible markup hints and edited comment hints', () => {
        const markerRect = {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.4,
        };

        expect(toNativeMarkupHint({
            subtype: 'Highlight',
            pageIndex: 0,
            markerRect,
            markupGeometry: [markerRect],
            annotationId: '44R0',
            color: '#ffee00',
            id: 'hint-1',
            pageMarkupIndex: 3,
            source: 'editor',
            contents: 'Edited markup note',
            consumed: false,
        })).toEqual({
            subtype: 'Highlight',
            pageIndex: 0,
            markerRect,
            markupGeometry: [markerRect],
            annotationId: '44R0',
            color: '#ffee00',
            id: 'hint-1',
            pageMarkupIndex: 3,
            source: 'editor',
            contents: 'Edited markup note',
        });

        const mutation = buildNativeMarkupMutationForSave({
            canonicalComments: [
                createComment({
                    stableKey: 'ann:0:44R0',
                    subtype: 'Highlight',
                    color: '#ffee00',
                    colorEdited: true,
                    annotationId: '44R0',
                    markerRect,
                    markupGeometry: [markerRect],
                }),
                createComment({
                    stableKey: 'ann:0:45R0',
                    subtype: 'Squiggly',
                    annotationId: '45R0',
                    markerRect,
                }),
            ],
            annotationWorkDirty: true,
            markupSubtypeOverrides: new Map<string, TMarkupSubtype>([[
                ' 44R0 ',
                'Underline',
            ]]),
            markupSubtypeHints: [{
                subtype: 'Squiggly',
                pageIndex: 0,
                markerRect,
                annotationId: '45R0',
                color: null,
                id: null,
                pageMarkupIndex: null,
                source: null,
                consumed: false,
            }],
        });

        expect(mutation?.overrides).toEqual([[
            '44R0',
            'Underline',
        ]]);
        expect(mutation?.hints).toEqual([
            expect.objectContaining({
                subtype: 'Squiggly',
                annotationId: '45R0',
            }),
            expect.objectContaining({
                subtype: 'Highlight',
                annotationId: '44R0',
                markupGeometry: [markerRect],
            }),
        ]);
    });

    it('keeps the marker rectangle when detailed geometry exceeds the native bound', () => {
        const markerRect = {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.4,
        };
        const nativeHint = toNativeMarkupHint({
            subtype: 'Squiggly',
            pageIndex: 0,
            markerRect,
            markupGeometry: Array.from(
                {length: PDF_NATIVE_MUTATION_LIMITS.markupGeometryItems + 1},
                () => markerRect,
            ),
            annotationId: null,
            color: '#336699',
            id: 'bounded-fallback',
            pageMarkupIndex: null,
            source: 'editor',
            consumed: false,
        });

        expect(nativeHint).toEqual(expect.objectContaining({markerRect}));
        expect(nativeHint).not.toHaveProperty('markupGeometry');
    });

    it('matches a live markup hint by its canonical app annotation identity', () => {
        const markerRect = {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.4,
        };
        const mutation = buildNativeMarkupMutationForSave({
            canonicalComments: [createComment({
                appAnnotationId: 'app-markup-1',
                id: 'current-runtime-id',
                stableKey: 'ann:0:current-runtime-id',
                subtype: 'Highlight',
                source: 'editor',
                annotationId: null,
                markerRect,
            })],
            annotationWorkDirty: true,
            markupSubtypeOverrides: undefined,
            markupSubtypeHints: [{
                appAnnotationId: 'app-markup-1',
                subtype: 'Highlight',
                pageIndex: 0,
                markerRect,
                annotationId: null,
                color: '#ffee00',
                id: 'stale-runtime-id',
                pageMarkupIndex: null,
                source: 'editor-live',
                consumed: false,
            }],
        });

        expect(mutation?.hints).toContainEqual(expect.objectContaining({
            appAnnotationId: 'app-markup-1',
            id: 'stale-runtime-id',
        }));
    });

    it('drops a retired PDF override when an undone markup is editor-owned', () => {
        const markerRect = {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.4,
        };
        const mutation = buildNativeMarkupMutationForSave({
            canonicalComments: [createComment({
                appAnnotationId: 'app-markup-1',
                id: '9R',
                stableKey: 'ann:0:9R',
                subtype: 'Highlight',
                source: 'editor',
                annotationId: null,
                markerRect,
            })],
            annotationWorkDirty: true,
            markupSubtypeOverrides: new Map<string, TMarkupSubtype>([[
                '9R0',
                'Underline',
            ]]),
            markupSubtypeHints: [{
                appAnnotationId: 'app-markup-1',
                subtype: 'Highlight',
                pageIndex: 0,
                markerRect,
                annotationId: '9R0',
                color: '#ffee00',
                id: 'pdfjs_saved_highlight_undo',
                pageMarkupIndex: 0,
                source: 'editor-live',
                consumed: false,
            }],
        });

        expect(mutation?.overrides).toEqual([]);
        expect(mutation?.hints).toContainEqual(expect.objectContaining({
            appAnnotationId: 'app-markup-1',
            id: '9R',
            annotationId: null,
            source: 'editor',
        }));
    });

    it('drops stale markup hints and overrides that no longer match current markup comments', () => {
        const markerRect = {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.4,
        };

        const mutation = buildNativeMarkupMutationForSave({
            canonicalComments: [createComment()],
            annotationWorkDirty: true,
            markupSubtypeOverrides: new Map<string, TMarkupSubtype>([[
                '44R0',
                'Underline',
            ]]),
            markupSubtypeHints: [{
                subtype: 'Squiggly',
                pageIndex: 0,
                markerRect,
                annotationId: '45R0',
                color: null,
                id: null,
                pageMarkupIndex: null,
                source: null,
                consumed: false,
            }],
        });

        expect(mutation).toBeNull();
    });
});
