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

const rect = {
    left: 0.1,
    top: 0.2,
    width: 0.3,
    height: 0.04,
};

function base(id: string) {
    return {
        identity: {id: asAnnotationId(id)},
        pageIndex: 1,
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: 1,
        modifiedAt: 1,
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
        expect(store.get(entity.identity.id)).toEqual(before);
        expect(store.redo()).toBe(true);
        expect(store.get(entity.identity.id)).toEqual(after);
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
        expect(store.get(entity.identity.id)).toEqual(before);
        expect(store.redo()).toBe(true);
        expect(store.get(entity.identity.id)).toMatchObject({deleted: true});
    });

    it('keeps selection in the store, clones it, and intersects it with live ids', () => {
        const store = new AnnotationStore();
        const first = store.createNote(note('first'));
        const second = store.createNote(note('second'));
        const selected = store.selectedIds as Set<typeof first.identity.id>;

        store.select([
            first.identity.id,
            second.identity.id,
            asAnnotationId('missing'),
        ]);
        expect(store.selectedIds).toEqual(new Set([
            first.identity.id,
            second.identity.id,
        ]));
        selected.add(asAnnotationId('outside'));
        expect(store.selectedIds).toEqual(new Set([
            first.identity.id,
            second.identity.id,
        ]));

        store.delete(first.identity.id);
        expect(store.selectedIds).toEqual(new Set([second.identity.id]));
        store.clearSelection();
        expect(store.selectedIds).toEqual(new Set());
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
