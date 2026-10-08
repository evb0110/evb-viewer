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
import {requirePageIndex} from '@contracts/pageNumbers';
import {requireEpochMs} from '@contracts/timestamps';

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
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: requireEpochMs(1),
        modifiedAt: requireEpochMs(1),
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
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: requireEpochMs(1),
        modifiedAt: requireEpochMs(1),
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
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: requireEpochMs(1),
        modifiedAt: requireEpochMs(1),
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
        pageIndex: requirePageIndex(2),
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

    it('keeps a known markup preview when a later text extraction has no result', () => {
        const store = new AnnotationStore();
        const markup = store.createTextMarkup(textMarkup('preview-retention', {
            contents: 'Authored note',
            selectedText: 'selected text',
        }));

        expect(store.updateTextMarkupSelectedText(markup.identity.id, null)).toBe(false);
        expect(store.get(markup.identity.id)).toMatchObject({
            contents: 'Authored note',
            selectedText: 'selected text',
        });
    });

    it('keeps a saved markup preview when the parsed baseline has no extracted text', () => {
        const store = new AnnotationStore();
        const markup = store.createTextMarkup(textMarkup('saved-preview', {
            identity: {
                id: asAnnotationId('saved-preview'),
                pdfRef: '12 0 R',
            },
            selectedText: 'selected text',
        }));
        const frontier = store.beginSave();
        store.markPersisted(frontier, [{
            annotationId: markup.identity.id,
            pdfRef: '12 0 R',
        }]);

        store.replaceFromDocument([textMarkup('saved-preview', {
            identity: {
                id: asAnnotationId('saved-preview'),
                pdfRef: '12 0 R',
            },
            revision: 12,
            persistedRevision: 12,
            quadPoints: [{
                ...rect,
                left: rect.left + 0.00005,
            }],
            selectedText: null,
        })], []);

        expect(store.get(markup.identity.id)).toMatchObject({
            selectedText: 'selected text',
            identity: {pdfRef: '12 0 R'},
        });
    });

    it('invalidates markup preview only when geometry changes', () => {
        const store = new AnnotationStore();
        const movedRect = {
            ...rect,
            left: 0.5,
        };
        const markup = store.createTextMarkup(textMarkup('preview-geometry', {
            contents: 'Authored note',
            selectedText: 'selected text',
        }));

        expect(store.updateTextMarkup(markup.identity.id, {
            color: '#00ff00',
            opacity: 0.5,
            contents: 'Updated note',
        })).toMatchObject({
            contents: 'Updated note',
            selectedText: 'selected text',
        });

        expect(store.updateTextMarkup(markup.identity.id, {quadPoints: [movedRect]})).toMatchObject({
            contents: 'Updated note',
            selectedText: null,
        });
    });

    it('rejects text enrichment resolved for obsolete markup geometry', () => {
        const store = new AnnotationStore();
        const movedRect = {
            ...rect,
            left: 0.5,
        };
        const markup = store.createTextMarkup(textMarkup('stale-enrichment', {
            identity: {
                id: asAnnotationId('stale-enrichment'),
                pdfRef: '12 0 R',
            },
            selectedText: 'selected text',
        }));
        const parsedGeometry = markup.quadPoints;
        store.updateTextMarkup(markup.identity.id, {quadPoints: [movedRect]});

        expect(store.updateTextMarkupSelectedText(markup.identity.id, 'stale text', parsedGeometry)).toBe(false);
        expect(store.get(markup.identity.id)).toMatchObject({selectedText: null});
        expect(store.updateTextMarkupSelectedText(
            markup.identity.id,
            'current text',
            [movedRect],
        )).toBe(true);
        expect(store.get(markup.identity.id)).toMatchObject({selectedText: 'current text'});
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
            store.createTextMarkup(textMarkup(id, {pageIndex: requirePageIndex(25)}));
        });
        store.markPersisted(store.beginSave(), ids.map((id, index) => ({
            annotationId: id,
            pdfRef: `${index + 1} 0 R`,
        })));

        store.replaceFromDocument(ids.map((_, index) => textMarkup(`parsed-${index}`, {
            identity: {
                id: asAnnotationId(`parsed-${index}`),
                pdfRef: `${index + 1} 0 R`,
            },
            pageIndex: requirePageIndex(25),
        })), []);

        expect(store.list().map(entity => entity.identity.id)).toEqual(ids);
    });

    it('keeps fingerprint collisions ambiguous until earlier parsed ids consume candidates', () => {
        const store = new AnnotationStore();
        const first = textMarkup('first', {persistedRevision: 0});
        const second = textMarkup('second', {persistedRevision: 0});
        store.replaceFromDocument([
            first,
            second,
        ], []);

        store.replaceFromDocument([
            textMarkup('ambiguous'),
            first,
            textMarkup('unique-after-first'),
        ], []);

        expect(store.list().map(entity => entity.identity.id)).toEqual([
            first.identity.id,
            second.identity.id,
            asAnnotationId('ambiguous'),
        ]);
        expect(store.get(asAnnotationId('unique-after-first'))).toBeNull();
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('excludes consumed reference candidates after an ambiguous fingerprint lookup', () => {
        const store = new AnnotationStore();
        const first = textMarkup('first', {identity: {
            id: asAnnotationId('first'),
            pdfRef: '1R',
        }});
        const second = textMarkup('second');
        store.replaceFromDocument([
            first,
            second,
        ], []);

        store.replaceFromDocument([
            textMarkup('ambiguous'),
            textMarkup('first', {identity: {
                id: first.identity.id,
                pdfRef: '2R',
            }}),
            textMarkup('renamed-second', {identity: {
                id: asAnnotationId('renamed-second'),
                pdfRef: '1R',
            }}),
        ], []);

        expect(store.list().map(entity => entity.identity.id)).toEqual([
            first.identity.id,
            second.identity.id,
            asAnnotationId('ambiguous'),
        ]);
        expect(store.resolveExternal({pdfRef: '1R'})).toBe(second.identity.id);
        expect(store.resolveExternal({pdfRef: '2R'})).toBe(first.identity.id);
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('does not widen exact reference matches through external-index normalization', () => {
        const store = new AnnotationStore();
        const original = textMarkup('original', {identity: {
            id: asAnnotationId('original'),
            pdfRef: ' 1R ',
        }});
        store.replaceFromDocument([original], []);
        store.updateTextMarkup(original.identity.id, {contents: 'dirty local text'});
        const before = store.list({includeDeleted: true});

        // The raw references differ and the dirty fingerprint differs. A
        // normalized reference match would incorrectly merge the two records.
        expect(() => store.replaceFromDocument([textMarkup('parsed', {identity: {
            id: asAnnotationId('parsed'),
            pdfRef: '1R',
        }})], [])).toThrow('already bound');
        expect(store.list({includeDeleted: true})).toEqual(before);
    });

    it.each([
        {
            label: 'matches exact empty references',
            currentRef: '',
            parsedRef: '',
            matched: true,
        },
        {
            label: 'matches exact whitespace-only references',
            currentRef: ' ',
            parsedRef: ' ',
            matched: true,
        },
        {
            label: 'does not match an empty reference to an undefined reference',
            currentRef: '',
            parsedRef: undefined,
            matched: false,
        },
        {
            label: 'does not match a whitespace-only reference to an empty reference',
            currentRef: ' ',
            parsedRef: '',
            matched: false,
        },
        {
            label: 'does not match distinct whitespace-only references',
            currentRef: ' ',
            parsedRef: '\t',
            matched: false,
        },
    ])('$label', ({
        currentRef, parsedRef, matched,
    }) => {
        const store = new AnnotationStore();
        const original = textMarkup('original', {identity: {
            id: asAnnotationId('original'),
            pdfRef: currentRef,
        }});
        store.replaceFromDocument([original], []);
        store.updateTextMarkup(original.identity.id, {contents: 'dirty local text'});
        store.replaceFromDocument([textMarkup('parsed', {identity: {
            id: asAnnotationId('parsed'),
            ...(parsedRef === undefined ? {} : {pdfRef: parsedRef}),
        }})], []);

        expect(store.list()).toHaveLength(matched ? 1 : 2);
        expect(store.get(original.identity.id)).toMatchObject({
            identity: {pdfRef: currentRef},
            contents: 'dirty local text',
        });
        expect(store.get(asAnnotationId('parsed')) === null).toBe(matched);
        expect(store.undo()).toBe(true);
        expect(store.get(original.identity.id)).toMatchObject({contents: ''});
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('rejects a duplicate caused by remapping without changing state, epoch, or external resolution', () => {
        const store = new AnnotationStore();
        const original = textMarkup('original', {identity: {
            id: asAnnotationId('original'),
            pdfRef: '1R',
        }});
        store.replaceFromDocument([original], [foreign()]);
        const before = store.list({includeDeleted: true});
        const epoch = store.mutationEpoch;
        const canUndo = store.canUndo;
        const canRedo = store.canRedo;

        expect(() => store.replaceFromDocument([
            textMarkup('renamed', {identity: {
                id: asAnnotationId('renamed'),
                pdfRef: '1R',
            }}),
            original,
        ], [])).toThrow('Duplicate parsed AnnotationId original');

        expect(store.list({includeDeleted: true})).toEqual(before);
        expect(store.foreign).toEqual([foreign()]);
        expect(store.mutationEpoch).toBe(epoch);
        expect(store.resolveExternal({pdfRef: '1R'})).toBe(original.identity.id);
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
        expect(store.canUndo).toBe(canUndo);
        expect(store.canRedo).toBe(canRedo);
    });

    it('does not match fingerprints across pages or adopt unsaved non-shape candidates', () => {
        const store = new AnnotationStore();
        const onOtherPage = textMarkup('other-page', {pageIndex: requirePageIndex(1)});
        store.replaceFromDocument([onOtherPage], []);
        const unsaved = store.createTextMarkup(textMarkup('unsaved'));
        store.replaceFromDocument([textMarkup('parsed')], []);

        expect(store.get(onOtherPage.identity.id)).toBeNull();
        expect(store.get(unsaved.identity.id)).not.toBeNull();
        expect(store.get(asAnnotationId('parsed'))).not.toBeNull();
        expect(store.list()).toHaveLength(2);
    });

    it('retains omitted dirty entities, including tombstones', () => {
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
