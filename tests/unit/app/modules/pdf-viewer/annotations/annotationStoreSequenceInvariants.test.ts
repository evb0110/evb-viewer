import {
    describe,
    expect,
    it,
} from 'vitest';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {
    asAnnotationId,
    type AnnotationEntity,
    type INoteEntity,
    type IShapeEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {requirePageIndex} from '@contracts/pageNumbers';

function note(id: string): INoteEntity {
    return {
        identity: {id: asAnnotationId(id)},
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
        author: null,
        kind: 'note',
        contents: id,
        color: '#ffff00',
        open: false,
        position: {
            left: 0.1,
            top: 0.2,
            width: 0.02,
            height: 0.02,
        },
    };
}

function shape(id: string): IShapeEntity {
    const {
        contents: _contents,
        position: _position,
        color: _color,
        open: _open,
        ...base
    } = note(id);
    return {
        ...base,
        kind: 'shape',
        tool: 'rectangle',
        rect: {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.4,
        },
        strokeColor: '#123456',
        strokeWidth: 2,
        fill: null,
        opacity: 1,
    };
}

interface IExpectedEntity {
    id: string;
    value: string;
}

function visible(entities: readonly AnnotationEntity[]): IExpectedEntity[] {
    return entities.filter(entity => !entity.deleted).map(entity => ({
        id: entity.identity.id,
        value: entity.kind === 'note' ? entity.contents : entity.kind === 'shape' ? entity.strokeColor : '',
    })).sort((a, b) => a.id.localeCompare(b.id));
}

describe('AnnotationStore interleaved sequence invariants', () => {
    it('keeps create-delete history without marking an unchanged document dirty', () => {
        const store = new AnnotationStore();
        const entity = store.createNote(note('draft'));
        store.delete(entity.identity.id);

        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
        expect(store.hasChangesSinceSavedBaseline('note')).toBe(false);
        expect(store.canUndo).toBe(true);
        store.undo();
        expect(store.list()).toHaveLength(1);
        expect(store.hasChangesSinceSavedBaseline()).toBe(true);
        store.redo();
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('treats a saved deletion as empty through undo-edit and undo-create', () => {
        const store = new AnnotationStore();
        const entity = store.createNote(note('saved'));
        store.updateNote(entity.identity.id, {contents: 'edited'});
        store.markPersisted(store.beginSave(), [{
            annotationId: entity.identity.id,
            pdfRef: '4R',
        }]);
        store.delete(entity.identity.id);
        expect(store.hasChangesSinceSavedBaseline()).toBe(true);
        store.markPersisted(store.beginSave());
        store.replaceFromDocument([], []);

        store.undo();
        expect(store.hasChangesSinceSavedBaseline()).toBe(true);
        expect(store.get(entity.identity.id)?.identity.pdfRef).toBeUndefined();
        store.undo();
        store.undo();
        expect(store.list()).toEqual([]);
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
        store.redo();
        expect(store.hasChangesSinceSavedBaseline()).toBe(true);
        store.redo();
        store.redo();
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('rejects a save acknowledgement after another kind changes while preserving both edits', () => {
        const store = new AnnotationStore();
        const saved = store.createNote(note('note'));
        const frontier = store.beginSave();
        const later = store.createShape(shape('shape'));
        expect(() => store.markPersisted(frontier)).toThrow(/staleRevisionError/u);
        expect(store.get(saved.identity.id)?.persistedRevision).toBe(-1);
        expect(store.get(later.identity.id)?.persistedRevision).toBe(-1);
        store.undo();
        expect(store.get(saved.identity.id)).not.toBeNull();
        expect(store.get(later.identity.id)).toBeNull();
        expect(store.hasChangesSinceSavedBaseline()).toBe(true);
    });

    it.each([
        1,
        7,
        19,
        42,
        103,
    ])('preserves semantic history across saves and reparses, seed %i', (seed) => {
        const store = new AnnotationStore();
        const imported = {
            ...note('imported'),
            identity: {
                id: asAnnotationId('imported'),
                pdfRef: '1R',
            },
            persistedRevision: 0,
        };
        store.replaceFromDocument([imported], []);
        let expected = visible([imported]);
        let saved = structuredClone(expected);
        const undo: IExpectedEntity[][] = [];
        const redo: IExpectedEntity[][] = [];
        const trace: string[] = [];
        let state = seed;
        let nextId = 0;
        let nextRef = 2;
        function random(max: number) {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return state % max;
        }
        function record() {
            undo.push(structuredClone(expected));
            redo.length = 0;
        }
        for (let step = 0; step < 150; step += 1) {
            const op = random(7);
            if (op === 0 || expected.length === 0 && op < 3) {
                record();
                const id = `authored-${nextId++}`;
                const entity = nextId % 2 ? store.createNote(note(id)) : store.createShape(shape(id));
                expected = [
                    ...expected,
                    ...visible([entity]),
                ].sort((a, b) => a.id.localeCompare(b.id));
                trace.push(`create ${id}`);
            } else if (op === 1 || op === 2) {
                record();
                const entry = expected[random(expected.length)]!;
                const id = asAnnotationId(entry.id);
                if (op === 1) {
                    const entity = store.get(id)!;
                    const value = entity.kind === 'note' ? `edit-${step}` : `#${step.toString(16).padStart(6, '0')}`;
                    if (entity.kind === 'note') store.updateNote(id, {contents: value});
                    else store.updateShape(id, {strokeColor: value});
                    expected = expected.map(item => item.id === id ? {
                        ...item,
                        value,
                    } : item);
                    trace.push(`edit ${id}`);
                } else {
                    store.delete(id);
                    expected = expected.filter(item => item.id !== id);
                    trace.push(`delete ${id}`);
                }
            } else if (op === 3) {
                trace.push('undo');
                expect(store.undo(), trace.join('\n')).toBe(undo.length > 0);
                if (undo.length) {
                    redo.push(structuredClone(expected));
                    expected = undo.pop()!;
                }
            } else if (op === 4) {
                trace.push('redo');
                expect(store.redo(), trace.join('\n')).toBe(redo.length > 0);
                if (redo.length) {
                    undo.push(structuredClone(expected));
                    expected = redo.pop()!;
                }
            } else if (op === 5) {
                trace.push('save and reparse');
                store.markPersisted(store.beginSave(), store.list().map(entity => ({
                    annotationId: entity.identity.id,
                    pdfRef: `${nextRef++}R`,
                })));
                saved = structuredClone(expected);
                const parsed = store.list().map(entity => ({
                    ...entity,
                    identity: {
                        id: asAnnotationId(`parsed-${entity.identity.pdfRef}`),
                        pdfRef: entity.identity.pdfRef!,
                    },
                    revision: 0,
                    persistedRevision: 0,
                }));
                store.replaceFromDocument(parsed, []);
            } else {
                trace.push('selection transition');
                store.select(expected.map(entity => asAnnotationId(entity.id)));
                store.clearSelection();
            }
            expect(visible(store.list()), trace.join('\n')).toEqual(expected);
            expect(store.hasChangesSinceSavedBaseline(), trace.join('\n')).toBe(JSON.stringify(expected) !== JSON.stringify(saved));
        }
    });
});
