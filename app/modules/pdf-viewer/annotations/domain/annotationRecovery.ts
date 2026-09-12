import {PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES} from '@contracts/electronApiDocuments';
import type {
    AnnotationEntity,
    AnnotationId,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {IAnnotationMarkerRect} from '@app/types/annotations';
import type {
    AnnotationStore,
    IPdfForeignAnnotationRecord,
} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {isRecord} from '@contracts/runtimeGuards';

export const CANONICAL_ANNOTATION_RECOVERY_VERSION = 1 as const;
const MAX_RECOVERY_BYTES = PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES;
const MAX_DRAFT_TEXT_CHARS = 1_000_000;

export interface IAnnotationRecoveryDraft {
    readonly annotationId: AnnotationId;
    readonly kind: 'text-box' | 'note';
    readonly canonicalRevision: number;
    readonly text: string;
    readonly geometry?: IAnnotationMarkerRect;
    readonly generation: number;
}

export interface IAnnotationRecoveryDraftError extends IAnnotationRecoveryDraft {readonly error: string;}

export interface ICanonicalAnnotationRecovery {
    readonly version: typeof CANONICAL_ANNOTATION_RECOVERY_VERSION;
    readonly annotationMutationGeneration: number;
    readonly entities: readonly AnnotationEntity[];
    readonly foreign: readonly IPdfForeignAnnotationRecord[];
    readonly drafts: readonly IAnnotationRecoveryDraft[];
    // Derived while validating, never persisted: a draft is incompatible only
    // relative to the entities it arrives with, so the verdict is recomputed on
    // every load rather than trusted from the payload.
    readonly draftErrors?: readonly IAnnotationRecoveryDraftError[];
}

export class AnnotationRecoveryAdmissionError extends Error {
    public readonly code = 'CANONICAL_ANNOTATION_RECOVERY_ADMISSION_FAILED' as const;

    public constructor(message: string) {
        super(message);
        this.name = 'AnnotationRecoveryAdmissionError';
    }
}

function clone<T>(value: T): T {
    return structuredClone(value);
}

function assertFiniteNonNegativeInteger(value: unknown, label: string): asserts value is number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new AnnotationRecoveryAdmissionError(`${label} must be a non-negative safe integer`);
    }
}

function validateDraft(draft: unknown): asserts draft is IAnnotationRecoveryDraft {
    if (!isRecord(draft) || (draft.kind !== 'text-box' && draft.kind !== 'note')) {
        throw new AnnotationRecoveryAdmissionError('Recovery draft kind is invalid');
    }
    if (typeof draft.annotationId !== 'string' || !draft.annotationId.trim()) {
        throw new AnnotationRecoveryAdmissionError('Recovery draft identity is invalid');
    }
    assertFiniteNonNegativeInteger(draft.canonicalRevision, 'Recovery draft canonicalRevision');
    assertFiniteNonNegativeInteger(draft.generation, 'Recovery draft generation');
    if (typeof draft.text !== 'string' || draft.text.length > MAX_DRAFT_TEXT_CHARS) {
        throw new AnnotationRecoveryAdmissionError('Recovery draft text exceeds the supported limit');
    }
    if (draft.geometry) {
        const values = Object.values(draft.geometry);
        if (values.length !== 4 || values.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
            throw new AnnotationRecoveryAdmissionError('Recovery draft geometry is invalid');
        }
    }
}

function validateEntity(entity: unknown): asserts entity is AnnotationEntity {
    if (!isRecord(entity)) {
        throw new AnnotationRecoveryAdmissionError('Recovery entity is invalid');
    }
    const identity = entity.identity;
    const id = isRecord(identity) ? identity.id : undefined;
    const pageIndex = entity.pageIndex;
    const revision = entity.revision;
    const persistedRevision = entity.persistedRevision;
    const allowedKinds: readonly unknown[] = [
        'text-box',
        'note',
        'text-markup',
        'placed-image',
        'shape',
    ];
    if (!allowedKinds.includes(entity.kind)
        || typeof id !== 'string' || !id.trim()
        || typeof pageIndex !== 'number' || !Number.isSafeInteger(pageIndex) || pageIndex < 0
        || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0
        || typeof persistedRevision !== 'number' || !Number.isSafeInteger(persistedRevision) || persistedRevision < -1
        || typeof entity.deleted !== 'boolean') {
        throw new AnnotationRecoveryAdmissionError('Recovery entity is invalid');
    }
}

