import {
    describe,
    expect,
    it,
} from 'vitest';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {
    asAnnotationId,
    type AnnotationEntity,
    type IPlacedImageEntity,
    type INoteEntity,
    type IShapeEntity,
    type ITextBoxEntity,
    type ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {requirePageIndex} from '@contracts/pageNumbers';
import {requireEpochMs} from '@contracts/timestamps';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {
    captureCanonicalAnnotationRecovery,
    restoreCanonicalAnnotationRecovery,
    type ICanonicalAnnotationRecovery,
} from '@app/modules/pdf-viewer/annotations/domain/annotationRecovery';

const rect = {
    left: 0.1,
    top: 0.2,
    width: 0.3,
    height: 0.04,
};

function base(id: string) {
    return {
        identity: {id: asAnnotationId(id)},
        pageIndex: requirePageIndex(1),
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: requireEpochMs(1),
        modifiedAt: requireEpochMs(1),
        author: 'Author',
    } as const;
}

function textBox(id = 'text-box'): ITextBoxEntity {
    return {
        ...base(id),
        kind: 'text-box',
        text: 'Text',
        rect,
        rotation: 0,
        fontSize: 12,
        color: '#123456',
    };
}

function note(id = 'note'): INoteEntity {
    return {
        ...base(id),
        kind: 'note',
        contents: 'Contents',
        position: rect,
        color: '#ffcc00',
        open: false,
    };
}

function markup(id = 'markup'): ITextMarkupEntity {
    return {
        ...base(id),
        kind: 'text-markup',
        subtype: 'Highlight',
        contents: 'Contents',
        quadPoints: [rect],
        color: '#ffff00',
        opacity: 0.5,
    };
}

function placedImage(id = 'placed-image'): IPlacedImageEntity {
    return {
        ...base(id),
        kind: 'placed-image',
        rect,
        rotation: 90,
        image: {
            objectNumber: 8,
            generationNumber: 0,
            byteLength: 16,
            sha256: 'abcdef',
        },
    };
}

function shape(id = 'shape'): IShapeEntity {
    return {
        ...base(id),
        kind: 'shape',
        tool: 'rectangle',
        rect,
        points: [{
            x: 0.1,
            y: 0.2,
        }],
        strokes: [[{
            x: 0.1,
            y: 0.2,
        }]],
        strokeColor: '#123456',
        strokeWidth: 2,
        fill: '#ffffff',
        opacity: 1,
    };
}

const creators: ReadonlyArray<[
    string,
    (store: AnnotationStore, entity: AnnotationEntity) => AnnotationEntity,
    () => AnnotationEntity,
]> = [
    [
        'text box',
        (store, entity) => store.createTextBox(entity as ITextBoxEntity),
        textBox,
    ],
    [
        'note',
        (store, entity) => store.createNote(entity as INoteEntity),
        note,
    ],
    [
        'text markup',
        (store, entity) => store.createTextMarkup(entity as ITextMarkupEntity),
        markup,
    ],
    [
        'placed image',
        (store, entity) => store.createPlacedImage(entity as IPlacedImageEntity),
        placedImage,
    ],
    [
        'shape',
        (store, entity) => store.createShape(entity as IShapeEntity),
        shape,
    ],
];

/** The payload as version 1 stored it, without the read revision and changed-field names. */
function asVersion1({annotationReadRevision: _readRevision, changedFields: _changedFields, ...recovery}: ICanonicalAnnotationRecovery) {
    return {...recovery, version: 1 as const};
}

/** Commits a read of the bytes at `revision`, as a parse of the whole document does. */
function readInto(
    store: AnnotationStore,
    entities: readonly AnnotationEntity[],
    revision: string,
    foreign: Parameters<AnnotationStore['replaceFromDocument']>[1] = [],
    preserveSavedBaseline = false,
) {
    store.replaceFromDocument(entities, foreign, undefined, [], [], preserveSavedBaseline, requireDocumentRevisionToken(revision));
}

describe('AnnotationStore public API', () => {
    it('captures and restores a complete revision-fenced canonical recovery state', () => {
        const source = new AnnotationStore();
        const foreign = {
            kind: 'foreign' as const,
            pageIndex: 1,
            subtype: 'Widget',
            name: 'foreign-widget',
            objectNumber: 7,
            generationNumber: 0,
            reason: 'not app-owned',
        };
        source.restoreForeignAnnotations([foreign]);
        const original = source.createNote(note('recovery-note'));
        const deleted = source.createNote(note('deleted-note'));
        const save = source.beginSave();
        source.markPersisted(save);
        source.updateNote(original.identity.id, {contents: 'changed'});
        source.delete(deleted.identity.id);
        const pendingShape = source.createShape(shape('recovery-shape'));
        const recovery = captureCanonicalAnnotationRecovery(source, [{
            annotationId: original.identity.id,
            kind: 'note',
            canonicalRevision: original.revision + 1,
            text: 'typed but not committed',
            generation: 4,
        }]);

        const restored = new AnnotationStore();
        restored.replaceFromDocument([
            {
                ...original,
                revision: 0,
                persistedRevision: 0,
            },
            {
                ...deleted,
                revision: 0,
                persistedRevision: 0,
            },
        ], [{
            ...foreign,
            name: 'parsed-baseline-widget',
        }]);
        const result = restoreCanonicalAnnotationRecovery(restored, recovery);

        expect(result.annotationMutationGeneration).toBe(recovery.annotationMutationGeneration);
        expect(restored.get(original.identity.id)).toMatchObject({
            contents: 'changed',
            revision: 1,
            persistedRevision: 0,
        });
        expect(restored.get(deleted.identity.id)).toMatchObject({
            deleted: true,
            revision: 1,
            persistedRevision: 0,
        });
        expect(result.drafts[0]).toMatchObject({
            text: 'typed but not committed',
            generation: 4,
        });
        expect(restored.get(pendingShape.identity.id)).toEqual(pendingShape);
        expect(restored.hasChangesSinceSavedBaseline('shape')).toBe(true);
        expect(restored.foreign).toEqual([foreign]);
    });

    it('resolves drafts against the detached final capture without retaining mutable store bytes', () => {
        const store = new AnnotationStore();
        const entity = store.createNote(note('captured-note'));
        const recovery = captureCanonicalAnnotationRecovery(store, entities => entities.map(captured => ({
            annotationId: captured.identity.id,
            kind: 'note' as const,
            canonicalRevision: captured.revision,
            text: 'uncommitted note draft',
            generation: 3,
        })));
        store.updateNote(entity.identity.id, {contents: 'later edit'});
        expect(recovery.entities).toEqual([entity]);
        const restored = new AnnotationStore();
        const result = restoreCanonicalAnnotationRecovery(restored, recovery);
        expect(result.draftErrors).toEqual([]);
        expect(result.drafts).toEqual([{
            annotationId: entity.identity.id,
            kind: 'note',
            canonicalRevision: entity.revision,
            text: 'uncommitted note draft',
            generation: 3,
        }]);
        expect(restored.get(entity.identity.id)).toEqual(entity);
    });

    it('rejects malformed and over-sized recovery drafts before admission', () => {
        const store = new AnnotationStore();
        expect(() => captureCanonicalAnnotationRecovery(store, [{
            annotationId: asAnnotationId('draft'),
            kind: 'text-box',
            canonicalRevision: 0,
            text: 'x'.repeat(1_000_001),
            generation: 1,
        }])).toThrow(/supported limit/u);
        expect(() => restoreCanonicalAnnotationRecovery(store, {
            version: 99,
            annotationMutationGeneration: 1,
            entities: [],
            foreign: [],
            drafts: [],
        })).toThrow(/unsupported version/u);
    });

    it('retains an incompatible draft as an error without applying its text', () => {
        const store = new AnnotationStore();
        const entity = store.createTextBox(textBox('mismatched-draft'));
        const result = restoreCanonicalAnnotationRecovery(store, {
            version: 1,
            annotationMutationGeneration: 1,
            entities: [entity],
            foreign: [],
            drafts: [{
                annotationId: entity.identity.id,
                kind: 'text-box',
                canonicalRevision: entity.revision + 1,
                text: 'Retained text',
                generation: 2,
            }],
        });

        expect(result.drafts).toEqual([]);
        expect(result.draftErrors).toMatchObject([{
            annotationId: entity.identity.id,
            text: 'Retained text',
            error: expect.stringContaining('active canonical entity'),
        }]);
        expect(store.get(entity.identity.id)).toMatchObject({text: 'Text'});
    });

    describe('drafts captured while a re-read of other bytes was pending', () => {
        const rotated = {
            left: 0.76,
            top: 0.1,
            width: 0.04,
            height: 0.3,
        };
        const moved = {
            left: 0.5,
            top: 0.6,
            width: 0.3,
            height: 0.04,
        };
        const foreignFreeText = {
            kind: 'foreign' as const,
            pageIndex: 1,
            subtype: 'FreeText',
            name: 'free-text',
            objectNumber: 9,
            generationNumber: 0,
            reason: 'rotated page',
        };
        function editorDraft(id: string, canonicalRevision: number, geometry: typeof rect) {
            return {
                annotationId: asAnnotationId(id),
                kind: 'text-box' as const,
                canonicalRevision,
                text: `${id} editor text`,
                geometry,
                generation: 2,
            };
        }
        // The store as the old bytes read it: saved entities, edits the bytes do not hold and open editors.
        // The recovered bytes' read has every entity in a rotated frame, and one note on the page that moved up.
        function captureDuringReread() {
            const captured = new AnnotationStore();
            readInto(captured, [
                ...['saved-note', 'moved-note', 'typed-note', 'moved-up-note', 'deleted-note'].map(id => note(id)),
                textBox('label'), textBox('moved-label'), textBox('free-text'),
            ], 'rev-1');
            captured.updateNote(asAnnotationId('moved-note'), {position: moved});
            captured.updateNote(asAnnotationId('typed-note'), {contents: 'Typed'});
            captured.updateNote(asAnnotationId('moved-up-note'), {contents: 'Typed'});
            captured.delete(asAnnotationId('deleted-note'));
            captured.updateTextBox(asAnnotationId('moved-label'), {rect: moved});
            const created = captured.createShape(shape('new-shape'));
            const recovery = captureCanonicalAnnotationRecovery(captured, [
                editorDraft('label', 0, rect),
                editorDraft('moved-label', 1, moved),
            ]);
            const recovered = new AnnotationStore();
            readInto(recovered, [
                ...['saved-note', 'moved-note', 'typed-note', 'deleted-note'].map(id => ({...note(id), position: rotated})),
                {...note('moved-up-note'), position: rotated, pageIndex: requirePageIndex(0)},
                {...textBox('label'), rect: rotated, rotation: 90},
                {...textBox('moved-label'), rect: rotated, rotation: 90},
                // On a page the recovered bytes added after the capture.
                {...note('read-only-note'), position: rotated},
            ], 'rev-2', [foreignFreeText]);
            return {recovery, recovered, created};
        }

        it.each([
            ['a version 1 snapshot', (recovery: ICanonicalAnnotationRecovery) => asVersion1(recovery)],
            ['a snapshot taken after the read of the recovered bytes', (recovery: ICanonicalAnnotationRecovery) => ({...recovery, annotationReadRevision: 'rev-2'})],
        ])('replays %s as captured', (_label, payload) => {
            const {recovery, recovered} = captureDuringReread();
            const result = restoreCanonicalAnnotationRecovery(recovered, JSON.parse(JSON.stringify(payload(recovery))));

            expect(recovered.get(asAnnotationId('saved-note'))).toMatchObject({position: rect, contents: 'Contents'});
            expect(recovered.get(asAnnotationId('typed-note'))).toMatchObject({position: rect, contents: 'Typed'});
            expect(recovered.get(asAnnotationId('free-text'))).toMatchObject({rect});
            expect(recovered.foreign).toEqual([]);
            expect(result.drafts[0]).toMatchObject({text: 'label editor text', geometry: rect});
        });

        it('records the revision of the read the snapshot holds', () => {
            expect(captureDuringReread().recovery).toMatchObject({
                version: 2,
                annotationReadRevision: 'rev-1',
                changedFields: {
                    'moved-note': ['position'],
                    'typed-note': ['contents'],
                    'moved-up-note': ['contents'],
                    'deleted-note': ['deleted'],
                    'moved-label': ['rect'],
                },
            });
        });

        it('takes the recovered read\'s entity for an unchanged one and drops its editor rectangle', () => {
            const {recovery, recovered, created} = captureDuringReread();
            const read = recovered.get(asAnnotationId('saved-note'));
            const result = restoreCanonicalAnnotationRecovery(recovered, recovery);

            expect(recovered.get(asAnnotationId('saved-note'))).toEqual(read);
            expect(recovered.get(asAnnotationId('read-only-note'))).toMatchObject({position: rotated});
            expect(recovered.get(asAnnotationId('label'))).toMatchObject({rect: rotated, rotation: 90, text: 'Text'});
            expect(recovered.get(created.identity.id)).toEqual(created);
            expect(result.drafts[0]).toEqual({
                annotationId: asAnnotationId('label'),
                kind: 'text-box',
                canonicalRevision: 0,
                text: 'label editor text',
                generation: 2,
            });
        });

        it('keeps the fields the user changed and takes the read\'s position and page for the others', () => {
            const {recovery, recovered} = captureDuringReread();
            restoreCanonicalAnnotationRecovery(recovered, recovery);

            expect(recovered.get(asAnnotationId('typed-note'))).toMatchObject({position: rotated, pageIndex: 1, contents: 'Typed'});
            expect(recovered.get(asAnnotationId('moved-up-note'))).toMatchObject({position: rotated, pageIndex: 0, contents: 'Typed'});
            expect(recovered.get(asAnnotationId('deleted-note'))).toMatchObject({position: rotated, deleted: true});
            expect(recovered.hasChangesSinceSavedBaseline('note')).toBe(true);
        });

        it('keeps a geometry edit the user made, with its editor rectangle', () => {
            const {recovery, recovered} = captureDuringReread();
            const result = restoreCanonicalAnnotationRecovery(recovered, recovery);

            expect(recovered.get(asAnnotationId('moved-note'))).toMatchObject({position: moved, contents: 'Contents'});
            expect(recovered.get(asAnnotationId('moved-label'))).toMatchObject({rect: moved, rotation: 0});
            expect(result.drafts[1]).toMatchObject({text: 'moved-label editor text', geometry: moved});
        });

        it('keeps moved geometry when the app stops again before the restored read is recorded', () => {
            const {recovery} = captureDuringReread();
            const readOfSameBytes = () => {
                const store = new AnnotationStore();
                readInto(store, [note('saved-note'), note('moved-note'), note('typed-note'), textBox('label'), textBox('moved-label')], 'rev-1');
                return store;
            };
            const firstRestore = readOfSameBytes();
            restoreCanonicalAnnotationRecovery(firstRestore, recovery);
            const secondRestore = readOfSameBytes();
            restoreCanonicalAnnotationRecovery(secondRestore, captureCanonicalAnnotationRecovery(firstRestore));

            expect(secondRestore.get(asAnnotationId('moved-note'))).toMatchObject({position: moved});
            expect(secondRestore.get(asAnnotationId('moved-label'))).toMatchObject({rect: moved});
            expect(secondRestore.get(asAnnotationId('saved-note'))).toMatchObject({position: rect});
            expect(secondRestore.get(asAnnotationId('typed-note'))).toMatchObject({position: rect, contents: 'Typed'});
        });

        it('leaves out a clean entity the recovered read keeps as foreign', () => {
            const {recovery, recovered} = captureDuringReread();
            restoreCanonicalAnnotationRecovery(recovered, recovery);

            expect(recovered.get(asAnnotationId('free-text'))).toBeNull();
            expect(recovered.foreign).toEqual([foreignFreeText]);
        });

        it('replays as captured while the store holds no named read', () => {
            const {recovery} = captureDuringReread();
            const recovered = new AnnotationStore();
            recovered.replaceFromDocument([{...note('saved-note'), position: rotated}], []);
            restoreCanonicalAnnotationRecovery(recovered, recovery);

            expect(recovered.get(asAnnotationId('saved-note'))).toMatchObject({position: rect});
            expect(recovered.get(asAnnotationId('free-text'))).toMatchObject({rect});
        });

        it('restores an edit beside an unchanged imported annotation named like an object property', () => {
            const notes = [note('constructor'), note('edited-note')];
            const captured = new AnnotationStore();
            readInto(captured, notes, 'rev-1');
            captured.updateNote(asAnnotationId('edited-note'), {contents: 'Typed'});
            const recovery = JSON.parse(JSON.stringify(captureCanonicalAnnotationRecovery(captured)));
            const recovered = new AnnotationStore();
            readInto(recovered, notes.map(entry => ({...entry, position: rotated})), 'rev-2');
            restoreCanonicalAnnotationRecovery(recovered, recovery);

            expect(recovered.get(asAnnotationId('edited-note'))).toMatchObject({contents: 'Typed', position: rotated});
            expect(recovered.get(asAnnotationId('constructor'))).toMatchObject({contents: 'Contents', position: rotated});
        });
    });

    describe('an imported annotation without /NM whose page moved', () => {
        // The parser names an annotation without /NM by its page and object, so reading the
        // reordered bytes names the same PDF object anew.
        const onPage = (id: string, pageIndex: number): INoteEntity => ({
            ...note(id),
            identity: {id: asAnnotationId(id), pdfRef: '5 0 R'},
            pageIndex: requirePageIndex(pageIndex),
        });
        const swapPages = {previousPageCount: 2, pages: [{fromPageNumber: 2}, {fromPageNumber: 1}]};
        const noteDraft = (store: AnnotationStore) => ({
            annotationId: asAnnotationId('first-read-id'),
            kind: 'note' as const,
            canonicalRevision: store.get(asAnnotationId('first-read-id'))!.revision,
            text: 'Typed before the crash',
            generation: 3,
        });
        function reorder(edit: (store: AnnotationStore) => void, rereadLanded: boolean) {
            const live = new AnnotationStore();
            readInto(live, [onPage('first-read-id', 1)], 'rev-1');
            edit(live);
            live.remapPages(swapPages);
            if (rereadLanded) readInto(live, [onPage('reordered-read-id', 0)], 'rev-2', [], true);
            const recovery = JSON.parse(JSON.stringify(captureCanonicalAnnotationRecovery(live, [noteDraft(live)])));
            const recovered = new AnnotationStore();
            readInto(recovered, [onPage('reordered-read-id', 0)], 'rev-2');
            return {live, recovery, recovered};
        }

        it.each([
            ['during the re-read', false],
            ['after the re-read', true],
        ])('keeps a note draft typed before a reorder whose crash came %s', (_label, rereadLanded) => {
            const {live, recovery, recovered} = reorder(() => {}, rereadLanded);
            expect(live.get(asAnnotationId('first-read-id'))).toMatchObject({pageIndex: 0});

            const result = restoreCanonicalAnnotationRecovery(recovered, recovery);

            expect(result.drafts).toEqual([{...noteDraft(live), annotationId: asAnnotationId('reordered-read-id')}]);
            expect(recovered.list({includeDeleted: true}).map(entity => entity.identity.id)).toEqual(['reordered-read-id']);
        });

        it('takes the recovered read\'s page for an edited note captured on the page it left', () => {
            const live = new AnnotationStore();
            readInto(live, [onPage('first-read-id', 1)], 'rev-1');
            live.updateNote(asAnnotationId('first-read-id'), {contents: 'Committed'});
            const recovery = JSON.parse(JSON.stringify(captureCanonicalAnnotationRecovery(live)));
            const recovered = new AnnotationStore();
            readInto(recovered, [onPage('reordered-read-id', 0)], 'rev-2');
            restoreCanonicalAnnotationRecovery(recovered, recovery);

            expect(recovery.entities[0]).toMatchObject({pageIndex: 1});
            expect(recovered.list({includeDeleted: true})).toEqual([
                expect.objectContaining({identity: {id: 'reordered-read-id', pdfRef: '5 0 R'}, pageIndex: 0, contents: 'Committed'}),
            ]);
        });

        it.each([
            ['during the re-read', false, 2],
            ['after the re-read', true, 2],
            ['after the re-read, from version 1', true, 1],
        ])('keeps a committed edit and a deletion through a reorder whose crash came %s', (_label, rereadLanded, version) => {
            const edited = reorder(store => store.updateNote(asAnnotationId('first-read-id'), {contents: 'Committed'}), rereadLanded);
            restoreCanonicalAnnotationRecovery(edited.recovered, version === 1 ? asVersion1(edited.recovery) : edited.recovery);
            expect(edited.recovered.list({includeDeleted: true})).toEqual([
                expect.objectContaining({identity: {id: 'reordered-read-id', pdfRef: '5 0 R'}, pageIndex: 0, contents: 'Committed'}),
            ]);
            expect(edited.recovered.hasChangesSinceSavedBaseline('note')).toBe(true);

            // A version 1 snapshot names no changed fields, so its tombstones bind to nothing.
            if (version === 1) return;
            const deleted = reorder(store => store.delete(asAnnotationId('first-read-id')), rereadLanded);
            restoreCanonicalAnnotationRecovery(deleted.recovered, {...deleted.recovery, drafts: []});
            expect(deleted.recovered.list()).toEqual([]);
            expect(deleted.recovered.dirtyEntities()).toEqual([
                expect.objectContaining({identity: {id: 'reordered-read-id', pdfRef: '5 0 R'}, deleted: true}),
            ]);
        });
    });

    describe('a page operation that renumbers the objects', () => {
        // Moving page one to the end renumbers the objects in page order: note B, on page three, takes
        // note A's object 5 0 R, and A becomes 6 0 R. Neither has /NM, so the parser names both anew.
        const noteAt = (id: string, pdfRef: string, pageIndex: number, contents: string): INoteEntity => ({
            ...note(id),
            identity: {id: asAnnotationId(id), pdfRef},
            pageIndex: requirePageIndex(pageIndex),
            contents,
        });
        const firstRead = [noteAt('a-first', '5 0 R', 0, 'A text'), noteAt('b-first', '9 0 R', 2, 'B text')];
        const reorderedRead = [noteAt('b-second', '5 0 R', 1, 'B text'), noteAt('a-second', '6 0 R', 2, 'A text')];
        const moveFirstPageLast = {previousPageCount: 3, pages: [{fromPageNumber: 2}, {fromPageNumber: 3}, {fromPageNumber: 1}]};
        function liveStore(edit: (store: AnnotationStore) => void = () => {}) {
            const store = new AnnotationStore();
            readInto(store, firstRead, 'rev-1');
            store.remapPages(moveFirstPageLast);
            edit(store);
            return store;
        }
        const summary = (store: AnnotationStore) => store.list({includeDeleted: true})
            .map(entity => [entity.identity.id, entity.identity.pdfRef, entity.pageIndex, entity.deleted, (entity as INoteEntity).contents])
            .sort();

        it.each([false, true])('keeps a note deleted while the read was pending deleted and the other note live (saved baseline kept: %s)', (preserveSavedBaseline) => {
            const store = liveStore(live => live.delete(asAnnotationId('a-first')));
            readInto(store, reorderedRead, 'rev-2', [], preserveSavedBaseline);

            expect(summary(store)).toEqual([
                ['a-first', '6 0 R', 2, true, 'A text'],
                ['b-first', '5 0 R', 1, false, 'B text'],
            ]);
        });

        it('merges a note edited while the read was pending into its own object', () => {
            const store = liveStore(live => live.updateNote(asAnnotationId('a-first'), {contents: 'A edited'}));
            readInto(store, reorderedRead, 'rev-2', [], true);

            expect(summary(store)).toEqual([
                ['a-first', '6 0 R', 2, false, 'A edited'],
                ['b-first', '5 0 R', 1, false, 'B text'],
            ]);
        });

        it('gives an inserted note whose minted id names another annotation an id of its own', () => {
            const store = new AnnotationStore();
            readInto(store, [noteAt('minted-a', '5 0 R', 0, 'A text')], 'rev-1');
            // A page inserted before page one: its note takes A's old page and object, and so A's minted id.
            store.remapPages({previousPageCount: 1, pages: [{insertedId: 'inserted-page'}, {fromPageNumber: 1}]});
            readInto(store, [noteAt('minted-a', '5 0 R', 0, 'Inserted'), noteAt('minted-moved', '7 0 R', 1, 'A text')], 'rev-2', [], true);

            const notes = store.list().map(entity => [entity.identity.pdfRef, entity.pageIndex, (entity as INoteEntity).contents]);
            expect(notes.sort()).toEqual([['5 0 R', 0, 'Inserted'], ['7 0 R', 1, 'A text']]);
            expect(store.get(asAnnotationId('minted-a'))).toMatchObject({contents: 'A text', identity: {pdfRef: '7 0 R'}});
        });

        it('leaves notes the working bytes hold twice unmatched rather than deleting one of them', () => {
            const twin = (id: string, pdfRef: string) => noteAt(id, pdfRef, 1, 'Twin');
            const store = new AnnotationStore();
            readInto(store, [twin('t1-first', '5 0 R'), twin('t2-first', '6 0 R')], 'rev-1');
            store.remapPages({previousPageCount: 2, pages: [{fromPageNumber: 2}, {fromPageNumber: 1}]});
            store.delete(asAnnotationId('t1-first'));
            readInto(store, [{...twin('t-x', '3 0 R'), pageIndex: requirePageIndex(0)}, {...twin('t-y', '4 0 R'), pageIndex: requirePageIndex(0)}], 'rev-2', [], true);

            expect(store.list().map(entity => entity.identity.pdfRef).sort()).toEqual(['3 0 R', '4 0 R']);
        });

        it('takes the read\'s replies and recovery graph for a note edited while the read was pending', () => {
            const reply = (objectNumber: number) => ({objectNumber, generationNumber: 0, contents: 'Reply', author: null, createdAt: null, modifiedAt: null});
            const store = new AnnotationStore();
            readInto(store, [{...noteAt('parent-first', '5 0 R', 0, 'Parent'), replies: [reply(7)], recoveryData: 'graph-before'}], 'rev-1');
            store.remapPages({previousPageCount: 2, pages: [{fromPageNumber: 2}, {fromPageNumber: 1}]});
            store.updateNote(asAnnotationId('parent-first'), {contents: 'Parent edited'});
            const recovery = JSON.parse(JSON.stringify(captureCanonicalAnnotationRecovery(store)));
            const reread = {...noteAt('parent-second', '3 0 R', 1, 'Parent'), replies: [reply(4)], recoveryData: 'graph-after'};
            readInto(store, [reread], 'rev-2', [], true);
            expect(store.get(asAnnotationId('parent-first'))).toMatchObject({contents: 'Parent edited', replies: [reply(4)], recoveryData: 'graph-after'});

            const recovered = new AnnotationStore();
            readInto(recovered, [reread], 'rev-2');
            restoreCanonicalAnnotationRecovery(recovered, recovery);
            expect(recovered.list()).toEqual([expect.objectContaining({
                identity: {id: 'parent-second', pdfRef: '3 0 R'}, contents: 'Parent edited', replies: [reply(4)], recoveryData: 'graph-after',
            })]);
        });

        describe('recovered after the app stopped while the read was pending', () => {
            function recoverReordered(edit: (store: AnnotationStore) => void, draftText: string | null) {
                const live = liveStore(edit);
                const draft = draftText === null ? [] : [{
                    annotationId: asAnnotationId('a-first'),
                    kind: 'note' as const,
                    canonicalRevision: live.get(asAnnotationId('a-first'))!.revision,
                    text: draftText,
                    generation: 1,
                }];
                const recovery = JSON.parse(JSON.stringify(captureCanonicalAnnotationRecovery(live, draft)));
                const recovered = new AnnotationStore();
                readInto(recovered, reorderedRead, 'rev-2');
                return {recovered, result: restoreCanonicalAnnotationRecovery(recovered, recovery)};
            }

            it('gives a draft typed into note A, in note B\'s words, to note A and leaves B as read', () => {
                const {recovered, result} = recoverReordered(() => {}, 'B text');

                expect(result.drafts).toEqual([expect.objectContaining({annotationId: 'a-second', text: 'B text'})]);
                expect(summary(recovered)).toEqual([
                    ['a-second', '6 0 R', 2, false, 'A text'],
                    ['b-second', '5 0 R', 1, false, 'B text'],
                ]);
            });

            it('keeps an edit committed to note A, in note B\'s words, on note A', () => {
                const {recovered} = recoverReordered(live => live.updateNote(asAnnotationId('a-first'), {contents: 'B text'}), null);

                expect(summary(recovered)).toEqual([
                    ['a-second', '6 0 R', 2, false, 'B text'],
                    ['b-second', '5 0 R', 1, false, 'B text'],
                ]);
                expect(recovered.dirtyEntities().map(entity => entity.identity.id)).toEqual(['a-second']);
            });

            it('keeps note A\'s deletion on note A', () => {
                const {recovered} = recoverReordered(live => live.delete(asAnnotationId('a-first')), null);

                expect(summary(recovered)).toEqual([
                    ['a-second', '6 0 R', 2, true, 'A text'],
                    ['b-second', '5 0 R', 1, false, 'B text'],
                ]);
            });

            it('keeps a draft of one of two notes it cannot tell apart as a note of its own', () => {
                const twin = (id: string, pdfRef: string, pageIndex: number) => noteAt(id, pdfRef, pageIndex, 'Twin');
                const live = new AnnotationStore();
                readInto(live, [twin('t1-first', '5 0 R', 1), twin('t2-first', '6 0 R', 1)], 'rev-1');
                live.remapPages({previousPageCount: 2, pages: [{fromPageNumber: 2}, {fromPageNumber: 1}]});
                const recovery = JSON.parse(JSON.stringify(captureCanonicalAnnotationRecovery(live, [{
                    annotationId: asAnnotationId('t1-first'), kind: 'note', canonicalRevision: 0, text: 'Typed', generation: 1,
                }])));
                const recovered = new AnnotationStore();
                const reread = [twin('t-x', '5 0 R', 0), twin('t-y', '6 0 R', 0)];
                readInto(recovered, reread, 'rev-2');
                const result = restoreCanonicalAnnotationRecovery(recovered, recovery);

                expect(result.drafts).toEqual([expect.objectContaining({annotationId: 't1-first', text: 'Typed'})]);
                expect(recovered.get(asAnnotationId('t1-first'))).toMatchObject({identity: {id: 't1-first'}, persistedRevision: -1});
                expect(recovered.get(asAnnotationId('t-x'))).toEqual(expect.objectContaining({contents: 'Twin', deleted: false}));
                expect(recovered.get(asAnnotationId('t-y'))).toEqual(expect.objectContaining({contents: 'Twin', deleted: false}));
            });
        });
    });

    describe('the read revision', () => {
        it('names the bytes the last committed read parsed, through a page change until their read commits', () => {
            const store = new AnnotationStore();
            expect(store.readRevision).toBeNull();
            readInto(store, [note('note')], 'rev-1');
            expect(store.readRevision).toBe('rev-1');

            store.remapPages({previousPageCount: 2, pages: [{fromPageNumber: 2}, {fromPageNumber: 1}]});
            expect(store.readRevision).toBe('rev-1');
            // A read of some pages that cannot stand for the document commits nothing.
            expect(store.replaceFromDocument([{...note('note'), pageIndex: requirePageIndex(0)}], [], [1], [], [], false,
                requireDocumentRevisionToken('rev-2'))).toBe(false);
            expect(store.readRevision).toBe('rev-1');
            readInto(store, [{...note('note'), pageIndex: requirePageIndex(0)}], 'rev-2');
            expect(store.readRevision).toBe('rev-2');
            store.replaceFromDocument([note('note')], []);
            expect(store.readRevision).toBeNull();
        });
    });

    describe('the 4 MiB recovery budget', () => {
        const budget = 4 * 1024 * 1024;
        const noteTextLimit = 64 * 1024;
        const encodedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
        // The snapshot as version 1 stored it, without the read revision and changed-field names.
        const snapshotBytes = ({annotationReadRevision: _readRevision, changedFields: _changedFields, ...snapshot}: ICanonicalAnnotationRecovery) => encodedBytes(snapshot);
        // Saved notes, each within the note text limit, and one unsaved edit, captured at `bytes`.
        function editedStoreOfSize(bytes: number) {
            const notes = Array.from({length: 66}, (_, index) => note(`note-${index}`));
            const edited = (entries: INoteEntity[]) => {
                const store = new AnnotationStore();
                readInto(store, entries, 'rev-1');
                store.updateNote(asAnnotationId('note-0'), {contents: 'Typed'});
                return {store, entries};
            };
            let remaining = bytes - snapshotBytes(captureCanonicalAnnotationRecovery(edited(notes).store));
            return edited(notes.map((entry, index) => {
                const length = index === 0 ? 0 : Math.max(0, Math.min(remaining, noteTextLimit - entry.contents.length));
                remaining -= length;
                return {...entry, contents: entry.contents + 'a'.repeat(length)};
            }));
        }

        it('captures a snapshot that fills the budget, its version 2 metadata beside it', () => {
            const {store} = editedStoreOfSize(budget);
            const recovery = captureCanonicalAnnotationRecovery(store);

            expect(snapshotBytes(recovery)).toBe(budget);
            expect(encodedBytes(recovery)).toBeGreaterThan(budget);
            expect(recovery.changedFields).toEqual({'note-0': ['contents']});
            expect(() => captureCanonicalAnnotationRecovery(editedStoreOfSize(budget + 1).store))
                .toThrow(`exceeds the ${budget}-byte annotation budget`);
        });

        it('replays the edit from the largest snapshot capture admits, and admits nothing past the budget', () => {
            const {store, entries} = editedStoreOfSize(budget);
            const stored = JSON.parse(JSON.stringify(captureCanonicalAnnotationRecovery(store)));
            const recovered = new AnnotationStore();
            readInto(recovered, entries, 'rev-2');
            restoreCanonicalAnnotationRecovery(recovered, stored);

            expect(recovered.get(asAnnotationId('note-0'))).toMatchObject({contents: 'Typed'});
            const past = {...stored, entities: stored.entities.map((entity: INoteEntity) => (
                entity.identity.id === 'note-1' ? {...entity, contents: `${entity.contents}a`} : entity
            ))};
            expect(snapshotBytes(past)).toBe(budget + 1);
            expect(() => restoreCanonicalAnnotationRecovery(new AnnotationStore(), past))
                .toThrow(`exceeds the ${budget}-byte annotation budget`);
        });

        it('admits no snapshot capture refuses, incompatible drafts included', () => {
            const {store} = editedStoreOfSize(0);
            const draft = (index: number) => ({
                annotationId: asAnnotationId(`missing-${String(index)}`),
                kind: 'note' as const,
                canonicalRevision: 0,
                text: 'a'.repeat(1_000_000),
                generation: 1,
            });
            const drafts = Array.from({length: 5}, (_, index) => draft(index));
            expect(() => captureCanonicalAnnotationRecovery(store, drafts)).toThrow(`exceeds the ${budget}-byte annotation budget`);
            const stored = {...JSON.parse(JSON.stringify(captureCanonicalAnnotationRecovery(store))), drafts};
            expect(() => restoreCanonicalAnnotationRecovery(new AnnotationStore(), stored)).toThrow(`exceeds the ${budget}-byte annotation budget`);
        });

        it('refuses changed-field names past their own bound', () => {
            const {store} = editedStoreOfSize(0);
            const recovery = captureCanonicalAnnotationRecovery(store);

            expect(() => restoreCanonicalAnnotationRecovery(new AnnotationStore(), {
                ...recovery,
                changedFields: {'note-0': Array.from({length: 33}, (_, index) => `field-${index}`)},
            })).toThrow('Recovery changed fields are invalid');
            expect(() => restoreCanonicalAnnotationRecovery(new AnnotationStore(), {
                ...recovery,
                changedFields: {'not-captured': ['contents']},
            })).toThrow('Recovery changed fields are invalid');
        });
    });

    it.each(creators)('creates a canonical %s', (_label, create, fixture) => {
        const store = new AnnotationStore();
        const entity = fixture();
        const returned = create(store, entity);

        expect(returned).toEqual(entity);
        expect(store.list()).toEqual([entity]);
        expect(store.get(entity.identity.id)).toEqual(entity);
    });

    it('updates every canonical property through one typed transaction per kind', () => {
        const store = new AnnotationStore();
        const box = store.createTextBox(textBox());
        const boxRevision = store.updateTextBox(box.identity.id, {
            text: 'Changed',
            rect: {
                ...rect,
                left: 0.4,
            },
            rotation: 180,
            fontSize: 14,
            color: '#abcdef',
        });
        expect(boxRevision).toMatchObject({
            text: 'Changed',
            rect: {
                ...rect,
                left: 0.4,
            },
            rotation: 180,
            fontSize: 14,
            color: '#abcdef',
            revision: 1,
        });

        const noteEntity = store.createNote(note());
        expect(store.updateNote(noteEntity.identity.id, {
            contents: 'Changed',
            position: {
                ...rect,
                top: 0.5,
            },
            color: '#abcdef',
            open: true,
        })).toMatchObject({
            contents: 'Changed',
            position: {
                ...rect,
                top: 0.5,
            },
            color: '#abcdef',
            open: true,
            revision: 1,
        });

        const markupEntity = store.createTextMarkup(markup());
        expect(store.updateTextMarkup(markupEntity.identity.id, {
            subtype: 'Underline',
            contents: 'Changed',
            quadPoints: [{
                ...rect,
                height: 0.08,
            }],
            color: '#abcdef',
            opacity: 0.75,
        })).toMatchObject({
            subtype: 'Underline',
            contents: 'Changed',
            quadPoints: [{
                ...rect,
                height: 0.08,
            }],
            color: '#abcdef',
            opacity: 0.75,
            revision: 1,
        });

        const imageEntity = store.createPlacedImage(placedImage());
        expect(store.updatePlacedImage(imageEntity.identity.id, {
            rect: {
                ...rect,
                width: 0.6,
            },
            rotation: 270,
            image: {
                ...imageEntity.image,
                byteLength: 32,
            },
        })).toMatchObject({
            rect: {
                ...rect,
                width: 0.6,
            },
            rotation: 270,
            image: {
                ...imageEntity.image,
                byteLength: 32,
            },
            revision: 1,
        });

        const shapeEntity = store.createShape(shape());
        expect(store.updateShape(shapeEntity.identity.id, {
            tool: 'arrow',
            rect: {
                ...rect,
                width: 0.6,
            },
            points: [{
                x: 0.3,
                y: 0.4,
            }],
            strokes: [[{
                x: 0.3,
                y: 0.4,
            }]],
            strokeColor: '#abcdef',
            strokeWidth: 4,
            fill: null,
            opacity: 0.75,
        })).toMatchObject({
            tool: 'arrow',
            rect: {
                ...rect,
                width: 0.6,
            },
            points: [{
                x: 0.3,
                y: 0.4,
            }],
            strokes: [[{
                x: 0.3,
                y: 0.4,
            }]],
            strokeColor: '#abcdef',
            strokeWidth: 4,
            fill: null,
            opacity: 0.75,
            revision: 1,
        });
    });

    it.each(creators)('undoes and redoes one %s transaction exactly', (_label, create, fixture) => {
        const store = new AnnotationStore();
        const entity = fixture();
        create(store, entity);
        const before = store.get(entity.identity.id);
        if (entity.kind === 'text-box') {
            store.updateTextBox(entity.identity.id, {text: 'Changed'});
        } else if (entity.kind === 'note') {
            store.updateNote(entity.identity.id, {contents: 'Changed'});
        } else if (entity.kind === 'text-markup') {
            store.updateTextMarkup(entity.identity.id, {contents: 'Changed'});
        } else if (entity.kind === 'placed-image') {
            store.updatePlacedImage(entity.identity.id, {rotation: 180});
        } else {
            store.updateShape(entity.identity.id, {strokeWidth: 4});
        }
        const after = store.get(entity.identity.id);

        expect(store.undo()).toBe(true);
        expect(store.get(entity.identity.id)).toEqual({
            ...before,
            revision: 2,
        });
        expect(store.redo()).toBe(true);
        expect(store.get(entity.identity.id)).toEqual({
            ...after,
            revision: 3,
        });
    });

    it('deletes in history and restores the exact entity on undo and redo', () => {
        const store = new AnnotationStore();
        const entity = store.createNote(note());
        const before = store.get(entity.identity.id);

        store.delete(entity.identity.id);
        expect(store.get(entity.identity.id)).toMatchObject({
            deleted: true,
            revision: 1,
        });
        expect(store.list()).toEqual([]);
        expect(store.undo()).toBe(true);
        expect(store.get(entity.identity.id)).toEqual({
            ...before,
            revision: 2,
        });
        expect(store.redo()).toBe(true);
        expect(store.get(entity.identity.id)).toMatchObject({deleted: true});
    });

    it('keeps a read-only label exactly as its producer wrote it', () => {
        // review-b7s: a dashed, beveled, inset, underlined or cloudy label is
        // selectable and copyable; no edit, move or delete reaches it.
        const store = new AnnotationStore();
        const label: ITextBoxEntity = {
            ...textBox('dashed-label'),
            identity: {
                id: asAnnotationId('dashed-label'),
                pdfRef: '6R',
            },
            persistedRevision: 0,
            readOnly: true,
        };
        store.import(label);
        expect(() => store.updateTextBox(label.identity.id, {color: '#f59e0b'})).toThrow('Annotation dashed-label is read-only');
        expect(() => store.updateTextBox(label.identity.id, {rect: {
            ...rect,
            left: 0.2,
        }})).toThrow('is read-only');
        expect(() => store.delete(label.identity.id)).toThrow('is read-only');
        expect(store.get(label.identity.id)).toEqual(label);
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('rejects creators with a non-zero initial revision', () => {
        const store = new AnnotationStore();
        expect(() => store.createTextBox({
            ...textBox(),
            revision: 1,
        })).toThrow(
            'New annotations must start at revision 0 with persistedRevision -1',
        );
        expect(() => store.createNote({
            ...note(),
            persistedRevision: 0,
        })).toThrow(
            'New annotations must start at revision 0 with persistedRevision -1',
        );
    });
});
