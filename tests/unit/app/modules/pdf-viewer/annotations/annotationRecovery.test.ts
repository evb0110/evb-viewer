import {performance} from 'node:perf_hooks';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    asAnnotationId,
    type INoteEntity,
    type ITextBoxEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {
    AnnotationRecoveryAdmissionError,
    CANONICAL_ANNOTATION_RECOVERY_VERSION,
    captureCanonicalAnnotationRecovery,
    restoreCanonicalAnnotationRecovery,
    validateCanonicalAnnotationRecovery,
    type ICanonicalAnnotationRecovery,
} from '@app/modules/pdf-viewer/annotations/domain/annotationRecovery';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requirePageIndex} from '@contracts/pageNumbers';
import {requireEpochMs} from '@contracts/timestamps';

function makeNote(
    id: string,
    pageIndex: number,
    overrides: Partial<INoteEntity> = {},
): INoteEntity {
    return {
        kind: 'note',
        identity: {id: asAnnotationId(id)},
        pageIndex: requirePageIndex(pageIndex),
        revision: 0,
        persistedRevision: 0,
        deleted: false,
        createdAt: requireEpochMs(1_780_000_000_000),
        modifiedAt: requireEpochMs(1_780_000_000_100),
        author: 'Author',
        contents: 'Body',
        position: {
            left: 0.1,
            top: 0.2,
            width: 0.05,
            height: 0.05,
        },
        color: '#ffcc00',
        open: false,
        ...overrides,
    };
}

function makeTextBox(
    id: string,
    pageIndex: number,
    overrides: Partial<ITextBoxEntity> = {},
): ITextBoxEntity {
    return {
        kind: 'text-box',
        identity: {id: asAnnotationId(id)},
        pageIndex: requirePageIndex(pageIndex),
        revision: 0,
        persistedRevision: 0,
        deleted: false,
        createdAt: requireEpochMs(1_780_000_000_000),
        modifiedAt: requireEpochMs(1_780_000_000_100),
        author: 'Author',
        text: 'Hello',
        rect: {
            left: 0.1,
            top: 0.2,
            width: 0.2,
            height: 0.1,
        },
        rotation: 0,
        fontSize: 12,
        color: '#000000',
        ...overrides,
    };
}

function createStoreWithReadRevision(entities: readonly (INoteEntity | ITextBoxEntity)[], revision: string) {
    const store = new AnnotationStore();
    store.importMany(() => {
        for (const entity of entities) {
            store.import(entity);
        }
    });
    Object.defineProperty(store, 'readRevision', {
        configurable: true,
        get: () => requireDocumentRevisionToken(revision),
    });
    return store;
}

