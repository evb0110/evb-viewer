import type { TPageIndex } from '@contracts/pageNumbers';

import type {
    AnnotationEntity,
    AnnotationId,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type { IAnnotationSaveFrontier } from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import type {TAnnotationMutationOperation} from '@app/modules/pdf-viewer/engine/annotations/persistence/backendAnnotationMutation';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdfContracts';
export type {TAnnotationMutationOperation} from '@app/modules/pdf-viewer/engine/annotations/persistence/backendAnnotationMutation';

export type TSerializationBackend = 'native-append';
export type TSaveMutationPhase =
    | 'page-tree'
    | 'metadata'
    | 'ocr'
    | 'annotations'
    | 'postconditions';

/** Route-independent semantic order. Backends may change mechanism, never ordering. */
const SAVE_MUTATION_ORDER: readonly TSaveMutationPhase[] = Object.freeze([
    'page-tree',
    'metadata',
    'ocr',
    'annotations',
    'postconditions',
]);

export interface ISerializationPageOperation {
    readonly operation: 'rotate' | 'delete' | 'insert' | 'reorder' | 'crop' | 'remove-crop';
    readonly pageIndexes: readonly TPageIndex[];
    readonly fields: Readonly<Record<string, unknown>>;
}

export interface ISerializationMetadataPlan {
    readonly pageLabels: readonly IPdfPageLabelRange[] | null;
    readonly bookmarks: readonly IPdfBookmarkEntry[] | null;
}

export interface ISerializationOcrOperation {
    readonly pageIndex: TPageIndex;
    readonly operation: 'replace-text-layer' | 'remove-text-layer';
    readonly payloadHash: string;
}

export interface ISerializationRouteConstraints {
    readonly allowedBackends: readonly TSerializationBackend[];
    readonly forceRewrite: boolean;
    readonly preserveLoadedSource: boolean;
}

export interface ISerializationPostconditions {
    readonly expectedPageCount: number | null;
    readonly requireValidXref: boolean;
    readonly requireAnnotationSemanticMatch: boolean;
    readonly changedObjectRefs: readonly string[];
}

export interface ISerializationPlanInputs {
    readonly pageOperations?: readonly ISerializationPageOperation[];
    readonly metadata?: Partial<ISerializationMetadataPlan>;
    readonly ocrOperations?: readonly ISerializationOcrOperation[];
    readonly routeConstraints?: Partial<ISerializationRouteConstraints>;
    readonly postconditions?: Partial<ISerializationPostconditions>;
}

/** The sole canonical mutation order shared by every serialization backend. */
export const SERIALIZATION_MUTATION_ORDER: readonly TAnnotationMutationOperation[] = [
    'prepare-free-text-appearance',
    'write-free-text-contents',
    'write-text-markup',
    'write-shape',
    'delete-annotation',
    'bind-identities',
];

export interface IAnnotationMutationStep {
    readonly id: string;
    readonly annotationId: AnnotationId;
    readonly operation: TAnnotationMutationOperation;
    readonly dependsOn: readonly string[];
    readonly fields: Readonly<Record<string, unknown>>;
}

export interface ISerializationPlan {
    readonly frontier: IAnnotationSaveFrontier;
    readonly sourceRevision: IAnnotationSaveFrontier['documentRevisionToken'];
    readonly sourceEpoch: number;
    readonly entityBaselineHash: string;
    readonly mutationOrder: readonly TSaveMutationPhase[];
    readonly pageOperations: readonly ISerializationPageOperation[];
    readonly metadata: ISerializationMetadataPlan;
    readonly ocrOperations: readonly ISerializationOcrOperation[];
    readonly routeConstraints: ISerializationRouteConstraints;
    readonly postconditions: ISerializationPostconditions;
    readonly steps: readonly IAnnotationMutationStep[];
    readonly expected: readonly AnnotationEntity[];
    readonly entities: readonly AnnotationEntity[];
    readonly changedObjectRefs: readonly string[];
}

const MAX_TARGETED_OBJECT_REFS = 128;
const CANONICAL_OBJECT_REF = /(?:^|\D)(\d+)\s+(\d+)\s+R(?:$|\D)/iu;
const COMPACT_OBJECT_REF = /(?:^|\D)(\d+)R(\d+)?(?:$|\D)/iu;

function cloneSerializable<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeObjectRef(value: string | null | undefined) {
    if (!value) {
        return null;
    }
    const canonical = CANONICAL_OBJECT_REF.exec(value.trim());
    const compact = canonical ? null : COMPACT_OBJECT_REF.exec(value.trim());
    const objectNumber = Number(canonical?.[1] ?? compact?.[1]);
    const generationNumber = Number(canonical?.[2] ?? compact?.[2] ?? 0);
    if (
        !Number.isSafeInteger(objectNumber)
        || !Number.isSafeInteger(generationNumber)
        || objectNumber < 1
        || generationNumber < 0
    ) {
        return null;
    }
    return `${objectNumber} ${generationNumber} R`;
}

function collectChangedObjectRefs(entities: readonly AnnotationEntity[]) {
    const refs = new Set<string>();
    entities.forEach((entity) => {
        if (entity.deleted || refs.size >= MAX_TARGETED_OBJECT_REFS) {
            return;
        }
        const ref = normalizeObjectRef(entity.identity.pdfRef);
        if (ref) {
            refs.add(ref);
        }
    });
    return Object.freeze([...refs]);
}

const FIELDS: Record<AnnotationEntity['kind'], readonly string[]> = {
    'text-box': [
        'text',
        'rect',
        'rotation',
        'fontSize',
        'color',
        'author',
        'createdAt',
        'modifiedAt',
    ],
    note: [
        'contents',
        'position',
        'color',
        'open',
        'author',
        'createdAt',
        'modifiedAt',
    ],
    'text-markup': [
        'subtype',
        'contents',
        'quadPoints',
        'color',
        'opacity',
        'author',
        'createdAt',
        'modifiedAt',
    ],
    'placed-image': [
        'rect',
        'rotation',
        'image',
        'author',
        'createdAt',
        'modifiedAt',
    ],
    shape: [
        'tool',
        'pdfSubtype',
        'lineStartStyle',
        'lineEndStyle',
        'rect',
        'points',
        'strokes',
        'strokeColor',
        'strokeWidth',
        'fill',
        'opacity',
        'author',
        'createdAt',
        'modifiedAt',
    ],
};

function allowedFields(entity: AnnotationEntity) {
    return Object.fromEntries(FIELDS[entity.kind].map(field => [
        field,
        Reflect.get(entity, field),
    ]));
}

export function buildSerializationPlan(
    frontier: IAnnotationSaveFrontier,
    dirty: readonly AnnotationEntity[],
    entities: readonly AnnotationEntity[] = dirty,
    inputs: ISerializationPlanInputs = {},
): ISerializationPlan {
    // History retains deleted drafts for undo, but the PDF never contained
    // them. Delete only entities with evidence of an existing PDF object.
    const serializableDirty = dirty.filter(entity => (
        !entity.deleted || entity.persistedRevision >= 0 || Boolean(entity.identity.pdfRef)
        || (entity.kind === 'shape' && entity.materialized === true)
    ));
    const knownPdfRefs = entities
        .map(entity => entity.identity.pdfRef)
        .filter((value): value is string => Boolean(value));
    // Each entity's earlier step ids, in order: its bind step depends on them.
    const stepIdsByAnnotation = new Map<string, string[]>();
    const steps: IAnnotationMutationStep[] = [];
    const addStep = (step: IAnnotationMutationStep) => {
        steps.push(step);
        const ids = stepIdsByAnnotation.get(step.annotationId) ?? [];
        ids.push(step.id);
        stepIdsByAnnotation.set(step.annotationId, ids);
    };
    serializableDirty.forEach((entity) => {
        const prefix = entity.identity.id;
        if (entity.deleted) {
            addStep({
                id: `${prefix}:delete`,
                annotationId: entity.identity.id,
                operation: 'delete-annotation',
                dependsOn: [],
                fields: {
                    identity: entity.identity,
                    pageIndex: entity.pageIndex,
                    kind: entity.kind,
                },
            });
            return;
        }
        if (entity.kind === 'note' || entity.kind === 'text-box') {
            const prepareId = `${prefix}:prepare-free-text`;
            addStep({
                id: prepareId,
                annotationId: entity.identity.id,
                operation: 'prepare-free-text-appearance',
                dependsOn: [],
                fields: {position: entity.kind === 'note' ? entity.position : entity.rect},
            });
            addStep({
                id: `${prefix}:contents`,
                annotationId: entity.identity.id,
                operation: 'write-free-text-contents',
                dependsOn: [prepareId],
                fields: allowedFields(entity),
            });
        } else if (entity.kind === 'placed-image') {
            // Existing placed-image appearances are owned by the dedicated native
            // image writer. Geometry-only edits are projected into that writer
            // after this plan is frozen.
        } else {
            addStep({
                id: `${prefix}:write`,
                annotationId: entity.identity.id,
                operation: entity.kind === 'shape' ? 'write-shape' : 'write-text-markup',
                dependsOn: [],
                fields: allowedFields(entity),
            });
        }
        addStep({
            id: `${prefix}:bind`,
            annotationId: entity.identity.id,
            operation: 'bind-identities',
            dependsOn: [...(stepIdsByAnnotation.get(entity.identity.id) ?? [])],
            fields: {
                identity: entity.identity,
                pageIndex: entity.pageIndex,
                kind: entity.kind,
                ...(entity.kind === 'text-markup' ? {subtype: entity.subtype} : {}),
                knownPdfRefs,
            },
        });
    });
    assertValidAnnotationSerializationPlan(steps);
    const mutationOrder = new Map(SERIALIZATION_MUTATION_ORDER.map((operation, index) => [
        operation,
        index,
    ]));
    steps.sort((left, right) => (
        (mutationOrder.get(left.operation) ?? Number.MAX_SAFE_INTEGER)
        - (mutationOrder.get(right.operation) ?? Number.MAX_SAFE_INTEGER)
    ));
    const expected = serializableDirty.map(entity => Object.freeze(structuredClone(entity)));
    const canonicalEntities = entities.map(entity => Object.freeze(structuredClone(entity)));
    const changedObjectRefs = collectChangedObjectRefs(expected);
    const pageOperations = inputs.pageOperations?.map(operation => Object.freeze(cloneSerializable(operation))) ?? [];
    const ocrOperations = inputs.ocrOperations?.map(operation => Object.freeze(cloneSerializable(operation))) ?? [];
    const allowedBackends = inputs.routeConstraints?.allowedBackends
        ? [...inputs.routeConstraints.allowedBackends]
        : ['native-append'] satisfies TSerializationBackend[];
    const metadata = Object.freeze({
        pageLabels: inputs.metadata?.pageLabels ? Object.freeze(cloneSerializable(inputs.metadata.pageLabels)) : null,
        bookmarks: inputs.metadata?.bookmarks ? Object.freeze(cloneSerializable(inputs.metadata.bookmarks)) : null,
    });
    const postconditions = Object.freeze({
        expectedPageCount: inputs.postconditions?.expectedPageCount ?? null,
        requireValidXref: inputs.postconditions?.requireValidXref ?? true,
        requireAnnotationSemanticMatch: inputs.postconditions?.requireAnnotationSemanticMatch ?? expected.length > 0,
        changedObjectRefs: Object.freeze([...(inputs.postconditions?.changedObjectRefs ?? changedObjectRefs)]),
    });
    return Object.freeze({
        frontier,
        sourceRevision: frontier.documentRevisionToken,
        sourceEpoch: frontier.epoch,
        entityBaselineHash: frontier.entityBaselineHash,
        mutationOrder: SAVE_MUTATION_ORDER,
        pageOperations: Object.freeze(pageOperations),
        metadata,
        ocrOperations: Object.freeze(ocrOperations),
        routeConstraints: Object.freeze({
            allowedBackends: Object.freeze(allowedBackends),
            forceRewrite: inputs.routeConstraints?.forceRewrite ?? false,
            preserveLoadedSource: inputs.routeConstraints?.preserveLoadedSource ?? false,
        }),
        postconditions,
        steps: Object.freeze(steps),
        expected: Object.freeze(expected),
        entities: Object.freeze(canonicalEntities),
        changedObjectRefs: postconditions.changedObjectRefs,
    });
}

/** Deterministic route policy over one immutable plan. */
export function selectSerializationBackend(
    plan: ISerializationPlan,
    available: readonly TSerializationBackend[],
): TSerializationBackend {
    const supported = new Set(available);
    const allowed = plan.routeConstraints.allowedBackends.filter(backend => supported.has(backend));
    const selected = plan.routeConstraints.forceRewrite
        ? allowed.find(backend => backend === 'native-append')
        : allowed[0];
    if (!selected) throw new Error('No serialization backend satisfies the immutable plan constraints');
    return selected;
}

function assertValidAnnotationSerializationPlan(steps: readonly IAnnotationMutationStep[]) {
    // The first step for each id, as a search through the steps would find.
    const stepsById = new Map<string, IAnnotationMutationStep>();
    steps.forEach(step => stepsById.has(step.id) || stepsById.set(step.id, step));
    steps.forEach((step) => {
        step.dependsOn.forEach((dependency) => {
            if (!stepsById.has(dependency)) throw new Error(`Missing annotation-plan dependency ${dependency}`);
        });
        if (step.operation === 'write-free-text-contents') {
            const hasPrepare = step.dependsOn.some(id => stepsById.get(id)?.operation === 'prepare-free-text-appearance');
            if (!hasPrepare) throw new Error('FreeText contents require a prepared blank appearance and point rect');
        }
    });
}
