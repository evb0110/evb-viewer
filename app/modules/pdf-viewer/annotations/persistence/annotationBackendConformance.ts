import type {IBackendAnnotationMutation} from '@app/modules/pdf-viewer/engine/annotations/persistence/backendAnnotationMutation';
import type {
    IAnnotationMutationStep,
    ISerializationPlan,
    IAnnotationReopenReader,
} from '@app/modules/pdf-viewer/annotations/persistence/annotationSavePlan';
import {
    SERIALIZATION_MUTATION_ORDER,
    verifyAnnotationSave,
} from '@app/modules/pdf-viewer/annotations/persistence/annotationSavePlan';
export type {IBackendAnnotationMutation} from '@app/modules/pdf-viewer/engine/annotations/persistence/backendAnnotationMutation';

export const ANNOTATION_PERSISTENCE_BACKENDS = ['native-append'] as const;

export type TAnnotationPersistenceBackend = typeof ANNOTATION_PERSISTENCE_BACKENDS[number];

function orderSteps(steps: readonly IAnnotationMutationStep[]) {
    const mutationOrder = new Map(SERIALIZATION_MUTATION_ORDER.map((operation, index) => [
        operation,
        index,
    ]));
    const remaining = new Map(steps.map((step, index) => [
        step.id,
        {
            step,
            index,
        },
    ]));
    const completed = new Set<string>();
    const ordered: IAnnotationMutationStep[] = [];
    while (remaining.size) {
        const ready = [...remaining.values()]
            .filter(({step}) => step.dependsOn.every(id => completed.has(id)))
            .sort((left, right) => (
                (mutationOrder.get(left.step.operation) ?? Number.MAX_SAFE_INTEGER)
                - (mutationOrder.get(right.step.operation) ?? Number.MAX_SAFE_INTEGER)
                || left.index - right.index
            ));
        if (!ready.length) {
            throw new Error(`Cyclic annotation mutation dependencies: ${[...remaining.keys()].join(', ')}`);
        }
        ready.forEach(({step}) => {
            remaining.delete(step.id);
            completed.add(step.id);
            ordered.push(step);
        });
    }
    return ordered;
}

/**
 * All persistence routes consume this same ordered semantic program. Backends
 * may encode it differently, but may not choose fields or reorder operations.
 */
export function projectAnnotationBackendMutations(
    plan: ISerializationPlan,
    backend: TAnnotationPersistenceBackend,
): readonly IBackendAnnotationMutation[] {
    return orderSteps(plan.steps).map((step, order) => ({
        backend,
        order,
        annotationId: step.annotationId,
        operation: step.operation,
        fields: structuredClone(step.fields),
    }));
}

function semanticProgram(mutations: readonly IBackendAnnotationMutation[]) {
    return mutations.map(({
        annotationId,
        fields,
        operation,
        order,
    }) => ({
        annotationId,
        fields,
        operation,
        order,
    }));
}

export function assertAnnotationBackendSemanticConformance(plan: ISerializationPlan) {
    const programs = ANNOTATION_PERSISTENCE_BACKENDS.map(backend => (
        semanticProgram(projectAnnotationBackendMutations(plan, backend))
    ));
    const expected = JSON.stringify(programs[0]);
    if (programs.some(program => JSON.stringify(program) !== expected)) {
        throw new Error('Annotation persistence backends produced divergent semantic programs');
    }
    return programs[0] ?? [];
}

export interface IAnnotationPersistenceBackendAdapter extends IAnnotationReopenReader {
    readonly backend: TAnnotationPersistenceBackend;
    apply(mutations: readonly IBackendAnnotationMutation[]): Promise<Uint8Array>;
}

/**
 * Executes and semantically reopens every supported backend. This is the
 * conformance gate used by backend fixtures; byte equality is intentionally
 * not required, but the canonical plan and reopen truth are.
 */
export async function verifyAllAnnotationPersistenceBackends(
    plan: ISerializationPlan,
    adapters: readonly IAnnotationPersistenceBackendAdapter[],
) {
    const byBackend = new Map(adapters.map(adapter => [
        adapter.backend,
        adapter,
    ]));
    if (
        byBackend.size !== ANNOTATION_PERSISTENCE_BACKENDS.length
        || ANNOTATION_PERSISTENCE_BACKENDS.some(backend => !byBackend.has(backend))
    ) {
        throw new Error('Annotation conformance requires exactly one adapter for every persistence backend');
    }
    assertAnnotationBackendSemanticConformance(plan);
    return Promise.all(ANNOTATION_PERSISTENCE_BACKENDS.map(async (backend) => {
        const adapter = byBackend.get(backend)!;
        const mutations = projectAnnotationBackendMutations(plan, backend);
        const bytes = await adapter.apply(mutations);
        await verifyAnnotationSave(bytes, plan, adapter);
        return {
            backend,
            bytes,
        };
    }));
}
