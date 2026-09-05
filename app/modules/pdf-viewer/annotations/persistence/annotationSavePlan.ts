import type {
    AnnotationEntity,
    AnnotationId,
    ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type { IAnnotationSaveFrontier } from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import type {TAnnotationMutationOperation} from '@app/modules/pdf-viewer/engine/annotations/persistence/backendAnnotationMutation';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdfContracts';
import {
    matchCanonicalTextMarkupGeometry,
    TEXT_MARKUP_COORDINATE_TOLERANCE,
    toCanonicalTextMarkupGeometry,
} from '@app/modules/pdf-viewer/engine/annotation-geometry/canonicalTextMarkupGeometry';
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
    readonly pageIndexes: readonly number[];
    readonly fields: Readonly<Record<string, unknown>>;
}

export interface ISerializationMetadataPlan {
    readonly pageLabels: readonly IPdfPageLabelRange[] | null;
    readonly bookmarks: readonly IPdfBookmarkEntry[] | null;
}

export interface ISerializationOcrOperation {
    readonly pageIndex: number;
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
    const steps: IAnnotationMutationStep[] = [];
    const knownPdfRefs = entities
        .map(entity => entity.identity.pdfRef)
        .filter((value): value is string => Boolean(value));
    dirty.forEach((entity) => {
        const prefix = entity.identity.id;
        if (entity.deleted) {
            steps.push({
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
            steps.push({
                id: prepareId,
                annotationId: entity.identity.id,
                operation: 'prepare-free-text-appearance',
                dependsOn: [],
                fields: {position: entity.kind === 'note' ? entity.position : entity.rect},
            });
            steps.push({
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
            steps.push({
                id: `${prefix}:write`,
                annotationId: entity.identity.id,
                operation: entity.kind === 'shape' ? 'write-shape' : 'write-text-markup',
                dependsOn: [],
                fields: allowedFields(entity),
            });
        }
        steps.push({
            id: `${prefix}:bind`,
            annotationId: entity.identity.id,
            operation: 'bind-identities',
            dependsOn: steps.filter(step => step.annotationId === entity.identity.id).map(step => step.id),
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
    const expected = dirty.map(entity => Object.freeze(structuredClone(entity)));
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
    const ids = new Set(steps.map(step => step.id));
    steps.forEach((step) => {
        step.dependsOn.forEach((dependency) => {
            if (!ids.has(dependency)) throw new Error(`Missing annotation-plan dependency ${dependency}`);
        });
        if (step.operation === 'write-free-text-contents') {
            const hasPrepare = step.dependsOn.some(id => steps.find(candidate => candidate.id === id)?.operation === 'prepare-free-text-appearance');
            if (!hasPrepare) throw new Error('FreeText contents require a prepared blank appearance and point rect');
        }
    });
}

export interface IAnnotationReopenReader {reopen(bytes: Uint8Array): Promise<readonly AnnotationEntity[]>;}

/** Privacy-safe stand-in for annotation text: presence, length, and a digest. */
interface IAnnotationTextFingerprint {
    readonly present: boolean;
    readonly length: number;
    readonly hash: string;
}

/**
 * What a semantic reopen saw, field by field. Everything here is safe to log:
 * annotation text is reduced to {@link IAnnotationTextFingerprint}, and
 * geometry to counts and a bounded coordinate delta.
 */
interface IAnnotationVerificationDiagnostic {
    readonly annotationId: string;
    readonly kind: AnnotationEntity['kind'];
    /** What the reopened file turned out to hold, which is the other half of a kind mismatch. */
    readonly reopenedKind: AnnotationEntity['kind'];
    readonly pageIndex: number;
    readonly expectedSubtype: string | null;
    readonly reopenedSubtype: string | null;
    readonly expectedText: IAnnotationTextFingerprint;
    readonly reopenedText: IAnnotationTextFingerprint;
    readonly expectedGeometryCount: number;
    readonly reopenedGeometryCount: number;
    readonly maxCoordinateDelta: number | null;
    readonly worstRectIndex: number | null;
    readonly coordinateTolerance: number;
    readonly failedFields: readonly string[];
}

/**
 * How many per-annotation diagnostics one rejected save carries, and how many
 * failure clauses its message names.
 *
 * A plan can hold every dirty annotation in a document, and a systematic
 * regression fails all of them at once, so an unbounded record would put
 * thousands of structured entries into a log line written on the failure path.
 * Twelve is enough to see whether one annotation moved or the whole page did —
 * the point of the record — while the total count, which stays exact, carries
 * the scale. This mirrors the bounded annotation inventory snapshots: keep a
 * useful sample, report the true size, retain neither without a ceiling.
 */
const MAX_ANNOTATION_VERIFICATION_DIAGNOSTICS = 12;

/**
 * Largest per-coordinate difference a faithful sticky-note anchor round trip
 * may show, in page-normalized units.
 *
 * It starts at the same number as
 * {@link TEXT_MARKUP_COORDINATE_TOLERANCE} because both cover the same
 * representation loss — a writer that emits two decimals of a PDF unit — but
 * an anchor is one `/Rect` written by whichever backend served the save, while
 * the markup tolerance also absorbs PDF.js's `Float32Array` quad storage. They
 * are separate constants so tightening or loosening one path cannot silently
 * move the other.
 */
const STICKY_NOTE_ANCHOR_COORDINATE_TOLERANCE = 0.0001;

function describeVerificationFailures(failures: readonly string[]) {
    const named = failures.slice(0, MAX_ANNOTATION_VERIFICATION_DIAGNOSTICS);
    const remaining = failures.length - named.length;
    return remaining > 0
        ? `${named.join('; ')}; and ${remaining} more`
        : named.join('; ');
}

class AnnotationReopenVerificationError extends Error {
    constructor(
        message: string,
        /** A bounded sample of the failures, not necessarily all of them. */
        readonly diagnostics: readonly IAnnotationVerificationDiagnostic[],
        /** How many fields failed in total, however few are described above. */
        readonly failureCount: number,
    ) {
        super(message);
        this.name = 'AnnotationReopenVerificationError';
    }
}

/**
 * Reduces annotation text to something a log may carry. The digest is a
 * 32-bit FNV-1a value: enough to tell "the same text came back" from "different
 * text came back", useless for recovering the text itself.
 */
function fingerprintAnnotationText(text: string): IAnnotationTextFingerprint {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return {
        present: text.length > 0,
        length: text.length,
        hash: (hash >>> 0).toString(36),
    };
}

export async function verifyAnnotationSave(
    bytes: Uint8Array,
    plan: ISerializationPlan,
    reader: IAnnotationReopenReader,
) {
    const actual = await reader.reopen(bytes);
    const byId = new Map(actual.map(entity => [
        entity.identity.id,
        entity,
    ]));
    const failures: string[] = [];
    const diagnostics: IAnnotationVerificationDiagnostic[] = [];
    const differs = (left: unknown, right: unknown) => JSON.stringify(left) !== JSON.stringify(right);
    const anchorRectDiffers = (left: {
        left: number;
        top: number;
        width: number;
        height: number
    }, right: {
        left: number;
        top: number;
        width: number;
        height: number
    }) => (
        Math.abs(left.left - right.left) > STICKY_NOTE_ANCHOR_COORDINATE_TOLERANCE
        || Math.abs(left.top - right.top) > STICKY_NOTE_ANCHOR_COORDINATE_TOLERANCE
        || Math.abs(left.width - right.width) > STICKY_NOTE_ANCHOR_COORDINATE_TOLERANCE
        || Math.abs(left.height - right.height) > STICKY_NOTE_ANCHOR_COORDINATE_TOLERANCE
    );
    plan.expected.forEach((expected) => {
        const reopened = byId.get(expected.identity.id);
        if (expected.deleted) {
            if (reopened && !reopened.deleted) failures.push(`${expected.identity.id}: deletion absent`);
            return;
        }
        if (!reopened) {
            failures.push(`${expected.identity.id}: missing`);
            return;
        }
        if (reopened.kind !== expected.kind || reopened.pageIndex !== expected.pageIndex) {
            failures.push(
                `${expected.identity.id}: kind/page mismatch`
                + ` (expected ${expected.kind} on page ${expected.pageIndex + 1},`
                + ` reopened ${reopened.kind} on page ${reopened.pageIndex + 1})`,
            );
        }
        const expectedBindings = expected.identity;
        if (expectedBindings.pdfRef && reopened.identity.pdfRef !== expectedBindings.pdfRef) {
            failures.push(`${expected.identity.id}: identity binding mismatch`);
        }
        if (expected.kind === 'note' && (reopened.kind !== 'note' || reopened.contents !== expected.contents)) {
            failures.push(`${expected.identity.id}: contents mismatch`);
        }
        if (expected.kind === 'note' && reopened.kind === 'note' && anchorRectDiffers(reopened.position, expected.position)) {
            failures.push(`${expected.identity.id}: position mismatch`);
        }
        if (expected.kind === 'text-box') {
            if (reopened.kind !== 'text-box') {
                failures.push(`${expected.identity.id}: text-box kind mismatch`);
            } else {
                if (reopened.text !== expected.text) {
                    failures.push(`${expected.identity.id}: text-box contents mismatch`);
                }
                if (anchorRectDiffers(reopened.rect, expected.rect)) {
                    failures.push(`${expected.identity.id}: text-box rect mismatch`);
                }
            }
        }
        if (expected.kind === 'text-markup') {
            const diagnostic = verifyTextMarkupFidelity(expected, reopened, failures);
            if (diagnostic.failedFields.length && diagnostics.length < MAX_ANNOTATION_VERIFICATION_DIAGNOSTICS) {
                diagnostics.push(diagnostic);
            }
        }
        if (expected.kind === 'shape' && (reopened.kind !== 'shape' || differs(reopened.rect, expected.rect))) {
            failures.push(`${expected.identity.id}: shape geometry mismatch`);
        }
    });
    if (failures.length) {
        throw new AnnotationReopenVerificationError(
            `Annotation reopen verification failed: ${describeVerificationFailures(failures)}`,
            diagnostics,
            failures.length,
        );
    }
}

/**
 * Compares one text-markup annotation field by field and reports each
 * difference separately. A single combined verdict cannot say whether the
 * subtype, the note text, or one rectangle moved, and that is exactly what the
 * next failure report needs to say.
 *
 * Selected-text fidelity is defined here: a text-markup entity's `text` is the
 * annotation's own note, never the document text under the selection.
 * Selection-created markup starts with empty text, so a writer that pushed the
 * selected words into `/Contents` is reported as a text mismatch rather than
 * silently accepted. Which stored bytes hold that note — `/Contents`, a linked
 * popup, or neither once the text merely repeats the page — is the reader's
 * question, and both sides of this comparison ask it the same way.
 */
function verifyTextMarkupFidelity(
    expected: ITextMarkupEntity,
    reopened: AnnotationEntity,
    failures: string[],
): IAnnotationVerificationDiagnostic {
    const failedFields: string[] = [];
    const expectedGeometry = toCanonicalTextMarkupGeometry(expected.quadPoints);
    const isMarkup = reopened.kind === 'text-markup';
    const reopenedGeometry = isMarkup ? toCanonicalTextMarkupGeometry(reopened.quadPoints) : [];
    const match = matchCanonicalTextMarkupGeometry(expectedGeometry, reopenedGeometry);
    if (!isMarkup) {
        // The kind/page check above already failed this annotation; recording
        // the field here keeps the diagnostic without a duplicate message.
        failedFields.push('kind');
    } else {
        if (reopened.subtype !== expected.subtype) {
            failedFields.push('subtype');
            failures.push(
                `${expected.identity.id}: markup subtype mismatch (expected ${expected.subtype}, reopened ${reopened.subtype})`,
            );
        }
        if (reopened.contents !== expected.contents) {
            failedFields.push('text');
            failures.push(
                `${expected.identity.id}: markup contents mismatch (expected ${describeTextPresence(expected.contents)}, reopened ${describeTextPresence(reopened.contents)})`,
            );
        }
        if (!match.countMatches) {
            failedFields.push('geometryCount');
            failures.push(
                `${expected.identity.id}: markup geometry count mismatch (expected ${match.expectedCount}, reopened ${match.reopenedCount})`,
            );
        } else if (!match.matched) {
            failedFields.push('geometry');
            failures.push(
                `${expected.identity.id}: markup geometry mismatch (rect ${match.worstRectIndex ?? 0} moved by ${match.maxCoordinateDelta.toExponential(3)}, tolerance ${TEXT_MARKUP_COORDINATE_TOLERANCE})`,
            );
        }
    }
    return {
        annotationId: expected.identity.id,
        kind: expected.kind,
        reopenedKind: reopened.kind,
        pageIndex: expected.pageIndex,
        expectedSubtype: expected.subtype,
        reopenedSubtype: isMarkup ? reopened.subtype : null,
        expectedText: fingerprintAnnotationText(expected.contents),
        reopenedText: fingerprintAnnotationText(isMarkup ? reopened.contents : ''),
        expectedGeometryCount: match.expectedCount,
        reopenedGeometryCount: match.reopenedCount,
        maxCoordinateDelta: match.expectedCount > 0 && match.reopenedCount > 0
            ? match.maxCoordinateDelta
            : null,
        worstRectIndex: match.worstRectIndex,
        coordinateTolerance: TEXT_MARKUP_COORDINATE_TOLERANCE,
        failedFields,
    };
}

/** Text never reaches a message or a log; only whether there was any, and how much. */
function describeTextPresence(text: string) {
    return text.length === 0 ? 'empty' : `${text.length} chars`;
}
