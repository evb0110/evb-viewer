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
} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {parseDocumentRevisionToken} from '@contracts/documentRevision';
import {isRecord} from '@contracts/runtimeGuards';
import {isWorkspaceRecoveryRaster} from '@contracts/workspaceCheckpoint';

export const CANONICAL_ANNOTATION_RECOVERY_VERSION = 3 as const;
const MAX_DRAFT_TEXT_CHARS = 1_000_000;
// The names a changed field can have: those of the semantic fingerprint, over every kind.
const SEMANTIC_FIELD_NAMES: ReadonlySet<string> = new Set([
    'kind', 'pageIndex', 'deleted', 'author',
    'text', 'rect', 'rotation', 'fontSize', 'color',
    'contents', 'position', 'open',
    'subtype', 'quadPoints', 'opacity',
    'image',
    'tool', 'pdfSubtype', 'lineStartStyle', 'lineEndStyle', 'points', 'strokes', 'strokeColor', 'strokeWidth', 'fill',
]);
const FIELD_DIGEST = /^[0-9a-f]{28}$/u;

/** A 53-bit hash of `text` (cyrb53). */
function hash53(text: string, seed: number) {
    let first = 0xdeadbeef ^ seed;
    let second = 0x41c6ce57 ^ seed;
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        first = Math.imul(first ^ code, 2654435761);
        second = Math.imul(second ^ code, 1597334677);
    }
    first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
    second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
    return (4294967296 * (2097151 & second) + (first >>> 0)).toString(16).padStart(14, '0');
}

/** A bounded digest of a semantic field's value. What the bytes held is only compared, never restored. */
function fieldDigest(value: unknown) {
    const text = value === undefined ? 'undefined' : JSON.stringify(value);
    return `${hash53(text, 1)}${hash53(text, 2)}`;
}

export interface IAnnotationRecoveryDraft {
    readonly annotationId: AnnotationId;
    readonly kind: 'text-box' | 'note';
    readonly canonicalRevision: number;
    readonly text: string;
    readonly geometry?: IAnnotationMarkerRect;
    readonly generation: number;
}

export interface IAnnotationRecoveryDraftError extends IAnnotationRecoveryDraft {readonly error: string;}

/** The drafts, or a function of each annotation's current revision (null when the store has none) giving them. */
export type TAnnotationRecoveryDraftInput = readonly IAnnotationRecoveryDraft[]
    | ((revisionOf: (annotationId: AnnotationId) => number | null) => readonly IAnnotationRecoveryDraft[]);

export interface ICanonicalAnnotationRecovery {
    readonly version: 1 | 2 | typeof CANONICAL_ANNOTATION_RECOVERY_VERSION;
    /** From version 2: the byte revision whose annotation read the entities' geometry reflects; null when unknown. */
    readonly annotationReadRevision?: string | null;
    /** From version 2: by entity, the semantic fields that differ from what the working bytes hold. */
    readonly changedFields?: Readonly<Record<string, readonly string[]>>;
    /** From version 3: by entity, a digest of what the working bytes hold of each changed field; none for one they hold nothing of. */
    readonly heldFields?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    readonly annotationMutationGeneration: number;
    /**
     * From version 3, the pending Save plan: the annotations whose state the working bytes do not hold, and those the
     * drafts name. The bytes the drafts replay onto hold every other annotation and the foreign ones. Versions 1 and 2
     * held every annotation, beside a foreign list replay no longer reads.
     */
    readonly entities: readonly AnnotationEntity[];
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
        || typeof entity.deleted !== 'boolean'
        || (isRecord(identity) && identity.pdfRef !== undefined && typeof identity.pdfRef !== 'string')
        || !isNullableString(entity.author)
        || !hasKindFields(entity)) {
        throw new AnnotationRecoveryAdmissionError('Recovery entity is invalid');
    }
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isNullableString = (value: unknown) => value === null || typeof value === 'string';
const isRect = (value: unknown) => isRecord(value) && ['left', 'top', 'width', 'height'].every(key => isFiniteNumber(value[key]));
const isPoints = (value: unknown) => Array.isArray(value) && value.every(point => isRecord(point) && isFiniteNumber(point.x) && isFiniteNumber(point.y));

