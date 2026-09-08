import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    asAnnotationId,
    type AnnotationEntity,
    type INoteEntity,
    type ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {
    buildSerializationPlan,
    verifyAnnotationSave,
} from '@app/modules/pdf-viewer/annotations/persistence/annotationSavePlan';
import {requirePageIndex} from '@contracts/pageNumbers';

function note(id = 'note'): INoteEntity {
    return {
        kind: 'note',
        identity: {id: asAnnotationId(id)},
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
        author: null,
        contents: 'note contents',
        position: {
            left: 0.1,
            top: 0.2,
            width: 0.02,
            height: 0.02,
        },
        color: '#ffcc00',
        open: false,
    };
}

function markup(id = 'markup'): ITextMarkupEntity {
    return {
        kind: 'text-markup',
        identity: {id: asAnnotationId(id)},
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
        author: null,
        subtype: 'Highlight',
        contents: '',
        quadPoints: [{
            left: 0.1,
            top: 0.2,
            width: 0.2,
            height: 0.04,
        }],
        color: '#ffff00',
        opacity: 0.6,
    };
}

function planFor(entity: INoteEntity | ITextMarkupEntity) {
    const store = new AnnotationStore();
    if (entity.kind === 'note') {
        store.createNote(entity);
    } else {
        store.createTextMarkup(entity);
    }
    const frontier = store.beginSave();
    return buildSerializationPlan(
        frontier,
        store.dirtyEntities(),
        store.list({includeDeleted: true}),
    );
}

function expectedMarkup(plan: ReturnType<typeof planFor>): ITextMarkupEntity {
    const expected = plan.expected[0];
    if (!expected || expected.kind !== 'text-markup') {
        throw new Error('Expected a text markup save plan');
    }
    return expected;
}

describe('annotation tombstone serialization', () => {
    function fixtures(): AnnotationEntity[] {
        const base = note();
        const rect = base.position;
        return [
            base,
            markup(),
            {
                ...base,
                kind: 'text-box',
                text: 'draft',
                rect,
                rotation: 0,
                fontSize: 12,
            },
            {
                ...base,
                kind: 'placed-image',
                rect,
                rotation: 0,
                image: {
                    objectNumber: 42,
                    generationNumber: 0,
                    byteLength: 20,
                    sha256: 'a'.repeat(64),
                },
            },
            {
                ...base,
                kind: 'shape',
                tool: 'rectangle',
                rect,
                strokeColor: '#000000',
                strokeWidth: 1,
                fill: null,
                opacity: 1,
            },
        ];
    }

    function capture(store: AnnotationStore) {
        return buildSerializationPlan(store.beginSave(), store.dirtyEntities(), store.list({includeDeleted: true}));
    }

    it.each(fixtures())('does not serialize a never-saved $kind deletion', (entity) => {
        const store = new AnnotationStore();
        store.import(entity);
        store.delete(entity.identity.id);
        const survivor = store.createNote(note('survivor'));
        const plan = capture(store);
        expect(plan.steps.some(step => step.operation === 'delete-annotation')).toBe(false);
        expect(plan.expected.map(value => value.identity.id)).toEqual([survivor.identity.id]);
        expect(store.get(entity.identity.id)?.deleted).toBe(true);
        expect(plan.entities.find(value => value.identity.id === entity.identity.id)?.deleted).toBe(true);
    });

    it.each(fixtures())('keeps a persisted $kind delete even when only its stable identity is available', (entity) => {
        const store = new AnnotationStore();
        store.import({
            ...entity,
            persistedRevision: 0,
        });
        store.delete(entity.identity.id);
        expect(capture(store).steps).toEqual([expect.objectContaining({operation: 'delete-annotation'})]);
    });

    it('keeps PDF-reference deletion proof even before revision acknowledgement', () => {
        const store = new AnnotationStore();
        const entity = note();
        store.import({
            ...entity,
            identity: {
                ...entity.identity,
                pdfRef: '12R',
            },
        });
        store.delete(entity.identity.id);
        expect(capture(store).steps).toEqual([expect.objectContaining({operation: 'delete-annotation'})]);
    });

    it('keeps a materialized shape deletion before its reference is reconciled', () => {
        const store = new AnnotationStore();
        const entity = fixtures().find(value => value.kind === 'shape');
        if (!entity || entity.kind !== 'shape') throw new Error('Expected shape fixture');
        store.import({
            ...entity,
            materialized: true,
        });
        store.delete(entity.identity.id);
        expect(capture(store).steps).toEqual([expect.objectContaining({operation: 'delete-annotation'})]);
    });

    it('restores an unsaved deletion after another annotation is saved', () => {
        const store = new AnnotationStore();
        const draft = store.createNote(note('draft'));
        store.createNote(note('survivor'));
        store.delete(draft.identity.id);
        const plan = capture(store);
        expect(plan.steps.some(step => step.operation === 'delete-annotation')).toBe(false);
        store.markPersisted(plan.frontier, [{
            annotationId: 'survivor',
            pdfRef: '12R',
        }]);
        expect(capture(store).steps).toEqual([]);
        expect(store.undo()).toBe(true);
        expect(capture(store).expected).toEqual([expect.objectContaining({
            deleted: false,
            persistedRevision: -1,
        })]);
        expect(store.redo()).toBe(true);
        expect(capture(store).steps).toEqual([]);
    });

    it('deletes a saved annotation, recreates it on undo, and deletes its new reference on redo', () => {
        const store = new AnnotationStore();
        const draft = store.createNote(note());
        store.markPersisted(store.beginSave(), [{
            annotationId: draft.identity.id,
            pdfRef: '12R',
        }]);
        store.delete(draft.identity.id);
        const deletion = capture(store);
        expect(deletion.steps).toEqual([expect.objectContaining({operation: 'delete-annotation'})]);
        store.markPersisted(deletion.frontier);
        expect(store.undo()).toBe(true);
        const restoration = capture(store);
        expect(restoration.expected).toEqual([expect.objectContaining({
            deleted: false,
            persistedRevision: -1,
        })]);
        store.markPersisted(restoration.frontier, [{
            annotationId: draft.identity.id,
            pdfRef: '24R',
        }]);
        expect(store.redo()).toBe(true);
        expect(capture(store).steps).toEqual([expect.objectContaining({
            operation: 'delete-annotation',
            fields: expect.objectContaining({identity: expect.objectContaining({pdfRef: '24R'})}),
        })]);
    });
});