function assertRecoveryWithinBudget(recovery: ICanonicalAnnotationRecovery) {
    let encoded: string;
    try {
        encoded = JSON.stringify(recovery);
    } catch (error) {
        throw new AnnotationRecoveryAdmissionError(`Recovery state is not serializable: ${String(error)}`);
    }
    const bytes = new TextEncoder().encode(encoded).byteLength;
    if (bytes > MAX_RECOVERY_BYTES) {
        throw new AnnotationRecoveryAdmissionError(
            `Recovery state exceeds the ${MAX_RECOVERY_BYTES}-byte annotation budget`,
        );
    }
}

export function captureCanonicalAnnotationRecovery(
    store: Pick<AnnotationStore, 'mutationEpoch' | 'list' | 'foreign'>,
    drafts: readonly IAnnotationRecoveryDraft[] = [],
): ICanonicalAnnotationRecovery {
    assertFiniteNonNegativeInteger(store.mutationEpoch, 'Annotation mutation generation');
    drafts.forEach(validateDraft);
    const recovery: ICanonicalAnnotationRecovery = {
        version: CANONICAL_ANNOTATION_RECOVERY_VERSION,
        annotationMutationGeneration: store.mutationEpoch,
        entities: clone(store.list({includeDeleted: true})),
        foreign: clone(store.foreign),
        drafts: clone(drafts),
    };
    assertRecoveryWithinBudget(recovery);
    return recovery;
}

export function validateCanonicalAnnotationRecovery(value: unknown): ICanonicalAnnotationRecovery {
    if (!value || typeof value !== 'object') {
        throw new AnnotationRecoveryAdmissionError('Recovery state is not an object');
    }
    const candidate = value as Partial<ICanonicalAnnotationRecovery>;
    if (candidate.version !== CANONICAL_ANNOTATION_RECOVERY_VERSION
        || !Array.isArray(candidate.entities)
        || !Array.isArray(candidate.foreign)
        || !Array.isArray(candidate.drafts)) {
        throw new AnnotationRecoveryAdmissionError('Recovery state has an unsupported version or shape');
    }
    const annotationMutationGeneration = candidate.annotationMutationGeneration;
    assertFiniteNonNegativeInteger(annotationMutationGeneration, 'Annotation mutation generation');
    const entityIds = new Set<string>();
    const entities = candidate.entities as readonly unknown[];
    const drafts = candidate.drafts as readonly unknown[];
    const validatedEntities: AnnotationEntity[] = [];
    const validatedDrafts: IAnnotationRecoveryDraft[] = [];
    const draftErrors: IAnnotationRecoveryDraftError[] = [];
    entities.forEach((entity) => {
        validateEntity(entity);
        if (entityIds.has(entity.identity.id)) {
            throw new AnnotationRecoveryAdmissionError(`Recovery contains duplicate annotation identity ${entity.identity.id}`);
        }
        entityIds.add(entity.identity.id);
        validatedEntities.push(entity);
    });
    drafts.forEach((draft) => {
        validateDraft(draft);
        const entity = validatedEntities.find(candidateEntity => candidateEntity.identity.id === draft.annotationId);
        if (!entity || entity.kind !== draft.kind || entity.revision !== draft.canonicalRevision || entity.deleted) {
            draftErrors.push({
                ...draft,
                error: `Recovery draft ${draft.annotationId} does not match an active canonical entity`,
            });
            return;
        }
        validatedDrafts.push(draft);
    });
    const recovery: ICanonicalAnnotationRecovery = {
        version: CANONICAL_ANNOTATION_RECOVERY_VERSION,
        annotationMutationGeneration,
        entities: validatedEntities,
        foreign: candidate.foreign as readonly IPdfForeignAnnotationRecord[],
        drafts: validatedDrafts,
        draftErrors,
    };
    assertRecoveryWithinBudget(recovery);
    return recovery;
}

/**
 * Replays a complete renderer snapshot into a store after the admitted base
 * PDF has been parsed. The parsed baseline remains the saved baseline, so
 * recovered edits stay dirty and do not enter authored undo history twice.
 */
export function restoreCanonicalAnnotationRecovery(
    store: Pick<AnnotationStore, 'importMany' | 'import' | 'restoreForeignAnnotations'>,
    value: unknown,
) {
    const recovery = validateCanonicalAnnotationRecovery(value);
    store.importMany(() => {
        store.restoreForeignAnnotations(recovery.foreign);
        recovery.entities.forEach(entity => {
            store.import(entity, {preserveSavedBaseline: true});
        });
    });
    return recovery;
}