/** The fields an entity of its kind needs before replay reads them. */
function hasKindFields(entity: Record<string, unknown>) {
    switch (entity.kind) {
        case 'text-box':
            return typeof entity.text === 'string' && isRect(entity.rect) && [0, 90, 180, 270].includes(entity.rotation as number)
                && isFiniteNumber(entity.fontSize) && isNullableString(entity.color);
        case 'note':
            return typeof entity.contents === 'string' && isRect(entity.position) && isNullableString(entity.color)
                && typeof entity.open === 'boolean';
        case 'text-markup':
            return typeof entity.subtype === 'string' && typeof entity.contents === 'string'
                && Array.isArray(entity.quadPoints) && entity.quadPoints.every(isRect)
                && isNullableString(entity.color) && (entity.opacity === null || isFiniteNumber(entity.opacity));
        case 'placed-image':
            return isRect(entity.rect) && isFiniteNumber(entity.rotation)
                && isRecord(entity.image) && isFiniteNumber(entity.image.byteLength) && typeof entity.image.sha256 === 'string'
                && (entity.image.kind !== 'raster' || isWorkspaceRecoveryRaster(entity.image));
        case 'shape':
            return typeof entity.tool === 'string' && isRect(entity.rect) && typeof entity.strokeColor === 'string'
                && isFiniteNumber(entity.strokeWidth) && isNullableString(entity.fill) && isFiniteNumber(entity.opacity)
                && (entity.points === undefined || isPoints(entity.points))
                && (entity.strokes === undefined || (Array.isArray(entity.strokes) && entity.strokes.every(isPoints)));
        default:
            return false;
    }
}

function assertHeldFieldsValid(heldFields: unknown, entityIds: Pick<ReadonlySet<string>, 'has'>) {
    if (heldFields !== undefined && (!isRecord(heldFields) || !Object.entries(heldFields).every(([id, digests]) => entityIds.has(id)
        && isRecord(digests) && Object.entries(digests).every(([name, digest]) => SEMANTIC_FIELD_NAMES.has(name)
            && typeof digest === 'string' && FIELD_DIGEST.test(digest))))) {
        throw new AnnotationRecoveryAdmissionError('Recovery held fields are invalid');
    }
}

function assertChangedFieldsValid(changedFields: unknown, entityIds: Pick<ReadonlySet<string>, 'has'>) {
    if (!isRecord(changedFields) || !Object.entries(changedFields).every(([id, names]) => entityIds.has(id)
        && Array.isArray(names) && new Set(names).size === names.length
        && names.every(name => typeof name === 'string' && SEMANTIC_FIELD_NAMES.has(name)))) {
        throw new AnnotationRecoveryAdmissionError('Recovery changed fields are invalid');
    }
}

/**
 * The pending Save plan as drafts: the annotations whose state the working bytes do not hold, with the fields that
 * differ, and the annotations open editors' drafts name, which may hold the bytes' state.
 */
