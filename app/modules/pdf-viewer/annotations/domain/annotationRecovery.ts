import type {
    AnnotationEntity,
    AnnotationId,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {semanticFieldsChangedSince} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {IAnnotationMarkerRect} from '@app/types/annotations';
import type {
    AnnotationStore,
    IPdfForeignAnnotationRecord,
} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {takeParsedFields} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {parseDocumentRevisionToken} from '@contracts/documentRevision';
import {isRecord} from '@contracts/runtimeGuards';
import {mapWorkspaceRecoveryRasters} from '@contracts/workspaceCheckpoint';

export const CANONICAL_ANNOTATION_RECOVERY_VERSION = 2 as const;
const MAX_RECOVERY_BYTES = 4 * 1024 * 1024;
const MAX_DRAFT_TEXT_CHARS = 1_000_000;
// An entity's changed-field names, bounded apart from the snapshot's budget: a kind has fewer semantic fields.
const MAX_CHANGED_FIELDS = 32;
const MAX_CHANGED_FIELD_NAME_CHARS = 64;

export interface IAnnotationRecoveryDraft {
    readonly annotationId: AnnotationId;
    readonly kind: 'text-box' | 'note';
    readonly canonicalRevision: number;
    readonly text: string;
    readonly geometry?: IAnnotationMarkerRect;
    readonly generation: number;
}

export interface IAnnotationRecoveryDraftError extends IAnnotationRecoveryDraft {readonly error: string;}

export type TAnnotationRecoveryDraftInput = readonly IAnnotationRecoveryDraft[]
    | ((entities: readonly AnnotationEntity[]) => readonly IAnnotationRecoveryDraft[]);

export interface ICanonicalAnnotationRecovery {
    readonly version: 1 | typeof CANONICAL_ANNOTATION_RECOVERY_VERSION;
    /** From version 2: the byte revision whose annotation read the entities' geometry reflects. */
    readonly annotationReadRevision?: string | null;
    /** From version 2: by entity, the fields that differ from what the working bytes hold. */
    readonly changedFields?: Readonly<Record<string, readonly string[]>>;
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

function assertChangedFieldsValid(changedFields: unknown, entityIds: ReadonlySet<string>) {
    if (!isRecord(changedFields) || !Object.entries(changedFields).every(([id, names]) => entityIds.has(id)
        && Array.isArray(names) && names.length <= MAX_CHANGED_FIELDS && new Set(names).size === names.length
        && names.every(name => typeof name === 'string' && name.length <= MAX_CHANGED_FIELD_NAME_CHARS))) {
        throw new AnnotationRecoveryAdmissionError('Recovery changed fields are invalid');
    }
}

/** The snapshot keeps the range version 1 admitted; the version 2 metadata is bounded on its own. */
function assertRecoveryWithinBudget(recovery: ICanonicalAnnotationRecovery) {
    const {annotationReadRevision: _readRevision, changedFields: _changedFields, ...snapshot} = recovery;
    let encoded: string;
    try {
        encoded = JSON.stringify(mapWorkspaceRecoveryRasters(snapshot, image => ({
            ...image,
            dataBase64: '',
        })));
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
    store: Pick<AnnotationStore, 'mutationEpoch' | 'list' | 'foreign' | 'snapshotState'>,
    draftInput: TAnnotationRecoveryDraftInput = [],
    annotationReadRevision: string | null = null,
): ICanonicalAnnotationRecovery {
    assertFiniteNonNegativeInteger(store.mutationEpoch, 'Annotation mutation generation');
    const entities = store.list({includeDeleted: true});
    const drafts = typeof draftInput === 'function' ? draftInput(entities) : draftInput;
    drafts.forEach(validateDraft);
    const {working} = store.snapshotState();
    const recovery: ICanonicalAnnotationRecovery = {
        version: CANONICAL_ANNOTATION_RECOVERY_VERSION,
        annotationReadRevision,
        changedFields: Object.fromEntries(entities.flatMap((entity) => {
            const changed = semanticFieldsChangedSince(entity, working.get(entity.identity.id)?.fingerprint ?? null);
            return changed.length > 0 ? [[entity.identity.id, changed]] : [];
        })),
        annotationMutationGeneration: store.mutationEpoch,
        entities,
        foreign: store.foreign,
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
    const {version, annotationReadRevision, changedFields} = candidate;
    if ((version !== 1 && version !== CANONICAL_ANNOTATION_RECOVERY_VERSION)
        || (version === CANONICAL_ANNOTATION_RECOVERY_VERSION && annotationReadRevision !== null
            && parseDocumentRevisionToken(annotationReadRevision) !== annotationReadRevision)
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
    if (version === CANONICAL_ANNOTATION_RECOVERY_VERSION) assertChangedFieldsValid(changedFields, entityIds);
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
        version,
        ...(version === CANONICAL_ANNOTATION_RECOVERY_VERSION ? {annotationReadRevision, changedFields} : {}),
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
 *
 * `readRevision` names the bytes whose read the store holds. A version 2 snapshot
 * of another read, such as during a rotation's re-read, may hold an older page or
 * frame: each field the user did not change takes that read's value, so an unchanged
 * entity is the read's or stays out, and the read's foreign list stands.
 */
export function restoreCanonicalAnnotationRecovery(
    store: Pick<AnnotationStore, 'importMany' | 'import' | 'restoreForeignAnnotations' | 'get'>,
    value: unknown,
    readRevision: string | null = null,
): ICanonicalAnnotationRecovery {
    const recovery = validateCanonicalAnnotationRecovery(value);
    const reread = readRevision !== null && recovery.annotationReadRevision !== undefined
        && recovery.annotationReadRevision !== readRevision;
    // Own entries only: an imported /NM such as `constructor` names no inherited value.
    const changedFields = new Map(Object.entries(recovery.changedFields ?? {}));
    const placedByRead = new Set<string>();
    store.importMany(() => {
        if (!reread) store.restoreForeignAnnotations(recovery.foreign);
        recovery.entities.forEach((entity) => {
            const changed = changedFields.get(entity.identity.id);
            const read = reread ? store.get(entity.identity.id) : null;
            if (reread && !changed) {
                placedByRead.add(entity.identity.id);
            } else if (!changed || !read || read.kind !== entity.kind) {
                store.import(entity, {preserveSavedBaseline: true});
            } else {
                const unchanged = new Set(semanticFieldsChangedSince(entity, null).filter(key => !changed.includes(key)));
                store.import(takeParsedFields(entity, read, unchanged), {preserveSavedBaseline: true});
                if (unchanged.has('rect')) placedByRead.add(entity.identity.id);
            }
        });
    });
    // An open editor's rectangle on a label placed by the read was taken in the frame the read replaced; its text stays.
    return placedByRead.size === 0 ? recovery : {
        ...recovery,
        drafts: recovery.drafts.map(({geometry, ...draft}) => (
            placedByRead.has(draft.annotationId) || !geometry ? draft : {...draft, geometry}
        )),
    };
}
