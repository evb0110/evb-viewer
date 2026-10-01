import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {
    AnnotationEntity,
    IPlacedImageEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { computeSummaryStableKey } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';
import {
    assertAnnotationBackendSemanticConformance,
    projectAnnotationBackendMutations,
} from '@app/modules/pdf-viewer/annotations/persistence/annotationBackendConformance';
import { getPdfAnnotationIdFromStableKey } from '@app/modules/pdf-viewer/annotations/pdf-refs/parsePdfAnnotationStableKey';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/annotation-subtype-hints/pdfSerializationSubtypeHintsTypes';
import type {
    ISerializationPlan,
    TSerializationBackend,
} from '@app/modules/pdf-viewer/annotations/persistence/annotationSavePlan';
import { selectSerializationBackend } from '@app/modules/pdf-viewer/annotations/persistence/annotationSavePlan';
import {
    normalizePdfJsAnnotationId,
    parsePdfAnnotationRef,
} from '@app/utils/pdfAnnotationRefs';
import type {
    INativeAppendSaveRoute,
    TNativePdfMutationSaveMode,
} from '@app/modules/pdf-viewer/runtime/save/nativePdfMutationProjectionTypes';
import type {
    IPdfFrontierAnnotationChanges,
    IPdfSaveByteRouteDecision,
    IPdfSaveCanonicalInputs,
    IPdfViewerAnnotationSavePlan,
    INativePdfMutationProjection,
    IPdfViewerSaveTransactionDirtyState,
    IPdfViewerSaveTransactionDocumentStructure,
    IPdfViewerSaveTransactionNativeCapabilities,
    TNativeSaveRouteRejection,
} from '@app/modules/pdf-viewer/runtime/save/pdfViewerSaveTransaction.types';
import {
    projectNativeAnnotationDeletes,
    getNativeAnnotationDeleteCommentTargetKey,
    getNativeAnnotationDeleteRequestTargetKey,
} from '@app/modules/pdf-viewer/annotations/persistence/nativeAnnotationDeleteProjection';
import {
    buildNativeFreeTextNotesForSave,
    isReplayableEditorOnlyFreeTextNote,
    isReplayableCanonicalStickyNote,
} from '@app/modules/pdf-viewer/annotations/persistence/nativeFreeTextNoteProjection';
import {isReplayableCanonicalTextBox} from '@app/modules/pdf-viewer/runtime/save/nativeTextBoxMutations';
import type {
    IPdfNativePlacedImage,
    IPdfNativePlacedImageGeometryUpdate,
    IPdfNativeTextBoxMutation,
} from '@contracts/electronApiDocuments';
import { buildNativeMarkupMutationForSave } from '@app/modules/pdf-viewer/annotations/persistence/nativeMarkupProjection';
import {
    buildNativeBookmarksMutationForSave,
    buildNativePageLabelsMutationForSave,
} from '@app/modules/pdf-viewer/runtime/save/nativeMetadataMutations';
import {
    arePendingTextsCoveredByNativeChanges,
    buildNativeNoteTextUpdatesForSave,
} from '@app/modules/pdf-viewer/annotations/persistence/nativeNoteTextUpdateProjection';
import {nativeNoteGeometryProjection} from '@app/modules/pdf-viewer/annotations/persistence/nativeNoteGeometryProjection';
import {buildNativeShapesMutationForSave} from '@app/modules/pdf-viewer/runtime/save/nativeShapeMutations';
import {requirePageIndex} from '@contracts/pageNumbers';

export type {
    IPdfSaveByteRouteDecision,
    IPdfSaveCanonicalInputs,
} from '@app/modules/pdf-viewer/runtime/save/pdfViewerSaveTransaction.types';

/** Everything outside the frozen plan that save routing is allowed to depend on. */
export interface IPdfSaveRouteCapabilities {
    readonly saveFlowMode: TNativePdfMutationSaveMode;
    readonly availableBackends: readonly TSerializationBackend[];
    readonly nativeCapabilities: IPdfViewerSaveTransactionNativeCapabilities | undefined;
    readonly dirtyState: IPdfViewerSaveTransactionDirtyState | undefined;
    readonly documentStructure: IPdfViewerSaveTransactionDocumentStructure | undefined;
    readonly hasLoadedSource: boolean;
    readonly forceWriterSave: boolean;
    readonly rewriteShapeState: boolean;
    readonly totalPageCount: number;
    readonly shapes: IShapeAnnotation[] | null;
    readonly deletedEmbeddedShapeAnnotationIds: string[];
    readonly deletedEmbeddedShapeStableKeys: string[];
    readonly markupSubtypeOverrides: Map<string, TMarkupSubtype> | undefined;
    readonly markupSubtypeHints: IMarkupSubtypeHint[];
    /** `undefined` preserves the pre-canonical-text-box compatibility path. */
    readonly nativeTextBoxes?: IPdfNativeTextBoxMutation[] | null;
}

export interface IPdfSaveNativeRouteDecision extends INativeAppendSaveRoute {
    readonly annotationPlan: IPdfViewerAnnotationSavePlan;
    readonly canonical: IPdfSaveCanonicalInputs;
    readonly dirtyState: IPdfViewerSaveTransactionDirtyState;
    readonly documentStructure: IPdfViewerSaveTransactionDocumentStructure;
    /** The byte route this native decision was preferred over. */
    readonly fallback: IPdfSaveByteRouteDecision;
}

export type TPdfSaveRouteDecision = IPdfSaveNativeRouteDecision | IPdfSaveByteRouteDecision;

function entitySummary(entity: AnnotationEntity): IAnnotationCommentSummary {
    const source = entity.kind === 'shape'
        ? 'shape' as const
        : entity.persistedRevision >= 0 && entity.identity.pdfRef
            ? 'pdf' as const
            : 'editor' as const;
    const id = entity.identity.pdfRef ?? entity.identity.id;
    const annotationId = entity.identity.pdfRef ?? null;
    const common = {
        appAnnotationId: entity.identity.id,
        id,
        stableKey: computeSummaryStableKey({
            id,
            pageIndex: requirePageIndex(entity.pageIndex),
            source,
            annotationId,
        }),
        pageIndex: entity.pageIndex,
        pageNumber: entity.pageIndex + 1,
        author: entity.author,
        createdAt: entity.createdAt,
        modifiedAt: entity.modifiedAt,
        uid: null,
        annotationId,
        source,
    } as const;
    if (entity.kind === 'text-box') {
        return {
            ...common,
            text: entity.text,
            subtype: 'FreeText',
            color: entity.color,
            hasNote: Boolean(entity.text),
            markerRect: structuredClone(entity.rect),
        };
    }
    if (entity.kind === 'note') {
        return {
            ...common,
            text: entity.contents,
            subtype: 'Text',
            color: entity.color,
            open: entity.open,
            hasNote: true,
            markerRect: structuredClone(entity.position),
        };
    }
    if (entity.kind === 'text-markup') {
        return {
            ...common,
            text: entity.contents,
            subtype: entity.subtype,
            color: entity.color,
            opacity: entity.opacity,
            hasNote: Boolean(entity.contents),
            markerRect: structuredClone(entity.quadPoints[0] ?? null),
            markupGeometry: structuredClone(entity.quadPoints),
        };
    }
    if (entity.kind === 'placed-image') {
        return {
            ...common,
            text: '',
            subtype: 'Stamp',
            color: null,
            hasNote: false,
            markerRect: structuredClone(entity.rect),
        };
    }
    return {
        ...common,
        source: 'shape',
        id: entity.identity.id,
        stableKey: computeSummaryStableKey({
            id: entity.identity.id,
            pageIndex: entity.pageIndex,
            source: 'shape',
        }),
        text: '',
        color: entity.strokeColor,
        hasNote: false,
        markerRect: structuredClone(entity.rect),
    };
}

/**
 * A persisted import can appear in dirtyAt while the saved semantic baseline
 * is still being rebuilt around editor work. Revision equality means it is not
 * authored work. Tombstones remain changes because page remaps can preserve
 * their revision.
 */
function isActuallyChangedEntity(entity: AnnotationEntity) {
    return entity.deleted || entity.revision !== entity.persistedRevision;
}

function isNewCanonicalStickyNoteEntity(entity: AnnotationEntity) {
    return entity.kind === 'note'
        && entity.persistedRevision < 0
        && !entity.identity.pdfRef;
}

function summarizeFrontierChanges(plan: ISerializationPlan): IPdfFrontierAnnotationChanges {
    const ids = new Set<string>();
    const noteIds = new Set<string>();
    const changedEntities = plan.expected.filter(isActuallyChangedEntity);
    changedEntities.forEach((entity) => {
        [
            entity.identity.id,
            entity.identity.pdfRef,
        ].forEach((candidate) => {
            addReplayableAnnotationId(ids, candidate);
            if (entity.kind === 'note' || entity.kind === 'text-box') {
                addReplayableAnnotationId(noteIds, candidate);
            }
        });
    });
    return {
        ids,
        noteIds,
        hasChanges: changedEntities.length > 0,
    };
}

function addReplayableAnnotationId(ids: Set<string>, id: string | null | undefined) {
    const normalized = normalizePdfJsAnnotationId(id);
    if (!normalized) {
        return;
    }

    ids.add(normalized);

    const nestedEditorId = normalized.match(/^editor:\d+:(.+)$/u)?.[1];
    if (nestedEditorId && nestedEditorId !== normalized) {
        addReplayableAnnotationId(ids, nestedEditorId);
    }
}

function addEmbeddedAnnotationIdFromStableKey(ids: Set<string>, stableKey: string) {
    const normalized = normalizePdfJsAnnotationId(getPdfAnnotationIdFromStableKey(stableKey));
    if (normalized) {
        ids.add(normalized);
    }
}

function addReplayableNativeEntityIds(
    ids: Set<string>,
    input: {
        shapes: readonly IShapeAnnotation[] | null;
        deletedShapeAnnotationIds: readonly string[];
        deletedShapeStableKeys: readonly string[];
        textBoxes: ReadonlyArray<Pick<IPdfNativeTextBoxMutation, 'stableKey' | 'annotationId'>>;
        placedImageGeometryUpdates?: ReadonlyArray<
            Pick<IPdfNativePlacedImageGeometryUpdate, 'stableKey' | 'annotationId'>
        >;
    },
) {
    input.shapes?.forEach((shape) => {
        addReplayableAnnotationId(ids, shape.annotationId);
        addReplayableAnnotationId(ids, shape.stableKey);
    });
    input.deletedShapeAnnotationIds.forEach((id) => addReplayableAnnotationId(ids, id));
    input.deletedShapeStableKeys.forEach((stableKey) => addReplayableAnnotationId(ids, stableKey));
    input.textBoxes.forEach((textBox) => {
        addReplayableAnnotationId(ids, textBox.stableKey);
        addReplayableAnnotationId(ids, textBox.annotationId);
    });
    input.placedImageGeometryUpdates?.forEach((update) => {
        if (update.stableKey) {
            ids.add(update.stableKey);
        }
        addReplayableAnnotationId(ids, update.annotationId);
    });
}

function collectReplayableEmbeddedAnnotationIds(input: {
    pendingTexts: Map<string, string>;
    pendingDeletes: IAnnotationCommentSummary[];
    comments: IAnnotationCommentSummary[];
    changedComments: IAnnotationCommentSummary[];
    replayableCanonicalStickyNoteStableKeys: ReadonlySet<string>;
    frontierChanges: IPdfFrontierAnnotationChanges;
    nativeTextBoxes?: ReadonlyArray<Pick<IPdfNativeTextBoxMutation, 'stableKey' | 'annotationId'>>;
    shapes?: readonly IShapeAnnotation[] | null;
    deletedShapeAnnotationIds?: readonly string[];
    deletedShapeStableKeys?: readonly string[];
    placedImages?: ReadonlyArray<Pick<IPlacedImageEntity, 'identity'>>;
}) {
    const ids = new Set<string>();
    const placedImageGeometryUpdates = input.placedImages?.map(image => ({
        stableKey: image.identity.id,
        ...(image.identity.pdfRef === undefined ? {} : {annotationId: image.identity.pdfRef}),
    }));
    addReplayableNativeEntityIds(ids, {
        shapes: input.shapes ?? null,
        deletedShapeAnnotationIds: input.deletedShapeAnnotationIds ?? [],
        deletedShapeStableKeys: input.deletedShapeStableKeys ?? [],
        textBoxes: input.nativeTextBoxes ?? [],
        ...(placedImageGeometryUpdates === undefined ? {} : {placedImageGeometryUpdates}),
    });
    input.pendingTexts.forEach((_text, stableKey) => {
        addEmbeddedAnnotationIdFromStableKey(ids, stableKey);
        const matchingComments = input.comments.filter(candidate => candidate.stableKey === stableKey);
        const [
            matchingComment,
            ...otherMatchingComments
        ] = matchingComments;
        if (matchingComment && otherMatchingComments.length === 0) {
            addCommentIdentityAliases(ids, matchingComment);
        }
    });
    input.pendingDeletes.forEach((comment) => {
        [
            comment.appAnnotationId,
            comment.annotationId,
            comment.uid,
            comment.id,
        ].forEach(id => addReplayableAnnotationId(ids, id));
        addEmbeddedAnnotationIdFromStableKey(ids, comment.stableKey);
    });
    input.comments
        .filter(comment => isReplayableEditorOnlyFreeTextNote(comment) || isReplayableCanonicalTextBox(comment))
        .forEach((comment) => {
            [
                comment.annotationId,
                comment.uid,
                comment.id,
            ].forEach(id => addReplayableAnnotationId(ids, id));
        });
    input.changedComments
        .filter(comment => comment.source === 'shape')
        .forEach((comment) => {
            // Canonical shapes are projected by the native shape mutation
            // payload. Their canonical aliases must not make that payload look
            // like work no native operation replays.
            addCommentIdentityAliases(ids, comment);
        });
    input.changedComments
        .filter(isTextMarkupComment)
        .forEach((comment) => {
            // Changed canonical markups are emitted by the native markup
            // payload. Count their aliases before route selection so an
            // imported text update can remain on source replay beside them.
            addCommentIdentityAliases(ids, comment);
        });
    input.changedComments
        .filter(comment => (
            isReplayableCanonicalStickyNote(comment)
            && input.replayableCanonicalStickyNoteStableKeys.has(comment.stableKey)
        ))
        .forEach((comment) => {
            addCommentIdentityAliases(ids, comment);
        });
    if (ids.size > 0) {
        input.frontierChanges.noteIds.forEach((id) => {
            addReplayableAnnotationId(ids, id);
        });
    }
    return ids;
}

function deriveCanonicalSaveInputs(
    plan: ISerializationPlan,
    capabilities: IPdfSaveRouteCapabilities,
): IPdfSaveCanonicalInputs {
    assertAnnotationBackendSemanticConformance(plan);
    // Once a frontier has been captured, every downstream backend is projected solely
    // from that immutable plan. Reading a second live-state route here made save
    // selection depend on mutations that happened after capture.
    const comments = plan.entities
        .filter(entity => !entity.deleted)
        .map(entitySummary);
    const changedEntities = plan.expected
        .filter(entity => !entity.deleted && isActuallyChangedEntity(entity));
    const changedComments = plan.expected
        .filter(entity => !entity.deleted && isActuallyChangedEntity(entity))
        .map(entitySummary);
    const pendingTexts = new Map<string, string>();
    const pendingDeletes: IAnnotationCommentSummary[] = [];
    plan.expected.filter(isActuallyChangedEntity).forEach((entity) => {
        const summary = entitySummary(entity);
        if (entity.deleted && entity.kind !== 'shape') {
            pendingDeletes.push(summary);
            return;
        }
        if (
            (entity.kind === 'note' || (entity.kind === 'text-box' && capabilities.nativeTextBoxes === undefined))
            && entity.identity.pdfRef
        ) {
            pendingTexts.set(summary.stableKey, summary.text);
        }
    });
    const frontierChanges = summarizeFrontierChanges(plan);
    const replayableCanonicalStickyNoteStableKeys = new Set(
        changedEntities
            .filter(isNewCanonicalStickyNoteEntity)
            .map(entity => entitySummary(entity).stableKey),
    );
    return {
        comments,
        pendingTexts,
        pendingDeletes,
        frontierChanges,
        replayableEmbeddedAnnotationIds: collectReplayableEmbeddedAnnotationIds({
            pendingTexts,
            pendingDeletes,
            comments,
            changedComments,
            replayableCanonicalStickyNoteStableKeys,
            frontierChanges,
            ...(capabilities.nativeTextBoxes === undefined
                ? {}
                : {nativeTextBoxes: capabilities.nativeTextBoxes ?? []}),
            shapes: capabilities.shapes,
            deletedShapeAnnotationIds: capabilities.deletedEmbeddedShapeAnnotationIds,
            deletedShapeStableKeys: capabilities.deletedEmbeddedShapeStableKeys,
            placedImages: changedEntities
                .filter((entity): entity is IPlacedImageEntity => entity.kind === 'placed-image'),
        }),
        replayableCanonicalStickyNoteStableKeys,
    };
}

function planAnnotationRoute(canonical: IPdfSaveCanonicalInputs): IPdfViewerAnnotationSavePlan {
    const changes = canonical.frontierChanges;
    const hasPendingReplayableEmbeddedChanges = canonical.pendingTexts.size > 0
        || canonical.pendingDeletes.length > 0
        || canonical.replayableEmbeddedAnnotationIds.size > 0;
    const hasEditorOnlyAnnotationsPendingMaterialization = canonical.comments.some(comment =>
        comment.source === 'editor'
        && !parsePdfAnnotationRef(comment.annotationId)
        && !isReplayableEditorOnlyFreeTextNote(comment)
        && !isReplayableCanonicalTextBox(comment)
        && !canonical.replayableCanonicalStickyNoteStableKeys.has(comment.stableKey),
    );

    if (hasPendingReplayableEmbeddedChanges && !hasEditorOnlyAnnotationsPendingMaterialization) {
        // Replayable sticky notes stay on the loaded-source writer route. The
        // native writer owns the append and no renderer rewrite is permitted.
        if (!changes.hasChanges) {
            return {
                route: 'loaded-source',
                expectedCost: 'full-document',
                reason: 'pending-embedded-annotation-operations',
                unreplayableAnnotationIds: [],
            };
        }

        const unreplayableAnnotationIds = Array.from(changes.ids)
            .filter(id => !canonical.replayableEmbeddedAnnotationIds.has(id));
        if (unreplayableAnnotationIds.length === 0 && changes.ids.size > 0) {
            return {
                route: 'loaded-source',
                expectedCost: 'full-document',
                reason: 'changed-annotation-ids-covered-by-embedded-operations',
                unreplayableAnnotationIds,
            };
        }

        if (unreplayableAnnotationIds.length > 0) {
            return {
                route: 'writer-save',
                expectedCost: 'full-document',
                reason: 'unreplayable-changed-annotation-ids',
                unreplayableAnnotationIds,
            };
        }
    }

    if (changes.hasChanges) {
        return {
            route: 'writer-save',
            expectedCost: 'full-document',
            reason: 'changed-annotations-not-replayable',
            unreplayableAnnotationIds: Array.from(changes.ids),
        };
    }

    if (hasEditorOnlyAnnotationsPendingMaterialization) {
        return {
            route: 'writer-save',
            expectedCost: 'full-document',
            reason: 'editor-only-annotations-pending-materialization',
            unreplayableAnnotationIds: [],
        };
    }

    return {
        route: 'source-clean',
        expectedCost: 'small',
        reason: 'no-annotation-work',
        unreplayableAnnotationIds: [],
    };
}

interface INativeSaveDescriptors {
    readonly nativeCapabilities: IPdfViewerSaveTransactionNativeCapabilities;
    readonly dirtyState: IPdfViewerSaveTransactionDirtyState;
    readonly documentStructure: IPdfViewerSaveTransactionDocumentStructure;
}

function admitNativeAppendRoute(
    plan: ISerializationPlan,
    capabilities: IPdfSaveRouteCapabilities,
): INativeSaveDescriptors | TNativeSaveRouteRejection {
    if (selectSerializationBackend(plan, capabilities.availableBackends) !== 'native-append') {
        return 'backend-not-native-append';
    }
    const {
        nativeCapabilities,
        dirtyState,
        documentStructure,
    } = capabilities;
    if (!nativeCapabilities || !dirtyState || !documentStructure) {
        return 'save-descriptors-unavailable';
    }
    if (capabilities.saveFlowMode !== 'save' && capabilities.saveFlowMode !== 'save_as') {
        return 'not-save-mode';
    }
    if (!nativeCapabilities.hasNativePdfMutationCapability) {
        return 'native-save-capability-unavailable';
    }
    return {
        nativeCapabilities,
        dirtyState,
        documentStructure,
    };
}

/**
 * Shapes are canonical annotation entities, so the coarse annotation revision
 * counters cannot tell shape work apart from note and markup work. The plan
 * owns what this save actually changes, so ask it instead.
 */
function hasNonShapeAnnotationWork(plan: ISerializationPlan) {
    return plan.expected.some(entity => isActuallyChangedEntity(entity) && entity.kind !== 'shape');
}

function buildNativePlacedImageGeometryUpdates(
    plan: ISerializationPlan,
): IPdfNativePlacedImageGeometryUpdate[] {
    return plan.entities
        .filter((entity): entity is IPlacedImageEntity => (
            entity.kind === 'placed-image' && !entity.deleted && isActuallyChangedEntity(entity)
            && !('kind' in entity.image)
        ))
        .flatMap(entity => 'kind' in entity.image ? [] : [{
            pageIndex: requirePageIndex(entity.pageIndex),
            stableKey: entity.identity.id,
            author: entity.author,
            ...(entity.identity.pdfRef
                ? {annotationId: normalizePdfJsAnnotationId(entity.identity.pdfRef)}
                : {sourceImage: {...entity.image}}),
            x: entity.rect.left,
            y: entity.rect.top,
            width: entity.rect.width,
            height: entity.rect.height,
            rotationDegrees: entity.rotation,
        }]);
}

function buildNativePlacedImages(plan: ISerializationPlan): IPdfNativePlacedImage[] {
    return plan.expected.flatMap(entity => {
        if (entity.kind !== 'placed-image' || entity.deleted || !isActuallyChangedEntity(entity) || !('kind' in entity.image)) {
            return [];
        }
        return [{
            pageIndex: requirePageIndex(entity.pageIndex),
            stableKey: entity.identity.id,
            author: entity.author,
            ...(entity.identity.pdfRef ? {annotationId: normalizePdfJsAnnotationId(entity.identity.pdfRef)} : {}),
            x: entity.rect.left,
            y: entity.rect.top,
            width: entity.rect.width,
            height: entity.rect.height,
            rotationDegrees: entity.rotation,
            mimeType: entity.image.mimeType,
            bytesBase64: entity.image.dataBase64,
            byteLength: entity.image.byteLength,
            sha256: entity.image.sha256,
        }];
    });
}

function addCommentIdentityAliases(ids: Set<string>, comment: IAnnotationCommentSummary) {
    [
        comment.appAnnotationId,
        comment.annotationId,
        comment.id,
        comment.uid,
    ].forEach(id => addReplayableAnnotationId(ids, id));
    addEmbeddedAnnotationIdFromStableKey(ids, comment.stableKey);
}

function areAnnotationIdentityAliasesEqual(
    left: string | null | undefined,
    right: string | null | undefined,
) {
    const normalizedLeft = normalizePdfJsAnnotationId(left);
    const normalizedRight = normalizePdfJsAnnotationId(right);
    return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

function isTextMarkupComment(comment: IAnnotationCommentSummary) {
    return comment.subtype === 'Highlight'
        || comment.subtype === 'Underline'
        || comment.subtype === 'StrikeOut'
        || comment.subtype === 'Strikethrough'
        || comment.subtype === 'Squiggly';
}

function isCanonicalTextBoxComment(comment: IAnnotationCommentSummary) {
    return Boolean(comment.appAnnotationId)
        && comment.subtype?.trim().toLowerCase() === 'freetext';
}

function nativeTextBoxCoversComment(
    textBox: {
        stableKey: string;
        annotationId?: string | null
    },
    comment: IAnnotationCommentSummary,
) {
    const textBoxIdentities = [
        textBox.stableKey,
        textBox.annotationId,
    ];
    const commentIdentities = [
        comment.appAnnotationId,
        comment.annotationId,
        comment.id,
        comment.uid,
        comment.stableKey,
    ];
    return textBoxIdentities.some(textBoxIdentity => (
        commentIdentities.some(commentIdentity => (
            textBoxIdentity === commentIdentity
            || areAnnotationIdentityAliasesEqual(textBoxIdentity, commentIdentity)
        ))
    ));
}

function buildClassifiedNativeMutationProjection(
    plan: ISerializationPlan,
    canonical: IPdfSaveCanonicalInputs,
    capabilities: IPdfSaveRouteCapabilities,
    admitted: INativeSaveDescriptors,
    annotationRoute: IPdfViewerAnnotationSavePlan,
): INativePdfMutationProjection | TNativeSaveRouteRejection {
    const replayAllowed = annotationRoute.route === 'loaded-source';
    const changedComments = plan.entities
        .filter(entity => !entity.deleted && isActuallyChangedEntity(entity))
        .map(entitySummary);
    const noteTextUpdatesResult = replayAllowed && canonical.pendingTexts.size > 0
        ? buildNativeNoteTextUpdatesForSave({
            pendingTexts: canonical.pendingTexts,
            canonicalComments: canonical.comments,
        })
        : null;
    const canonicalStickyNotesForNativeAppend = changedComments.filter(comment => (
        isReplayableCanonicalStickyNote(comment)
        && canonical.replayableCanonicalStickyNoteStableKeys.has(comment.stableKey)
    ));
    const freeTextNotesResult = buildNativeFreeTextNotesForSave({
        // EVB-owned sticky notes remain safe native payloads when another
        // A canonical annotation outside the writer's bounded mutation set
        // must fail closed instead of entering a second save route.
        canonicalComments: replayAllowed
            ? capabilities.nativeTextBoxes === undefined
                ? changedComments
                : changedComments.filter(comment => !isCanonicalTextBoxComment(comment))
            : canonicalStickyNotesForNativeAppend,
        replayableCanonicalStickyNoteStableKeys: canonical.replayableCanonicalStickyNoteStableKeys,
    });
    const annotationDeletesResult = replayAllowed
        ? projectNativeAnnotationDeletes({pendingDeletes: canonical.pendingDeletes})
        : null;
    const noteTextUpdates = noteTextUpdatesResult?.value ?? [];
    const noteGeometryUpdatesResult = replayAllowed
        ? nativeNoteGeometryProjection(changedComments)
        : null;
    if (noteGeometryUpdatesResult?.skipEvents.length) {
        return 'annotation-work-not-covered-by-native-mutations';
    }
    const noteGeometryUpdates = noteGeometryUpdatesResult?.value ?? [];
    const placedImageGeometryUpdates = buildNativePlacedImageGeometryUpdates(plan);
    const placedImages = buildNativePlacedImages(plan);
    const imageMutationCount = placedImageGeometryUpdates.length + placedImages.length;
    const recoverableNotes = new Map<string, string>(plan.expected.flatMap(entity => (
        entity.kind === 'note' && !entity.deleted && !entity.identity.pdfRef && entity.recoveryData
            ? [[
                entity.identity.id,
                entity.recoveryData,
            ] as const]
            : []
    )));
    const freeTextNotes = (freeTextNotesResult?.value ?? []).map(note => {
        const recoveryData = recoverableNotes.get(note.stableKey);
        return recoveryData === undefined ? note : {
            ...note,
            recoveryData,
        };
    });
    // Native text-box mutations are already a bounded projection. They remain
    // valid when other changed annotations select the writer route.
    const textBoxes = capabilities.nativeTextBoxes ?? [];
    if (
        capabilities.nativeTextBoxes !== undefined
        && changedComments.some(isCanonicalTextBoxComment)
        && changedComments
            .filter(isCanonicalTextBoxComment)
            .some(comment => !textBoxes.some(textBox => nativeTextBoxCoversComment(textBox, comment)))
    ) {
        return 'native-text-box-payload-unavailable';
    }
    const annotationDeletes = annotationDeletesResult?.value ?? [];
    const pendingDeleteTargetKeys = canonical.pendingDeletes
        .map(getNativeAnnotationDeleteCommentTargetKey);
    const projectedDeleteTargetKeys = annotationDeletes
        .map(getNativeAnnotationDeleteRequestTargetKey);
    const pendingDeleteTargetSet = new Set(pendingDeleteTargetKeys);
    const projectedDeleteTargetSet = new Set(projectedDeleteTargetKeys);
    const hasExactNativeDeleteCoverage = (
        pendingDeleteTargetKeys.length === annotationDeletes.length
        && pendingDeleteTargetKeys.every((key): key is string => key !== null)
        && projectedDeleteTargetKeys.every((key): key is string => key !== null)
        && pendingDeleteTargetSet.size === pendingDeleteTargetKeys.length
        && projectedDeleteTargetSet.size === projectedDeleteTargetKeys.length
        && pendingDeleteTargetKeys.every(key => projectedDeleteTargetSet.has(key))
    );
    const annotationWorkDirty = hasNonShapeAnnotationWork(plan);
    const markup = buildNativeMarkupMutationForSave({
        canonicalComments: canonical.comments,
        changedComments,
        annotationWorkDirty,
        markupSubtypeOverrides: capabilities.markupSubtypeOverrides,
        markupSubtypeHints: capabilities.markupSubtypeHints,
    });
    const hasMarkupMutations = Boolean(markup);
    const nativeNoteMutationCount = noteTextUpdates.length
        + freeTextNotes.length
        + textBoxes.length
        + annotationDeletes.length
        + noteGeometryUpdates.length;
    if (capabilities.forceWriterSave && nativeNoteMutationCount === 0 && !hasMarkupMutations
        && imageMutationCount === 0) {
        return 'writer-save-required';
    }
    if (!arePendingTextsCoveredByNativeChanges({
        pendingTexts: canonical.pendingTexts,
        nativeNoteTextUpdates: noteTextUpdatesResult?.value ?? null,
        nativeFreeTextNotes: freeTextNotesResult?.value ?? null,
    })) {
        return 'pending-texts-not-covered-by-native-mutations';
    }
    if (canonical.pendingDeletes.length > 0 && !hasExactNativeDeleteCoverage) {
        return 'pending-deletes-not-covered-by-native-mutations';
    }
    if (annotationWorkDirty && nativeNoteMutationCount === 0 && !hasMarkupMutations
        && imageMutationCount === 0) {
        return 'annotation-work-not-covered-by-native-mutations';
    }

    const shapes = buildNativeShapesMutationForSave({
        shapeStateDirty: admitted.dirtyState.shapeStateDirty,
        rewriteShapeState: capabilities.rewriteShapeState,
        totalPageCount: capabilities.totalPageCount,
        shapes: capabilities.shapes,
        deletedAnnotationIds: capabilities.deletedEmbeddedShapeAnnotationIds,
        deletedStableKeys: capabilities.deletedEmbeddedShapeStableKeys,
    });
    const hasShapeMutations = Boolean(shapes);
    if (admitted.dirtyState.shapeStateDirty && !hasShapeMutations) {
        return 'shape-payload-unavailable';
    }
    const pageLabels = buildNativePageLabelsMutationForSave({
        pageLabelsDirty: admitted.documentStructure.pageLabelsDirty,
        totalPageCount: capabilities.totalPageCount,
        pageLabelRanges: admitted.documentStructure.pageLabelRanges,
    });
    const bookmarks = buildNativeBookmarksMutationForSave({
        bookmarksDirty: admitted.documentStructure.bookmarksDirty,
        totalPageCount: capabilities.totalPageCount,
        bookmarkItems: admitted.documentStructure.bookmarkItems,
        untitledBookmarkLabel: admitted.documentStructure.untitledBookmarkLabel,
    });
    const hasMetadataMutations = Boolean(pageLabels) || Boolean(bookmarks);
    if (
        (admitted.documentStructure.pageLabelsDirty || admitted.documentStructure.bookmarksDirty)
        && !hasMetadataMutations
    ) {
        return 'metadata-payload-unavailable';
    }
    if (
        (hasMetadataMutations || hasShapeMutations)
        && !admitted.nativeCapabilities.canPersistNativeMetadataMutations
    ) {
        return 'native-structured-save-capability-unavailable';
    }
    if (nativeNoteMutationCount === 0 && !hasMetadataMutations && !hasShapeMutations && !hasMarkupMutations
        && imageMutationCount === 0) {
        return 'no-native-mutations-projected';
    }

    return {
        canonicalAnnotationProgram: projectAnnotationBackendMutations(plan, 'native-append'),
        mutations: {
            ...(noteTextUpdates.length > 0 ? {updates: noteTextUpdates} : {}),
            ...(noteGeometryUpdates.length > 0 ? {geometryUpdates: noteGeometryUpdates} : {}),
            ...(freeTextNotes.length > 0 ? {freeTextNotes} : {}),
            ...(textBoxes.length > 0 ? {textBoxes} : {}),
            ...(annotationDeletes.length > 0 ? {deletes: annotationDeletes} : {}),
            ...(pageLabels ? {pageLabels} : {}),
            ...(bookmarks ? {bookmarks} : {}),
            ...(shapes ? {shapes} : {}),
            ...(markup ? {markup} : {}),
            ...(placedImageGeometryUpdates.length > 0 ? {placedImageGeometryUpdates} : {}),
            ...(placedImages.length > 0 ? {placedImages} : {}),
        },
        placedImageGeometryUpdates,
        noteTextUpdates,
        noteGeometryUpdates,
        freeTextNotes,
        textBoxes,
        annotationDeletes,
        hasMetadataMutations,
        hasShapeMutations,
        hasMarkupMutations,
        phase: hasMetadataMutations || hasShapeMutations || hasMarkupMutations
            ? 'persist-native-pdf-mutations'
            : annotationDeletes.length > 0
                ? 'persist-native-annotation-changes'
                : textBoxes.length > 0
                    ? 'persist-native-text-box-changes'
                    : freeTextNotes.length > 0
                        ? 'persist-native-note-changes'
                        : 'persist-native-note-text-updates',
    };
}

/**
 * The one place save routing is decided. Every projector receives the result and
 * asserts it; none of them may re-derive a mode, capability, or coverage branch.
 */
export function buildNativePdfMutationProjection(
    plan: ISerializationPlan,
    capabilities: IPdfSaveRouteCapabilities,
): TPdfSaveRouteDecision {
    const canonical = deriveCanonicalSaveInputs(plan, capabilities);
    // Forced materialization selects the full writer route but never removes the
    // native-append grant: bounded native mutations still beat a full rewrite.
    const replayPlan = planAnnotationRoute(canonical);
    const annotationPlan: IPdfViewerAnnotationSavePlan = capabilities.forceWriterSave
        ? {
            route: 'writer-save',
            expectedCost: 'full-document',
            reason: canonical.frontierChanges.hasChanges
                ? 'writer-save-forced-with-annotation-changes'
                : 'writer-save-forced',
            unreplayableAnnotationIds: Array.from(canonical.frontierChanges.ids),
        }
        : replayPlan;
    const admitted = admitNativeAppendRoute(plan, capabilities);
    const nativeProjection = typeof admitted === 'string'
        ? admitted
        : buildClassifiedNativeMutationProjection(plan, canonical, capabilities, admitted, replayPlan);
    const nativeRejection = typeof nativeProjection === 'string'
        ? nativeProjection
        : 'native-write-failed';
    const byteRoute: IPdfSaveByteRouteDecision = {
        route: annotationPlan.route,
        annotationPlan,
        canonical,
        baseBytes: capabilities.hasLoadedSource && annotationPlan.route !== 'writer-save'
            ? 'loaded-source'
            : 'writer-save',
        sourceFallbackAllowed: annotationPlan.route === 'loaded-source',
        nativeRejection,
    };
    if (typeof admitted === 'string' || typeof nativeProjection === 'string') {
        return byteRoute;
    }

    return {
        route: 'native-append',
        annotationRoute: replayPlan,
        replayableAnnotationMutationsAllowed: replayPlan.route === 'loaded-source',
        metadataMutationsAllowed: admitted.nativeCapabilities.canPersistNativeMetadataMutations,
        annotationWorkDirty: hasNonShapeAnnotationWork(plan),
        writerSaveForced: capabilities.forceWriterSave,
        nativeMutationProjection: nativeProjection,
        annotationPlan,
        canonical,
        dirtyState: admitted.dirtyState,
        documentStructure: admitted.documentStructure,
        fallback: byteRoute,
    };
}
