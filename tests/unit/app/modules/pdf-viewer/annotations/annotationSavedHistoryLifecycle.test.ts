import {
    describe,
    expect,
    it,
} from 'vitest';
import {AnnotationApplication} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import type {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {
    asAnnotationId,
    type AnnotationEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {requirePageIndex} from '@contracts/pageNumbers';
import {normalizePdfNativeMutationSet} from '@contracts/nativePdfMutations';
import {buildNativeMarkupMutationForSave} from '@app/modules/pdf-viewer/annotations/persistence/nativeMarkupProjection';
import {mapPdfAnnotationParseEntity} from '@app/modules/pdf-viewer/runtime/sessions/mapPdfAnnotationParseEntity';

const rect = {
    left: 0.2,
    top: 0.2,
    width: 0.2,
    height: 0.2,
};
function entity(kind: AnnotationEntity['kind']): AnnotationEntity {
    const base = {
        identity: {
            id: asAnnotationId(`history-${kind}`),
            pdfRef: '10 0 R',
        },
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: 0,
        deleted: false,
        author: null,
        createdAt: null,
        modifiedAt: null,
    };
    switch (kind) {
        case 'note': return {
            ...base,
            kind,
            contents: 'initial',
            position: rect,
            color: '#ffff00',
            open: false,
        };
        case 'text-box': return {
            ...base,
            kind,
            text: 'initial',
            rect,
            rotation: 0,
            fontSize: 12,
            color: '#000000',
        };
        case 'text-markup': return {
            ...base,
            kind,
            contents: 'initial',
            quadPoints: [rect],
            subtype: 'Highlight',
            color: '#ffff00',
            opacity: 1,
        };
        case 'shape': return {
            ...base,
            kind,
            tool: 'rectangle',
            rect,
            strokeColor: '#000000',
            strokeWidth: 2,
            fill: null,
            opacity: 1,
        };
        case 'placed-image': return {
            ...base,
            kind,
            rect,
            rotation: 0,
            image: {
                objectNumber: 12,
                generationNumber: 0,
                byteLength: 20,
                sha256: 'a'.repeat(64),
            },
        };
    }
}
function edit(store: AnnotationStore, original: AnnotationEntity, step: number) {
    const id = original.identity.id;
    switch (original.kind) {
        case 'note': return store.updateNote(id, {contents: `edit-${step}`});
        case 'text-box': return store.updateTextBox(id, {text: `edit-${step}`});
        case 'text-markup': return store.updateTextMarkup(id, {contents: `edit-${step}`});
        case 'shape': return store.updateShape(id, {strokeWidth: step + 2});
        case 'placed-image': return store.updatePlacedImage(id, {rect: {
            ...rect,
            left: 0.2 + step / 10,
        }});
    }
}
/** The production lifecycle acknowledges bindings, then parses the committed file. */
function commitAndReparse(app: AnnotationApplication) {
    const session = app.beginSave();
    const parsed = session.plan.entities.filter(entry => !entry.deleted).map(entry => ({
        ...entry,
        identity: {
            ...entry.identity,
            pdfRef: entry.identity.pdfRef ?? '20 0 R',
        },
        revision: 0,
        persistedRevision: 0,
    }));
    app.acknowledgeSave(session, null, parsed.map(entry => ({
        annotationId: entry.identity.id,
        pdfRef: entry.identity.pdfRef,
    })));
    app.store.replaceFromDocument(parsed, []);
    return session.plan;
}
const kinds: Array<AnnotationEntity['kind']> = [
    'note',
    'text-box',
    'text-markup',
    'shape',
    'placed-image',
];

describe.each(kinds)('%s saved history lifecycle', kind => {
    it('saves undo and a divergent edit after acknowledgement and committed reparse', () => {
        const app = new AnnotationApplication('saved-history');
        const original = entity(kind);
        app.store.replaceFromDocument([original], []);
        edit(app.store, original, 1);
        commitAndReparse(app);
        const savedRevision = app.store.get(original.identity.id)!.revision;
        expect(app.store.undo()).toBe(true);
        const undone = app.store.get(original.identity.id)!;
        expect(undone.revision).toBeGreaterThan(savedRevision);
        expect(app.store.hasChangesSinceSavedBaseline()).toBe(true);
        expect(app.beginSave().plan.expected).toEqual([undone]);
        edit(app.store, original, 2);
        const divergent = app.store.get(original.identity.id)!;
        expect(divergent.revision).toBeGreaterThan(undone.revision);
        expect(app.beginSave().plan.expected).toEqual([divergent]);
        expect(commitAndReparse(app).expected).toEqual([divergent]);
        expect(app.beginSave().plan.expected).toEqual([]);
        expect(app.store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('returns to a clean save frontier when redo restores the committed state', () => {
        const app = new AnnotationApplication('saved-redo');
        const original = entity(kind);
        app.store.replaceFromDocument([original], []);
        edit(app.store, original, 1);
        commitAndReparse(app);
        app.store.undo();
        app.store.redo();
        expect(app.beginSave().plan.expected).toEqual([]);
        expect(app.store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('retains saved deletion history across repeated reparses and recreates under a fresh binding', () => {
        const app = new AnnotationApplication('saved-delete');
        const original = entity(kind);
        app.store.replaceFromDocument([original], []);
        app.store.delete(original.identity.id);
        commitAndReparse(app);
        commitAndReparse(app);
        expect(app.store.hasChangesSinceSavedBaseline()).toBe(false);
        expect(app.store.undo()).toBe(true);
        const restored = app.store.get(original.identity.id)!;
        expect(restored.deleted).toBe(false);
        expect(restored.identity.pdfRef).toBeUndefined();
        expect(restored.persistedRevision).toBe(-1);
        expect(app.beginSave().plan.expected).toEqual([restored]);
        commitAndReparse(app);
        expect(app.store.get(original.identity.id)!.identity.pdfRef).toBe('20 0 R');
        expect(app.store.redo()).toBe(true);
        const deletion = app.beginSave().plan.expected[0]!;
        expect(deletion.deleted).toBe(true);
        expect(deletion.identity.pdfRef).toBe('20 0 R');
    });
});


describe('saved markup author history', () => {
    it('keeps authored markup clean after projection, transport, acknowledge, reparse, undo and redo', () => {
        const app = new AnnotationApplication('author-history');
        const original = entity('text-markup');
        if (original.kind !== 'text-markup') throw new Error('Expected markup');
        const created = app.store.createTextMarkup({
            ...original,
            identity: {id: original.identity.id},
            persistedRevision: -1,
            author: 'Анна כהן',
            color: '#ffd400',
            opacity: 0.35,
        });
        const save = app.beginSave();
        const comments = [...app.listCommentSummaries()];
        const markup = buildNativeMarkupMutationForSave({
            canonicalComments: comments,
            changedComments: comments,
            annotationWorkDirty: true,
            markupSubtypeOverrides: undefined,
            markupSubtypeHints: [],
        });
        const hint = normalizePdfNativeMutationSet({markup}, 'mutations').markup!.hints[0]!;
        expect(hint.author).toBe(created.author);
        expect(hint.color).toBe('#ffd400');
        expect(hint.opacity).toBe(0.35);
        app.acknowledgeSave(save, null, [{
            annotationId: created.identity.id,
            pdfRef: '20 0 R',
        }]);
        app.store.replaceFromDocument([mapPdfAnnotationParseEntity({
            kind: 'highlight',
            name: created.identity.id,
            objectNumber: 20,
            generationNumber: 0,
            pageIndex: created.pageIndex,
            createdAt: null,
            modifiedAt: null,
            author: hint.author ?? null,
            subtype: created.subtype,
            contents: hint.contents ?? '',
            quadPoints: hint.markupGeometry ?? [hint.markerRect],
            color: hint.color ?? '#ffff00',
            opacity: hint.opacity ?? 1,
        })], []);
        expect(app.store.hasChangesSinceSavedBaseline()).toBe(false);
        expect(app.store.undo()).toBe(true);
        expect(app.store.hasChangesSinceSavedBaseline()).toBe(true);
        expect(app.store.redo()).toBe(true);
        expect(app.store.get(created.identity.id)?.author).toBe(created.author);
        expect(app.store.hasChangesSinceSavedBaseline()).toBe(false);
        expect(app.store.dirtyEntities()).toEqual([]);
        expect(app.beginSave().plan.expected).toEqual([]);
    });
});