export function captureCanonicalAnnotationRecovery(
    store: Pick<AnnotationStore, 'mutationEpoch' | 'pendingChanges' | 'get' | 'readRevision'>,
    draftInput: TAnnotationRecoveryDraftInput = [],
): ICanonicalAnnotationRecovery {
    assertFiniteNonNegativeInteger(store.mutationEpoch, 'Annotation mutation generation');
    const drafts = typeof draftInput === 'function' ? draftInput(id => store.get(id)?.revision ?? null) : draftInput;
    drafts.forEach(validateDraft);
    const changes = store.pendingChanges().filter(change => change.changedFields.length > 0);
    const entities = new Map(changes.map(({entity}) => [entity.identity.id, entity]));
    drafts.forEach((draft) => {
        const entity = entities.has(draft.annotationId) ? null : store.get(draft.annotationId);
        if (entity) entities.set(entity.identity.id, entity);
    });
    return {
        version: CANONICAL_ANNOTATION_RECOVERY_VERSION,
        annotationReadRevision: store.readRevision,
        changedFields: Object.fromEntries(changes.map(({entity, changedFields}) => [entity.identity.id, changedFields])),
        heldFields: Object.fromEntries(changes.flatMap(({entity, heldFields}) => (heldFields ? [[
            entity.identity.id,
            Object.fromEntries(Object.entries(heldFields).map(([name, value]) => [name, fieldDigest(value)])),
        ]] : []))),
        annotationMutationGeneration: store.mutationEpoch,
        entities: [...entities.values()],
        drafts: clone(drafts),
    };
}

/**
 * Whether the working bytes hold everything a captured plan replays: it changes no annotation, and each open editor's
 * text is what its annotation, which the bytes hold, already says.
 */
export function isAnnotationRecoveryWritten(recovery: ICanonicalAnnotationRecovery) {
    if (Object.keys(recovery.changedFields ?? {}).length > 0) return false;
    const entities = new Map(recovery.entities.map(entity => [entity.identity.id, entity]));
    return recovery.drafts.every((draft) => {
        const entity = entities.get(draft.annotationId);
        if (!entity || (entity.kind !== 'note' && entity.kind !== 'text-markup' && entity.kind !== 'text-box')) return false;
        const edited = entity.kind === 'text-box'
            ? {...entity, text: draft.text, rect: draft.geometry ?? entity.rect}
            : {...entity, contents: draft.text};
        return semanticEntityFingerprint(edited) === semanticEntityFingerprint(entity);
    });
}

