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
import type {
    IShapeEntity,
    INoteEntity,
    IPlacedImageEntity,
    ITextBoxEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {AnnotationApplication} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {
    asAnnotationId,
    toLegacyShapeAnnotation,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {buildSerializationPlan} from '@app/modules/pdf-viewer/annotations/persistence/annotationSavePlan';
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
    buildNativePdfMutationProjection,
    type IPdfSaveRouteCapabilities,
} from '@app/modules/pdf-viewer/runtime/save/nativeMutationProjection';
import {
    buildNativeMarkupMutationForSave,
    toNativeMarkupHint,
} from '@app/modules/pdf-viewer/annotations/persistence/nativeMarkupProjection';
import { nativeNoteGeometryProjection } from '@app/modules/pdf-viewer/annotations/persistence/nativeNoteGeometryProjection';
import {
    PDF_NATIVE_MUTATION_LIMITS,
    normalizePdfNativeMutationSet,
} from '@contracts/nativePdfMutations';
import {requirePageIndex} from '@contracts/pageNumbers';
import {requireEpochMs} from '@contracts/timestamps';

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: 'ann-1',
        stableKey: 'ann:0:12R0',
        sortIndex: null,
        pageIndex: requirePageIndex(0),
        pageNumber: 1,
        text: 'Original note',
        kindLabel: 'Note',
        subtype: 'Text',
        author: 'Tester',
        createdAt: requireEpochMs(1781009077123),
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
        pageIndex: requirePageIndex(0),
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
        createdAt: requireEpochMs(1781009077123),
        modifiedAt: requireEpochMs(1781009077999),
        ...overrides,
    };
}

function createShapeEntity(overrides: Partial<IShapeEntity> = {}): IShapeEntity {
    return {
        kind: 'shape',
        identity: {
            id: asAnnotationId('shape-entity'),
            pdfRef: '22R0',
        },
        pageIndex: requirePageIndex(0),
        revision: 1,
        persistedRevision: 0,
        deleted: false,
        createdAt: requireEpochMs(1781009077123),
        modifiedAt: requireEpochMs(1781009077999),
        author: 'Tester',
        tool: 'rectangle',
        rect: {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.4,
        },
        strokeColor: '#00aaff',
        strokeWidth: 2,
        fill: null,
        opacity: 0.75,
        ...overrides,
    };
}

function createNativeRouteCapabilities(
    overrides: Partial<IPdfSaveRouteCapabilities> = {},
): IPdfSaveRouteCapabilities {
    return {
        saveFlowMode: 'save',
        availableBackends: ['native-append'],
        nativeCapabilities: {
            hasNativePdfMutationCapability: true,
            canPersistNativeMetadataMutations: true,
        },
        dirtyState: {
            annotationDirty: true,
            hasAnnotationChanges: true,
            shapeStateDirty: true,
        },
        documentStructure: {
            pageLabelsDirty: false,
            pageLabelRanges: [],
            bookmarksDirty: false,
            bookmarkItems: [],
            untitledBookmarkLabel: 'Untitled',
            totalPages: 1,
        },
        liveAnnotationChanges: {
            ids: new Set(),
            replayableEditorNoteIds: new Set(),
            nativeFreeTextEditors: new Map(),
            hasChanges: false,
            hasUnknownChanges: false,
            fingerprint: 'empty',
        },
        hasLoadedSource: true,
        forceWriterSave: false,
        rewriteShapeState: true,
        totalPageCount: 1,
        shapes: [createShape()],
        deletedEmbeddedShapeAnnotationIds: [],
        deletedEmbeddedShapeStableKeys: [],
        markupSubtypeOverrides: undefined,
        markupSubtypeHints: [],
        nativeTextBoxes: [],
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
            pageIndex: requirePageIndex(0),
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
            createdAt: requireEpochMs(1781009077123),
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

    it('keeps the canonical open state for a new sticky note', () => {
        const comment = createEditorFreeTextComment({
            appAnnotationId: 'sticky-note-1',
            subtype: 'Text',
            open: true,
        });

        expect(toNativeFreeTextNote(comment)).toEqual(expect.objectContaining({open: true}));
    });
});

