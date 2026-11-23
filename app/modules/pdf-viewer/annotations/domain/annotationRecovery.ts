import {
    asAnnotationId,
    semanticEntityFingerprint,
    type AnnotationEntity,
    type AnnotationId,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {IAnnotationMarkerRect} from '@app/types/annotations';
import {
    takeParsedFields,
    type AnnotationStore,
    type IPdfForeignAnnotationRecord,
} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
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
    /** From version 2: the byte revision whose annotation read the entities' geometry reflects; null when unknown. */
    readonly annotationReadRevision?: string | null;
    /** From version 2: by entity, the semantic fields that differ from what the working bytes hold. */
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

/** The semantic fields of `entity` whose value differs from `fingerprint`, an entry of its kind; all of them without one. */
function semanticFieldsChangedSince(entity: AnnotationEntity, fingerprint: string | null) {
    const current = JSON.parse(semanticEntityFingerprint(entity)) as Record<string, unknown>;
    const base = fingerprint === null ? null : JSON.parse(fingerprint) as Record<string, unknown>;
    return Object.keys(current).filter(key => !base || JSON.stringify(current[key]) !== JSON.stringify(base[key]));
}

/**
 * The stored snapshot keeps its budget, measured alike at capture and admission; the version 2 metadata is
 * bounded on its own.
 */
function assertRecoveryWithinBudget(recovery: Omit<ICanonicalAnnotationRecovery, 'draftErrors'>) {
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
    store: Pick<AnnotationStore, 'mutationEpoch' | 'list' | 'foreign' | 'snapshotState' | 'readRevision'>,
    draftInput: TAnnotationRecoveryDraftInput = [],
): ICanonicalAnnotationRecovery {
    assertFiniteNonNegativeInteger(store.mutationEpoch, 'Annotation mutation generation');
    const entities = store.list({includeDeleted: true});
    const drafts = typeof draftInput === 'function' ? draftInput(entities) : draftInput;
    drafts.forEach(validateDraft);
    const {working} = store.snapshotState();
    const recovery: ICanonicalAnnotationRecovery = {
        version: CANONICAL_ANNOTATION_RECOVERY_VERSION,
        annotationReadRevision: store.readRevision,
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
    // Capture measured every draft; an incompatible one is still stored and counts the same.
    assertRecoveryWithinBudget({
        version,
        annotationMutationGeneration,
        entities: validatedEntities,
        foreign: candidate.foreign as readonly IPdfForeignAnnotationRecord[],
        drafts: drafts as readonly IAnnotationRecoveryDraft[],
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
    return recovery;
}

/** An entity's semantic fields, at the precision the working baseline compares them. */
function semanticFields(entity: AnnotationEntity) {
    return JSON.parse(semanticEntityFingerprint(entity)) as Record<string, unknown>;
}

/**
 * Each captured entity the store holds under another id, by the id the store's read gives it. An annotation without
 * /NM takes its id from its page and object, and a page operation renumbers the objects, so neither the captured id
 * nor the captured ref need name it in the recovered read. It is the live annotation of its kind whose semantic
 * fields equal every field the user did not change apart from the page, which only decides between several. An
 * entity the bytes never held changed every field and binds nothing. A version 1 snapshot names no changed fields;
 * it binds by ref on the same page. An ambiguous or missing match binds nothing, and the entity keeps its own id.
 */
function idsInStore(
    store: Pick<AnnotationStore, 'snapshotState'>,
    recovery: ICanonicalAnnotationRecovery,
    changedFields: ReadonlyMap<string, readonly string[]>,
    reread: boolean,
) {
    const current = store.snapshotState().entities;
    const comparedKeysFor = (captured: AnnotationEntity, fields: Record<string, unknown>) => {
        const changed = changedFields.get(captured.identity.id) ?? [];
        return recovery.version === 1
            ? ['kind', 'pageIndex']
            : Object.keys(fields).filter(key => key !== 'deleted' && key !== 'pageIndex' && !changed.includes(key));
    };
    const sameField = (left: Record<string, unknown>, right: Record<string, unknown>, key: string) => (
        JSON.stringify(left[key]) === JSON.stringify(right[key])
    );
    const rotatableGeometryKeys = new Set([
        'rect',
        'position',
        'quadPoints',
        'points',
        'strokes',
        'rotation',
    ]);
    const matchesExistingId = (captured: AnnotationEntity) => {
        const existing = current.get(captured.identity.id);
        if (!existing) return false;
        if (!reread) return true;
        if (existing.deleted) return false;
        const fields = semanticFields(captured);
        const compared = comparedKeysFor(captured, fields).filter(key => !rotatableGeometryKeys.has(key));
        if (!compared.includes('kind')) return false;
        const candidate = semanticFields(existing);
        return compared.every(key => sameField(candidate, fields, key));
    };
    const directIds = new Set<string>(recovery.entities.filter(matchesExistingId).map(entity => entity.identity.id));
    const taken = new Set<string>(directIds);
    const unbound = [...current.values()].filter(entity => !entity.deleted && !taken.has(entity.identity.id))
        .map(entity => ({entity, fields: semanticFields(entity)}));
    const ids = new Map<string, AnnotationId>();
    recovery.entities.forEach((captured) => {
        if (directIds.has(captured.identity.id)) return;
        const fields = semanticFields(captured);
        const changed = changedFields.get(captured.identity.id) ?? [];
        // A deletion the bytes already hold names no annotation of the read.
        if (captured.deleted && (recovery.version === 1 || !changed.includes('deleted'))) return;
        const compared = comparedKeysFor(captured, fields);
        if (!compared.includes('kind')) return;
        const matches = unbound.filter(({entity, fields: candidate}) => !taken.has(entity.identity.id)
            && (recovery.version !== 1 || (!!entity.identity.pdfRef?.trim() && entity.identity.pdfRef === captured.identity.pdfRef))
            && compared.every(key => sameField(candidate, fields, key)));
        const onPage = matches.length > 1 ? matches.filter(({fields: candidate}) => sameField(candidate, fields, 'pageIndex')) : matches;
        if (onPage.length !== 1) return;
        const bound = onPage[0]!.entity;
        taken.add(bound.identity.id);
        ids.set(captured.identity.id, bound.identity.id);
    });
    return {ids, directIds};
}

/**
 * Replays a complete renderer snapshot into a store after the admitted base
 * PDF has been parsed. The parsed baseline remains the saved baseline, so
 * recovered edits stay dirty and do not enter authored undo history twice.
 * Entities and drafts take the id the store's read gives their PDF object.
 *
 * A version 2 snapshot of another read than the store's, such as one taken
 * during a rotation's re-read, may hold an older page or frame: each field the
 * user did not change takes the store's read value, so an unchanged entity is
 * the read's or stays out, and the read's foreign list stands.
 */
export function restoreCanonicalAnnotationRecovery(
    store: Pick<AnnotationStore, 'importMany' | 'import' | 'restoreForeignAnnotations' | 'get' | 'readRevision' | 'snapshotState' | 'resolveExternal'>,
    value: unknown,
): ICanonicalAnnotationRecovery {
    const recovery = validateCanonicalAnnotationRecovery(value);
    const reread = store.readRevision !== null && recovery.annotationReadRevision !== undefined
        && recovery.annotationReadRevision !== store.readRevision;
    // Own entries only: an imported /NM such as `constructor` names no inherited value.
    const changedFields = new Map(Object.entries(recovery.changedFields ?? {}));
    const {ids, directIds} = idsInStore(store, recovery, changedFields, reread);
    const placedByRead = new Set<string>();
    const drafted = new Set<string>(recovery.drafts.map(draft => draft.annotationId));
    store.importMany(() => {
        if (!reread) store.restoreForeignAnnotations(recovery.foreign);
        recovery.entities.forEach((captured) => {
            const mappedId = ids.get(captured.identity.id);
            const held = mappedId !== undefined
                ? store.get(mappedId)
                : directIds.has(captured.identity.id)
                    ? store.get(captured.identity.id)
                    : null;
            const pdfRef = captured.identity.pdfRef;
            const refHolder = !held && pdfRef?.trim() ? store.resolveExternal({pdfRef}) : null;
            const collidesWithOther = !held && store.get(captured.identity.id) !== null;
            const detachFromPdfObject = !held && (
                collidesWithOther
                || (reread && Boolean(pdfRef?.trim()))
                || (refHolder !== null && refHolder !== captured.identity.id)
            );
            const detachedId = collidesWithOther ? asAnnotationId(crypto.randomUUID()) : captured.identity.id;
            if (collidesWithOther) ids.set(captured.identity.id, detachedId);
            // The store's read names the object. A captured ref or minted id from before a renumbering page operation
            // that has no unique match in the recovered read is kept as a new annotation rather than written over an
            // object that may not be its own (or kept with a stale pdfRef that no longer exists).
            const entity = held ? {...captured, identity: held.identity}
                : detachFromPdfObject
                    ? {...captured, identity: {id: detachedId}, persistedRevision: -1}
                    : captured;
            const changed = changedFields.get(captured.identity.id);
            const read = reread ? held : null;
            if (reread && !changed && (held || !drafted.has(captured.identity.id) || captured.deleted)) {
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
    return {
        ...recovery,
        drafts: recovery.drafts.map(({geometry, ...draft}) => {
            const annotationId = ids.get(draft.annotationId) ?? draft.annotationId;
            return {...draft, annotationId, ...(geometry && !placedByRead.has(annotationId) ? {geometry} : {})};
        }),
    };
}