describe('canonical annotation recovery indexing and uniqueness', () => {
    it('validates drafts in O(D + C), rejects duplicates, and records draft mismatches', () => {
        const active = makeNote('active-1', 0, {revision: 2});
        const deleted = makeNote('deleted-1', 0, {
            revision: 1,
            deleted: true,
        });
        const payload: ICanonicalAnnotationRecovery = {
            version: CANONICAL_ANNOTATION_RECOVERY_VERSION,
            annotationReadRevision: requireDocumentRevisionToken('rev-1'),
            changedFields: {},
            annotationMutationGeneration: 3,
            entities: [
                active,
                deleted,
            ],
            drafts: [
                {
                    annotationId: active.identity.id,
                    kind: 'note',
                    canonicalRevision: 2,
                    text: 'ok',
                    generation: 3,
                },
                {
                    annotationId: deleted.identity.id,
                    kind: 'note',
                    canonicalRevision: 1,
                    text: 'deleted target',
                    generation: 3,
                },
                {
                    annotationId: asAnnotationId('missing-id'),
                    kind: 'note',
                    canonicalRevision: 0,
                    text: 'missing target',
                    generation: 3,
                },
            ],
        };

        const validated = validateCanonicalAnnotationRecovery(payload);
        expect(validated.drafts).toHaveLength(1);
        expect(validated.drafts[0]?.annotationId).toBe(active.identity.id);
        expect(validated.draftErrors).toHaveLength(2);

        expect(() => validateCanonicalAnnotationRecovery({
            ...payload,
            entities: [
                active,
                active,
            ],
        })).toThrow(AnnotationRecoveryAdmissionError);
    });

    it('preserves global vs per-page uniqueness and leaves ambiguous reread candidates detached', () => {
        // Two identical notes on different pages -> pageIndex tie-breaker binds each uniquely.
        // Two identical notes on page 2 -> ambiguous on page, must remain detached.
        const page0Note = makeNote('reread-p0', 0, {
            identity: {
                id: asAnnotationId('reread-p0'),
                pdfRef: '10 0 R',
            },
            author: 'Shared',
            contents: 'Original',
        });
        const page1Note = makeNote('reread-p1', 1, {
            identity: {
                id: asAnnotationId('reread-p1'),
                pdfRef: '11 0 R',
            },
            author: 'Shared',
            contents: 'Original',
        });
        const ambigA = makeNote('reread-ambig-a', 2, {
            identity: {
                id: asAnnotationId('reread-ambig-a'),
                pdfRef: '12 0 R',
            },
            author: 'Ambiguous',
            contents: 'Original',
        });
        const ambigB = makeNote('reread-ambig-b', 2, {
            identity: {
                id: asAnnotationId('reread-ambig-b'),
                pdfRef: '13 0 R',
            },
            author: 'Ambiguous',
            contents: 'Original',
        });

        // Capture a real v3 plan (with heldFields digests) from a pre-renumber store.
        const sourceStore = new AnnotationStore();
        sourceStore.replaceFromDocument([
            makeNote('old-p0', 0, {
                identity: {
                    id: asAnnotationId('old-p0'),
                    pdfRef: '90 0 R',
                },
                author: 'Shared',
                contents: 'Original',
            }),
            makeNote('old-p1', 1, {
                identity: {
                    id: asAnnotationId('old-p1'),
                    pdfRef: '91 0 R',
                },
                author: 'Shared',
                contents: 'Original',
            }),
            makeNote('old-ambig', 2, {
                identity: {
                    id: asAnnotationId('old-ambig'),
                    pdfRef: '92 0 R',
                },
                author: 'Ambiguous',
                contents: 'Original',
            }),
        ], [], undefined, [], [], false, requireDocumentRevisionToken('rev-before'));
        sourceStore.updateNote(asAnnotationId('old-p0'), {contents: 'Edited P0'});
        sourceStore.updateNote(asAnnotationId('old-p1'), {contents: 'Edited P1'});
        sourceStore.updateNote(asAnnotationId('old-ambig'), {contents: 'Edited Ambig'});
        const captured = captureCanonicalAnnotationRecovery(sourceStore);

        const rereadStore = createStoreWithReadRevision([
            page0Note,
            page1Note,
            ambigA,
            ambigB,
        ], 'rev-after');
        restoreCanonicalAnnotationRecovery(rereadStore, captured);

        expect((rereadStore.get(asAnnotationId('reread-p0')) as INoteEntity | null)?.contents).toBe('Edited P0');
        expect((rereadStore.get(asAnnotationId('reread-p1')) as INoteEntity | null)?.contents).toBe('Edited P1');
        // Ambiguous candidates must remain untouched and the captured edit stays detached with no stale pdfRef.
        expect((rereadStore.get(asAnnotationId('reread-ambig-a')) as INoteEntity | null)?.contents).toBe('Original');
        expect((rereadStore.get(asAnnotationId('reread-ambig-b')) as INoteEntity | null)?.contents).toBe('Original');
        const detached = rereadStore.get(asAnnotationId('old-ambig')) as INoteEntity | null;
        expect(detached?.contents).toBe('Edited Ambig');
        expect(detached?.identity.pdfRef).toBeUndefined();
        expect(detached?.persistedRevision).toBe(-1);
    });

    it('binds exact PDF refs on same-bytes recovery and scales linearly for 1,000 reread entities', () => {
        const sameBytesTarget = makeTextBox('store-tb', 0, {
            identity: {
                id: asAnnotationId('store-tb'),
                pdfRef: '77 0 R',
            },
            text: 'Before',
        });
        const sameBytesStore = createStoreWithReadRevision([sameBytesTarget], 'rev-same');
        const sameBytesPlan: ICanonicalAnnotationRecovery = {
            version: CANONICAL_ANNOTATION_RECOVERY_VERSION,
            annotationReadRevision: requireDocumentRevisionToken('rev-same'),
            changedFields: {'captured-tb': ['text']},
            annotationMutationGeneration: 1,
            entities: [makeTextBox('captured-tb', 0, {
                identity: {
                    id: asAnnotationId('captured-tb'),
                    pdfRef: '77 0 R',
                },
                revision: 1,
                text: 'After',
            })],
            drafts: [],
        };
        restoreCanonicalAnnotationRecovery(sameBytesStore, sameBytesPlan);
        expect((sameBytesStore.get(asAnnotationId('store-tb')) as ITextBoxEntity | null)?.text).toBe('After');

        // Scaling: 1,000 reread entities + 1,000 drafts.
        const count = 1_000;
        const readNotes = Array.from({length: count}, (_, index) => makeNote(`read-${index}`, index % 100, {
            identity: {
                id: asAnnotationId(`read-${index}`),
                pdfRef: `${index + 10} 0 R`,
            },
            author: `Author-${index}`,
            contents: `Original-${index}`,
        }));
        const largeStore = createStoreWithReadRevision(readNotes, 'rev-after');
        const capturedNotes = readNotes.map((entity, index) => ({
            ...entity,
            identity: {
                id: asAnnotationId(`old-${index}`),
                pdfRef: `${index + 5000} 0 R`,
            },
            revision: 1,
            contents: `Recovered-${index}`,
        }));
        const largeRecovery: ICanonicalAnnotationRecovery = {
            version: CANONICAL_ANNOTATION_RECOVERY_VERSION,
            annotationReadRevision: requireDocumentRevisionToken('rev-before'),
            changedFields: Object.fromEntries(capturedNotes.map(entity => [
                entity.identity.id,
                ['contents'],
            ])),
            annotationMutationGeneration: 1,
            entities: capturedNotes,
            drafts: capturedNotes.map(entity => ({
                annotationId: entity.identity.id,
                kind: 'note' as const,
                canonicalRevision: 1,
                text: 'Draft',
                generation: 1,
            })),
        };

        const startedAt = performance.now();
        const restored = restoreCanonicalAnnotationRecovery(largeStore, largeRecovery);
        const elapsedMs = performance.now() - startedAt;

        expect(restored.drafts).toHaveLength(count);
        expect(restored.drafts[0]?.annotationId).toBe(asAnnotationId('read-0'));
        expect(restored.drafts[count - 1]?.annotationId).toBe(asAnnotationId(`read-${count - 1}`));
        expect((largeStore.get(asAnnotationId(`read-${count - 1}`)) as INoteEntity | null)?.contents).toBe(`Recovered-${count - 1}`);
        expect(elapsedMs).toBeLessThan(600);
    });
});
