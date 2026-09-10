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
    buildTextMarkupSelectionPlan,
    normalizeAnnotationText,
    remapSavedSemanticFingerprint,
    saveFrontierEntityBaseline,
    semanticEntityFingerprint,
    semanticSnapshot,
    semanticSnapshotsEqual,
    snapshotOfKind,
    toLegacyShapeStableKey,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
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

interface IHistoryEntry {
    readonly id: AnnotationId;
    readonly before: AnnotationEntity | null;
    readonly after: AnnotationEntity | null;
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

export class AnnotationStore {
    readonly #entities = new Map<AnnotationId, AnnotationEntity>();
    readonly #identities = new ExternalIdentityIndex();
    readonly #listeners = new Set<TListener>();
    readonly #history: IAnnotationHistoryAuthority;
    readonly #saveFrontiers = new WeakMap<IAnnotationSaveFrontier, true>();
    readonly #persistenceIdentities = new AnnotationPersistenceIdentityLedger();
    readonly #retainedHistoryTargets = new Map<AnnotationId, number>();
    readonly #selectedIds = new Set<AnnotationId>();
    #foreign: readonly IPdfForeignAnnotationRecord[] = [];
    #savedSemanticSnapshot = new Map<AnnotationId, ISavedSemanticEntry>();
    #mutationEpoch = 0;
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

    list(options: {includeDeleted?: boolean} = {}) {
        return Array.from(this.#entities.values())
            .filter(entity => options.includeDeleted === true || !entity.deleted)
            .map(cloneEntity);
    }

    get(id: AnnotationId) {
        const entity = this.#entities.get(id);
        return entity ? cloneEntity(entity) : null;
    }

    /** Includes creations removed by undo while their redo commands remain. */
    deletedAnnotationIds(): readonly AnnotationId[] {
        return [
            ...Array.from(this.#entities.values()).filter(entity => entity.deleted).map(entity => entity.identity.id),
            ...Array.from(this.#retainedHistoryTargets.keys()).filter(id => !this.#entities.has(id)),
        ];
    }

    resolveExternal(bindings: Omit<IAnnotationIdentity, 'id'>): AnnotationId | null {
        return this.#identities.resolve(bindings);
    }

    subscribe(listener: TListener) {
        this.#listeners.add(listener);
        listener(this.list());
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
     * Runs related persisted imports with one saved-baseline comparison. Each
     * import still updates the identity index in callback order.
     */
    importMany<T>(callback: () => T): T {
        if (this.#bulkImportState) {
            return callback();
        }
        this.#bulkImportState = {canUseFastPath: !this.hasChangesSinceSavedBaseline()};
        try {
            return callback();
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
            return cloneEntity(current);
        }
        const imported = cloneCanonicalEntity(entity);
        const currentSemanticFingerprint = canUseFastPath && !shouldUpdateSavedBaseline && current
            ? semanticEntityFingerprint(current)
            : null;
        this.#replaceEntities([{
            id: imported.identity.id,
            before: current ?? null,
            after: imported,
        }]);
        if (shouldUpdateSavedBaseline && wasSemanticallyClean) {
            if (canUseFastPath) {
                this.#savedSemanticSnapshot.set(imported.identity.id, {
                    kind: imported.kind,
                    deleted: imported.deleted,
                    fingerprint: semanticEntityFingerprint(imported),
                });
            } else {
                this.#savedSemanticSnapshot = semanticSnapshot(this.#entities.values());
            }
        } else if (
            canUseFastPath
            && currentSemanticFingerprint !== semanticEntityFingerprint(imported)
        ) {
            this.#disableBulkImportFastPath();
        }
        this.#mutationEpoch += 1;
        this.#emit(true);
        return cloneEntity(imported);
    }

    get foreign(): readonly IPdfForeignAnnotationRecord[] {
        return this.#foreign.map(record => structuredClone(record));
    }

    restoreForeignAnnotations(foreign: readonly IPdfForeignAnnotationRecord[]) {
        this.#foreign = foreign.map(record => structuredClone(record));
    }

    getForeignAnnotations() {
        return this.foreign;
    }