describe('native imported note geometry builders', () => {
    it('carries note color and open state with an imported note geometry update', () => {
        const comment = createComment({
            open: true,
            color: '#336699',
            markerRect: {
                left: 0.2,
                top: 0.3,
                width: 0.02,
                height: 0.02,
            },
        });

        expect(nativeNoteGeometryProjection([comment]).value).toEqual([expect.objectContaining({
            color: '#336699',
            open: true,
        })]);
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
                pageIndex: requirePageIndex(0),
                objectNumber: 12,
                generationNumber: 0,
            },
            {
                pageIndex: requirePageIndex(0),
                stableKey: 'ann:0:pdfjs_internal_editor_0',
                createdAt: requireEpochMs(1781009077123),
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

    it('preserves a canonical shape author through the rendering and native transport projections', () => {
        const entity = createShapeEntity({author: 'Анна כהן'});
        const projected = buildNativeShapesMutationForSave({
            shapeStateDirty: true,
            rewriteShapeState: true,
            totalPageCount: 1,
            shapes: [toLegacyShapeAnnotation(entity)],
            deletedAnnotationIds: [],
            deletedStableKeys: [],
        });
        const normalized = normalizePdfNativeMutationSet({shapes: projected}, 'shape author');
        expect(normalized.shapes?.shapes[0]?.author).toBe(entity.author);
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

describe('native PDF save route', () => {
    it('saves a new text box beside an unsaved deletion and preserves a persisted delete', () => {
        const app = new AnnotationApplication('deleted-draft-save');
        const draft: ITextBoxEntity = {
            kind: 'text-box',
            identity: {id: asAnnotationId('draft')},
            pageIndex: requirePageIndex(0),
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: null,
            text: 'draft',
            rect: {
                left: 0.1,
                top: 0.1,
                width: 0.2,
                height: 0.2,
            },
            rotation: 0,
            fontSize: 12,
            color: '#000000',
        };
        app.store.createTextBox(draft);
        app.store.delete(draft.identity.id);
        app.store.import({
            ...draft,
            identity: {
                id: asAnnotationId('persisted'),
                pdfRef: '12R',
            },
            persistedRevision: 0,
        });
        app.store.delete(asAnnotationId('persisted'));
        app.store.createTextBox({
            ...draft,
            identity: {id: asAnnotationId('survivor')},
        });
        const result = buildNativePdfMutationProjection(app.beginSave().plan, createNativeRouteCapabilities({
            shapes: [],
            nativeTextBoxes: [{
                pageIndex: requirePageIndex(0),
                stableKey: 'survivor',
                text: 'draft',
                rect: [
                    20,
                    70,
                    60,
                    90,
                ],
                rotation: 0,
                fontSize: 12,
                color: [
                    0,
                    0,
                    0,
                ],
            }],
        }));
        expect(result.route).toBe('native-append');
        if (result.route !== 'native-append') throw new Error(`Expected native save: ${result.nativeRejection}`);
        const mutations = result.nativeMutationProjection.mutations;
        expect(mutations.textBoxes).toHaveLength(1);
        expect(mutations.textBoxes?.[0]?.stableKey).toBe('survivor');
        expect(mutations.deletes).toEqual([expect.objectContaining({objectNumber: 12})]);
        expect(result.canonical.pendingDeletes).toHaveLength(1);
        expect(result.canonical.pendingDeletes[0]?.appAnnotationId).toBe('persisted');
    });

    function projectRecovery(entity: INoteEntity | IPlacedImageEntity) {
        const app = new AnnotationApplication('recovery');
        app.store.import(entity);
        const decision = buildNativePdfMutationProjection(app.beginSave().plan, createNativeRouteCapabilities({
            dirtyState: {
                annotationDirty: true,
                hasAnnotationChanges: true,
                shapeStateDirty: false,
            },
            shapes: [],
        }));
        if (decision.route !== 'native-append') {
            throw new Error(`Expected native append, got ${decision.nativeRejection}`);
        }
        return normalizePdfNativeMutationSet(decision.nativeMutationProjection.mutations, 'image author');
    }

    function recoveryImage(): IPlacedImageEntity {
        return {
            kind: 'placed-image',
            identity: {id: asAnnotationId('restored-stamp')},
            pageIndex: requirePageIndex(0),
            revision: 2,
            persistedRevision: -1,
            deleted: false,
            author: 'Анна כהן',
            createdAt: null,
            modifiedAt: null,
            rect: {
                left: 0.2,
                top: 0.2,
                width: 0.3,
                height: 0.3,
            },
            rotation: 25,
            image: {
                objectNumber: 42,
                generationNumber: 0,
                byteLength: 20,
                sha256: 'a'.repeat(64),
            },
        };
    }

    it('restores an unbound stamp from its retained image without reviving the retired annotation reference', () => {
        const entity = recoveryImage();
        expect(projectRecovery(entity).placedImageGeometryUpdates).toEqual([{
            pageIndex: 0,
            stableKey: 'restored-stamp',
            author: entity.author,
            sourceImage: entity.image,
            x: 0.2,
            y: 0.2,
            width: 0.3,
            height: 0.3,
            rotationDegrees: 25,
        }]);
    });

    it('projects an authored raster as native image creation and replacement', () => {
        const entity: IPlacedImageEntity = {
            ...recoveryImage(),
            image: {
                kind: 'raster',
                mimeType: 'image/png',
                dataBase64: 'cG5n',
                byteLength: 3,
                sha256: 'b'.repeat(64),
                width: 10,
                height: 10,
            },
        };
        const created = projectRecovery(entity);
        expect(created.placedImageGeometryUpdates).toBeUndefined();
        expect(created.placedImages).toEqual([{
            pageIndex: 0,
            stableKey: 'restored-stamp',
            author: entity.author,
            x: 0.2,
            y: 0.2,
            width: 0.3,
            height: 0.3,
            rotationDegrees: 25,
            mimeType: 'image/png',
            bytesBase64: 'cG5n',
            byteLength: 3,
            sha256: 'b'.repeat(64),
        }]);
        const replaced = projectRecovery({
            ...entity,
            identity: {
                ...entity.identity,
                pdfRef: '10 0 R',
            },
        });
        expect(replaced.placedImages?.[0]?.annotationId).toBe('10R');
        expect(replaced.placedImages?.[0]?.author).toBe(entity.author);
    });

    it('does not rewrite a saved raster present in a reconciliation save plan', () => {
        const saved: IPlacedImageEntity = {
            ...recoveryImage(),
            persistedRevision: 2,
            identity: {
                id: asAnnotationId('saved-raster'),
                pdfRef: '10 0 R',
            },
            image: {
                kind: 'raster',
                mimeType: 'image/png',
                dataBase64: 'cG5n',
                byteLength: 3,
                sha256: 'b'.repeat(64),
                width: 10,
                height: 10,
            },
        };
        const note: INoteEntity = {
            kind: 'note',
            identity: {id: asAnnotationId('edited-note')},
            pageIndex: saved.pageIndex,
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: null,
            contents: 'new note',
            position: saved.rect,
            color: '#ffff00',
            open: false,
        };
        const app = new AnnotationApplication('reconciliation');
        app.store.import(saved);
        app.store.createNote(note);
        const session = app.beginSave();
        const plan = buildSerializationPlan(session.frontier, [
            saved,
            note,
        ], app.store.list());
        const result = buildNativePdfMutationProjection(plan, createNativeRouteCapabilities({shapes: []}));
        expect(result.route).toBe('native-append');
        if (result.route !== 'native-append') throw new Error('Expected native save');
        expect(result.nativeMutationProjection.mutations.placedImages).toBeUndefined();
        expect(result.nativeMutationProjection.mutations.freeTextNotes).toHaveLength(1);
    });

    it('includes a retained note thread graph only when recreating an unbound note', () => {
        const stamp = recoveryImage();
        const note: INoteEntity = {
            kind: 'note',
            identity: stamp.identity,
            pageIndex: stamp.pageIndex,
            revision: 2,
            persistedRevision: -1,
            deleted: false,
            author: null,
            createdAt: null,
            modifiedAt: null,
            contents: 'restored parent',
            position: stamp.rect,
            color: '#ffff00',
            open: false,
            recoveryData: '0011',
        };
        expect(projectRecovery(note).freeTextNotes?.[0]?.recoveryData).toBe('0011');
        const changed = projectRecovery({
            ...note,
            persistedRevision: 0,
            identity: {
                ...note.identity,
                pdfRef: '10 0 R',
            },
        });
        expect(changed.freeTextNotes).toBeUndefined();
    });

    it('admits managed shape mutations when the native shape payload is available', () => {
        const shape = createShapeEntity();
        const nativeShape = createShape({annotationId: shape.identity.pdfRef});
        const plan = buildSerializationPlan(
            {
                documentRevisionToken: null,
                epoch: 1,
                entityBaselineHash: 'shape-baseline',
                revisions: new Map([[
                    shape.identity.id,
                    shape.persistedRevision,
                ]]),
            },
            [shape],
            [shape],
            {routeConstraints: {
                allowedBackends: ['native-append'],
                preserveLoadedSource: true,
            }},
        );

        const decision = buildNativePdfMutationProjection(
            plan,
            createNativeRouteCapabilities({shapes: [nativeShape]}),
        );

        expect(decision.route).toBe('native-append');
        if (decision.route !== 'native-append') {
            throw new Error(`Expected native append, got ${decision.nativeRejection}`);
        }
        expect(decision.nativeMutationProjection.mutations.shapes).toMatchObject({
            rewriteShapeState: true,
            shapes: [expect.objectContaining({
                annotationId: '22R',
                stableKey: nativeShape.stableKey,
                type: 'rectangle',
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
            pageIndex: requirePageIndex(0),
            markerRect,
            markupGeometry: [markerRect],
            annotationId: '44R0',
            color: '#ffee00',
            id: 'hint-1',
            pageMarkupIndex: 3,
            source: 'editor',
            contents: 'Edited markup note',
            opacity: 0.45,
            consumed: false,
        })).toEqual({
            subtype: 'Highlight',
            pageIndex: requirePageIndex(0),
            markerRect,
            markupGeometry: [markerRect],
            annotationId: '44R0',
            color: '#ffee00',
            id: 'hint-1',
            pageMarkupIndex: 3,
            source: 'editor',
            contents: 'Edited markup note',
            opacity: 0.45,
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
                createComment({
                    stableKey: 'ann:0:46R0',
                    subtype: 'Underline',
                    annotationId: '46R0',
                    color: '#224466',
                    opacity: 0.4,
                    markerRect,
                }),
            ],
            changedComments: [
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
                    stableKey: 'ann:0:46R0',
                    subtype: 'Underline',
                    annotationId: '46R0',
                    color: '#224466',
                    opacity: 0.4,
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
                pageIndex: requirePageIndex(0),
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
            expect.objectContaining({
                subtype: 'Underline',
                annotationId: '46R0',
                color: '#224466',
                opacity: 0.4,
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
            pageIndex: requirePageIndex(0),
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
                pageIndex: requirePageIndex(0),
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
                pageIndex: requirePageIndex(0),
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
                pageIndex: requirePageIndex(0),
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
