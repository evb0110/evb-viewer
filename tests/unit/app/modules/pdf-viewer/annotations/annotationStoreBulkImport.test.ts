import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    asAnnotationId,
    type INoteEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { requirePageIndex } from '@contracts/pageNumbers';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';

function persistedNote(id: string, contents = id): INoteEntity {
    return {
        kind: 'note',
        identity: {
            id: asAnnotationId(id),
            pdfRef: `${id}-ref`,
        },
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: 0,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
        author: null,
        contents,
        position: {
            left: 0.1,
            top: 0.2,
            width: 0.1,
            height: 0.1,
        },
        color: '#ffff00',
        open: false,
    };
}

function semanticFingerprintCalls(calls: readonly unknown[][]) {
    return calls.filter(([value]) => (
        typeof value === 'object'
        && value !== null
        && 'kind' in value
        && 'pageIndex' in value
    ));
}

describe('AnnotationStore bulk imports', () => {
    it('advances a clean persisted baseline without rescanning the whole store', () => {
        const store = new AnnotationStore();
        const entities = Array.from({length: 32}, (_, index) => persistedNote(`persisted-${index}`));
        const stringify = vi.spyOn(JSON, 'stringify');
        const callsBeforeImport = stringify.mock.calls.length;

        try {
            store.importMany(() => {
                entities.forEach(entity => store.import(entity));
            });

            const importCalls = semanticFingerprintCalls(stringify.mock.calls.slice(callsBeforeImport));
            expect(importCalls).toHaveLength(entities.length);
            expect(store.hasChangesSinceSavedBaseline()).toBe(false);
        } finally {
            stringify.mockRestore();
        }
    });

    it('publishes one snapshot for a bulk import, however many entities it brings', () => {
        const store = new AnnotationStore();
        const published = vi.fn();
        store.subscribe(published);
        published.mockClear();

        store.importMany(() => {
            Array.from({length: 64}, (_, index) => persistedNote(`recovered-${index}`))
                .forEach(entity => store.import(entity, {preserveSavedBaseline: true}));
        });

        expect(published).toHaveBeenCalledTimes(1);
        expect(store.list()).toHaveLength(64);
    });

    it('keeps a dirty store dirty when persisted entities arrive in bulk', () => {
        const store = new AnnotationStore();
        const savedId = asAnnotationId('saved');
        store.import(persistedNote(savedId));
        store.createNote({
            ...persistedNote('draft'),
            identity: {id: asAnnotationId('draft')},
            persistedRevision: -1,
        });

        store.importMany(() => {
            store.import(persistedNote('new-persisted'));
        });

        expect(store.hasChangesSinceSavedBaseline()).toBe(true);
        expect(store.get(savedId)).toEqual(expect.objectContaining({persistedRevision: 0}));
    });

    it('falls back after identity rebinding without dirtying semantic content', () => {
        const store = new AnnotationStore();
        const entity = persistedNote('bound');
        store.import(entity);
        const stringify = vi.spyOn(JSON, 'stringify');
        const callsBeforeImport = stringify.mock.calls.length;

        try {
            store.importMany(() => {
                store.bindIdentity({
                    annotationId: entity.identity.id,
                    expectedRevision: entity.revision,
                    bindings: {pdfRef: 'bound-ref-2'},
                });
                store.import({
                    ...entity,
                    identity: {
                        ...entity.identity,
                        pdfRef: 'bound-ref-2',
                    },
                    revision: entity.revision + 1,
                });
            });

            const importCalls = semanticFingerprintCalls(stringify.mock.calls.slice(callsBeforeImport));
            expect(importCalls).toHaveLength(3);
            expect(store.hasChangesSinceSavedBaseline()).toBe(false);
            expect(store.get(entity.identity.id)?.identity.pdfRef).toBe('bound-ref-2');
        } finally {
            stringify.mockRestore();
        }
    });

    it('keeps a no-op identity binding on the bulk fast path', () => {
        const store = new AnnotationStore();
        const entity = persistedNote('same');
        store.import(entity);
        const stringify = vi.spyOn(JSON, 'stringify');
        const callsBeforeImport = stringify.mock.calls.length;

        try {
            store.importMany(() => {
                store.bindIdentity({
                    annotationId: entity.identity.id,
                    expectedRevision: entity.revision,
                    bindings: {pdfRef: 'same-ref'},
                });
                store.import(persistedNote('next'));
            });

            const importCalls = semanticFingerprintCalls(stringify.mock.calls.slice(callsBeforeImport));
            expect(importCalls).toHaveLength(2);
        } finally {
            stringify.mockRestore();
        }
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('falls back after a dirty import restores the saved content', () => {
        const store = new AnnotationStore();
        const entity = persistedNote('restore', 'saved');
        store.import(entity);
        store.setNoteText(entity.identity.id, 'edited');

        store.importMany(() => {
            store.import({
                ...entity,
                revision: 1,
            });
            store.import({
                ...entity,
                revision: 2,
                contents: 'saved again',
            });
        });

        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('disables the fast path after a generic authored mutation', () => {
        const store = new AnnotationStore();
        const entity = persistedNote('mutated');
        store.import(entity);

        store.importMany(() => {
            store.setNoteText(entity.identity.id, 'edited');
            store.import(persistedNote('arrived-after-edit'));
        });

        expect(store.hasChangesSinceSavedBaseline()).toBe(true);
    });
});
