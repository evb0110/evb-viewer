import {
    describe,
    expect,
    it,
} from 'vitest';
import {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {buildSerializationPlan} from '@app/modules/pdf-viewer/annotations/persistence/annotationSavePlan';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requirePageIndex} from '@contracts/pageNumbers';
import {
    ANNOTATION_PERSISTENCE_BACKENDS,
    assertAnnotationBackendSemanticConformance,
    projectAnnotationBackendMutations,
} from '@app/modules/pdf-viewer/annotations/persistence/annotationBackendConformance';

describe('annotation persistence backend conformance', () => {
    it('feeds all three backends the same ordered semantic program', () => {
        const store = new AnnotationStore();
        const noteId = asAnnotationId('annotation-note');
        const markupId = asAnnotationId('annotation-markup');
        store.createNote({
            kind: 'note',
            identity: {
                id: noteId,
                pdfRef: '12R0',
            },
            pageIndex: requirePageIndex(0),
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: 'Test',
            contents: 'שלום — semantic note',
            position: {
                left: 0.1,
                top: 0.2,
                width: 0.02,
                height: 0.02,
            },
            color: '#ffcc00',
            open: false,
        });
        store.createTextMarkup({
            kind: 'text-markup',
            identity: {
                id: markupId,
                pdfRef: '13 0 R',
            },
            pageIndex: requirePageIndex(1),
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: null,
            subtype: 'Squiggly',
            contents: 'overlap',
            quadPoints: [{
                left: 0.3,
                top: 0.4,
                width: 0.2,
                height: 0.03,
            }],
            color: '#336699',
            opacity: 0.42,
        });
        store.delete(markupId);
        const frontier = store.beginSave();
        const plan = buildSerializationPlan(frontier, store.dirtyEntities());
        expect(plan.changedObjectRefs).toEqual(['12 0 R']);
        expect(Object.isFrozen(plan)).toBe(true);
        expect(Object.isFrozen(plan.steps)).toBe(true);

        const programs = ANNOTATION_PERSISTENCE_BACKENDS.map(backend => (
            projectAnnotationBackendMutations(plan, backend)
        ));
        const semantics = programs.map(program => program.map(({
            backend: _backend,
            ...mutation
        }) => mutation));

        const expectedSemantics = semantics[0]!;
        expect(assertAnnotationBackendSemanticConformance(plan)).toEqual(expectedSemantics);
        expect(expectedSemantics.map(mutation => mutation.operation)).toEqual([
            'prepare-free-text-appearance',
            'delete-annotation',
            'write-free-text-contents',
            'bind-identities',
        ]);
        expect(expectedSemantics[2]?.fields).toMatchObject({
            contents: 'שלום — semantic note',
            position: {
                width: 0.02,
                height: 0.02,
            },
        });
    });

    it('captures one global immutable frontier for structure, metadata, OCR, annotations, and postconditions', () => {
        const store = new AnnotationStore();
        const pageLabels = [{
            startPage: 1,
            style: 'D' as const,
            prefix: '',
            startNumber: 1,
        }];
        const plan = buildSerializationPlan(store.beginSave(requireDocumentRevisionToken('revision-global')), [], [], {
            pageOperations: [{
                operation: 'rotate',
                pageIndexes: [requirePageIndex(0)],
                fields: {degrees: 90},
            }],
            metadata: {pageLabels},
            ocrOperations: [{
                pageIndex: requirePageIndex(0),
                operation: 'replace-text-layer',
                payloadHash: 'ocr-hash',
            }],
            routeConstraints: {
                allowedBackends: ['native-append'],
                forceRewrite: true,
            },
            postconditions: {
                expectedPageCount: 1,
                changedObjectRefs: ['7 0 R'],
            },
        });

        pageLabels[0]!.prefix = 'mutated-after-frontier';
        expect(plan.sourceRevision).toBe(requireDocumentRevisionToken('revision-global'));
        expect(plan.mutationOrder).toEqual([
            'page-tree',
            'metadata',
            'ocr',
            'annotations',
            'postconditions',
        ]);
        expect(plan.metadata.pageLabels?.[0]?.prefix).toBe('');
        expect(plan.pageOperations).toEqual([{
            operation: 'rotate',
            pageIndexes: [requirePageIndex(0)],
            fields: {degrees: 90},
        }]);
        expect(plan.ocrOperations).toHaveLength(1);
        expect(plan.postconditions).toMatchObject({
            expectedPageCount: 1,
            requireValidXref: true,
        });
        expect(plan.changedObjectRefs).toEqual(['7 0 R']);
        expect(Object.isFrozen(plan)).toBe(true);
    });
});