describe('annotation save reopen verification', () => {
    it('rejects a note whose persisted color differs from the canonical entity', async () => {
        const plan = planFor(note());
        const reopened = {
            ...plan.expected[0]!,
            color: '#00ccff',
        };

        await expect(verifyAnnotationSave(
            Uint8Array.of(1),
            plan,
            {reopen: async () => [reopened]},
        )).rejects.toThrow('note: note color mismatch');
    });

    it('rejects a note whose persisted open state differs from the canonical entity', async () => {
        const plan = planFor({
            ...note(),
            open: true,
        });
        const reopened = {
            ...plan.expected[0]!,
            open: false,
        };

        await expect(verifyAnnotationSave(
            Uint8Array.of(1),
            plan,
            {reopen: async () => [reopened]},
        )).rejects.toThrow('note: note open state mismatch');
    });

    it('rejects a markup whose persisted color differs from the canonical entity', async () => {
        const plan = planFor(markup());
        const reopened = {
            ...expectedMarkup(plan),
            color: '#00ccff',
        };

        await expect(verifyAnnotationSave(
            Uint8Array.of(1),
            plan,
            {reopen: async () => [reopened]},
        )).rejects.toThrow('markup: markup color mismatch');
    });

    it('accepts color casing and Float32 opacity round-trip quantization', async () => {
        const plan = planFor(markup());
        const reopened = {
            ...expectedMarkup(plan),
            color: '#FFFF00',
            opacity: new Float32Array([0.6]).at(0) ?? 0.6,
        };

        await expect(verifyAnnotationSave(
            Uint8Array.of(1),
            plan,
            {reopen: async () => [reopened]},
        )).resolves.toBeUndefined();
    });

    it('rejects a markup whose persisted opacity differs from the canonical entity', async () => {
        const plan = planFor(markup());
        const reopened = {
            ...expectedMarkup(plan),
            opacity: 0.2,
        };

        await expect(verifyAnnotationSave(
            Uint8Array.of(1),
            plan,
            {reopen: async () => [reopened]},
        )).rejects.toThrow('markup: markup opacity mismatch');
    });
});
