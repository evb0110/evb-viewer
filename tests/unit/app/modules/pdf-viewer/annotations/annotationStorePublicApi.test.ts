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
            captured.replaceFromDocument([
                ...['saved-note', 'moved-note', 'typed-note', 'moved-up-note', 'deleted-note'].map(id => note(id)),
                textBox('label'), textBox('moved-label'), textBox('free-text'),
            ], []);
            captured.updateNote(asAnnotationId('moved-note'), {position: moved});
            captured.updateNote(asAnnotationId('typed-note'), {contents: 'Typed'});
            captured.updateNote(asAnnotationId('moved-up-note'), {contents: 'Typed'});
            captured.delete(asAnnotationId('deleted-note'));
            captured.updateTextBox(asAnnotationId('moved-label'), {rect: moved});
            const created = captured.createShape(shape('new-shape'));
            const recovery = captureCanonicalAnnotationRecovery(captured, [
                editorDraft('label', 0, rect),
                editorDraft('moved-label', 1, moved),
            ], 'rev-1');
            const recovered = new AnnotationStore();
            recovered.replaceFromDocument([
                ...['saved-note', 'moved-note', 'typed-note', 'deleted-note'].map(id => ({...note(id), position: rotated})),
                {...note('moved-up-note'), position: rotated, pageIndex: requirePageIndex(0)},
                {...textBox('label'), rect: rotated, rotation: 90},
                {...textBox('moved-label'), rect: rotated, rotation: 90},
            ], [foreignFreeText]);
            return {recovery, recovered, created};
        }

        it.each([
            ['a version 1 snapshot', (recovery: ICanonicalAnnotationRecovery) => ({...recovery, version: 1, annotationReadRevision: undefined})],
            ['a snapshot taken after the read of the recovered bytes', (recovery: ICanonicalAnnotationRecovery) => ({...recovery, annotationReadRevision: 'rev-2'})],
        ])('replays %s as captured', (_label, payload) => {
            const {recovery, recovered} = captureDuringReread();
            const result = restoreCanonicalAnnotationRecovery(recovered, payload(recovery), 'rev-2');

            expect(recovered.get(asAnnotationId('saved-note'))).toMatchObject({position: rect, contents: 'Contents'});
            expect(recovered.get(asAnnotationId('typed-note'))).toMatchObject({position: rect, contents: 'Typed'});
            expect(recovered.get(asAnnotationId('free-text'))).toMatchObject({rect});
            expect(recovered.foreign).toEqual([]);
            expect(result.drafts[0]).toMatchObject({text: 'label editor text', geometry: rect});
        });

        it('takes the recovered read\'s entity for an unchanged one and drops its editor rectangle', () => {
            const {recovery, recovered, created} = captureDuringReread();
            const read = recovered.get(asAnnotationId('saved-note'));
            const result = restoreCanonicalAnnotationRecovery(recovered, recovery, 'rev-2');

            expect(recovered.get(asAnnotationId('saved-note'))).toEqual(read);
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
            restoreCanonicalAnnotationRecovery(recovered, recovery, 'rev-2');

            expect(recovered.get(asAnnotationId('typed-note'))).toMatchObject({position: rotated, pageIndex: 1, contents: 'Typed'});
            expect(recovered.get(asAnnotationId('moved-up-note'))).toMatchObject({position: rotated, pageIndex: 0, contents: 'Typed'});
            expect(recovered.get(asAnnotationId('deleted-note'))).toMatchObject({position: rotated, deleted: true});
            expect(recovered.hasChangesSinceSavedBaseline('note')).toBe(true);
        });

        it('keeps a geometry edit the user made, with its editor rectangle', () => {
            const {recovery, recovered} = captureDuringReread();
            const result = restoreCanonicalAnnotationRecovery(recovered, recovery, 'rev-2');

            expect(recovered.get(asAnnotationId('moved-note'))).toMatchObject({position: moved, contents: 'Contents'});
            expect(recovered.get(asAnnotationId('moved-label'))).toMatchObject({rect: moved, rotation: 0});
            expect(result.drafts[1]).toMatchObject({text: 'moved-label editor text', geometry: moved});
        });

        it('keeps moved geometry when the app stops again before the restored read is recorded', () => {
            const {recovery} = captureDuringReread();
            const readOfSameBytes = () => {
                const store = new AnnotationStore();
                store.replaceFromDocument([note('saved-note'), note('moved-note'), note('typed-note'), textBox('label'), textBox('moved-label')], []);
                return store;
            };
            const firstRestore = readOfSameBytes();
            restoreCanonicalAnnotationRecovery(firstRestore, recovery, 'rev-1');
            const secondRestore = readOfSameBytes();
            restoreCanonicalAnnotationRecovery(secondRestore, captureCanonicalAnnotationRecovery(firstRestore, [], null), 'rev-1');

            expect(secondRestore.get(asAnnotationId('moved-note'))).toMatchObject({position: moved});
            expect(secondRestore.get(asAnnotationId('moved-label'))).toMatchObject({rect: moved});
            expect(secondRestore.get(asAnnotationId('saved-note'))).toMatchObject({position: rect});
            expect(secondRestore.get(asAnnotationId('typed-note'))).toMatchObject({position: rect, contents: 'Typed'});
        });

        it('leaves out a clean entity the recovered read keeps as foreign', () => {
            const {recovery, recovered} = captureDuringReread();
            restoreCanonicalAnnotationRecovery(recovered, recovery, 'rev-2');

            expect(recovered.get(asAnnotationId('free-text'))).toBeNull();
            expect(recovered.foreign).toEqual([foreignFreeText]);
        });

        it('replays as captured while the store holds no read', () => {
            const {recovery, recovered} = captureDuringReread();
            restoreCanonicalAnnotationRecovery(recovered, recovery, null);

            expect(recovered.get(asAnnotationId('saved-note'))).toMatchObject({position: rect});
            expect(recovered.get(asAnnotationId('free-text'))).toMatchObject({rect});
        });

        it('restores an edit beside an unchanged imported annotation named like an object property', () => {
            const notes = [note('constructor'), note('edited-note')];
            const captured = new AnnotationStore();
            captured.replaceFromDocument(notes, []);
            captured.updateNote(asAnnotationId('edited-note'), {contents: 'Typed'});
            const recovery = JSON.parse(JSON.stringify(captureCanonicalAnnotationRecovery(captured, [], 'rev-1')));
            const recovered = new AnnotationStore();
            recovered.replaceFromDocument(notes.map(entry => ({...entry, position: rotated})), []);
            restoreCanonicalAnnotationRecovery(recovered, recovery, 'rev-2');

            expect(recovered.get(asAnnotationId('edited-note'))).toMatchObject({contents: 'Typed', position: rotated});
            expect(recovered.get(asAnnotationId('constructor'))).toMatchObject({contents: 'Contents', position: rotated});
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
                store.replaceFromDocument(entries, []);
                store.updateNote(asAnnotationId('note-0'), {contents: 'Typed'});
                return {store, entries};
            };
            let remaining = bytes - snapshotBytes(captureCanonicalAnnotationRecovery(edited(notes).store, [], 'rev-1'));
            return edited(notes.map((entry, index) => {
                const length = index === 0 ? 0 : Math.max(0, Math.min(remaining, noteTextLimit - entry.contents.length));
                remaining -= length;
                return {...entry, contents: entry.contents + 'a'.repeat(length)};
            }));
        }

        it('captures a snapshot that fills the budget, its version 2 metadata beside it', () => {
            const {store} = editedStoreOfSize(budget);
            const recovery = captureCanonicalAnnotationRecovery(store, [], 'rev-1');

            expect(snapshotBytes(recovery)).toBe(budget);
            expect(encodedBytes(recovery)).toBeGreaterThan(budget);
            expect(recovery.changedFields).toEqual({'note-0': ['contents']});
            expect(() => captureCanonicalAnnotationRecovery(editedStoreOfSize(budget + 1).store, [], 'rev-1'))
                .toThrow(`exceeds the ${budget}-byte annotation budget`);
        });

        it('replays the edit from a snapshot admitted at the budget, and admits nothing past it', () => {
            // Admission measures the snapshot with its derived draft errors, 17 bytes for none.
            const {store, entries} = editedStoreOfSize(budget - 17);
            const stored = JSON.parse(JSON.stringify(captureCanonicalAnnotationRecovery(store, [], 'rev-1')));
            const recovered = new AnnotationStore();
            recovered.replaceFromDocument(entries, []);
            restoreCanonicalAnnotationRecovery(recovered, stored, 'rev-2');

            expect(recovered.get(asAnnotationId('note-0'))).toMatchObject({contents: 'Typed'});
            const past = editedStoreOfSize(budget - 16);
            expect(() => restoreCanonicalAnnotationRecovery(new AnnotationStore(), JSON.parse(JSON.stringify(
                captureCanonicalAnnotationRecovery(past.store, [], 'rev-1'),
            )), 'rev-2')).toThrow(`exceeds the ${budget}-byte annotation budget`);
        });

        it('refuses changed-field names past their own bound', () => {
            const {store} = editedStoreOfSize(0);
            const recovery = captureCanonicalAnnotationRecovery(store, [], 'rev-1');

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
