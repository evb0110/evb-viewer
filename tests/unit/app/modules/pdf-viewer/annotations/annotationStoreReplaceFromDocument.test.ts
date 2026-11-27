import {
    describe,
    expect,
    it,
    vi,
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
    type IShapeEntity,
    type IPlacedImageEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {AnnotationApplication} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {collectNativeTextBoxMutationsForSave} from '@app/modules/pdf-viewer/runtime/save/nativeTextBoxMutations';
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

    describe('a re-read of a rotated page', () => {
        const rotated = {
            left: 0.6,
            top: 0.1,
            width: 0.04,
            height: 0.3,
        };
        const bound = (id: string, pdfRef: string) => ({identity: {
            id: asAnnotationId(id),
            pdfRef,
        }});
        const importedNote = (overrides: Partial<INoteEntity> = {}) => note('imported-note', {
            ...bound('imported-note', '11 0 R'),
            persistedRevision: 0,
            ...overrides,
        });
        const importedHighlight = (overrides: Partial<ITextMarkupEntity> = {}) => textMarkup('imported-highlight', {
            ...bound('imported-highlight', '12 0 R'),
            contents: 'document comment',
            persistedRevision: 0,
            ...overrides,
        });
        const importedLabel = (overrides: Partial<ITextBoxEntity> = {}) => textBox('imported-label', {
            ...bound('imported-label', '13 0 R'),
            persistedRevision: 0,
            ...overrides,
        });
        const otherPageNote = (overrides: Partial<INoteEntity> = {}) => note('other-page-note', {
            ...bound('other-page-note', '14 0 R'),
            pageIndex: requirePageIndex(1),
            persistedRevision: 0,
            ...overrides,
        });
        const opened = () => {
            const store = new AnnotationStore();
            store.replaceFromDocument([
                importedNote(),
                importedHighlight(),
                importedLabel(),
                otherPageNote(),
            ], []);
            return store;
        };
        /** The working bytes after page 1 rotated: the same objects, projected into the turned page. */
        const reread = (store: AnnotationStore, preserveSavedBaseline: boolean) => store.replaceFromDocument([
            importedNote({position: rotated}),
            importedHighlight({quadPoints: [rotated]}),
            importedLabel({
                rect: rotated,
                rotation: 90,
            }),
            otherPageNote(),
        ], [], undefined, [], [], preserveSavedBaseline);

        it.each([
            false,
            true,
        ])('keeps text typed during the re-read and takes the re-read geometry (preserve baseline %s)', (preserveSavedBaseline) => {
            const store = opened();
            store.setNoteText(asAnnotationId('imported-note'), 'typed during re-read');
            store.updateTextMarkup(asAnnotationId('imported-highlight'), {contents: 'comment typed during re-read'});
            store.updateTextBox(asAnnotationId('imported-label'), {text: 'label typed during re-read'});

            expect(reread(store, preserveSavedBaseline)).toBe(true);

            expect(store.get(asAnnotationId('imported-note'))).toMatchObject({
                identity: {pdfRef: '11 0 R'},
                contents: 'typed during re-read',
                position: rotated,
            });
            expect(store.get(asAnnotationId('imported-highlight'))).toMatchObject({
                identity: {pdfRef: '12 0 R'},
                contents: 'comment typed during re-read',
                quadPoints: [rotated],
            });
            expect(store.get(asAnnotationId('imported-label'))).toMatchObject({
                text: 'label typed during re-read',
                rect: rotated,
                rotation: 90,
            });
            expect(store.dirtyEntities().map(entity => entity.identity.id).sort()).toEqual([
                'imported-highlight',
                'imported-label',
                'imported-note',
            ]);
        });

        it.each([
            false,
            true,
        ])('keeps a move made on another page during the re-read (preserve baseline %s)', (preserveSavedBaseline) => {
            const store = opened();
            const moved = {
                ...rect,
                left: 0.5,
                top: 0.6,
            };
            store.updateNote(asAnnotationId('other-page-note'), {position: moved});

            expect(reread(store, preserveSavedBaseline)).toBe(true);

            expect(store.get(asAnnotationId('other-page-note'))).toMatchObject({
                identity: {pdfRef: '14 0 R'},
                position: moved,
            });
            expect(store.dirtyEntities().map(entity => entity.identity.id)).toEqual(['other-page-note']);
            expect(store.get(asAnnotationId('imported-note'))).toMatchObject({position: rotated});
        });

        it.each([
            false,
            true,
        ])('keeps a style change made during the re-read (preserve baseline %s)', (preserveSavedBaseline) => {
            const store = opened();
            store.updateTextMarkup(asAnnotationId('imported-highlight'), {
                color: '#4caf50',
                opacity: 0.5,
            });
            store.updateNote(asAnnotationId('imported-note'), {
                color: '#ff0000',
                open: true,
            });
            store.updateTextBox(asAnnotationId('imported-label'), {fontSize: 18});

            expect(reread(store, preserveSavedBaseline)).toBe(true);

            expect(store.get(asAnnotationId('imported-highlight'))).toMatchObject({
                color: '#4caf50',
                opacity: 0.5,
                quadPoints: [rotated],
            });
            expect(store.get(asAnnotationId('imported-note'))).toMatchObject({
                color: '#ff0000',
                open: true,
                position: rotated,
            });
            expect(store.get(asAnnotationId('imported-label'))).toMatchObject({
                fontSize: 18,
                rect: rotated,
                rotation: 90,
            });
        });

        it.each([
            false,
            true,
        ])('undoes and redoes a text edit made before the re-read over the re-read geometry (preserve baseline %s)', (preserveSavedBaseline) => {
            const store = opened();
            store.setNoteText(asAnnotationId('imported-note'), 'typed during re-read');
            store.updateTextMarkup(asAnnotationId('imported-highlight'), {contents: 'comment typed during re-read'});
            reread(store, preserveSavedBaseline);

            expect(store.undo()).toBe(true);
            expect(store.undo()).toBe(true);
            expect(store.get(asAnnotationId('imported-note'))).toMatchObject({
                contents: 'document contents',
                position: rotated,
            });
            expect(store.get(asAnnotationId('imported-highlight'))).toMatchObject({
                contents: 'document comment',
                quadPoints: [rotated],
            });

            expect(store.redo()).toBe(true);
            expect(store.redo()).toBe(true);
            expect(store.get(asAnnotationId('imported-note'))).toMatchObject({
                identity: {pdfRef: '11 0 R'},
                contents: 'typed during re-read',
                position: rotated,
            });
            expect(store.get(asAnnotationId('imported-highlight'))).toMatchObject({
                identity: {pdfRef: '12 0 R'},
                contents: 'comment typed during re-read',
                quadPoints: [rotated],
            });
        });

        it.each([
            false,
            true,
        ])('restores a note deleted during the re-read with the re-read geometry (preserve baseline %s)', (preserveSavedBaseline) => {
            const store = opened();
            store.delete(asAnnotationId('imported-note'));
            reread(store, preserveSavedBaseline);

            expect(store.get(asAnnotationId('imported-note'))).toMatchObject({
                deleted: true,
                position: rotated,
            });
            expect(store.undo()).toBe(true);
            expect(store.get(asAnnotationId('imported-note'))).toMatchObject({
                deleted: false,
                identity: {pdfRef: '11 0 R'},
                position: rotated,
            });
        });

        it('replays a command in full when nothing outside history changed the annotation', () => {
            const store = opened();
            const moved = {
                ...rect,
                left: 0.5,
            };
            store.updateNote(asAnnotationId('imported-note'), {
                contents: 'edited',
                position: moved,
            });
            const edited = store.get(asAnnotationId('imported-note'));

            expect(store.undo()).toBe(true);
            expect(store.get(asAnnotationId('imported-note'))).toMatchObject({
                contents: 'document contents',
                position: rect,
            });
            expect(store.redo()).toBe(true);
            expect(store.get(asAnnotationId('imported-note'))).toEqual({
                ...edited,
                revision: 3,
                persistedRevision: 2,
            });
            expect(store.dirtyEntities().map(entity => entity.identity.id)).toEqual(['imported-note']);
        });
    });

    it.each([
        false,
        true,
    ])('leaves an untouched import the re-read reports as foreign to the writer (preserve baseline %s)', (preserveSavedBaseline) => {
        const store = new AnnotationStore();
        const label = textBox('imported-label', {
            identity: {
                id: asAnnotationId('imported-label'),
                pdfRef: '7 0 R',
            },
            persistedRevision: 0,
        });
        store.import(label);
        const rotatedLabel = {
            pageIndex: requirePageIndex(0),
            subtype: 'FreeText',
            name: 'imported-label',
            objectNumber: 7,
            generationNumber: 0,
            reason: 'Imported rotated FreeText has no recoverable canonical geometry',
        };

        expect(store.replaceFromDocument([], [rotatedLabel], undefined, [], [], preserveSavedBaseline)).toBe(true);

        expect(store.get(label.identity.id)).toBeNull();
        expect(store.dirtyEntities()).toEqual([]);
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
        expect(store.foreign).toEqual([expect.objectContaining({
            objectNumber: 7,
            generationNumber: 0,
        })]);
    });

    it.each([
        false,
        true,
    ])('keeps an edited import the re-read reports as foreign bound to its object, so Save creates no copy (preserve baseline %s)', async (preserveSavedBaseline) => {
        const application = new AnnotationApplication('edited-foreign-label');
        const id = asAnnotationId('imported-label');
        application.store.import(textBox('imported-label', {
            identity: {
                id,
                pdfRef: '7 0 R',
            },
            persistedRevision: 0,
        }));
        application.store.updateTextBox(id, {text: 'Accepted edit'});
        const rotatedLabel = {
            pageIndex: requirePageIndex(0),
            subtype: 'FreeText',
            name: null,
            objectNumber: 7,
            generationNumber: 0,
            reason: 'Imported rotated FreeText has no recoverable canonical geometry',
        };

        expect(application.store.replaceFromDocument([], [rotatedLabel], undefined, [], [], preserveSavedBaseline)).toBe(true);

        expect(application.store.get(id)).toMatchObject({
            identity: {pdfRef: '7 0 R'},
            text: 'Accepted edit',
        });
        expect(application.store.dirtyEntities().map(entity => entity.identity.id)).toEqual([id]);
        // The writer targets object 7, which it refuses as read-only, instead of appending a second box.
        const mutations = await collectNativeTextBoxMutationsForSave(
            {getPage: async () => ({rotate: 90, view: [0, 0, 612, 792]})},
            application.beginSave().plan,
        );
        expect(mutations).toEqual([expect.objectContaining({annotationId: '7R', text: 'Accepted edit'})]);
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
        store.subscribe(snapshotIncludingDeleted => notifications.push(snapshotIncludingDeleted));
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

describe('AnnotationStore.replaceFromDocument of some pages', () => {
    const reply = (objectNumber: number) => ({
        objectNumber,
        generationNumber: 0,
        contents: 'reply',
        author: null,
        createdAt: null,
        modifiedAt: null,
    });
    const parsedNote = (id: string, pdfRef: string, overrides: Partial<INoteEntity> = {}) => note(id, {
        identity: {
            id: asAnnotationId(id),
            pdfRef,
        },
        ...overrides,
    });
    const foreignOn = (pageIndex: number, objectNumber: number) => ({
        ...foreign(),
        pageIndex: requirePageIndex(pageIndex),
        objectNumber,
    });

    /** A document read whole: notes on pages 1 and 2, a text box on page 3. */
    function documentStore() {
        const store = new AnnotationStore();
        store.replaceFromDocument([
            parsedNote('first', '1 0 R', {contents: 'page one'}),
            parsedNote('gone', '4 0 R'),
            parsedNote('second', '2 0 R', {
                pageIndex: requirePageIndex(1),
                replies: [reply(9)],
            }),
            textBox('third', {
                identity: {
                    id: asAnnotationId('third'),
                    pdfRef: '3 0 R',
                },
                pageIndex: requirePageIndex(2),
            }),
        ], [
            foreignOn(0, 40),
            foreignOn(1, 41),
            foreignOn(2, 42),
        ]);
        return store;
    }

    it('replaces only the pages it read and keeps the rest of the document', () => {
        const store = documentStore();
        const untouched = [
            store.get(asAnnotationId('second')),
            store.get(asAnnotationId('third')),
        ];

        expect(store.replaceFromDocument([
            parsedNote('first', '1 0 R', {contents: 'saved text'}),
            parsedNote('added', '5 0 R', {contents: 'added note'}),
        ], [foreignOn(0, 43)], [0])).toBe(true);

        expect(store.get(asAnnotationId('first'))).toMatchObject({contents: 'saved text'});
        expect(store.get(asAnnotationId('added'))).toMatchObject({identity: {pdfRef: '5 0 R'}});
        expect(store.get(asAnnotationId('gone'))).toBeNull();
        expect([
            store.get(asAnnotationId('second')),
            store.get(asAnnotationId('third')),
        ]).toEqual(untouched);
        expect(store.foreign.map(record => record.objectNumber)).toEqual([
            43,
            41,
            42,
        ]);
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('changes nothing for a parsed annotation the store holds on another page', () => {
        const store = documentStore();
        const before = store.list({includeDeleted: true});

        expect(store.replaceFromDocument([parsedNote('second', '6 0 R')], [], [0])).toBe(false);

        expect(store.list({includeDeleted: true})).toEqual(before);
        expect(store.foreign.map(record => record.objectNumber)).toEqual([
            40,
            41,
            42,
        ]);
    });

    it('changes nothing for a thread without a reply that may sit on a page it did not read', () => {
        const store = documentStore();
        const before = store.list({includeDeleted: true});
        const second = (replies: Array<ReturnType<typeof reply>>) => parsedNote('second', '2 0 R', {
            pageIndex: requirePageIndex(1),
            contents: 'saved text',
            replies,
        });

        expect(store.replaceFromDocument([second([])], [], [1])).toBe(false);
        expect(store.list({includeDeleted: true})).toEqual(before);

        expect(store.replaceFromDocument([second([reply(9)])], [], [1])).toBe(true);
        expect(store.get(asAnnotationId('second'))).toMatchObject({contents: 'saved text'});
    });

    it('accepts only native-confirmed reply losses and keeps other missing replies guarded', () => {
        const store = documentStore();
        const parsed = parsedNote('second', '2 0 R', {
            pageIndex: requirePageIndex(1),
            replies: [],
        });
        const before = store.list({includeDeleted: true});
        expect(store.replaceFromDocument([parsed], [], [1], [], ['10 0 R'])).toBe(false);
        expect(store.list({includeDeleted: true})).toEqual(before);
        expect(store.replaceFromDocument([parsed], [], [1], [], ['9 1 R'])).toBe(false);
        expect(store.replaceFromDocument([parsed], [], [1], [], ['9 0 R'])).toBe(true);
        expect(store.get(asAnnotationId('second'))?.replies).toEqual([]);
        expect(store.get(asAnnotationId('first'))).toEqual(before.find(entity => entity.identity.id === 'first'));
    });

    it('reads some pages before a parse of the whole document without claiming the rest', () => {
        // A save can land before the document's opening parse finishes; the
        // parse of the whole document that follows supplies the other pages.
        const store = new AnnotationStore();

        expect(store.replaceFromDocument([parsedNote('first', '1 0 R')], [], [0])).toBe(true);
        expect(store.get(asAnnotationId('first'))).toMatchObject({contents: 'document contents'});
        expect(store.readWholeDocument).toBe(false);

        expect(store.replaceFromDocument([
            parsedNote('first', '1 0 R', {contents: 'saved'}),
            parsedNote('second', '2 0 R', {pageIndex: requirePageIndex(1)}),
        ], [])).toBe(true);
        expect(store.readWholeDocument).toBe(true);
        expect(store.list().map(entity => entity.identity.id)).toEqual([
            'first',
            'second',
        ]);
        expect(store.get(asAnnotationId('first'))).toMatchObject({contents: 'saved'});
        expect(store.replaceFromDocument([parsedNote('first', '1 0 R')], [], [0])).toBe(true);
        expect(store.readWholeDocument).toBe(true);
    });
});

function simpleShape(id: string): IShapeEntity {
    return {
        ...note(id),
        kind: 'shape',
        tool: 'rectangle',
        rect,
        strokeColor: '#123456',
        strokeWidth: 2,
        fill: null,
        opacity: 1,
    };
}

function placedImage(id: string): IPlacedImageEntity {
    return {
        ...note(id),
        kind: 'placed-image',
        rect,
        rotation: 0,
        image: {
            objectNumber: 42,
            generationNumber: 0,
            byteLength: 20,
            sha256: 'a'.repeat(64),
        },
    };
}

describe('scoped committed additive upserts', () => {
    const factories = [
        textMarkup,
        textBox,
        simpleShape,
        placedImage,
    ];
    it.each(factories)('merges a recognized upsert and retains outside baselines', (factory) => {
        const store = new AnnotationStore();
        const outside = note('outside', {pageIndex: requirePageIndex(1)});
        store.replaceFromDocument([outside], []);
        const added = factory('added');
        if (added.kind === 'shape') {store.createShape(added);}
        else if (added.kind === 'text-box') {store.createTextBox(added);}
        else if (added.kind === 'placed-image') {store.createPlacedImage(added);}
        else {store.createTextMarkup(added);}
        const frontier = store.beginSave();
        store.markPersisted(frontier, [{
            annotationId: 'added',
            pdfRef: '50 0 R',
        }]);
        store.updateNote(outside.identity.id, {contents: 'newer outside edit'});
        const parsed = {
            ...added,
            identity: {
                ...added.identity,
                pdfRef: '50 0 R',
            },
        };
        expect(store.replaceFromDocument([parsed], [], [0], [parsed])).toBe(true);
        expect(store.get(added.identity.id)).toMatchObject({
            identity: {pdfRef: '50 0 R'},
            persistedRevision: 0,
        });
        expect(store.get(outside.identity.id)).toMatchObject({contents: 'newer outside edit'});
        expect(store.dirtyEntities().map(entity => entity.identity.id)).toEqual([outside.identity.id]);
    });

    for (const failure of [
        'missing',
        'foreign',
        'wrong-ref',
        'wrong-kind',
    ] as const) {
        it.each(factories)(`changes nothing when an expected upsert is ${failure}`, (factory) => {
            const store = new AnnotationStore();
            const added = factory('added');
            const expected = {
                ...added,
                identity: {
                    ...added.identity,
                    pdfRef: '50 0 R',
                },
            };
            store.replaceFromDocument([expected], []);
            const before = store.list();
            const epoch = store.mutationEpoch;
            const entries = failure === 'wrong-ref' ? [{
                ...expected,
                identity: {
                    ...expected.identity,
                    pdfRef: '51 0 R',
                },
            }]
                : failure === 'wrong-kind' ? [note('added', {identity: expected.identity})] : [];
            const foreignRecords = failure === 'foreign' ? [{
                ...foreign(),
                pageIndex: requirePageIndex(0),
                objectNumber: 50,
            }] : [];
            expect(store.replaceFromDocument(entries, foreignRecords, [0], [expected])).toBe(false);
            expect(store.list()).toEqual(before);
            expect(store.foreign).toEqual([]);
            expect(store.mutationEpoch).toBe(epoch);
            expect(store.hasChangesSinceSavedBaseline()).toBe(false);
        });
    }

    it('re-reads one page without reaching annotations on other pages', () => {
        const inkOnPage = (id: string, pageIndex: number, persisted = false): IShapeEntity => ({
            kind: 'shape',
            identity: persisted ? {
                id: asAnnotationId(id),
                pdfRef: `${id} 0 R`,
            } : {id: asAnnotationId(id)},
            pageIndex: requirePageIndex(pageIndex),
            revision: 0,
            persistedRevision: persisted ? 0 : -1,
            deleted: false,
            createdAt: requireEpochMs(1),
            modifiedAt: requireEpochMs(1),
            author: null,
            tool: 'draw',
            pdfSubtype: 'Ink',
            rect,
            strokes: [[
                {
                    x: 0.1,
                    y: 0.2,
                },
                {
                    x: 0.3,
                    y: 0.25,
                },
            ]],
            strokeColor: '#d92626',
            strokeWidth: 2,
            fill: null,
            opacity: 1,
        });
        const documentOfPages = (pageCount: number) => {
            const store = new AnnotationStore();
            store.importMany(() => {
                for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
                    for (let slot = 0; slot < 3; slot += 1) {store.import(inkOnPage(`ink-${pageIndex}-${slot}`, pageIndex, true));}
                }
            });
            return store;
        };
        const parseOfPage = (store: AnnotationStore) => store.list()
            .filter(entity => entity.pageIndex === 0)
            .map((entity, index) => (index === 0 && entity.kind === 'shape' ? {
                ...entity,
                strokeColor: '#0000ff',
            } : entity));
        // The work of a one-page read must not grow with the document: count the fingerprints it computes.
        const fingerprintsForPageRead = (pageCount: number) => {
            const store = documentOfPages(pageCount);
            const otherPage = store.list().filter(entity => entity.pageIndex === pageCount - 1);
            const stringify = vi.spyOn(JSON, 'stringify');
            try {
                expect(store.replaceFromDocument(parseOfPage(store), [], [0])).toBe(true);
                return stringify.mock.calls.length;
            } finally {
                stringify.mockRestore();
                expect(store.get(asAnnotationId('ink-0-0'))).toMatchObject({
                    strokeColor: '#0000ff',
                    revision: 0,
                    persistedRevision: 0,
                });
                expect(store.hasChangesSinceSavedBaseline()).toBe(false);
                // Annotations on other pages keep their very objects: the read never rebuilt them.
                otherPage.forEach(entity => expect(store.get(entity.identity.id)).toBe(entity));
                expect(store.list()).toHaveLength(pageCount * 3);
            }
        };
        const small = fingerprintsForPageRead(4);
        expect(small).toBeGreaterThan(0);
        expect(fingerprintsForPageRead(400)).toBe(small);
    });

    it('keeps store order for a page read that adds an annotation and for a page operation Undo', () => {
        const inkOnPage = (id: string, pageIndex: number, persisted = false): IShapeEntity => ({
            kind: 'shape',
            identity: persisted ? {
                id: asAnnotationId(id),
                pdfRef: `${id} 0 R`,
            } : {id: asAnnotationId(id)},
            pageIndex: requirePageIndex(pageIndex),
            revision: 0,
            persistedRevision: persisted ? 0 : -1,
            deleted: false,
            createdAt: requireEpochMs(1),
            modifiedAt: requireEpochMs(1),
            author: null,
            tool: 'draw',
            pdfSubtype: 'Ink',
            rect,
            strokes: [[
                {
                    x: 0.1,
                    y: 0.2,
                },
                {
                    x: 0.3,
                    y: 0.25,
                },
            ]],
            strokeColor: '#d92626',
            strokeWidth: 2,
            fill: null,
            opacity: 1,
        });
        const store = new AnnotationStore();
        store.importMany(() => {
            for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
                for (let slot = 0; slot < 3; slot += 1) {store.import(inkOnPage(`ink-${pageIndex}-${slot}`, pageIndex, true));}
            }
        });
        const before = store.list().map(entity => entity.identity.id);
        const added = inkOnPage('ink-1-new', 1, true);
        expect(store.replaceFromDocument([
            ...store.list().filter(entity => entity.pageIndex === 1),
            added,
        ], [], [1])).toBe(true);
        expect(store.list().map(entity => entity.identity.id)).toEqual([
            ...before,
            added.identity.id,
        ]);
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);

        const state = store.snapshotState();
        store.delete(asAnnotationId('ink-0-0'));
        store.createShape(inkOnPage('later', 2));
        const replaced = store.exchangeState(state);
        expect(store.list().map(entity => entity.identity.id)).toEqual([
            ...before,
            added.identity.id,
        ]);
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
        store.exchangeState(replaced);
        expect(store.list({includeDeleted: true}).map(entity => entity.identity.id)).toEqual([
            ...before,
            added.identity.id,
            asAnnotationId('later'),
        ]);
        expect(store.get(asAnnotationId('ink-0-0'))?.deleted).toBe(true);
        expect(store.hasChangesSinceSavedBaseline()).toBe(true);
    });
});