export function validateCanonicalAnnotationRecovery(value: unknown): ICanonicalAnnotationRecovery {
    if (!value || typeof value !== 'object') {
        throw new AnnotationRecoveryAdmissionError('Recovery state is not an object');
    }
    const candidate = value as Partial<ICanonicalAnnotationRecovery>;
    const {version, annotationReadRevision, changedFields, heldFields} = candidate;
    if ((version !== 1 && version !== 2 && version !== CANONICAL_ANNOTATION_RECOVERY_VERSION)
        || (version !== 1 && annotationReadRevision !== null
            && parseDocumentRevisionToken(annotationReadRevision) !== annotationReadRevision)
        || !Array.isArray(candidate.entities)
        || !Array.isArray(candidate.drafts)) {
        throw new AnnotationRecoveryAdmissionError('Recovery state has an unsupported version or shape');
    }
    const annotationMutationGeneration = candidate.annotationMutationGeneration;
    assertFiniteNonNegativeInteger(annotationMutationGeneration, 'Annotation mutation generation');
    const entitiesById = new Map<string, AnnotationEntity>();
    const entities = candidate.entities as readonly unknown[];
    const drafts = candidate.drafts as readonly unknown[];
    const validatedEntities: AnnotationEntity[] = [];
    const validatedDrafts: IAnnotationRecoveryDraft[] = [];
    const draftErrors: IAnnotationRecoveryDraftError[] = [];
    entities.forEach((entity) => {
        validateEntity(entity);
        if (entitiesById.has(entity.identity.id)) {
            throw new AnnotationRecoveryAdmissionError(`Recovery contains duplicate annotation identity ${entity.identity.id}`);
        }
        entitiesById.set(entity.identity.id, entity);
        validatedEntities.push(entity);
    });
    if (version !== 1) assertChangedFieldsValid(changedFields, entitiesById);
    if (version === CANONICAL_ANNOTATION_RECOVERY_VERSION) assertHeldFieldsValid(heldFields, entitiesById);
    drafts.forEach((draft) => {
        validateDraft(draft);
        const entity = entitiesById.get(draft.annotationId);
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
        ...(version === 1 ? {} : {annotationReadRevision, changedFields}),
        ...(version === CANONICAL_ANNOTATION_RECOVERY_VERSION && heldFields !== undefined ? {heldFields} : {}),
        annotationMutationGeneration,
        entities: validatedEntities,
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
 * A plan replayed onto bytes of the read it was taken from binds by ref as well: a store keeps its ids through
 * re-reads that a new read mints anew, while the read's annotations the plan leaves out may equal a changed one in
 * every field it did not change. What the bytes held of the changed fields, when the plan names it, must hold for any
 * match, by id as well: it decides between such annotations, binds one without a ref, and keeps an edit off another,
 * including one a renumbered read gave the captured id.
 */
interface IUnboundRecoveryCandidate {
    readonly entity: AnnotationEntity;
    readonly fields: Record<string, unknown>;
    readonly fieldDigests: Map<string, string>;
}

interface IRecoveryCandidateBucket {
    readonly all: IUnboundRecoveryCandidate[];
    cursor: number;
    secondCursor: number;
}

interface IRecoverySignatureBucket {
    readonly global: IRecoveryCandidateBucket;
    readonly byPage: Map<unknown, IRecoveryCandidateBucket>;
}

function createRecoveryCandidateBucket(): IRecoveryCandidateBucket {
    return {
        all: [],
        cursor: 0,
        secondCursor: 0,
    };
}

function probeRecoveryBucket(
    bucket: IRecoveryCandidateBucket,
    taken: ReadonlySet<string>,
): IUnboundRecoveryCandidate | 'none' | 'ambiguous' {
    const {all} = bucket;
    while (bucket.cursor < all.length && taken.has(all[bucket.cursor]!.entity.identity.id)) {
        bucket.cursor += 1;
    }
    if (bucket.cursor >= all.length) {
        return 'none';
    }
    if (bucket.secondCursor <= bucket.cursor) {
        bucket.secondCursor = bucket.cursor + 1;
    }
    while (bucket.secondCursor < all.length && taken.has(all[bucket.secondCursor]!.entity.identity.id)) {
        bucket.secondCursor += 1;
    }
    return bucket.secondCursor < all.length ? 'ambiguous' : all[bucket.cursor]!;
}

function encodeComparedFieldValue(value: unknown) {
    return value === undefined ? 0 : [1, value];
}

function candidateFieldDigest(candidate: IUnboundRecoveryCandidate, key: string) {
    let digest = candidate.fieldDigests.get(key);
    if (digest === undefined) {
        digest = fieldDigest(candidate.fields[key]);
        candidate.fieldDigests.set(key, digest);
    }
    return digest;
}

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
    // Own entries only, as for the changed fields.
    const heldFields = new Map(Object.entries(recovery.heldFields ?? {}));
    const activeHeldEntriesFor = (captured: AnnotationEntity) => {
        const held = heldFields.get(captured.identity.id);
        if (!held) {
            return null;
        }
        return Object.entries(held).filter(([key]) => (
            key !== 'deleted'
            && key !== 'pageIndex'
            && !(reread && rotatableGeometryKeys.has(key))
        ));
    };
    /** Whether `fields` hold what the bytes held of the captured entity's changed fields, when the plan names that. */
    const holdsHeldFields = (captured: AnnotationEntity, fields: Record<string, unknown>) => {
        const activeHeld = activeHeldEntriesFor(captured);
        // Another read's geometry may be in another frame; the same bytes hold it exactly.
        return !activeHeld || activeHeld.every(([key, digest]) => fieldDigest(fields[key]) === digest);
    };
    const sameBytes = recovery.version === CANONICAL_ANNOTATION_RECOVERY_VERSION && !reread;
    const matchesExistingId = (captured: AnnotationEntity) => {
        const existing = current.get(captured.identity.id);
        if (!existing) return false;
        const existingFields = semanticFields(existing);
        // A read can give another annotation an id a page operation took from this one.
        if (!holdsHeldFields(captured, existingFields)) return false;
        if (!reread) {
            const ref = captured.identity.pdfRef?.trim();
            return !sameBytes || !ref || !existing.identity.pdfRef?.trim() || existing.identity.pdfRef === captured.identity.pdfRef;
        }
        if (existing.deleted) return false;
        const fields = semanticFields(captured);
        const compared = comparedKeysFor(captured, fields).filter(key => !rotatableGeometryKeys.has(key));
        if (!compared.includes('kind')) return false;
        return compared.every(key => sameField(existingFields, fields, key));
    };
    const directIds = new Set<string>(recovery.entities.filter(matchesExistingId).map(entity => entity.identity.id));
    const ids = new Map<string, AnnotationId>();
    const byRef = recovery.version === 1 || sameBytes;
    const taken = new Set<string>(directIds);
    const unboundByPdfRef = new Map<string, IUnboundRecoveryCandidate[]>();
    const unboundByKind = new Map<unknown, IUnboundRecoveryCandidate[]>();
    for (const entity of current.values()) {
        if (entity.deleted || taken.has(entity.identity.id)) {
            continue;
        }
        const fields = semanticFields(entity);
        const candidate: IUnboundRecoveryCandidate = {
            entity,
            fields,
            fieldDigests: new Map(),
        };
        if (entity.identity.pdfRef !== undefined) {
            const refBucket = unboundByPdfRef.get(entity.identity.pdfRef);
            if (refBucket) {
                refBucket.push(candidate);
            } else {
                unboundByPdfRef.set(entity.identity.pdfRef, [candidate]);
            }
        }
        const kindBucket = unboundByKind.get(fields.kind);
        if (kindBucket) {
            kindBucket.push(candidate);
        } else {
            unboundByKind.set(fields.kind, [candidate]);
        }
    }

    const schemaBuckets = new Map<string, Map<string, IRecoverySignatureBucket>>();
    const getSchemaIndex = (
        kind: unknown,
        comparedKeys: readonly string[],
        heldKeys: readonly string[],
    ) => {
        const schemaKey = JSON.stringify([
            kind,
            comparedKeys,
            heldKeys,
        ]);
        let index = schemaBuckets.get(schemaKey);
        if (index) {
            return index;
        }
        index = new Map();
        const kindCandidates = unboundByKind.get(kind) ?? [];
        for (const candidate of kindCandidates) {
            const signature = JSON.stringify([
                comparedKeys.map(key => encodeComparedFieldValue(candidate.fields[key])),
                heldKeys.map(key => candidateFieldDigest(candidate, key)),
            ]);
            let bucket = index.get(signature);
            if (!bucket) {
                bucket = {
                    global: createRecoveryCandidateBucket(),
                    byPage: new Map(),
                };
                index.set(signature, bucket);
            }
            bucket.global.all.push(candidate);
            const pageKey = candidate.fields.pageIndex;
            let pageBucket = bucket.byPage.get(pageKey);
            if (!pageBucket) {
                pageBucket = createRecoveryCandidateBucket();
                bucket.byPage.set(pageKey, pageBucket);
            }
            pageBucket.all.push(candidate);
        }
        schemaBuckets.set(schemaKey, index);
        return index;
    };

    recovery.entities.forEach((captured) => {
        if (directIds.has(captured.identity.id)) return;
        const fields = semanticFields(captured);
        const changed = changedFields.get(captured.identity.id) ?? [];
        // A deletion the bytes already hold names no annotation of the read.
        if (captured.deleted && (recovery.version === 1 || !changed.includes('deleted'))) return;
        // Another read's geometry may be in another frame.
        const compared = comparedKeysFor(captured, fields).filter(key => !reread || !rotatableGeometryKeys.has(key));
        if (!compared.includes('kind')) return;
        const capturedRef = captured.identity.pdfRef?.trim();
        // Without a ref, an annotation the bytes hold binds by its fields: those it changed, by what the bytes held.
        const boundByFields = changed.length === 0 || heldFields.has(captured.identity.id);
        if (byRef && !capturedRef && !boundByFields) {
            return;
        }
        if (byRef && capturedRef) {
            const refCandidates = unboundByPdfRef.get(captured.identity.pdfRef!);
            if (!refCandidates) {
                return;
            }
            const activeHeld = activeHeldEntriesFor(captured);
            const matches = refCandidates.filter(candidate => !taken.has(candidate.entity.identity.id)
                && compared.every(key => sameField(candidate.fields, fields, key))
                && (!activeHeld || activeHeld.every(([key, digest]) => candidateFieldDigest(candidate, key) === digest)));
            const onPage = matches.length > 1
                ? matches.filter(({fields: candidate}) => sameField(candidate, fields, 'pageIndex'))
                : matches;
            if (onPage.length !== 1) return;
            const bound = onPage[0]!.entity;
            taken.add(bound.identity.id);
            ids.set(captured.identity.id, bound.identity.id);
            return;
        }

        const comparedKeys = compared.filter(key => key !== 'kind').sort();
        const activeHeld = (activeHeldEntriesFor(captured) ?? [])
            .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
        const heldKeys = activeHeld.map(([key]) => key);
        const index = getSchemaIndex(fields.kind, comparedKeys, heldKeys);
        const signature = JSON.stringify([
            comparedKeys.map(key => encodeComparedFieldValue(fields[key])),
            activeHeld.map(([, digest]) => digest),
        ]);
        const bucket = index.get(signature);
        if (!bucket) {
            return;
        }
        const globalMatch = probeRecoveryBucket(bucket.global, taken);
        if (globalMatch === 'none') {
            return;
        }
        let resolved: IUnboundRecoveryCandidate | null = null;
        if (globalMatch !== 'ambiguous') {
            resolved = globalMatch;
        } else {
            const pageBucket = bucket.byPage.get(fields.pageIndex);
            if (!pageBucket) {
                return;
            }
            const pageMatch = probeRecoveryBucket(pageBucket, taken);
            if (pageMatch === 'none' || pageMatch === 'ambiguous') {
                return;
            }
            resolved = pageMatch;
        }
        taken.add(resolved.entity.identity.id);
        ids.set(captured.identity.id, resolved.entity.identity.id);
    });
    return {ids, directIds};
}

/**
 * Replays the pending Save plan into a store after the admitted working bytes
 * have been parsed; the parse holds every annotation the plan leaves out, and
 * the foreign ones. The parsed baseline remains the saved baseline, so
 * recovered edits stay dirty, Save writes them, and they do not enter authored
 * undo history twice. Entities and drafts take the id the store's read gives
 * their PDF object.
 *
 * A plan from another read than the store's, such as one taken during a
 * rotation's re-read, may hold an older page or frame: each field the user did
 * not change takes the store's read value, so an unchanged entity is the read's
 * or stays out.
 */
export function restoreCanonicalAnnotationRecovery(
    store: Pick<AnnotationStore, 'importMany' | 'import' | 'get' | 'readRevision' | 'snapshotState' | 'resolveExternal'>,
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
            // The working bytes do not hold a changed entity, so Save writes it whatever revision it was captured at.
            const pending = changed?.length ? {...entity, persistedRevision: Math.min(entity.persistedRevision, entity.revision - 1)} : entity;
            if (reread && !changed && (held || !drafted.has(captured.identity.id) || captured.deleted)) {
                placedByRead.add(entity.identity.id);
            } else if (!changed || !read || read.kind !== entity.kind) {
                store.import(pending, {preserveSavedBaseline: true});
            } else {
                const unchanged = new Set(Object.keys(semanticFields(entity)).filter(key => !changed.includes(key)));
                store.import(takeParsedFields(pending, read, unchanged), {preserveSavedBaseline: true});
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