    get selectedIds(): ReadonlySet<AnnotationId> {
        return new Set(this.#selectedIds);
    }

    select(ids: readonly AnnotationId[]) {
        const liveIds = new Set(Array.from(this.#entities.values())
            .filter(entity => !entity.deleted)
            .map(entity => entity.identity.id));
        const next = new Set(ids.filter(id => liveIds.has(id)));
        if (next.size === this.#selectedIds.size
            && Array.from(next).every(id => this.#selectedIds.has(id))) {
            return;
        }
        this.#selectedIds.clear();
        next.forEach(id => this.#selectedIds.add(id));
        this.#emit();
    }

    clearSelection() {
        if (!this.#selectedIds.size) {
            return;
        }
        this.#selectedIds.clear();
        this.#emit();
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
     * the saved baseline. A dirty local entity keeps all authored properties,
     * but receives the parsed PDF object reference and baseline fingerprint.
     */
    replaceFromDocument(
        entities: readonly AnnotationEntity[],
        foreign: readonly IPdfForeignAnnotationRecord[],
    ) {
        const currentEntities = Array.from(this.#entities.values());
        const usedCurrentIds = new Set<AnnotationId>();
        const fingerprintMatchedIds = new Set<AnnotationId>();
        const parsedById = new Map<AnnotationId, AnnotationEntity>();
        entities.forEach((entity) => {
            let id = entity.identity.id;
            if (!this.#entities.has(id)) {
                const pdfRefMatches = entity.identity.pdfRef === undefined
                    ? []
                    : currentEntities.filter(current => (
                        current.identity.pdfRef === entity.identity.pdfRef
                        && !current.deleted
                        && !usedCurrentIds.has(current.identity.id)
                    ));
                const matches = pdfRefMatches.length === 1
                    ? pdfRefMatches
                    : currentEntities.filter(current => (
                        !current.deleted
                    && (current.persistedRevision >= 0 || current.kind === 'shape')
                    && !usedCurrentIds.has(current.identity.id)
                    && current.kind === entity.kind
                    && current.pageIndex === entity.pageIndex
                    && saveReconciliationFingerprint(current) === saveReconciliationFingerprint(entity)
                    ));
                if (matches.length === 1) {
                    id = matches[0]!.identity.id;
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
            if (parsedById.has(id)) {
                throw new Error(`Duplicate parsed AnnotationId ${id}`);
            }
            usedCurrentIds.add(id);
            parsedById.set(id, cloneCanonicalEntity(entity));
        });

        const next = new Map<AnnotationId, AnnotationEntity>();
        const nextBaseline = new Map<AnnotationId, ISavedSemanticEntry>();
        const forgotten = new Set<AnnotationId>();
        this.#entities.forEach((current, id) => {
            const parsed = parsedById.get(id);
            if (!parsed) {
                // A committed deletion is absent from the parse by design.
                // Keep its command target so undo can recreate it without a
                // retired PDF ref, including after repeated saves.
                if (current.deleted && current.persistedRevision >= 0 && !isDirty(current)
                    && this.#retainedHistoryTargets.has(id)) {
                    next.set(id, cloneEntity(current));
                    nextBaseline.set(id, {
                        kind: current.kind,
                        deleted: current.deleted,
                        fingerprint: semanticEntityFingerprint(current),
                    });
                    return;
                }
                const materializedLocalShapeTombstone = current.kind === 'shape'
                    && current.deleted
                    && current.identity.pdfRef === undefined
                    && current.materialized === true;
                if (isDirty(current) && !materializedLocalShapeTombstone) {
                    next.set(id, cloneEntity(current));
                    const saved = this.#savedSemanticSnapshot.get(id);
                    if (saved !== undefined) {
                        nextBaseline.set(id, saved);
                    }
                } else {
                    forgotten.add(id);
                }
                return;
            }

            nextBaseline.set(id, {
                kind: parsed.kind,
                deleted: parsed.deleted,
                fingerprint: semanticEntityFingerprint(parsed),
            });
            if (isDirty(current)) {
                next.set(id, {
                    ...cloneEntity(current),
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
                });
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
            next.set(id, {
                ...cloneCanonicalEntity(parsedCanonical),
                identity: {
                    ...parsedCanonical.identity,
                    id,
                },
                revision: current.revision,
                persistedRevision: current.revision,
            });
        });

        parsedById.forEach((parsed, id) => {
            if (this.#entities.has(id)) {
                return;
            }
            const inserted = {
                ...cloneCanonicalEntity(parsed),
                revision: 0,
                persistedRevision: 0,
                deleted: false,
            };
            next.set(id, inserted);
            nextBaseline.set(id, {
                kind: inserted.kind,
                deleted: inserted.deleted,
                fingerprint: semanticEntityFingerprint(inserted),
            });
        });

        this.#history.forgetCommands(forgotten);
        this.#replaceAllEntities(next);
        forgotten.forEach(id => this.#persistenceIdentities.forget(id));
        this.#savedSemanticSnapshot = nextBaseline;
        this.#foreign = foreign.map(record => structuredClone(record));
        this.#mutationEpoch += 1;
        this.#emit();
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
            entities: Array.from(this.#entities.values()),
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
            before: cloneEntity(replacement.before),
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
            this.#savedSemanticSnapshot.delete(id);
            this.#persistenceIdentities.forget(id);
        });
        if (!removed.size) {
            return;
        }
        removed.forEach(id => this.#selectedIds.delete(id));
        this.#history.forgetCommands(removed);
        this.#rebindIdentities();
        this.#mutationEpoch += 1;
        this.#emit();
    }

    remapPages(delta: IPageIdentityDelta) {
        this.#entities.forEach((entity, id) => {
            const mappedPageNumber = mapPageNumberThroughPageIdentityDelta(delta, requirePageNumber(entity.pageIndex + 1));
            const nextPageIndex = mappedPageNumber === null ? undefined : requirePageIndex(mappedPageNumber - 1);
            const saved = this.#savedSemanticSnapshot.get(id);
            if (saved !== undefined) {
                this.#savedSemanticSnapshot.set(id, {
                    kind: saved.kind,
                    deleted: saved.deleted || nextPageIndex === undefined,
                    fingerprint: remapSavedSemanticFingerprint(saved.fingerprint, nextPageIndex),
                });
            }
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
        this.#rebindIdentities();
        this.#pruneSelection();
        this.#mutationEpoch += 1;
        this.#emit();
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
        this.#saveFrontiers.set(frontier, true);
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
    ) {
        this.assertSaveFrontierCurrent(frontier, currentDocumentRevisionToken);
        const bindingAliasToId = new Map<string, AnnotationId | null>();
        frontier.revisions.forEach((_revision, id) => {
            const entity = this.#entities.get(id);
            if (!entity) {
                return;
            }
            nativeBindingAliasesForEntity(entity).forEach((alias) => {
                const existing = bindingAliasToId.get(alias);
                if (existing !== undefined && existing !== id) {
                    bindingAliasToId.set(alias, null);
                    return;
                }
                bindingAliasToId.set(alias, id);
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
            if (!entity || entity.revision !== revision) {
                return;
            }
            const nextIdentity = entity.deleted
                ? identityWithPdfRef(entity.identity, undefined)
                : identityWithPdfRef(
                    entity.identity,
                    bindingById.get(id) ?? entity.identity.pdfRef,
                );
            updates.push({
                id,
                before: entity,
                after: {
                    ...entity,
                    identity: nextIdentity,
                    persistedRevision: revision,
                },
            });
        });
        this.#replaceEntities(updates);
        this.#savedSemanticSnapshot = semanticSnapshot(this.#entities.values());
        this.#persistenceIdentities.clear();
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

    adoptEntitiesAsSavedBaseline(ids: ReadonlySet<AnnotationId>) {
        ids.forEach((id) => {
            const entity = this.#entities.get(id);
            if (entity) {
                this.#savedSemanticSnapshot.set(id, {
                    kind: entity.kind,
                    deleted: entity.deleted,
                    fingerprint: semanticEntityFingerprint(entity),
                });
            }
        });
        this.#emit();
    }

    hasChangesSinceSavedBaseline(kind?: AnnotationEntity['kind']) {
        return !semanticSnapshotsEqual(
            snapshotOfKind(semanticSnapshot(this.#entities.values()), kind),
            snapshotOfKind(this.#savedSemanticSnapshot, kind),
        );
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

    /** Returns cloned canonical entities whose captured revision is not persisted. */
    dirtyEntities(): readonly AnnotationEntity[] {
        return Array.from(this.#entities.values())
            .filter(isDirty)
            .map(cloneEntity);
    }

    undo() { return this.#history.undo(); }
    redo() { return this.#history.redo(); }
    get canUndo() { return this.#history.canUndo; }
    get canRedo() { return this.#history.canRedo; }

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
        const created = cloneCanonicalEntity(entity);
        this.#commit([{
            id: entity.identity.id,
            before: null,
            after: created,
        }]);
        return cloneEntity(created);
    }

    #update<T extends AnnotationEntity>(
        id: AnnotationId,
        expectedKind: T['kind'] | undefined,
        update: (entity: T) => T,
    ): T {
        const before = this.#require(id);
        if (before.deleted) {
            throw new Error(`Annotation ${id} is deleted`);
        }
        if (expectedKind !== undefined && before.kind !== expectedKind) {
            throw new Error(`Expected a ${expectedKind} annotation, received ${before.kind}`);
        }
        const candidate = update(cloneEntity(before) as T);
        if (candidate.identity.id !== id || candidate.pageIndex !== before.pageIndex) {
            throw new Error('Annotation identity and pageIndex are immutable');
        }
        const after = {
            ...cloneCanonicalEntity(candidate),
            revision: before.revision + 1,
            modifiedAt: Date.now(),
        } as T;
        this.#commit([{
            id,
            before: cloneEntity(before),
            after,
        }]);
        return cloneEntity(after);
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
                after: entry[side],
            })), mode, registerFailureRollback);
        };
        apply('after', 'commit');
        entries.forEach(({id}) => this.#retainedHistoryTargets.set(id, (this.#retainedHistoryTargets.get(id) ?? 0) + 1));
        this.#history.registerCommand({
            cmd: register => apply('after', 'replay', register),
            undo: register => apply('before', 'replay', register),
            estimatedBytes: estimateRetainedAnnotationBytes(entries),
            annotationIds: entries.map(entry => entry.id),
            onDiscard: () => {
                entries.forEach(({id}) => {
                    const remaining = (this.#retainedHistoryTargets.get(id) ?? 1) - 1;
                    if (remaining > 0) this.#retainedHistoryTargets.set(id, remaining);
                    else this.#retainedHistoryTargets.delete(id);
                });
                if (this.#pruneUnretainedSavedDeletions()) {
                    this.#mutationEpoch += 1;
                    this.#emit();
                }
            },
        });
    }

    #pruneUnretainedSavedDeletions() {
        let pruned = false;
        this.#entities.forEach((entity, id) => {
            if (!entity.deleted || isDirty(entity) || this.#retainedHistoryTargets.has(id)) {
                return;
            }
            this.#entities.delete(id);
            this.#savedSemanticSnapshot.delete(id);
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
            const matchesSaved = this.#savedSemanticSnapshot.get(entry.id)?.fingerprint
                === semanticEntityFingerprint(entry.after);
            return {
                ...entry,
                after: {
                    ...entry.after,
                    revision,
                    persistedRevision: matchesSaved ? revision : entry.after.persistedRevision,
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
        entries.forEach((entry) => {
            if (entry.after) {
                this.#entities.set(entry.id, cloneEntity(entry.after));
            } else {
                this.#entities.delete(entry.id);
            }
        });
        this.#pruneSelection();
    }

    #replaceAllEntities(next: ReadonlyMap<AnnotationId, AnnotationEntity>) {
        const changes = [
            ...Array.from(this.#entities.values(), entity => ({
                before: liveIdentityOf(entity),
                after: null,
            })),
            ...Array.from(next.values(), entity => ({
                before: null,
                after: liveIdentityOf(entity),
            })),
        ];
        this.#identities.replace(changes);
        this.#entities.clear();
        next.forEach((entity, id) => this.#entities.set(id, cloneEntity(entity)));
        this.#pruneSelection();
    }

    #require(id: AnnotationId) {
        const entity = this.#entities.get(id);
        if (!entity) {
            throw new Error(`Unknown annotation ${id}`);
        }
        return entity;
    }

    #pruneSelection() {
        const live = new Set(Array.from(this.#entities.values())
            .filter(entity => !entity.deleted)
            .map(entity => entity.identity.id));
        Array.from(this.#selectedIds)
            .filter(id => !live.has(id))
            .forEach(id => this.#selectedIds.delete(id));
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
        const snapshot = this.list();
        this.#listeners.forEach(listener => listener(snapshot));
    }
}
