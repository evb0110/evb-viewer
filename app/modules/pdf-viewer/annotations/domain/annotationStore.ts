import {
    admitsAnnotationReadback, keepsReplies,
} from './annotationReadbackGuards';
import {isEqual} from 'es-toolkit/predicate';
import type {IPageIdentityDelta} from '@contracts/electronApiPageOps';
import {mapPageNumberThroughPageIdentityDelta} from '@contracts/electronApiPageOps';
import {
    requirePageIndex,
    requirePageNumber,
} from '@contracts/pageNumbers';
import type {IPdfNativeAnnotationIdentityBinding} from '@contracts/electronApiDocuments';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {IAnnotationMarkerRect} from '@app/types/annotations';
import type {
    AnnotationEntity,
    AnnotationId,
    IAnnotationIdentity,
    IPlacedImageEntity,
    INoteEntity,
    IShapeEntity,
    ITextBoxEntity,
    ITextMarkupEntity,
    ISavedSemanticEntry,
    ITextMarkupOverlapCandidate,
    ITextMarkupSelectionProjection,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {
    asAnnotationId,
    buildTextMarkupSelectionPlan,
    isReadOnlyAnnotation,
    normalizeAnnotationText,
    remapSavedSemanticFingerprint,
    saveFrontierEntityBaseline,
    semanticFieldsUnchangedSince,
    semanticEntityFingerprint,
    semanticSnapshot,
    toLegacyShapeStableKey,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {
    AnnotationEntityTable,
    fingerprintOf,
    freezeStoredEntity,
    isStoredEntity,
    semanticEntryOf,
} from '@app/modules/pdf-viewer/annotations/domain/annotationEntityTable';
import {
    AnnotationPersistenceIdentityLedger,
    rebaseAnnotationPersistenceIdentity,
} from '@app/modules/pdf-viewer/annotations/domain/annotationPersistenceIdentityLedger';
import {ExternalIdentityIndex} from '@app/modules/pdf-viewer/annotations/domain/externalIdentityIndex';
import {
    LocalAnnotationHistoryAuthority,
    type IAnnotationHistoryAuthority,
    type TRegisterAnnotationHistoryFailureRollback,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-history/pdfAppAnnotationHistoryCommand';

export type {IAnnotationHistoryAuthority} from '@app/modules/pdf-viewer/engine/annotations/annotation-history/pdfAppAnnotationHistoryCommand';

const ANNOTATION_OBJECT_BYTES = 32;
const ANNOTATION_SLOT_BYTES = 8;
const ANNOTATION_STRING_BYTES = 16;
const ANNOTATION_COLLECTION_BYTES = 48;
const ANNOTATION_MAX_ESTIMATE_DEPTH = 12;

function estimateAnnotationValueBytes(value: unknown, depth: number, seen: WeakSet<object>): number {
    if (value === null || value === undefined) {
        return 8;
    }
    if (typeof value === 'string') {
        return ANNOTATION_STRING_BYTES + value.length * 2;
    }
    if (typeof value !== 'object') {
        return 8;
    }
    if (depth >= ANNOTATION_MAX_ESTIMATE_DEPTH || seen.has(value)) {
        return ANNOTATION_OBJECT_BYTES;
    }
    seen.add(value);
    if (ArrayBuffer.isView(value)) {
        return ANNOTATION_OBJECT_BYTES + value.byteLength;
    }
    if (Array.isArray(value)) {
        return ANNOTATION_OBJECT_BYTES + Array.from(value as readonly unknown[]).reduce<number>(
            (total, entry) => total + ANNOTATION_SLOT_BYTES + estimateAnnotationValueBytes(entry, depth + 1, seen),
            0,
        );
    }
    if (value instanceof Map) {
        let total = ANNOTATION_COLLECTION_BYTES;
        value.forEach((entry: unknown, key: unknown) => {
            total += ANNOTATION_SLOT_BYTES + estimateAnnotationValueBytes(entry, depth + 1, seen);
            total += estimateAnnotationValueBytes(key, depth + 1, seen);
        });
        return total;
    }
    if (value instanceof Set) {
        let total = ANNOTATION_COLLECTION_BYTES;
        value.forEach((entry: unknown) => {
            total += ANNOTATION_SLOT_BYTES + estimateAnnotationValueBytes(entry, depth + 1, seen);
        });
        return total;
    }
    return Object.entries(value).reduce(
        (total, [
            key,
            entry,
        ]) => total + ANNOTATION_SLOT_BYTES + key.length * 2
            + estimateAnnotationValueBytes(entry, depth + 1, seen),
        ANNOTATION_OBJECT_BYTES,
    );
}

export function estimateRetainedAnnotationBytes(records: readonly unknown[]): number {
    const seen = new WeakSet<object>();
    return records.reduce<number>(
        (total: number, record: unknown) => total + estimateAnnotationValueBytes(record, 0, seen),
        ANNOTATION_OBJECT_BYTES,
    );
}

/** A foreign record is displayed and preserved by the writer, never edited here. */
export interface IPdfForeignAnnotationRecord {
    readonly kind?: 'foreign';
    readonly pageIndex: number;
    readonly subtype: string;
    readonly name: string | null;
    readonly objectNumber: number;
    readonly generationNumber: number;
    readonly reason?: string;
}

export interface IAnnotationStoreState {
    readonly entities: ReadonlyMap<AnnotationId, AnnotationEntity>;
    readonly saved: ReadonlyMap<AnnotationId, ISavedSemanticEntry>;
    readonly working: ReadonlyMap<AnnotationId, ISavedSemanticEntry>;
}

interface IHistoryEntry {
    readonly id: AnnotationId;
    readonly before: AnnotationEntity | null;
    readonly after: AnnotationEntity | null;
}

/** An entry of the pending Save plan. */
export interface IPendingAnnotationChange {
    readonly entity: AnnotationEntity;
    /** The semantic fields that differ from what the working bytes hold; none when they hold an edit Save has not persisted. */
    readonly changedFields: readonly string[];
    /** What the working bytes hold of each changed field; null when they hold nothing of the annotation. */
    readonly heldFields: Readonly<Record<string, unknown>> | null;
}

export interface IAnnotationSaveFrontier {
    readonly documentRevisionToken: TDocumentRevisionToken | null;
    readonly epoch: number;
    readonly entityBaselineHash: string;
    readonly revisions: ReadonlyMap<AnnotationId, number>;
}

interface IBulkImportState {canUseFastPath: boolean;}

type TListener = (entities: readonly AnnotationEntity[]) => void;

function cloneEntity<T extends AnnotationEntity>(entity: T): T {
    return structuredClone(entity);
}

function liveIdentityOf(entity: AnnotationEntity | null | undefined) {
    return entity && !entity.deleted ? entity.identity : null;
}

function isDirty(entity: AnnotationEntity) {
    return entity.revision > entity.persistedRevision;
}

function sameSemanticEntry(left: ISavedSemanticEntry | undefined, right: ISavedSemanticEntry | undefined) {
    return left === right || (left !== undefined && right !== undefined
        && left.kind === right.kind && left.deleted === right.deleted && left.fingerprint === right.fingerprint);
}

/**
 * The semantic fields of `entity` that differ from `working`, what the working bytes hold of it, and their values
 * there: every field when they hold no live annotation for it, such as one whose saved deletion was undone, and none
 * for a deletion they hold or an annotation they never held.
 */
function semanticChangesSince(entity: AnnotationEntity, working: ISavedSemanticEntry | undefined) {
    const holdsNone = working === undefined || working.deleted;
    if (entity.deleted && holdsNone) return {changedFields: [], heldFields: null};
    const current = JSON.parse(fingerprintOf(entity)) as Record<string, unknown>;
    const base = holdsNone ? null : JSON.parse(working.fingerprint) as Record<string, unknown>;
    const changedFields = Object.keys(current).filter(key => !base || JSON.stringify(current[key]) !== JSON.stringify(base[key]));
    return {changedFields, heldFields: base && Object.fromEntries(changedFields.map(key => [key, base[key]]))};
}

/**
 * `current` with the fields in `unchanged` taken from `parsed`, which ends as
 * the fields taken. A label's rect and rotation go together, and its frame and
 * read-only state are the parser's.
 */
export function takeParsedFields(current: AnnotationEntity, parsed: AnnotationEntity, unchanged: Set<string>) {
    const merged = {...current};
    const fields: Record<string, unknown> = merged;
    const read: Record<string, unknown> = {...parsed};
    if (current.kind === 'text-box') {
        if (!unchanged.has('rect') || !unchanged.has('rotation')) ['rect', 'rotation'].forEach(key => unchanged.delete(key));
        ['frame', 'readOnly'].forEach(key => unchanged.add(key));
    }
    if (current.kind === 'text-markup' && unchanged.has('quadPoints') && read.selectedText) unchanged.add('selectedText');
    // Replies and a note's recovery graph are the parser's, read from the same bytes, pages included.
    ['replies', 'recoveryData'].forEach(key => unchanged.add(key));
    unchanged.forEach((key) => {
        if (key in read) fields[key] = read[key];
        else delete fields[key];
    });
    return merged;
}

/**
 * A re-read reads bytes that hold no unsaved edit. A field still at the working
 * baseline takes the parse, such as a rotated page's geometry; a field changed
 * since keeps the edit. A tombstone merges the same way.
 */
function mergeReread(current: AnnotationEntity, parsed: AnnotationEntity, base: ISavedSemanticEntry | undefined) {
    if (!base || base.kind !== current.kind || parsed.kind !== current.kind) return current;
    return takeParsedFields(current, parsed, new Set(semanticFieldsUnchangedSince(current, base.fingerprint)));
}

/**
 * Undo and Redo replay only the fields the command changed. Every other field
 * keeps its live value, such as geometry a later re-read took from the page.
 */
function replayOnto(live: AnnotationEntity | undefined, entry: IHistoryEntry, side: 'before' | 'after') {
    const target = entry[side];
    if (!live || !target || !entry.before || !entry.after) return target;
    const merged = {...live};
    const fields: Record<string, unknown> = merged;
    const pair: Record<string, unknown>[] = [{...entry.before}, {...entry.after}];
    const captured = side === 'before' ? pair[0]! : pair[1]!;
    new Set(pair.flatMap(Object.keys)).forEach((key) => {
        if (isEqual(pair[0]![key], pair[1]![key])) return;
        if (key in captured) fields[key] = captured[key];
        else delete fields[key];
    });
    return merged;
}

function cloneCanonicalEntity<T extends AnnotationEntity>(entity: T): T {
    const cloned = cloneEntity(entity);
    switch (cloned.kind) {
        case 'text-box':
            return {
                ...cloned,
                text: normalizeAnnotationText(cloned.text),
                rect: structuredClone(cloned.rect),
            };
        case 'note':
            return {
                ...cloned,
                contents: normalizeAnnotationText(cloned.contents),
                position: structuredClone(cloned.position),
                ...(cloned.replies === undefined
                    ? {}
                    : {replies: cloned.replies.map(reply => structuredClone(reply))}),
            };
        case 'text-markup':
            return {
                ...cloned,
                contents: normalizeAnnotationText(cloned.contents),
                quadPoints: cloned.quadPoints.map(rect => structuredClone(rect)),
            };
        case 'placed-image':
            return {
                ...cloned,
                rect: structuredClone(cloned.rect),
                image: structuredClone(cloned.image),
            };
        case 'shape':
            return {
                ...cloned,
                rect: structuredClone(cloned.rect),
                points: cloned.points?.map(point => ({...point})),
                strokes: cloned.strokes?.map(stroke => stroke.map(point => ({...point}))),
            };
    }
}

function sameTextMarkupGeometry(
    left: ITextMarkupEntity['quadPoints'],
    right: ITextMarkupEntity['quadPoints'],
) {
    return left.length === right.length && left.every((rect, index) => {
        const candidate = right[index];
        return candidate?.left === rect.left
            && candidate.top === rect.top
            && candidate.width === rect.width
            && candidate.height === rect.height;
    });
}

function sameTextMarkupGeometryAfterRoundTrip(
    left: ITextMarkupEntity['quadPoints'],
    right: ITextMarkupEntity['quadPoints'],
) {
    const epsilon = 0.0001;
    const order = (first: IAnnotationMarkerRect, second: IAnnotationMarkerRect) => (
        first.top - second.top
        || first.left - second.left
        || first.width - second.width
        || first.height - second.height
    );
    const sortedLeft = [...left].sort(order);
    const sortedRight = [...right].sort(order);
    return sortedLeft.length === sortedRight.length && sortedLeft.every((rect, index) => {
        const candidate = sortedRight[index];
        return candidate !== undefined
            && Math.abs(candidate.left - rect.left) <= epsilon
            && Math.abs(candidate.top - rect.top) <= epsilon
            && Math.abs(candidate.width - rect.width) <= epsilon
            && Math.abs(candidate.height - rect.height) <= epsilon;
    });
}

function identityWithPdfRef(identity: IAnnotationIdentity, pdfRef: string | undefined) {
    return rebaseAnnotationPersistenceIdentity(identity, pdfRef);
}

/**
 * Native shape creation reports the managed stable key because the new PDF
 * object has no PDF.js reference yet. Keep the store's canonical id as the
 * owner while accepting that writer-facing alias during acknowledgement.
 */
function nativeBindingAliasesForEntity(entity: AnnotationEntity): readonly string[] {
    if (entity.kind !== 'shape') {
        return [entity.identity.id];
    }
    return [
        entity.identity.id,
        toLegacyShapeStableKey(entity.identity.id),
    ];
}

function hasRectLineEndpoints(entity: IShapeEntity) {
    if ((entity.tool !== 'line' && entity.tool !== 'arrow') || entity.points?.length !== 2) {
        return false;
    }
    const [
        start,
        end,
    ] = entity.points;
    const epsilon = 1e-6;
    const left = entity.rect.left;
    const top = entity.rect.top;
    const right = left + entity.rect.width;
    const bottom = top + entity.rect.height;
    const matches = (first: typeof start, last: typeof end) => (
        Math.abs(first!.x - left) <= epsilon
        && Math.abs(first!.y - top) <= epsilon
        && Math.abs(last!.x - right) <= epsilon
        && Math.abs(last!.y - bottom) <= epsilon
    );
    return matches(start, end) || matches(end, start);
}

function saveReconciliationFingerprint(entity: AnnotationEntity) {
    if (entity.kind === 'shape') {
        const withoutDeletion = {
            ...entity,
            deleted: false,
        };
        if (!hasRectLineEndpoints(entity)) {
            return semanticEntityFingerprint(withoutDeletion);
        }
        const {
            points: _points,
            ...withoutPoints
        } = withoutDeletion;
        return semanticEntityFingerprint(withoutPoints);
    }
    return semanticEntityFingerprint(entity);
}

/**
 * The canonical annotations of one document. Every entity it holds is deep-frozen and replaced, never changed, so
 * readers receive the stored objects themselves: a returned entity or snapshot cannot be written, and the store never
 * copies the document to publish it. The entity table indexes them by page and tracks which differ from the saved file.
 */
export class AnnotationStore {
    // The entities, tombstones included, and what the saved file holds of them.
    readonly #entities = new AnnotationEntityTable();
    readonly #identities = new ExternalIdentityIndex();
    readonly #listeners = new Set<TListener>();
    readonly #history: IAnnotationHistoryAuthority;
    readonly #saveFrontiers = new WeakMap<IAnnotationSaveFrontier, ReadonlyMap<AnnotationId, ISavedSemanticEntry>>();
    readonly #persistenceIdentities = new AnnotationPersistenceIdentityLedger();
    readonly #retainedHistoryTargets = new Map<AnnotationId, number>();
    #foreign: readonly IPdfForeignAnnotationRecord[] = [];
    // What the working bytes hold: a write can put edits there that Save has not published yet.
    #workingSemanticSnapshot = new Map<AnnotationId, ISavedSemanticEntry>();
    #mutationEpoch = 0;
    #readWholeDocument = false;
    #readRevision: TDocumentRevisionToken | null = null;
    #objectsRenumbered = false;
    #batchDepth = 0;
    #batchEmissionPending = false;
    #bulkImportState: IBulkImportState | null = null;

    constructor(history: IAnnotationHistoryAuthority = new LocalAnnotationHistoryAuthority()) {
        this.#history = history;
    }

    /** Monotonic semantic-state generation for asynchronous document fences. */
    get mutationEpoch() {
        return this.#mutationEpoch;
    }

    /** The frozen entities in store order; the same frozen array until the store next changes or publishes. */
    list(options: {includeDeleted?: boolean} = {}): readonly AnnotationEntity[] {
        return this.#entities.snapshot(options.includeDeleted === true);
    }

    get(id: AnnotationId): AnnotationEntity | null {
        return this.#entities.get(id) ?? null;
    }

    /** Includes creations removed by undo while their redo commands remain. */
    deletedAnnotationIds(): readonly AnnotationId[] {
        return [
            ...this.#entities.tombstoneIds(),
            ...Array.from(this.#retainedHistoryTargets.keys()).filter(id => !this.#entities.has(id)),
        ];
    }

    resolveExternal(bindings: Omit<IAnnotationIdentity, 'id'>): AnnotationId | null {
        return this.#identities.resolve(bindings);
    }

    /** Publishes one complete frozen snapshot, including tombstones; readers must filter deleted records for live UI. */
    subscribe(listener: TListener) {
        this.#listeners.add(listener);
        listener(this.list({includeDeleted: true}));
        return () => this.#listeners.delete(listener);
    }

    /** Defers the immutable store snapshot until a group of related mutations finishes. */
    batch<T>(callback: () => T): T {
        this.#batchDepth += 1;
        try {
            return callback();
        } finally {
            this.#batchDepth -= 1;
            if (this.#batchDepth === 0 && this.#batchEmissionPending) {
                this.#batchEmissionPending = false;
                this.#emitNow();
            }
        }
    }

    /**
     * Runs related persisted imports with one saved-baseline comparison and one
     * published snapshot. Each import still updates the identity index in
     * callback order.
     */
    importMany<T>(callback: () => T): T {
        if (this.#bulkImportState) {
            return callback();
        }
        this.#bulkImportState = {canUseFastPath: !this.hasChangesSinceSavedBaseline()};
        try {
            return this.batch(callback);
        } finally {
            this.#bulkImportState = null;
        }
    }

    /** Imports one canonical persisted entity without registering authored history. */
    import(entity: AnnotationEntity, options: {preserveSavedBaseline?: boolean} = {}) {
        const bulkImportState = this.#bulkImportState;
        const canUseFastPath = bulkImportState?.canUseFastPath === true;
        const shouldUpdateSavedBaseline = entity.persistedRevision >= 0
            && options.preserveSavedBaseline !== true;
        const wasSemanticallyClean = shouldUpdateSavedBaseline
            ? bulkImportState
                ? canUseFastPath || !this.hasChangesSinceSavedBaseline()
                : !this.hasChangesSinceSavedBaseline()
            : false;
        const current = this.#entities.get(entity.identity.id);
        if (current && current.revision > entity.revision) {
            return current;
        }
        const imported = cloneCanonicalEntity(entity);
        this.#replaceEntities([{
            id: imported.identity.id,
            before: current ?? null,
            after: imported,
        }]);
        if (shouldUpdateSavedBaseline) {
            // The working bytes hold what was read from them; so does the saved file while nothing was unsaved.
            const entry = semanticEntryOf(imported);
            this.#workingSemanticSnapshot.set(imported.identity.id, entry);
            if (wasSemanticallyClean) {
                this.#entities.setSaved(imported.identity.id, entry);
                // Outside a bulk import the saved file is then the store's annotations, tombstones included.
                if (!canUseFastPath) this.#entities.adoptCurrentAsSaved();
            }
        } else if (
            canUseFastPath
            && (!current || fingerprintOf(current) !== fingerprintOf(imported))
        ) {
            this.#disableBulkImportFastPath();
        }
        this.#mutationEpoch += 1;
        this.#emit(true);
        return imported;
    }

    get foreign(): readonly IPdfForeignAnnotationRecord[] {
        return this.#foreign.map(record => structuredClone(record));
    }

    getForeignAnnotations() {
        return this.foreign;
    }

    createTextBox(entity: ITextBoxEntity) {
        return this.#create(entity, 'text-box');
    }

    createNote(entity: INoteEntity) {
        return this.#create(entity, 'note');
    }

    /** Compatibility name for callers that describe the canonical note UI. */
    createStickyNote(entity: INoteEntity) {
        return this.createNote(entity);
    }

    createTextMarkup(entity: ITextMarkupEntity) {
        return this.#create(entity, 'text-markup');
    }

    createPlacedImage(entity: IPlacedImageEntity) {
        return this.#create(entity, 'placed-image');
    }

    createShape(entity: IShapeEntity) {
        return this.#create(entity, 'shape');
    }

    updateTextBox(
        id: AnnotationId,
        patch: Partial<Pick<ITextBoxEntity, 'text' | 'rect' | 'rotation' | 'fontSize' | 'color'>>,
    ) {
        return this.#update<ITextBoxEntity>(id, 'text-box', entity => ({
            ...entity,
            ...structuredClone(patch),
            ...(patch.text === undefined ? {} : {text: normalizeAnnotationText(patch.text)}),
        }));
    }

    updateNote(
        id: AnnotationId,
        patch: Partial<Pick<INoteEntity, 'contents' | 'position' | 'color' | 'open'>>,
    ) {
        return this.#update<INoteEntity>(id, 'note', entity => ({
            ...entity,
            ...structuredClone(patch),
            ...(patch.contents === undefined ? {} : {contents: normalizeAnnotationText(patch.contents)}),
        }));
    }

    /** Updates authored note text through the canonical kind-specific mutator. */
    setNoteText(id: AnnotationId, text: string) {
        const entity = this.#require(id);
        if (entity.kind === 'note') {
            return this.updateNote(id, {contents: text});
        }
        if (entity.kind === 'text-box') {
            return this.updateTextBox(id, {text});
        }
        if (entity.kind === 'text-markup') {
            return this.updateTextMarkup(id, {contents: text});
        }
        throw new Error('setNoteText requires a note-bearing annotation');
    }

    bindIdentity(event: {
        readonly annotationId: AnnotationId;
        readonly expectedRevision: number;
        readonly bindings: Pick<IAnnotationIdentity, 'pdfRef'>;
    }) {
        const entity = this.#require(event.annotationId);
        if (entity.revision !== event.expectedRevision) {
            throw new Error(`Stale identity binding for ${event.annotationId}`);
        }
        const pdfRef = event.bindings.pdfRef;
        const identity = pdfRef === undefined
            ? entity.identity
            : {
                ...entity.identity,
                pdfRef,
            };
        const identityChanged = entity.identity.pdfRef !== identity.pdfRef;
        if (identityChanged) {
            this.#disableBulkImportFastPath();
        }
        this.#replaceEntities([{
            id: entity.identity.id,
            before: entity,
            after: {
                ...entity,
                identity,
            },
        }]);
        this.#mutationEpoch += 1;
        this.#emit(Boolean(this.#bulkImportState) && !identityChanged);
    }

    updateTextMarkup(
        id: AnnotationId,
        patch: Partial<Pick<ITextMarkupEntity, 'subtype' | 'contents' | 'quadPoints' | 'color' | 'opacity'>>,
    ) {
        return this.#update<ITextMarkupEntity>(id, 'text-markup', entity => ({
            ...entity,
            ...structuredClone(patch),
            ...(patch.contents === undefined ? {} : {contents: normalizeAnnotationText(patch.contents)}),
            ...(patch.quadPoints === undefined || sameTextMarkupGeometry(entity.quadPoints, patch.quadPoints)
                ? {}
                : {selectedText: null}),
        }));
    }

    /** Updates parser-derived preview text without creating an authored revision. */
    updateTextMarkupSelectedText(
        id: AnnotationId,
        selectedText: string | null,
        expectedQuadPoints?: ITextMarkupEntity['quadPoints'],
    ) {
        const entity = this.#entities.get(id);
        if (!entity || entity.deleted || entity.kind !== 'text-markup') {
            return false;
        }
        if (expectedQuadPoints && !sameTextMarkupGeometry(entity.quadPoints, expectedQuadPoints)) {
            return false;
        }
        // Text extraction runs after the parsed annotation is committed. A
        // transiently unavailable text layer reports null, but that result
        // must not erase a preview captured when the markup was created or
        // by an earlier successful extraction.
        if (selectedText === null && entity.selectedText?.trim()) {
            return false;
        }
        if ((entity.selectedText ?? null) === selectedText) {
            return false;
        }
        this.#entities.set(id, {
            ...entity,
            selectedText,
        });
        this.#emit();
        return true;
    }

    updatePlacedImage(
        id: AnnotationId,
        patch: Partial<Pick<IPlacedImageEntity, 'rect' | 'rotation' | 'image'>>,
    ) {
        return this.#update<IPlacedImageEntity>(id, 'placed-image', entity => ({
            ...entity,
            ...structuredClone(patch),
        }));
    }

    updateShape(
        id: AnnotationId,
        patch: Partial<Pick<IShapeEntity, 'tool' | 'pdfSubtype' | 'lineStartStyle' | 'lineEndStyle' | 'rect' | 'points' | 'strokes' | 'strokeColor' | 'strokeWidth' | 'fill' | 'opacity'>>,
    ) {
        return this.#update<IShapeEntity>(id, 'shape', entity => ({
            ...entity,
            ...structuredClone(patch),
        }));
    }

    delete(id: AnnotationId) {
        return this.#update(id, undefined, entity => ({
            ...entity,
            deleted: true,
        }));
    }

    /**
     * Applies one document parse as one store transaction. Parsed entities are
     * the saved baseline. A dirty entity or tombstone receives the parsed PDF
     * object reference and fingerprint, and merges field by field (`mergeReread`).
     *
     * A parse of some pages (`pageIndices`) replaces only those pages; entities
     * and foreign records on other pages stay as they are. It changes nothing
     * and returns false when those pages alone cannot stand for the whole
     * document: a parsed annotation that matches an entity on another page, or
     * a parsed thread without a reply this store holds, which may sit on a page
     * the parse did not read.
     *
     * `readRevision` names the bytes parsed; null when the caller cannot name them.
     */
    replaceFromDocument(
        entities: readonly AnnotationEntity[],
        foreign: readonly IPdfForeignAnnotationRecord[],
        pageIndices?: readonly number[],
        expectedUpserts: ReadonlyArray<Pick<AnnotationEntity, 'identity' | 'kind'>> = [],
        deletedReplyRefs: readonly string[] = [],
        preserveSavedBaseline = false,
        readRevision: TDocumentRevisionToken | null = null,
    ) {
        const scope = pageIndices === undefined ? null : new Set(pageIndices);
        const inScope = (entry: {pageIndex: number}) => scope === null || scope.has(entry.pageIndex);
        if (!admitsAnnotationReadback(entities, foreign, scope, expectedUpserts)) return false;
        // The read pages' entities, tombstones included. A parse leaves a live entity on another page as it is.
        const scopedIds = scope === null ? [...this.#entities.keys()] : this.#entities.idsOnPages(scope);
        const scopedEntities = () => scopedIds.map(id => [id, this.#entities.get(id)!] as const);
        const confirmedDeletedReplies = new Set(deletedReplyRefs);
        const usedCurrentIds = new Set<AnnotationId>();
        const fingerprintMatchedIds = new Set<AnnotationId>();
        const parsedById = new Map<AnnotationId, AnnotationEntity>();
        let fingerprintCandidates: Map<string, Set<AnnotationId>> | undefined;
        const fingerprintBucketById = new Map<AnnotationId, Set<AnnotationId>>();
        let blankRefCandidates: Map<string, Set<AnnotationId>> | undefined;
        // A page operation renumbers the document's objects (`remapPages`), so until a read of the whole document
        // lands, refs and the ids the parser mints from page and object can name other annotations. Each annotation
        // is then found by what the working bytes hold of it, page included, deletions not yet written as well.
        const renumbered = this.#objectsRenumbered;
        let baselineCandidates: Map<string, Set<AnnotationId>> | undefined;
        const baselineBucketById = new Map<AnnotationId, Set<AnnotationId>>();
        const workingBaselineId = (entity: AnnotationEntity) => {
            if (!baselineCandidates) {
                baselineCandidates = new Map();
                scopedEntities().forEach(([id]) => {
                    const base = this.#workingSemanticSnapshot.get(id);
                    if (!base || base.deleted || usedCurrentIds.has(id)) return;
                    const bucket = baselineCandidates!.get(base.fingerprint) ?? new Set<AnnotationId>();
                    bucket.add(id);
                    baselineCandidates!.set(base.fingerprint, bucket);
                    baselineBucketById.set(id, bucket);
                });
            }
            const bucket = baselineCandidates.get(semanticEntityFingerprint(entity));
            return bucket?.size === 1 ? bucket.values().next().value : undefined;
        };
        const uniqueFingerprintId = (entity: AnnotationEntity) => {
            if (!fingerprintCandidates) {
                fingerprintCandidates = new Map();
                scopedEntities().forEach(([id, current]) => {
                    if (current.deleted || usedCurrentIds.has(id)
                        || !(current.persistedRevision >= 0 || current.kind === 'shape')) {
                        return;
                    }
                    // The semantic key includes kind and page. Keep every
                    // candidate: an ambiguous bucket can become unique later.
                    const key = saveReconciliationFingerprint(current);
                    const bucket = fingerprintCandidates!.get(key) ?? new Set<AnnotationId>();
                    bucket.add(id);
                    fingerprintCandidates!.set(key, bucket);
                    fingerprintBucketById.set(id, bucket);
                });
            }
            const bucket = fingerprintCandidates.get(saveReconciliationFingerprint(entity));
            return bucket?.size === 1 ? bucket.values().next().value : undefined;
        };
        const referenceId = (pdfRef: string | undefined) => {
            if (pdfRef === undefined) {
                return undefined;
            }
            if (pdfRef.trim()) {
                const id = this.#identities.resolve({pdfRef});
                const current = id ? this.#entities.get(id) : undefined;
                // The external index normalizes refs; this reconciliation has
                // always required raw equality, even for dirty local entities.
                return current && !current.deleted && !usedCurrentIds.has(current.identity.id)
                    && current.identity.pdfRef === pdfRef ? current.identity.id : undefined;
            }
            // Blank refs are not indexed external bindings, but raw equality
            // previously admitted them. Derive their candidates only if needed.
            if (!blankRefCandidates) {
                blankRefCandidates = new Map();
                scopedEntities().forEach(([id, current]) => {
                    const ref = current.identity.pdfRef;
                    if (current.deleted || usedCurrentIds.has(id) || ref === undefined || ref.trim()) {
                        return;
                    }
                    const bucket = blankRefCandidates!.get(ref) ?? new Set<AnnotationId>();
                    bucket.add(id);
                    blankRefCandidates!.set(ref, bucket);
                });
            }
            const bucket = blankRefCandidates.get(pdfRef);
            return bucket?.size === 1 ? bucket.values().next().value : undefined;
        };
        // Every annotation the working bytes hold claims its own parse before a minted id can claim it.
        const baselineIds = entities.map((entity) => {
            const baselineId = renumbered ? workingBaselineId(entity) : undefined;
            if (baselineId !== undefined) {
                usedCurrentIds.add(baselineId);
                baselineBucketById.get(baselineId)?.delete(baselineId);
            }
            return baselineId;
        });
        for (let [index, entity] of entities.entries()) {
            let id = entity.identity.id;
            const baselineId = baselineIds[index];
            const collidingExisting = this.#entities.get(id);
            if (renumbered && baselineId === undefined && collidingExisting
                && (usedCurrentIds.has(id) || collidingExisting.deleted || collidingExisting.kind !== entity.kind)) {
                // Its minted id names another annotation or a tombstone from before renumbering.
                id = asAnnotationId(crypto.randomUUID());
                entity = {...entity, identity: {...entity.identity, id}};
            }
            if (baselineId !== undefined ? baselineId !== id : !this.#entities.has(id)) {
                const matchedId = baselineId ?? (renumbered ? undefined : referenceId(entity.identity.pdfRef)) ?? uniqueFingerprintId(entity);
                if (matchedId !== undefined) {
                    id = matchedId;
                    fingerprintMatchedIds.add(id);
                    entity = {
                        ...entity,
                        identity: {
                            ...entity.identity,
                            id,
                        },
                    };
                }
            }
            const matched = this.#entities.get(id);
            if (scope && matched && (!inScope(matched) || !keepsReplies(entity, matched, confirmedDeletedReplies))) {
                return false;
            }
            if (parsedById.has(id)) {
                throw new Error(`Duplicate parsed AnnotationId ${id}`);
            }
            usedCurrentIds.add(id);
            fingerprintBucketById.get(id)?.delete(id);
            baselineBucketById.get(id)?.delete(id);
            const currentRef = this.#entities.get(id)?.identity.pdfRef;
            if (currentRef !== undefined) {
                blankRefCandidates?.get(currentRef)?.delete(id);
            }
            parsedById.set(id, cloneCanonicalEntity(entity));
        }

        // What the read changes: the entity and saved entry of each annotation it reaches. Saved entries of
        // annotations the store no longer holds do not outlive a read.
        const nextEntities = new Map<AnnotationId, AnnotationEntity>();
        const nextSaved = new Map<AnnotationId, ISavedSemanticEntry | undefined>(
            this.#entities.orphanedSavedIds().map(id => [id, undefined]),
        );
        const keep = (id: AnnotationId, entity: AnnotationEntity, saved: ISavedSemanticEntry | undefined) => {
            nextEntities.set(id, entity);
            nextSaved.set(id, saved);
        };
        const forgotten = new Set<AnnotationId>();
        const forget = (id: AnnotationId) => {
            forgotten.add(id);
            nextSaved.set(id, undefined);
        };
        // The bytes still hold these objects, but the editor can no longer own
        // them, e.g. a FreeText after its page rotated. The writer preserves them.
        const nowForeign = new Set(foreign.map(record => this.#identities.resolve({pdfRef: `${record.objectNumber} ${record.generationNumber} R`})));
        const saved = this.#entities.saved;
        // A tombstone on any page reaches the read: the parse holds no deletion.
        const reached = scope === null ? scopedIds : this.#entities.idsOnPages(scope, true);
        reached.forEach((id) => {
            const current = this.#entities.get(id)!;
            const parsed = parsedById.get(id);
            if (!parsed && !current.deleted && !isDirty(current) && nowForeign.has(id)) {
                forget(id);
                return;
            }
            if (preserveSavedBaseline) {
                // Persisted records follow the writer's page geometry. Pending
                // edits and tombstones keep their accepted intent and baseline.
                const reconciled = !parsed
                    ? current
                    : !current.deleted && !isDirty(current)
                        ? {
                            ...parsed,
                            revision: current.revision,
                        }
                        : mergeReread(current, parsed, this.#workingSemanticSnapshot.get(id));
                const represented = parsed && semanticEntityFingerprint(parsed) === fingerprintOf(reconciled);
                keep(id, {
                    ...reconciled,
                    // A pending edit to a now-foreign object stays bound to it, so Save targets that object.
                    identity: identityWithPdfRef(current.identity, parsed?.identity.pdfRef ?? (nowForeign.has(id) ? current.identity.pdfRef : undefined)),
                    persistedRevision: represented || (!parsed && current.deleted && saved.get(id)?.deleted) ? current.revision : -1,
                }, saved.get(id));
                return;
            }
            if (!parsed) {
                // A committed deletion is absent from the parse by design.
                // Keep its command target so undo can recreate it without a
                // retired PDF ref, including after repeated saves.
                if (current.deleted && current.persistedRevision >= 0 && !isDirty(current)
                    && this.#retainedHistoryTargets.has(id)) {
                    keep(id, current, semanticEntryOf(current));
                    return;
                }
                const materializedLocalShapeTombstone = current.kind === 'shape'
                    && current.deleted
                    && current.identity.pdfRef === undefined
                    && current.materialized === true;
                if (isDirty(current) && !materializedLocalShapeTombstone) {
                    keep(id, current, saved.get(id));
                } else {
                    forget(id);
                }
                return;
            }

            const parsedEntry = {
                kind: parsed.kind,
                deleted: parsed.deleted,
                fingerprint: semanticEntityFingerprint(parsed),
            };
            if (isDirty(current)) {
                keep(id, {
                    ...mergeReread(current, parsed, this.#workingSemanticSnapshot.get(id)),
                    identity: current.kind === 'shape'
                        && fingerprintMatchedIds.has(id)
                        && current.persistedRevision < 0
                        && current.identity.pdfRef === undefined
                        ? current.identity
                        : identityWithPdfRef(current.identity, parsed.identity.pdfRef),
                    ...(current.kind === 'shape'
                        && fingerprintMatchedIds.has(id)
                        && current.identity.pdfRef === undefined
                        ? {materialized: true}
                        : {}),
                }, parsedEntry);
                return;
            }
            const parsedCanonical = current.kind === 'text-markup'
                && parsed.kind === 'text-markup'
                && (parsed.selectedText === undefined || parsed.selectedText === null)
                && current.selectedText?.trim()
                && sameTextMarkupGeometryAfterRoundTrip(current.quadPoints, parsed.quadPoints)
                ? {
                    ...parsed,
                    selectedText: current.selectedText,
                }
                : parsed;
            keep(id, {
                ...parsedCanonical,
                identity: {
                    ...parsedCanonical.identity,
                    id,
                },
                revision: current.revision,
                persistedRevision: current.revision,
            }, parsedEntry);
        });

        parsedById.forEach((parsed, id) => {
            if (this.#entities.has(id)) {
                return;
            }
            if (preserveSavedBaseline && this.#retainedHistoryTargets.has(id)) {
                // A creation undone out of the store stays absent even if an
                // older checkpoint still contains its PDF object.
                keep(id, {
                    ...parsed,
                    deleted: true,
                    revision: 1,
                    persistedRevision: 0,
                }, saved.get(id));
                return;
            }
            const inserted = {
                ...parsed,
                revision: 0,
                persistedRevision: 0,
                deleted: false,
            };
            keep(id, inserted, semanticEntryOf(freezeStoredEntity(inserted)));
        });

        // What the working bytes hold of the read pages is what the parse holds.
        const parsedWorking = semanticSnapshot(parsedById.values());
        this.#history.forgetCommands(forgotten);
        this.#replaceEntities([
            ...Array.from(forgotten, id => ({
                id,
                before: this.#entities.get(id) ?? null,
                after: null,
            })),
            ...Array.from(nextEntities, ([id, after]) => ({
                id,
                before: this.#entities.get(id) ?? null,
                after,
            })).filter(entry => entry.before !== entry.after),
        ]);
        forgotten.forEach(id => this.#persistenceIdentities.forget(id));
        nextSaved.forEach((entry, id) => this.#entities.setSaved(id, entry));
        if (scope === null) this.#workingSemanticSnapshot.clear();
        else scopedIds.forEach(id => this.#workingSemanticSnapshot.delete(id));
        parsedWorking.forEach((entry, id) => this.#workingSemanticSnapshot.set(id, entry));
        if (preserveSavedBaseline) this.#persistenceIdentities.clear();
        this.#foreign = [
            ...this.#foreign.filter(record => !inScope(record)),
            ...foreign.map(record => structuredClone(record)),
        ].sort((left, right) => left.pageIndex - right.pageIndex);
        this.#readWholeDocument ||= !scope;
        if (!scope) this.#objectsRenumbered = false;
        this.#readRevision = readRevision;
        this.#mutationEpoch += 1;
        this.#emit();
        return true;
    }

    applyTextMarkupSelection(
        created: ITextMarkupEntity,
        overlapCandidates: readonly ITextMarkupOverlapCandidate[],
        resolveSelectedText?: (
            quadPoints: readonly IAnnotationMarkerRect[],
        ) => string | null | undefined,
    ): ITextMarkupSelectionProjection {
        if (this.#entities.has(created.identity.id)) {
            throw new Error(`Duplicate AnnotationId ${created.identity.id}`);
        }
        this.#assertNewEntity(created);
        const initialPlan = buildTextMarkupSelectionPlan({
            created,
            overlapCandidates,
            // The plan reads only annotations on the created markup's page, in store order.
            entities: this.#entities.onPage(created.pageIndex),
        });
        const shouldResolveSelectedText = initialPlan.replacements.length > 0
            || !initialPlan.projection.created.selectedText?.trim();
        const resolvedSelectedText = shouldResolveSelectedText
            ? resolveSelectedText?.(initialPlan.projection.created.quadPoints)
            : undefined;
        let plan = initialPlan;
        if (resolvedSelectedText !== undefined) {
            const selectedText = resolvedSelectedText === null
                && initialPlan.projection.created.selectedText?.trim()
                ? initialPlan.projection.created.selectedText
                : resolvedSelectedText;
            plan = {
                ...initialPlan,
                replacements: initialPlan.replacements.map(replacement => (
                    replacement.after.identity.id === initialPlan.projection.created.identity.id
                        ? {
                            ...replacement,
                            after: {
                                ...replacement.after,
                                selectedText,
                            },
                        }
                        : replacement
                )),
                projection: {
                    ...initialPlan.projection,
                    created: {
                        ...initialPlan.projection.created,
                        selectedText,
                    },
                },
            };
        }
        const entries: IHistoryEntry[] = plan.replacements.map(replacement => ({
            id: replacement.before.identity.id,
            before: replacement.before,
            // Its geometry can hold the caller's rects.
            after: cloneEntity(replacement.after),
        }));
        if (plan.projection.created.identity.id === created.identity.id) {
            entries.push({
                id: created.identity.id,
                before: null,
                after: cloneCanonicalEntity(plan.projection.created),
            });
        }
        if (entries.length > 0) {
            this.#commit(entries);
        }
        return plan.projection;
    }

    /** Hard-removes entities absent from an authoritative document. */
    forget(ids: ReadonlySet<AnnotationId>) {
        const removed = new Set<AnnotationId>();
        ids.forEach((id) => {
            if (this.#entities.delete(id)) {
                removed.add(id);
            }
            this.#entities.setSaved(id, undefined);
            this.#workingSemanticSnapshot.delete(id);
            this.#persistenceIdentities.forget(id);
        });
        if (!removed.size) {
            return;
        }
        this.#history.forgetCommands(removed);
        this.#rebindIdentities();
        this.#mutationEpoch += 1;
        this.#emit();
    }

    /** Moves each annotation to its page's new number; one on a removed page becomes a tombstone. */
    remapPages(delta: IPageIdentityDelta) {
        this.#entities.forEach((entity, id) => {
            const mappedPageNumber = mapPageNumberThroughPageIdentityDelta(delta, requirePageNumber(entity.pageIndex + 1));
            const nextPageIndex = mappedPageNumber === null ? undefined : requirePageIndex(mappedPageNumber - 1);
            const remap = (saved: ISavedSemanticEntry | undefined) => saved && {
                kind: saved.kind,
                deleted: saved.deleted || nextPageIndex === undefined,
                fingerprint: remapSavedSemanticFingerprint(saved.fingerprint, nextPageIndex),
            };
            this.#entities.setSaved(id, remap(this.#entities.saved.get(id)));
            const working = remap(this.#workingSemanticSnapshot.get(id));
            if (working !== undefined) this.#workingSemanticSnapshot.set(id, working);
            this.#entities.set(id, nextPageIndex === undefined
                ? {
                    ...entity,
                    deleted: true,
                }
                : {
                    ...entity,
                    pageIndex: nextPageIndex,
                });
        });
        this.#objectsRenumbered = true;
        this.#rebindIdentities();
        this.#mutationEpoch += 1;
        this.#emit();
    }

    /** The annotations, tombstones included, and what the saved and working bytes hold of them. */
    snapshotState(): IAnnotationStoreState {
        const entities = new Map<AnnotationId, AnnotationEntity>();
        this.#entities.forEach((entity, id) => entities.set(id, entity));
        return {
            entities,
            saved: new Map(this.#entities.saved),
            working: new Map(this.#workingSemanticSnapshot),
        };
    }

    /** Makes `state` current and returns the state it replaces, so a page operation's Undo and Redo swap the two. */
    exchangeState(state: IAnnotationStoreState): IAnnotationStoreState {
        const replaced = this.snapshotState();
        this.#replaceAllEntities(state.entities, state.saved);
        this.#workingSemanticSnapshot = new Map(state.working);
        // A page operation's Undo or Redo restores bytes whose objects the state's refs may not name.
        this.#objectsRenumbered = true;
        this.#mutationEpoch += 1;
        this.#emit();
        return replaced;
    }

    beginSave(documentRevisionToken: TDocumentRevisionToken | null = null): IAnnotationSaveFrontier {
        const entities = this.list({includeDeleted: true});
        const frontier: IAnnotationSaveFrontier = {
            documentRevisionToken,
            epoch: this.#mutationEpoch,
            entityBaselineHash: saveFrontierEntityBaseline(entities),
            revisions: new Map(entities.map(entity => [
                entity.identity.id,
                entity.revision,
            ])),
        };
        this.#saveFrontiers.set(frontier, new Map(entities.map(entity => [entity.identity.id, semanticEntryOf(entity)])));
        return frontier;
    }

    /**
     * Marks exactly the captured revision as persisted. The binding list is
     * staged with the same atomic identity index update as entity replacement.
     */
    markPersisted(
        frontier: IAnnotationSaveFrontier,
        bindings: readonly IPdfNativeAnnotationIdentityBinding[] = [],
        currentDocumentRevisionToken: TDocumentRevisionToken | null = frontier.documentRevisionToken,
        preserveSavedBaseline = false,
    ) {
        const saved = this.#saveFrontiers.get(frontier);
        if (!saved || frontier.documentRevisionToken !== currentDocumentRevisionToken) {
            throw new Error('staleRevisionError: document revision changed or annotation save frontier lost its authority');
        }
        const bindingAliasToId = new Map<string, AnnotationId | null>();
        frontier.revisions.forEach((_revision, id) => {
            const entity = this.#entities.get(id);
            if (!entity) {
                return;
            }
            nativeBindingAliasesForEntity(entity).forEach((alias) => {
                const existing = bindingAliasToId.get(alias);
                bindingAliasToId.set(alias, existing !== undefined && existing !== id ? null : id);
            });
        });
        const bindingById = new Map<AnnotationId, string>();
        const refs = new Set<string>();
        bindings.forEach((binding) => {
            const externalId = binding.annotationId.trim();
            const id = bindingAliasToId.get(externalId);
            if (!id || !frontier.revisions.has(id)) {
                throw new Error(`Unexpected persisted annotation identity ${binding.annotationId}`);
            }
            const pdfRef = binding.pdfRef.trim();
            if (!pdfRef || bindingById.has(id) || refs.has(pdfRef)) {
                throw new Error(`Conflicting persisted annotation identity for ${externalId}`);
            }
            bindingById.set(id, pdfRef);
            refs.add(pdfRef);
        });

        const updates: IHistoryEntry[] = [];
        frontier.revisions.forEach((revision, id) => {
            const entity = this.#entities.get(id);
            if (!entity) {
                return;
            }
            const nextIdentity = saved.get(id)?.deleted
                ? identityWithPdfRef(entity.identity, undefined)
                : identityWithPdfRef(
                    entity.identity,
                    bindingById.get(id) ?? entity.identity.pdfRef,
                );
            updates.push({
                id,
                before: entity,
                // An annotation the save left as it was keeps its object.
                after: nextIdentity === entity.identity && entity.persistedRevision === revision ? entity : {
                    ...entity,
                    identity: nextIdentity,
                    persistedRevision: revision,
                },
            });
        });
        this.#replaceEntities(updates);
        saved.forEach((entry, id) => this.#workingSemanticSnapshot.set(id, entry));
        if (!preserveSavedBaseline) saved.forEach((entry, id) => this.#entities.setSaved(id, entry));
        frontier.revisions.forEach((_revision, id) => this.#persistenceIdentities.forget(id));
        this.#saveFrontiers.delete(frontier);
        this.#pruneUnretainedSavedDeletions();
        if (updates.length) {
            this.#mutationEpoch += 1;
            this.#emit();
        }
    }

    /** Reverts only state prepared against a frontier. No preparation is owned here yet. */
    rollbackToSaveFrontier(frontier: IAnnotationSaveFrontier) {
        return this.#saveFrontiers.has(frontier);
    }

    /** Whether the live annotations, of one kind or all, differ from what the saved file holds; tombstones hold nothing. */
    hasChangesSinceSavedBaseline(kind?: AnnotationEntity['kind']) {
        return this.#entities.differsFromSaved(kind);
    }

    /**
     * The pending Save plan, which crash recovery stores as well: each annotation whose edit Save has not persisted
     * or that differs from what the working bytes hold, which a write can advance past the saved file. Any other
     * annotation holds the bytes' state unread: its revision is persisted, so it equals its saved entry, and the
     * working bytes hold what the saved file does.
     */
    pendingChanges(): readonly IPendingAnnotationChange[] {
        const changes: IPendingAnnotationChange[] = [];
        this.#entities.forEach((entity, id) => {
            const working = this.#workingSemanticSnapshot.get(id);
            if (!isDirty(entity) && working !== undefined && sameSemanticEntry(working, this.#entities.saved.get(id))) return;
            const {changedFields, heldFields} = semanticChangesSince(entity, working);
            if (isDirty(entity) || changedFields.length > 0) changes.push({entity, changedFields, heldFields});
        });
        return changes;
    }

    countDirtyPersistedDeletions() {
        return this.dirtyEntities()
            .filter(entity => entity.deleted && entity.persistedRevision >= 0)
            .length;
    }

    assertSaveFrontierCurrent(
        frontier: IAnnotationSaveFrontier,
        currentDocumentRevisionToken: TDocumentRevisionToken | null = frontier.documentRevisionToken,
    ) {
        if (!this.#saveFrontiers.has(frontier)) {
            throw new Error('staleRevisionError: annotation save frontier belongs to another store');
        }
        if (frontier.documentRevisionToken !== currentDocumentRevisionToken) {
            throw new Error('staleRevisionError: document revision changed after the annotation save frontier was captured');
        }
        const current = new Map(this.list({includeDeleted: true}).map(entity => [
            entity.identity.id,
            entity,
        ]));
        const capturedEntities = Array.from(frontier.revisions, ([id]) => current.get(id))
            .filter((entity): entity is AnnotationEntity => entity !== undefined);
        const capturedEntityChanged = capturedEntities.length !== frontier.revisions.size
            || saveFrontierEntityBaseline(capturedEntities) !== frontier.entityBaselineHash
            || Array.from(frontier.revisions).some(([
                id,
                revision,
            ]) => current.get(id)?.revision !== revision);
        const unsavedEntityCreatedAfterFrontier = Array.from(current.values()).some(entity => (
            !frontier.revisions.has(entity.identity.id)
            && entity.persistedRevision < 0
        ));
        if (capturedEntityChanged || unsavedEntityCreatedAfterFrontier) {
            throw new Error('staleRevisionError: annotations changed after the save frontier was captured');
        }
    }

    /** Returns the frozen entities whose captured revision is not persisted. */
    dirtyEntities(): readonly AnnotationEntity[] {
        return Array.from(this.#entities.values()).filter(isDirty);
    }

    undo() { return this.#history.undo(); }
    redo() { return this.#history.redo(); }
    get canUndo() { return this.#history.canUndo; }
    get canRedo() { return this.#history.canRedo; }
    /** A parse of the whole document has fed this store, not only of some pages. */
    get readWholeDocument() { return this.#readWholeDocument; }

    /**
     * The byte revision whose read last committed here, which the geometry reflects. It stays through a page
     * operation that publishes new bytes until their read commits; null before a read or when one was unnamed.
     */
    get readRevision() { return this.#readRevision; }

    #assertNewEntity(entity: AnnotationEntity) {
        if (entity.revision !== 0 || entity.persistedRevision !== -1) {
            throw new Error('New annotations must start at revision 0 with persistedRevision -1');
        }
    }

    #create<T extends AnnotationEntity>(entity: T, expectedKind: T['kind']): T {
        if (this.#entities.has(entity.identity.id)) {
            throw new Error(`Duplicate AnnotationId ${entity.identity.id}`);
        }
        if (entity.kind !== expectedKind) {
            throw new Error(`Expected a ${expectedKind} annotation, received ${entity.kind}`);
        }
        this.#assertNewEntity(entity);
        // History keeps it as the command's target; frozen, a caller cannot rewrite that.
        const created = freezeStoredEntity(cloneCanonicalEntity(entity));
        this.#commit([{
            id: entity.identity.id,
            before: null,
            after: created,
        }]);
        return created;
    }

    #update<T extends AnnotationEntity>(
        id: AnnotationId,
        expectedKind: T['kind'] | undefined,
        update: (entity: T) => T,
    ): T {
        const before = this.#require(id);
        if (before.deleted || isReadOnlyAnnotation(before)) {
            throw new Error(`Annotation ${id} is ${before.deleted ? 'deleted' : 'read-only'}`);
        }
        if (expectedKind !== undefined && before.kind !== expectedKind) {
            throw new Error(`Expected a ${expectedKind} annotation, received ${before.kind}`);
        }
        const candidate = update(before as T);
        if (candidate.identity.id !== id || candidate.pageIndex !== before.pageIndex) {
            throw new Error('Annotation identity and pageIndex are immutable');
        }
        const after = freezeStoredEntity({
            ...cloneCanonicalEntity(candidate),
            revision: before.revision + 1,
            modifiedAt: Date.now(),
        } as T);
        this.#commit([{
            id,
            before,
            after,
        }]);
        return after;
    }

    retainHistoryTargets(ids: readonly AnnotationId[] = [...new Set([
        ...this.#entities.keys(),
        ...this.#retainedHistoryTargets.keys(),
    ])]) {
        ids.forEach(id => this.#retainedHistoryTargets.set(id, (this.#retainedHistoryTargets.get(id) ?? 0) + 1));
        return () => {
            ids.forEach(id => {
                const remaining = (this.#retainedHistoryTargets.get(id) ?? 1) - 1;
                if (remaining > 0) this.#retainedHistoryTargets.set(id, remaining);
                else this.#retainedHistoryTargets.delete(id);
            });
            if (this.#pruneUnretainedSavedDeletions()) {
                this.#mutationEpoch += 1;
                this.#emit();
            }
        };
    }

    #commit(entries: readonly IHistoryEntry[]) {
        const apply = (
            side: 'before' | 'after',
            mode: 'commit' | 'replay',
            registerFailureRollback?: TRegisterAnnotationHistoryFailureRollback,
        ) => {
            const ordered = side === 'before' ? [...entries].reverse() : entries;
            this.#applyHistoryEntries(ordered.map(entry => ({
                id: entry.id,
                before: this.#entities.get(entry.id) ?? null,
                after: mode === 'replay' ? replayOnto(this.#entities.get(entry.id), entry, side) : entry[side],
            })), mode, registerFailureRollback);
        };
        apply('after', 'commit');
        const releaseTargets = this.retainHistoryTargets(entries.map(entry => entry.id));
        this.#history.registerCommand({
            cmd: register => apply('after', 'replay', register),
            undo: register => apply('before', 'replay', register),
            estimatedBytes: estimateRetainedAnnotationBytes(entries),
            annotationIds: entries.map(entry => entry.id),
            onDiscard: releaseTargets,
        });
    }

    #pruneUnretainedSavedDeletions() {
        let pruned = false;
        this.#entities.tombstoneIds().forEach((id) => {
            if (isDirty(this.#entities.get(id)!) || this.#retainedHistoryTargets.has(id)) {
                return;
            }
            this.#entities.delete(id);
            this.#entities.setSaved(id, undefined);
            this.#workingSemanticSnapshot.delete(id);
            this.#persistenceIdentities.forget(id);
            pruned = true;
        });
        return pruned;
    }

    #applyHistoryEntries(
        entries: readonly IHistoryEntry[],
        mode: 'commit' | 'replay',
        registerFailureRollback?: TRegisterAnnotationHistoryFailureRollback,
    ) {
        const previousEpoch = this.#mutationEpoch;
        const rebased = mode === 'commit'
            ? entries
            : this.#persistenceIdentities.rebaseReplay(entries, id => this.#entities.get(id));
        const applied = rebased.map(entry => {
            if (!entry.after) {
                return entry;
            }
            const revision = mode === 'commit'
                ? entry.after.revision
                : Math.max(entry.before?.revision ?? -1, entry.after.revision, entry.after.persistedRevision) + 1;
            const matchesSaved = (entry.after.persistedRevision >= 0 || (entry.after.deleted && !('pdfRef' in entry.after.identity)))
                && this.#entities.saved.get(entry.id)?.fingerprint === fingerprintOf(entry.after);
            return {
                ...entry,
                after: {
                    ...entry.after,
                    revision,
                    // Replaying intent can require writing even when it equals
                    // the saved document: the loaded checkpoint is independent.
                    persistedRevision: matchesSaved ? revision : entry.after.persistedRevision,
                    ...(!this.#entities.has(entry.id) && this.#readWholeDocument ? {
                        identity: identityWithPdfRef(entry.after.identity, undefined),
                        persistedRevision: -1,
                    } : {}),
                },
            };
        });
        this.#replaceEntities(applied);
        this.#mutationEpoch += 1;
        registerFailureRollback?.(() => {
            this.#replaceEntities([...applied].reverse().map(entry => ({
                id: entry.id,
                before: entry.after,
                after: entry.before,
            })));
            this.#mutationEpoch = previousEpoch;
            this.#emit();
        });
        this.#emit();
    }

    #replaceEntities(entries: readonly IHistoryEntry[]) {
        this.#identities.replace(entries.map(entry => ({
            before: liveIdentityOf(entry.before),
            after: liveIdentityOf(entry.after),
        })));
        // Each `after` is the store's own object: stored, it is frozen in place.
        entries.forEach((entry) => {
            if (entry.after) {
                this.#entities.set(entry.id, entry.after);
            } else {
                this.#entities.delete(entry.id);
            }
        });
    }

    #replaceAllEntities(next: ReadonlyMap<AnnotationId, AnnotationEntity>, saved: ReadonlyMap<AnnotationId, ISavedSemanticEntry>) {
        // A state this store captured holds its frozen entities; any other entity is copied before it is frozen.
        const owned = new Map(Array.from(next, ([id, entity]) => [id, isStoredEntity(entity) ? entity : cloneEntity(entity)] as const));
        const changes = [
            ...Array.from(this.#entities.values(), entity => ({
                before: liveIdentityOf(entity),
                after: null,
            })),
            ...Array.from(owned.values(), entity => ({
                before: null,
                after: liveIdentityOf(entity),
            })),
        ];
        this.#identities.replace(changes);
        this.#entities.replaceAll(owned, saved);
    }

    #require(id: AnnotationId) {
        const entity = this.#entities.get(id);
        if (!entity) {
            throw new Error(`Unknown annotation ${id}`);
        }
        return entity;
    }

    #rebindIdentities() {
        this.#identities.clear();
        this.#entities.forEach((entity) => {
            if (!entity.deleted) {
                this.#identities.bind(entity.identity);
            }
        });
    }

    #disableBulkImportFastPath() {
        if (this.#bulkImportState) {
            this.#bulkImportState.canUseFastPath = false;
        }
    }

    #emit(preserveBulkImportFastPath = false) {
        if (!preserveBulkImportFastPath) {
            this.#disableBulkImportFastPath();
        }
        if (this.#batchDepth > 0) {
            this.#batchEmissionPending = true;
            return;
        }
        this.#emitNow();
    }

    #emitNow() {
        const snapshotIncludingDeleted = this.#entities.publish();
        this.#listeners.forEach(listener => listener(snapshotIncludingDeleted));
    }
}
