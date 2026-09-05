import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    AnnotationStore,
    type IPdfForeignAnnotationRecord,
} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {
    asAnnotationId,
    type AnnotationEntity,
    type ITextBoxEntity,
    type INoteEntity,
    type ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

const rect = {
    left: 0.1,
    top: 0.2,
    width: 0.3,
    height: 0.04,
};

function note(
    id: string,
    overrides: Partial<INoteEntity> = {},
): INoteEntity {
    return {
        identity: {id: asAnnotationId(id)},
        pageIndex: 0,
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: 1,
        modifiedAt: 1,
        author: 'Author',
        kind: 'note',
        contents: 'document contents',
        position: rect,
        color: '#ffff00',
        open: false,
        ...overrides,
    };
}

function textBox(id: string, overrides: Partial<ITextBoxEntity> = {}): ITextBoxEntity {
    return {
        identity: {id: asAnnotationId(id)},
        pageIndex: 0,
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: 1,
        modifiedAt: 1,
        author: 'Author',
        kind: 'text-box',
        text: 'text',
        rect,
        rotation: 0,
        fontSize: 12,
        color: '#123456',
        ...overrides,
    };
}

function textMarkup(id: string, overrides: Partial<ITextMarkupEntity> = {}): ITextMarkupEntity {
    return {
        identity: {id: asAnnotationId(id)},
        pageIndex: 0,
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: 1,
        modifiedAt: 1,
        author: 'Author',
        kind: 'text-markup',
        subtype: 'Highlight',
        contents: '',
        quadPoints: [rect],
        color: '#ffff00',
        opacity: 1,
        selectedText: null,
        ...overrides,
    };
}

function foreign(): IPdfForeignAnnotationRecord {
    return {
        pageIndex: 2,
        subtype: 'Widget',
        name: null,
        objectNumber: 42,
        generationNumber: 0,
        reason: 'not app-owned',
    };
}

describe('AnnotationStore.replaceFromDocument', () => {
    it('updates derived markup text without creating an authored revision', () => {
        const store = new AnnotationStore();
        const markup = store.createTextMarkup(textMarkup('derived-text'));
        const epoch = store.mutationEpoch;
        const canUndo = store.canUndo;

        expect(store.updateTextMarkupSelectedText(markup.identity.id, 'selected text')).toBe(true);
        expect(store.get(markup.identity.id)).toMatchObject({
            selectedText: 'selected text',
            revision: 0,
            persistedRevision: -1,
        });
        expect(store.mutationEpoch).toBe(epoch);
        expect(store.canUndo).toBe(canUndo);
        expect(store.updateTextMarkupSelectedText(markup.identity.id, 'selected text')).toBe(false);
        const missingId = asAnnotationId('missing');
        expect(store.updateTextMarkupSelectedText(missingId, 'selected text')).toBe(false);
        expect(store.get(missingId)).toBeNull();
    });

    it('keeps a dirty local entity and adopts only the parsed PDF reference', () => {
        const store = new AnnotationStore();
        const local = store.createNote(note('paired', {identity: {
            id: asAnnotationId('paired'),
            pdfRef: '3R',
        }}));
        store.updateNote(local.identity.id, {contents: 'local edit'});

        store.replaceFromDocument([note('paired', {
            identity: {
                id: asAnnotationId('paired'),
                pdfRef: '9R',
            },
            contents: 'saved document contents',
            revision: 14,
            persistedRevision: 14,
        })], []);

        expect(store.get(local.identity.id)).toMatchObject({
            contents: 'local edit',
            revision: 1,
            persistedRevision: -1,
            identity: {pdfRef: '9R'},
        });

        // The parsed entity is the saved baseline. Once local content catches
        // up, the store must report semantic equality even though its local
        // revision remains newer than the parsed revision.
        store.updateNote(local.identity.id, {contents: 'saved document contents'});
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('replaces clean entities, inserts parsed entities, and forgets clean omissions', () => {
        const store = new AnnotationStore();
        const clean = store.createTextBox(textBox('clean'));
        store.markPersisted(store.beginSave(), [{
            annotationId: clean.identity.id,
            pdfRef: '1R',
        }]);
        const omitted = store.createTextBox(textBox('omitted'));
        store.markPersisted(store.beginSave(), [{
            annotationId: omitted.identity.id,
            pdfRef: '2R',
        }]);

        store.replaceFromDocument([
            note('parsed', {
                identity: {
                    id: asAnnotationId('parsed'),
                    pdfRef: '7R',
                },
                contents: 'from PDF',
                revision: 88,
                persistedRevision: 88,
            }),
            textBox('clean', {
                identity: {
                    id: asAnnotationId('clean'),
                    pdfRef: '8R',
                },
                text: 'reloaded',
                revision: 99,
                persistedRevision: 99,
            }),
        ], []);

        expect(store.get(clean.identity.id)).toMatchObject({
            text: 'reloaded',
            revision: 0,
            persistedRevision: 0,
            identity: {pdfRef: '8R'},
        });
        expect(store.get(asAnnotationId('parsed'))).toMatchObject({
            contents: 'from PDF',
            revision: 0,
            persistedRevision: 0,
            identity: {pdfRef: '7R'},
        });
        expect(store.get(omitted.identity.id)).toBeNull();
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('keeps stable ids for identical markups when the parser names change', () => {
        const store = new AnnotationStore();
        const ids = [
            'markup-a',
            'markup-b',
            'markup-c',
            'markup-d',
        ].map(id => asAnnotationId(id));
        ids.forEach((id) => {
            store.createTextMarkup(textMarkup(id, {pageIndex: 25}));
        });
        store.markPersisted(store.beginSave(), ids.map((id, index) => ({
            annotationId: id,
            pdfRef: `${index + 1} 0 R`,
        })));
        store.select([ids[2]!]);

        store.replaceFromDocument(ids.map((_, index) => textMarkup(`parsed-${index}`, {
            identity: {
                id: asAnnotationId(`parsed-${index}`),
                pdfRef: `${index + 1} 0 R`,
            },
            pageIndex: 25,
        })), []);

        expect(store.list().map(entity => entity.identity.id)).toEqual(ids);
        expect(store.selectedIds).toEqual(new Set([ids[2]! ]));
    });

    it('retains omitted dirty entities, including tombstones, and intersects selection with live ids', () => {
        const store = new AnnotationStore();
        const deleted = store.createNote(note('deleted'));
        store.markPersisted(store.beginSave(), [{
            annotationId: deleted.identity.id,
            pdfRef: '4R',
        }]);
        store.delete(deleted.identity.id);
        const dirty = store.createNote(note('dirty'));
        store.updateNote(dirty.identity.id, {contents: 'unsaved'});
        const parsed = store.createTextBox(textBox('parsed'));
        store.select([
            dirty.identity.id,
            deleted.identity.id,
            parsed.identity.id,
            asAnnotationId('missing'),
        ]);
        const notifications: Array<readonly AnnotationEntity[]> = [];
        store.subscribe(entities => notifications.push(entities));
        const beforeReplacementNotificationCount = notifications.length;

        store.replaceFromDocument([textBox('parsed', {identity: {
            id: parsed.identity.id,
            pdfRef: '5R',
        }})], [foreign()]);

        expect(store.get(dirty.identity.id)).toMatchObject({contents: 'unsaved'});
        expect(store.get(deleted.identity.id)).toMatchObject({
            deleted: true,
            identity: {},
        });
        expect(store.get(parsed.identity.id)).toMatchObject({identity: {pdfRef: '5R'}});
        expect(store.selectedIds).toEqual(new Set([
            dirty.identity.id,
            parsed.identity.id,
        ]));
        expect(store.foreign).toEqual([foreign()]);
        expect(store.getForeignAnnotations()).toEqual([foreign()]);
        expect(notifications).toHaveLength(beforeReplacementNotificationCount + 1);

        const foreignCopy = store.getForeignAnnotations()[0];
        expect(foreignCopy).toBeDefined();
        Object.assign(foreignCopy!, {reason: 'mutated clone'});
        expect(store.foreign[0]!.reason).toBe('not app-owned');
    });

    it('rejects duplicate parsed ids without changing entities or the foreign report', () => {
        const store = new AnnotationStore();
        const existing = store.createNote(note('existing'));
        const before = store.list({includeDeleted: true});
        expect(() => store.replaceFromDocument([
            note('duplicate'),
            note('duplicate'),
        ], [foreign()])).toThrow('Duplicate parsed AnnotationId');
        expect(store.list({includeDeleted: true})).toEqual(before);
        expect(store.foreign).toEqual([]);
        expect(store.get(existing.identity.id)).toEqual(existing);
    });
});
