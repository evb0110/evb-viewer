import type {
    ComputedRef,
    Ref,
} from 'vue';
import {normalizePdfJsAnnotationId} from '@app/utils/pdfAnnotationRefs';
import { usePdfAppAnnotationHistory } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAppAnnotationHistory';
import { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import { usePdfAnnotationColorCommands } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationColorCommands';
import { usePdfAnnotationCommentActions } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationCommentActions';
import { usePdfAnnotationCommentModel } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationCommentModel';
import { usePdfShapeTool } from '@app/modules/pdf-viewer/tools/public';
import { useAnnotationMutationService } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationMutationService';
import { BrowserLogger } from '@app/utils/browserLogger';
import type {
    IAnnotationCommentSummary,
    IAnnotationInventoryCompleteness,
    IAnnotationModifiedPayload,
    IAnnotationSettings,
    TAnnotationTool,
    TMarkupSubtype,
    ILinkAnnotation,
    TAnnotationSettingChange,
} from '@app/types/annotations';
import type {TPdfSource} from '@app/types/pdfUi';
import { AnnotationStore } from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import {
    pageNumberToPageIndex,
    requirePageNumber,
    type TPageNumber,
} from '@contracts/pageNumbers';
import { parseDocumentRef } from '@contracts/documentRef';
import type {
    IPdfDocumentTransition,
    TPdfDocumentSession,
} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import {
    applyParsedHighlightTextToStore,
    commitPdfAnnotationParseToStore,
} from '@app/modules/pdf-viewer/runtime/sessions/commitPdfAnnotationParseToStore';
import {pdfAnnotationRefKey} from '@app/modules/pdf-viewer/runtime/sessions/mapPdfAnnotationParseEntity';
import type { TPdfViewportSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import type { TPdfRenderingSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfRenderingSession';
import type { IAnnotationContextMenuPayload } from '@app/modules/pdf-viewer/engine/annotationContextMenuPayload';
import type {
    IAnnotationCreationFailureReport,
    TAnnotationCreationFailureReason,
    TAnnotationCreationOutcome,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationCreationOutcome.types';
import {
    asAnnotationId,
    normalizeAnnotationText,
    type ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {
    getDocumentFilesCapability,
    getDocumentWorkingCopyCapability,
} from '@app/utils/platformDocuments';
import { groupBy } from 'es-toolkit/array';
import type { IAnnotationEnrichmentState } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationEnrichmentPolicy';
import { usePdfViewerSaveTransaction } from '@app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction';
import {
    annotationEditorSurfaceKey,
    usePdfAnnotationEditorSurface,
} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import { createPdfPagePointResolver } from '@app/modules/pdf-viewer/engine/annotations/pdf-page-point-resolver/createPdfPagePointResolver';
import { markerRectFromPoint } from '@app/modules/pdf-viewer/engine/annotations/pdf-page-point-resolver/markerRectFromPoint';
import {useAnnotationTextSelectionCache} from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationTextSelectionCache';
import {
    createAnnotationSelectionLifecycle,
    type IAnnotationSelectionCreationRequest,
} from '@app/modules/pdf-viewer/runtime/annotations/createAnnotationSelectionLifecycle';
import {
    createPdfAnnotationSelectionMarkup,
    type ICreatePdfAnnotationSelectionMarkupRequest,
} from '@app/modules/pdf-viewer/runtime/annotations/createPdfAnnotationSelectionMarkup';
import { createPdfAnnotationEditorCompatibility } from '@app/modules/pdf-viewer/runtime/annotations/createPdfAnnotationEditorCompatibility';
import { isSelectionMarkupTool } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isSelectionMarkupTool';
import {
    createAnnotationCreationFailureReporter,
    emitCanonicalAnnotationOpenNote,
    findCanonicalAnnotationComment,
    sameStringSet,
} from '@app/modules/pdf-viewer/runtime/annotations/createPdfAnnotationSessionHelpers';
import { createPdfAnnotationStampImageResolver } from '@app/modules/pdf-viewer/runtime/annotations/createPdfAnnotationStampImageResolver';
import { createPdfAnnotationOwnershipRefreshWatch } from '@app/modules/pdf-viewer/runtime/annotations/createPdfAnnotationOwnershipRefreshWatch';
import { buildRangeFromPageText } from '@app/modules/pdf-viewer/engine/annotations/pdf-text-anchor-resolver/buildRangeFromPageText';
import { resolvePdfAnnotationSelectionGeometry } from '@app/modules/pdf-viewer/runtime/sessions/resolvePdfAnnotationSelectionGeometry';
import { deriveSelectedTextForParsedHighlights } from '@app/modules/pdf-viewer/runtime/sessions/deriveSelectedTextForParsedHighlights';
import {resolvePdfAnnotationPreviewTextFromMarkerRects} from '@app/modules/pdf-viewer/engine/annotations/pdf-annotation-preview-text/resolvePdfAnnotationPreviewText';
import { findPdfPageContainer } from '@app/modules/pdf-viewer/dom/pdf-viewer-dom/findPdfPageContainer';
import { subtypeForAnnotationTool } from '@app/modules/pdf-viewer/runtime/sessions/subtypeForAnnotationTool';
import type {
    ICreateTextMarkupFromTextOptions,
    ICreateTextMarkupFromTextResult,
} from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerExpose.types';
import type {IPdfPlacedImageFinalizePayload} from '@app/types/pdfImagePlacement';
import {unrotateAnnotationPlacementRect} from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';
import {preparePdfAnnotationRaster} from '@app/modules/pdf-viewer/runtime/annotations/preparePdfAnnotationRaster';
import {createAnnotationSelectionInteractionController} from '@app/modules/pdf-viewer/runtime/annotations/createAnnotationSelectionInteractionController';
import {
    captureCanonicalAnnotationRecovery,
    restoreCanonicalAnnotationRecovery,
    type IAnnotationRecoveryDraft,
    type ICanonicalAnnotationRecovery,
} from '@app/modules/pdf-viewer/annotations/domain/annotationRecovery';
export interface ICreatePdfAnnotationSessionOptions {
    document: TPdfDocumentSession;
    viewport: TPdfViewportSession;
    rendering: TPdfRenderingSession;
    viewerContainer: Ref<HTMLElement | null>;
    originalPath: ComputedRef<string | null>;
    src: ComputedRef<TPdfSource | null>;
    sourcePdfData: ComputedRef<Uint8Array | null>;
    workingCopyPath: ComputedRef<string | null>;
    documentRevisionToken: ComputedRef<TDocumentRevisionToken | null>;
    isAnySaving: ComputedRef<boolean>;
    isActive: ComputedRef<boolean>;
    bufferPages: ComputedRef<number>;
    annotationTool: ComputedRef<TAnnotationTool>;
    viewRotation?: ComputedRef<0 | 90 | 180 | 270>;
    annotationCursorMode: ComputedRef<boolean>;
    annotationKeepActive: ComputedRef<boolean>;
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
    authorName: ComputedRef<string | null | undefined>;
    clearPendingImagePlacement: () => void;
    emitAnnotationModified: (payload?: IAnnotationModifiedPayload) => void;
    emitAnnotationState: Parameters<typeof usePdfAppAnnotationHistory>[0]['emitAnnotationState'];
    emitAnnotationComments: (comments: IAnnotationCommentSummary[]) => void;
    emitAnnotationInventory: (completeness: IAnnotationInventoryCompleteness | null) => void;
    emitAnnotationEnrichmentState: (state: IAnnotationEnrichmentState) => void;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationContextMenu: (payload: IAnnotationContextMenuPayload) => void;
    emitAnnotationToolAutoReset: () => void;
    emitAnnotationToolCancel?: () => void;
    emitAnnotationSetting: (payload: TAnnotationSettingChange) => void;
    emitAnnotationCommentClick: (comment: IAnnotationCommentSummary) => void;
    reportAnnotationFailure?: (failure: IAnnotationCreationFailureReport) => void;
    emitShapeContextMenu: Parameters<typeof usePdfShapeTool>[0]['emitShapeContextMenu'];
    /** Renderer-owned PDF link state consumed by the portal overlay. */
    linkAnnotations?: Ref<ILinkAnnotation[]> | undefined;

}
interface IAnnotationStoreDocumentIdentityInput {
    workingCopyPath: string | null;
    source: TPdfSource | null;
}
interface IAnnotationSnapshotDocumentIdentityInput {
    originalPath: string | null;
    workingCopyPath: string | null;
    source: TPdfSource | null;
}
// Pathless sources are keyed by Blob instance because their metadata can collide.
// The `blob-instance:` prefix avoids collisions with file paths.
const annotationBlobIdentities = new WeakMap<Blob, string>();
let nextAnnotationBlobIdentity = 0;
function annotationBlobIdentity(source: Blob) {
    const existing = annotationBlobIdentities.get(source);
    if (existing) {
        return existing;
    }
    nextAnnotationBlobIdentity += 1;
    const identity = `blob-instance:${nextAnnotationBlobIdentity}`;
    annotationBlobIdentities.set(source, identity);
    return identity;
}

function annotationDocumentKey(source: TPdfSource | null) {
    if (!source) {
        return 'no-document';
    }
    return source instanceof Blob
        ? annotationBlobIdentity(source)
        : `path:${source.path}`;
}

function resolveAnnotationStoreDocumentIdentity(
    input: IAnnotationStoreDocumentIdentityInput,
) {
    return input.workingCopyPath
        ? `path:${input.workingCopyPath}`
        : annotationDocumentKey(input.source);
}

export function resolveAnnotationSnapshotDocumentIdentity(
    input: IAnnotationSnapshotDocumentIdentityInput,
) {
    return input.originalPath
        ? `source:${input.originalPath}`
        : input.workingCopyPath
            ? `path:${input.workingCopyPath}`
            : annotationDocumentKey(input.source);
}

export const createPdfAnnotationSession = (options: ICreatePdfAnnotationSessionOptions) => {
    const documentSession = options.document;
    const viewport = options.viewport;
    const rendering = options.rendering;
    const appAnnotationHistory = usePdfAppAnnotationHistory({
        emitAnnotationState: options.emitAnnotationState,
        markModified: options.emitAnnotationModified,
    });

    function emitForcedAnnotationMutation(mutationOptions: { scheduleCommentSync?: boolean } = {}) {
        options.emitAnnotationModified({ forceDirty: true });
        if (mutationOptions.scheduleCommentSync) {
            annotations.commentSync.scheduleAnnotationCommentsSync();
        }
    }

    function registerShapeHistoryCommand(command: {
        cmd: () => void;
        undo: () => void;
    }) {
        appAnnotationHistory.registerCommand(command);
    }

    function createAnnotationApplication(documentKey: string) {
        const history = appAnnotationHistory;
        return new AnnotationApplication(documentKey, new AnnotationStore({
            get canUndo() { return history.canUndo.value; },
            get canRedo() { return history.canRedo.value; },
            registerCommand: command => history.registerCommand(command),
            forgetCommands: ids => history.forgetCommands(ids),
            undo: () => history.undo(),
            redo: () => history.redo(),
        }));
    }
    const annotationApplication = shallowRef(createAnnotationApplication('no-document'));
    const storeOwnedPdfAnnotationIds = shallowRef(new Set<string>());
    // A native save keeps the PDF.js document that was loaded before the
    // write, so its pages still carry every annotation the save deleted. The
    // store retires a deleted entity's PDF ref when that save commits, which
    // would let the stale appearance repaint. Keep those refs hidden until
    // PDF.js loads a replacement document.
    const retiredPdfAnnotationIds = shallowRef(new Set<string>());
    const hiddenPdfAnnotationIds = computed(() => (
        retiredPdfAnnotationIds.value.size === 0
            ? storeOwnedPdfAnnotationIds.value
            : new Set([
                ...storeOwnedPdfAnnotationIds.value,
                ...retiredPdfAnnotationIds.value,
            ])
    ));
    const resolveStampImage = createPdfAnnotationStampImageResolver(documentSession);
    const shapeTool = usePdfShapeTool({
        annotationTool: options.annotationTool,
        annotationSettings: options.annotationSettings,
        isAnySaving: options.isAnySaving,
        annotationApplication,
        markModified: options.emitAnnotationModified,
        emitShapeContextMenu: options.emitShapeContextMenu,
        getDeletedShapeHandler: () => null,
        getShapeCommentsChangedHandler: () => null,
    });
    const {
        shapeComposable,
        selectedShapeCommands,
    } = shapeTool;

    const annotationProjection = shallowRef<IAnnotationCommentSummary[]>([]);
    const canonicalMarkupSubtypeHints = new Map<string, TMarkupSubtype>();
    const textBoxDrafts = new Map<string, string>();
    const textBoxDraftGenerations = new Map<string, number>();
    const annotationCommentModel = usePdfAnnotationCommentModel({
        isAnySaving: options.isAnySaving,
        annotationProjection,
        ingestSummaries: () => undefined,
        emitAnnotationComments: options.emitAnnotationComments,
    });
    const {
        annotationCommentsCache,
        activeCommentStableKey,
    } = annotationCommentModel;
    function projectCanonicalAnnotations() {
        const entities = annotationApplication.value.store.list({includeDeleted: true});
        const nextStoreOwnedPdfAnnotationIds = new Set<string>();
        const nextRetiredPdfAnnotationIds = new Set(retiredPdfAnnotationIds.value);
        entities.forEach((entity) => {
            const pdfJsAnnotationId = normalizePdfJsAnnotationId(entity.identity.pdfRef);
            if (!pdfJsAnnotationId) {
                return;
            }
            nextStoreOwnedPdfAnnotationIds.add(pdfJsAnnotationId);
            if (entity.deleted) {
                nextRetiredPdfAnnotationIds.add(pdfJsAnnotationId);
            }
        });
        if (!sameStringSet(storeOwnedPdfAnnotationIds.value, nextStoreOwnedPdfAnnotationIds)) {
            storeOwnedPdfAnnotationIds.value = nextStoreOwnedPdfAnnotationIds;
        }
        if (!sameStringSet(retiredPdfAnnotationIds.value, nextRetiredPdfAnnotationIds)) {
            retiredPdfAnnotationIds.value = nextRetiredPdfAnnotationIds;
        }
        const projected = annotationApplication.value.listCommentSummaries().map(comment => ({
            ...comment,
            text: (comment.annotationKind === 'text-box'
                ? textBoxDrafts.get(comment.appAnnotationId ?? '')
                : undefined) ?? comment.text,
        }));
        annotationProjection.value = projected.map(comment => Object.freeze({...comment}));
        annotationCommentModel.emitCommentsForSidebar(projected);
    }
    let stopAnnotationApplicationProjection = annotationApplication.value.store.subscribe(projectCanonicalAnnotations);
    const annotationDocumentIdentity = computed(() => (
        resolveAnnotationStoreDocumentIdentity({
            workingCopyPath: options.workingCopyPath.value,
            source: options.src.value,
        })
    ));
    function resetAnnotationApplication(documentKey: string) {
        stopAnnotationApplicationProjection();
        canonicalMarkupSubtypeHints.clear();
        textBoxDrafts.clear();
        textBoxDraftGenerations.clear();
        annotationCommentModel.clearProjection();
        annotationApplication.value = createAnnotationApplication(documentKey);
        stopAnnotationApplicationProjection = annotationApplication.value.store.subscribe(projectCanonicalAnnotations);
    }
    watch(annotationDocumentIdentity, resetAnnotationApplication, {immediate: true});
    // Canonical records describe the bytes PDF.js currently holds. Save and
    // file-history undo can rewrite the working copy in place and reload the
    // same path, so path-keyed identity cannot identify the loaded document or
    // preserve commands that invert edits. Reload clears the proxy before
    // publishing the next one, so the swap only affects the loaded document.
    let lastLoadedPdfDocument = documentSession.pdfDocument.value;
    watch(documentSession.pdfDocument, (document) => {
        if (!document || document === lastLoadedPdfDocument) {
            return;
        }
        const replacesLoadedDocument = lastLoadedPdfDocument !== null;
        lastLoadedPdfDocument = document;
        if (retiredPdfAnnotationIds.value.size > 0) {
            retiredPdfAnnotationIds.value = new Set();
        }
        if (!replacesLoadedDocument || options.isAnySaving.value) {
            return;
        }
        appAnnotationHistory.clear();
        resetAnnotationApplication(annotationDocumentIdentity.value);
    });
    onScopeDispose(() => stopAnnotationApplicationProjection());

    const linkAnnotations = options.linkAnnotations ?? ref<ILinkAnnotation[]>([]);
    const linksByPage = computed<Record<number, ILinkAnnotation[]>>(() =>
        groupBy(linkAnnotations.value, link => link.pageNumber),
    );
    const annotationEnrichmentState = shallowRef<IAnnotationEnrichmentState>({
        status: 'enriched',
        reason: null,
        canRetry: false,
    });
    const commentSync = {
        annotationEnrichmentState,
        scheduleAnnotationCommentsSync: () => {
            annotationCommentModel.emitCommentsForSidebar(annotationProjection.value);
        },
        syncAnnotationComments: () => {
            annotationCommentModel.emitCommentsForSidebar(annotationProjection.value);
            return Promise.resolve();
        },
        flushEditorCommentsForSave: async () => {},
        ensurePdfAnnotationNameReconciliation: (
            _reason: 'annotations-ui-open' | 'existing-annotation-mutation',
        ) => Promise.resolve('already-reconciled' as const),
        incrementSyncToken: () => {},
        discardInFlightSync: () => {},
        clearSyncState: () => {},
        setActiveCommentStableKey: (key: string | null) => {
            activeCommentStableKey.value = key;
        },
    };
    watch(
        commentSync.annotationEnrichmentState,
        state => options.emitAnnotationEnrichmentState(state),
        { immediate: true },
    );
    let commitPendingEditorDraftsForSave = () => {};
    const {
        editor,
        selectionMarkupStyle,
    } = createPdfAnnotationEditorCompatibility({
        annotationApplication,
        annotationSettings: options.annotationSettings,
        canonicalMarkupSubtypeHints,
        commitPendingFreeTextDraftsForSave: () => commitPendingEditorDraftsForSave(),
    });
    function emitAnnotationOpenNoteWithReconciliation(comment: IAnnotationCommentSummary) {
        emitCanonicalAnnotationOpenNote({
            annotationApplication,
            annotationProjection,
            comment,
            emitAnnotationOpenNote: options.emitAnnotationOpenNote,
        });
    }
    const pagePointResolver = createPdfPagePointResolver({
        viewerContainer: options.viewerContainer,
        currentPage: viewport.currentPage,
    });
    const textSelectionCache = useAnnotationTextSelectionCache({
        viewerContainer: options.viewerContainer,
        currentPage: viewport.currentPage,
        allowCrossPage: true,
    });
    const annotationEditorSurface = usePdfAnnotationEditorSurface({
        annotationApplication,
        isActive: options.isActive,
        activeTool: options.annotationTool,
        authorName: options.authorName,
        onCreationCompleted: options.emitAnnotationToolAutoReset,
        onTextBoxDraftChanged: (annotationId, text) => {
            if (text === null) {
                textBoxDrafts.delete(annotationId);
                textBoxDraftGenerations.delete(annotationId);
            } else {
                textBoxDrafts.set(annotationId, text);
                textBoxDraftGenerations.set(
                    annotationId,
                    (textBoxDraftGenerations.get(annotationId) ?? 0) + 1,
                );
            }
            projectCanonicalAnnotations();
        },
        onToolCancel: options.emitAnnotationToolCancel,
        settings: options.annotationSettings,
        resolveStampImage,
        emitAnnotationModified: options.emitAnnotationModified,
        runHistoryTransaction: action => appAnnotationHistory.runTransaction(action),
        undo: () => appAnnotationHistory.undoForEditor(),
        redo: () => appAnnotationHistory.redoForEditor(),
        emitShapeContextMenu: options.emitShapeContextMenu,
        getPageGeometry: pageIndex => {
            const metric = documentSession.pageMetrics.value[pageIndex];
            if (!metric) {
                return null;
            }
            const userUnit = metric.userUnit && metric.userUnit > 0 ? metric.userUnit : 1;
            return {
                viewRotation: options.viewRotation?.value ?? 0,
                pageView: [
                    0,
                    0,
                    (metric.rotation === 90 || metric.rotation === 270 ? metric.height : metric.width) / userUnit,
                    (metric.rotation === 90 || metric.rotation === 270 ? metric.width : metric.height) / userUnit,
                ],
                rotation: ([
                    0,
                    90,
                    180,
                    270,
                ] as const).includes(metric.rotation as 0 | 90 | 180 | 270)
                    ? metric.rotation as 0 | 90 | 180 | 270
                    : 0,
            };
        },
        emitOpenNote: entity => {
            if (entity.kind !== 'note') {
                return;
            }
            const comment = annotationProjection.value.find(candidate => (
                candidate.appAnnotationId === entity.identity.id
            )) ?? findCanonicalAnnotationComment(annotationApplication.value, entity.identity.id);
            if (comment) {
                emitAnnotationOpenNoteWithReconciliation(comment);
            }
        },
    });
    watch(options.isActive, (isActive) => {
        if (!isActive) annotationEditorSurface.suspendInteraction();
    }, {flush: 'sync'});
    commitPendingEditorDraftsForSave = annotationEditorSurface.commitPendingTextBoxDraftsForSave;
    provide(annotationEditorSurfaceKey, annotationEditorSurface);
    const createSelectionMarkup = createPdfAnnotationSelectionMarkup({
        resolveGeometry: range => resolvePdfAnnotationSelectionGeometry({
            documentSession,
            getViewRotation: () => options.viewRotation?.value ?? 0,
            viewerContainer: options.viewerContainer.value,
            range,
        }),
        createHighlights: (pages, request: ICreatePdfAnnotationSelectionMarkupRequest) => (
            appAnnotationHistory.runTransaction(() => pages.map(page => {
                const previewText = page.previewText;
                const entity = annotationEditorSurface.createHighlightFromSelection(
                    page.pageNumber - 1,
                    page.quadPoints,
                    {
                        subtype: request.subtype,
                        color: request.style.color,
                        opacity: request.style.opacity,
                        selectedText: page.selectedText,
                    },
                    previewText ? {resolveSelectedText: quadPoints => resolvePdfAnnotationPreviewTextFromMarkerRects(
                        request.subtype,
                        quadPoints,
                        previewText.textItems,
                        previewText.viewport,
                    )} : undefined,
                );
                return entity.identity.id;
            }))
        ),
        completeCreation: annotationEditorSurface.completeCreation,
        selectCreated: annotationEditorSurface.select,
        emitModified: options.emitAnnotationModified,
        onCreated: (annotationId, withNote) => {
            if (!withNote) {
                return;
            }
            const comment = findCanonicalAnnotationComment(annotationApplication.value, annotationId);
            emitAnnotationOpenNoteWithReconciliation(comment);
        },
        getActiveTool: () => options.annotationTool.value,
    });
    const selectionLifecycle = createAnnotationSelectionLifecycle({
        getActiveTool: () => options.annotationTool.value,
        consumeSelection: textSelectionCache.consumeSelection,
        create: (request: IAnnotationSelectionCreationRequest, isRequestCurrent) => createSelectionMarkup({
            ...request,
            range: request.selection.range,
        }, isRequestCurrent),
    });
    const failCommentAtPoint = createAnnotationCreationFailureReporter(options.reportAnnotationFailure);
    async function commentAtPoint(
        pageNumber: TPageNumber,
        pageX: number,
        pageY: number,
        _pointOptions: {preferTextAnchor?: boolean} = {},
    ): Promise<TAnnotationCreationOutcome> {
        await Promise.resolve();
        if (!options.viewerContainer.value) {
            return failCommentAtPoint('viewer-not-ready', pageNumber);
        }
        if (!findPdfPageContainer(options.viewerContainer.value, pageNumber)) {
            return failCommentAtPoint('page-not-rendered', pageNumber);
        }
        const position = markerRectFromPoint(pageX, pageY);
        if (!position) {
            return failCommentAtPoint('viewer-not-ready', pageNumber);
        }
        const created = annotationEditorSurface.createNoteAt(
            pageNumberToPageIndex(pageNumber),
            position,
            {open: true},
        );
        annotationEditorSurface.select([created.identity.id]);
        options.emitAnnotationModified();
        const comment = findCanonicalAnnotationComment(annotationApplication.value, created.identity.id);
        emitAnnotationOpenNoteWithReconciliation(comment);
        return {
            status: 'created',
            annotationId: created.identity.id,
        };
    }
    async function highlightSelectionInternal(withNote = false, explicitRange?: Range | null) {
        const selection = explicitRange
            ? textSelectionCache.getSelectionSnapshotForRange(explicitRange)
            : textSelectionCache.getSelectionSnapshotForCommentAction();
        const tool = options.annotationTool.value;
        const subtype = subtypeForAnnotationTool(tool);
        const style = selectionMarkupStyle(subtype);
        await Promise.resolve();
        if (!selection) {
            return {
                status: 'failed',
                reason: 'no-selection',
            } as const;
        }
        return selectionLifecycle.request({
            selection,
            tool,
            subtype,
            style,
            withNote,
            requireActiveTool: isSelectionMarkupTool(tool),
        });
    }
    async function highlightSelection() {
        return (await highlightSelectionInternal()).status === 'created';
    }
    async function commentSelection() {
        return (await highlightSelectionInternal(true)).status === 'created';
    }
    async function maybeApplySelectionMarkup(explicitRange: Range | null = null) {
        const tool = options.annotationTool.value;
        if (!isSelectionMarkupTool(tool)) {
            return false;
        }
        const selection = explicitRange
            ? textSelectionCache.getSelectionSnapshotForRange(explicitRange)
            : textSelectionCache.getSelectionSnapshotForToolActivation();
        if (!selection) {
            return false;
        }
        const subtype = subtypeForAnnotationTool(tool);
        const outcome = await selectionLifecycle.activate({
            selection,
            tool,
            subtype,
            style: selectionMarkupStyle(subtype),
            withNote: false,
        });
        return outcome.status === 'created';
    }
    async function createTextMarkupFromText(
        target: ICreateTextMarkupFromTextOptions,
    ): Promise<ICreateTextMarkupFromTextResult> {
        const requestedTool = options.annotationTool.value;
        const requestedSubtype: ICreateTextMarkupFromTextResult['subtype'] = target.markup === 'underline'
            ? 'Underline'
            : target.markup === 'strikethrough'
                ? 'StrikeOut'
                : target.markup === 'squiggly'
                    ? 'Squiggly'
                    : 'Highlight';
        const requestedStyle = selectionMarkupStyle(requestedSubtype);
        await Promise.resolve();
        const requestedPageNumber = Number.isFinite(target.pageNumber)
            ? Math.max(1, Math.trunc(target.pageNumber))
            : viewport.currentPage.value;
        const pageNumber = requirePageNumber(
            requestedPageNumber,
            documentSession.numPages.value > 0 ? documentSession.numPages.value : undefined,
        );
        const requestedText = target.text.trim();
        const occurrence = typeof target.occurrence === 'number' && Number.isFinite(target.occurrence)
            ? Math.max(1, Math.trunc(target.occurrence))
            : 1;
        const subtype = requestedSubtype;
        const result = (
            created: boolean,
            matchedText: string | null,
            reason?: string,
            failureReason?: TAnnotationCreationFailureReason,
        ) => ({
            created,
            pageNumber,
            requestedText,
            matchedText,
            occurrence,
            subtype,
            ...(reason ? {reason} : {}),
            ...(failureReason ? {failureReason} : {}),
        });
        if (!requestedText) {
            return result(false, null, 'Text is required.');
        }
        if (documentSession.numPages.value > 0 && pageNumber > documentSession.numPages.value) {
            return result(false, null, `Page ${pageNumber} is outside the document.`);
        }
        const pageContainer = findPdfPageContainer(options.viewerContainer.value, pageNumber);
        if (!pageContainer) {
            return result(false, null, `Page ${pageNumber} is not rendered.`);
        }
        const textLayer = pageContainer.querySelector<HTMLElement>('.text-layer, .textLayer');
        if (!textLayer) {
            return result(false, null, `Text was not found on page ${pageNumber}.`);
        }
        const match = buildRangeFromPageText(pageContainer, {
            text: requestedText,
            occurrence,
            caseSensitive: target.caseSensitive !== false,
            ...(target.wholeWord === undefined ? {} : {wholeWord: target.wholeWord}),
        });
        if (!match) {
            return result(false, null, `Text was not found on page ${pageNumber}.`);
        }
        const outcome = await createSelectionMarkup({
            range: match.range,
            tool: requestedTool,
            subtype,
            style: requestedStyle,
            withNote: target.withNote === true,
            requireActiveTool: false,
        });
        if (outcome.status === 'cancelled') {
            return result(false, match.matchedText, 'The document changed before the text markup was created.');
        }
        if (outcome.status === 'failed') {
            return result(
                false,
                match.matchedText,
                'The selected text could not be resolved.',
                outcome.reason,
            );
        }
        return result(true, match.matchedText);
    }
    function buildAnnotationContextMenuPayload(
        comment: IAnnotationCommentSummary | null,
        clientX: number,
        clientY: number,
    ): IAnnotationContextMenuPayload {
        const selectionRange = textSelectionCache.getSelectionRangeForCommentAction();
        const target = pagePointResolver.resolvePagePointTarget(clientX, clientY);
        return {
            comment,
            clientX,
            clientY,
            hasSelection: Boolean(selectionRange),
            selectionText: selectionRange?.toString() ?? '',
            pageNumber: target?.pageNumber === undefined
                ? null
                : requirePageNumber(target.pageNumber),
            pageX: target?.pageX ?? null,
            pageY: target?.pageY ?? null,
        };
    }
    const highlight = {
        highlightSelection,
        commentSelection,
        createTextMarkupFromText,
        commentAtPoint,
        maybeApplySelectionMarkup,
        buildAnnotationContextMenuPayload,
        resolvePagePointTarget: pagePointResolver.resolvePagePointTarget,
        findPageContainerFromClientPoint: pagePointResolver.findPageContainerFromClientPoint,
        clearSelectionCache: textSelectionCache.clearSelectionCache,
        highlightSelectionInternal,
    };
    const disposeSelectionInteraction = createAnnotationSelectionInteractionController({
        viewerContainer: options.viewerContainer,
        isActive: options.isActive,
        annotationTool: options.annotationTool,
        selectionCache: textSelectionCache,
        selectionLifecycle,
        applySelectionMarkup: maybeApplySelectionMarkup,
    });
    documentSession.registerDisposable(disposeSelectionInteraction);
    function summaryFromTarget(target: EventTarget | null) {
        if (!(target instanceof Element)) {
            return null;
        }
        const id = target.closest<HTMLElement>('[data-annotation-id]')?.dataset.annotationId;
        if (!id) {
            return null;
        }
        return annotationProjection.value.find(comment => comment.appAnnotationId === id)
            ?? annotationApplication.value.listCommentSummaries().find(comment => comment.appAnnotationId === id)
            ?? null;
    }
    function setActiveSummary(comment: IAnnotationCommentSummary | null) {
        activeCommentStableKey.value = comment?.stableKey ?? null;
    }
    const crud = {
        findEditorForComment: (_comment: IAnnotationCommentSummary) => null,
        findEditorByAnnotationElementId: (_pageIndex: number, _annotationId: string) => null,
        focusAnnotationComment: async (comment: IAnnotationCommentSummary) => {
            const id = annotationApplication.value.annotationIdForSummary(comment);
            if (id) {
                annotationEditorSurface.select([id]);
            }
            setActiveSummary(comment);
            viewport.singlePageScroll.scrollToPage(
                requirePageNumber(comment.pageNumber),
                {markerRect: comment.markerRect},
            );
            await nextTick();
        },
        updateAnnotationComment: (comment: IAnnotationCommentSummary, text: string) => {
            const id = annotationApplication.value.annotationIdForSummary(comment);
            const entity = id ? annotationApplication.value.store.get(id) : null;
            if (!id || !entity) {
                return false;
            }
            const normalizedText = normalizeAnnotationText(text);
            if (entity.kind === 'text-box') {
                return Boolean(annotationApplication.value.store.updateTextBox(id, {text: normalizedText}));
            }
            if (entity.kind === 'note') {
                return Boolean(annotationApplication.value.store.updateNote(id, {contents: normalizedText}));
            }
            if (entity.kind === 'text-markup') {
                return Boolean(annotationApplication.value.store.updateTextMarkup(id, {contents: normalizedText}));
            }
            return false;
        },
        deleteAnnotationComment: async (comment: IAnnotationCommentSummary) => {
            await Promise.resolve();
            const id = annotationApplication.value.annotationIdForSummary(comment);
            if (!id || !annotationApplication.value.store.get(id)) {
                return false;
            }
            annotationApplication.value.store.delete(id);
            options.emitAnnotationModified();
            return true;
        },
        handleAnnotationCommentClick: async (event: MouseEvent) => {
            await Promise.resolve();
            const comment = summaryFromTarget(event.target);
            if (!comment) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            setActiveSummary(comment);
            options.emitAnnotationCommentClick(comment);
        },
        handleAnnotationEditorDblClick: (event: MouseEvent) => {
            const comment = summaryFromTarget(event.target);
            if (!comment) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            setActiveSummary(comment);
            if (comment.subtype === 'Text' || comment.hasNote === true) {
                emitAnnotationOpenNoteWithReconciliation(comment);
            } else {
                options.emitAnnotationCommentClick(comment);
            }
        },
        handleAnnotationCommentContextMenu: (event: MouseEvent) => {
            const comment = summaryFromTarget(event.target);
            event.preventDefault();
            event.stopPropagation();
            setActiveSummary(comment);
            options.emitAnnotationContextMenu(buildAnnotationContextMenuPayload(comment, event.clientX, event.clientY));
        },
        findEditorFromTarget: (_target: EventTarget | null) => null,
        findEditorSummaryFromTarget: summaryFromTarget,
        findAnnotationSummaryFromTarget: summaryFromTarget,
        findAnnotationSummaryFromPoint: (_target: EventTarget | null, clientX: number, clientY: number) => {
            const element = document.elementFromPoint(clientX, clientY);
            return summaryFromTarget(element);
        },
        ensureEditorInteractionModeFromTarget: async () => {},
        resolveCommentFromIndicatorClickTarget: (target: EventTarget | null) => summaryFromTarget(target),
        clearSelection: annotationEditorSurface.clearSelection,
    };
    const annotations = {
        editor,
        commentSync,
        linksByPage,
        highlight,
        crud,
    };
    appAnnotationHistory.setReplayEffect(() => {
        annotations.commentSync.discardInFlightSync();
        annotations.commentSync.scheduleAnnotationCommentsSync();
    });
    onScopeDispose(() => {
        appAnnotationHistory.setReplayEffect(null);
    });
    const highlightComposable = annotations.highlight;
    const commentCrud = annotations.crud;
    const annotationColorCommands = usePdfAnnotationColorCommands({
        annotationApplication,
        annotationCommentModel,
        emitForcedAnnotationMutation,
    });
    const {
        focusAnnotationComment,
        deleteAnnotationComment,
    } = usePdfAnnotationCommentActions({
        viewerContainer: options.viewerContainer,
        numPages: documentSession.numPages,
        activeCommentStableKey,
        annotationCommentsCache,
        annotationCommentModel,
        shapeTool,
        shapeComposable,
        selectedShapeCommands,
        commentCrud,
        scrollToPage: (pageNumber, scrollOptions) => viewport.singlePageScroll.scrollToPage(pageNumber, scrollOptions),
        updateVisibleRange: viewport.scroll.updateVisibleRange,
        renderVisiblePages: rendering.renderVisiblePages,
        emitForcedAnnotationMutation,
    });
    function removeAnnotationFromDom(comment: IAnnotationCommentSummary) {
        if (comment.pageNumber > 0) {
            rendering.invalidatePages([comment.pageNumber]);
        }
    }
    const annotationMutationService = useAnnotationMutationService({
        runHistoryTransaction: action => appAnnotationHistory.runTransaction(action),
        updateAnnotationComment: commentCrud.updateAnnotationComment,
        deleteAnnotationComment,
        updateSelectedTextMarkupAnnotationColor: annotationColorCommands.updateSelectedTextMarkupAnnotationColor,
        updateSelectedTextMarkupAnnotationProperties: editor.markupSubtype.updateSelectedTextMarkupAnnotationProperties,
        updateTextMarkupAnnotationColor: annotationColorCommands.updateTextMarkupAnnotationColor,
        markAnnotationLocallyDeleted: annotationCommentModel.markLocallyDeleted,
        restoreAnnotationLocally: annotationCommentModel.restoreLocally,
        removeAnnotationFromInternalCache: annotationCommentModel.removeFromInternalCache,
        clearPendingMarkerMoves: annotationCommentModel.clearPendingMarkerMoves,
        handleMarkerMove: annotationCommentModel.handleMarkerMove,
        findEditorForComment: commentCrud.findEditorForComment,
        markModified: emitForcedAnnotationMutation,
        flushAnnotationCommentsForSave: annotations.commentSync.flushEditorCommentsForSave,
        resolveCanonicalAnnotationId: comment => annotationApplication.value.annotationIdForSummary(comment),
        setCanonicalNoteText: (id, text) => {
            const entity = annotationApplication.value.store.get(id);
            if (!entity || entity.kind === 'shape' || entity.kind === 'placed-image') {
                return;
            }
            const normalizedText = normalizeAnnotationText(text);
            if (entity.kind === 'text-box' && entity.text !== normalizedText) {
                annotationApplication.value.store.updateTextBox(id, {text: normalizedText});
            } else if (entity.kind === 'note' && entity.contents !== normalizedText) {
                annotationApplication.value.store.updateNote(id, {contents: normalizedText});
            } else if (entity.kind === 'text-markup' && entity.contents !== normalizedText) {
                annotationApplication.value.store.updateTextMarkup(id, {contents: normalizedText});
            }
        },
        deleteCanonicalAnnotation: id => {
            if (!annotationApplication.value.store.get(id)?.deleted) {
                annotationApplication.value.store.delete(id);
            }
        },
        moveCanonicalAnchor: (id, rect) => {
            const entity = annotationApplication.value.store.get(id);
            if (!entity || (entity.kind !== 'note' && entity.kind !== 'text-box')) {
                return;
            }
            const previous = entity.kind === 'note' ? entity.position : entity.rect;
            if (
                previous.left === rect.left
                && previous.top === rect.top
                && previous.width === rect.width
                && previous.height === rect.height
            ) {
                return;
            }
            if (entity.kind === 'note') {
                annotationApplication.value.store.updateNote(id, {position: rect});
            } else {
                annotationApplication.value.store.updateTextBox(id, {rect});
            }
        },
    });
    function handleSourceChanged(next: TPdfSource | null, previous: TPdfSource | null) {
        annotationCommentModel.handleSourceChanged(
            next,
            previous,
            { syncAnnotationComments: annotations.commentSync.syncAnnotationComments },
        );
    }
    const canvasHiddenAnnotationIds = computed(() => new Set(hiddenPdfAnnotationIds.value));
    const annotationProjectionReady = ref(!(options.workingCopyPath.value && options.documentRevisionToken.value && documentSession.pdfDocument.value));
    const detachProjection = rendering.attachAnnotationProjection({
        hiddenAnnotationIds: hiddenPdfAnnotationIds,
        annotationProjectionReady,
        canvasHiddenAnnotationIds,
        pageCommitted: () => undefined,
    });
    const stopStoreOwnershipRefreshWatch = createPdfAnnotationOwnershipRefreshWatch({
        documentSession,
        viewport,
        rendering,
        storeOwnedPdfAnnotationIds: hiddenPdfAnnotationIds,
        annotationProjectionReady,
        nextTick,
    });
    const scheduleSetAnnotationTool = (_tool: TAnnotationTool, _reason: string) => {};
    function clearAnnotationProjectionState() {
        annotationCommentModel.clearProjection();
        activeCommentStableKey.value = null;
        options.emitAnnotationComments([]);
        options.emitAnnotationInventory(null);
    }
    let writerParseRequest = 0;
    let writerParseAbortController: AbortController | null = null;
    function cancelWriterParse() {
        writerParseRequest += 1;
        writerParseAbortController?.abort();
        writerParseAbortController = null;
    }
    async function feedStoreFromWriterParse(
        transition: Pick<IPdfDocumentTransition, 'fence' | 'isCurrent'>,
    ) {
        writerParseAbortController?.abort();
        const request = ++writerParseRequest;
        const abortController = new AbortController();
        writerParseAbortController = abortController;
        // Both exits from this function settle through here so they cannot
        // drift apart: a superseded parse must not unblock consumers, and the
        // document may have swapped during any await above.
        function settleProjection() {
            if (writerParseAbortController !== abortController) {
                return;
            }
            writerParseAbortController = null;
            if (request === writerParseRequest && transition.isCurrent()) {
                annotationProjectionReady.value = true;
            }
        }
        const parsePath = parseDocumentRef(options.workingCopyPath.value)
            ?? parseDocumentRef(options.originalPath.value)
            ?? (options.src.value instanceof Blob ? null : parseDocumentRef(options.src.value?.path ?? null));
        const expectedRevisionToken = options.documentRevisionToken.value
            ?? (parsePath
                ? await getDocumentFilesCapability().getDocumentRevision(parsePath)
                    .then(revision => revision.token)
                    .catch(() => null)
                : null);
        const isProvisionalRevisionFence = transition.fence.documentRevision?.startsWith('load:') ?? false;
        if (
            !parsePath
            || !expectedRevisionToken
            || !documentSession.pdfDocument.value
            || (
                transition.fence.documentRevision !== expectedRevisionToken
                && !isProvisionalRevisionFence
            )
        ) {
            settleProjection();
            return;
        }
        const targetStore = annotationApplication.value.store;
        const targetStoreMutationEpoch = targetStore.mutationEpoch;
        try {
            const result = await getDocumentWorkingCopyCapability().parsePdfAnnotations(
                parsePath,
                {
                    expectedDocumentRevisionToken: expectedRevisionToken,
                    signal: abortController.signal,
                },
            );
            const committed = commitPdfAnnotationParseToStore({
                result,
                request,
                currentRequest: writerParseRequest,
                isTransitionCurrent: () => transition.isCurrent(),
                targetStore,
                currentStore: annotationApplication.value.store,
                targetStoreMutationEpoch,
                workingCopyPath: parsePath,
                currentWorkingCopyPath: parsePath,
                expectedRevisionToken,
                currentRevisionToken: options.documentRevisionToken.value ?? expectedRevisionToken,
            });
            if (!committed) {
                return;
            }
            const parsedMarkupGeometryByPdfRef = new Map<string, ITextMarkupEntity['quadPoints']>();
            result.entities.forEach((entry) => {
                if (entry.kind !== 'highlight') {
                    return;
                }
                parsedMarkupGeometryByPdfRef.set(
                    pdfAnnotationRefKey(entry.objectNumber, entry.generationNumber),
                    entry.quadPoints.map(rect => ({...rect})),
                );
            });
            void deriveSelectedTextForParsedHighlights({
                documentSession,
                result,
                transition,
                signal: abortController.signal,
            }).then((selectedTextByPdfRef) => {
                if (
                    !selectedTextByPdfRef
                    || abortController.signal.aborted
                    || request !== writerParseRequest
                    || !transition.isCurrent()
                    || annotationApplication.value.store !== targetStore
                ) {
                    return;
                }
                applyParsedHighlightTextToStore({
                    targetStore,
                    selectedTextByPdfRef,
                    parsedMarkupGeometryByPdfRef,
                });
            }).catch((error) => {
                if (!abortController.signal.aborted) {
                    BrowserLogger.debug('annotations', 'Failed to enrich imported writer highlights', error);
                }
            });
        } catch (error) {
            if (!abortController.signal.aborted) {
                BrowserLogger.warn('annotations', 'Failed to import writer PDF annotations', error);
            }
        } finally {
            settleProjection();
        }
    }
    const unsubscribeDocumentTransitions = documentSession.subscribe(async (transition) => {
        if (!transition.isCurrent()) {
            return;
        }
        if (transition.phase === 'invalidated') {
            cancelWriterParse();
            annotationProjectionReady.value = true;
            annotations.commentSync.incrementSyncToken();
            annotations.highlight.clearSelectionCache();
            if (transition.reason === 'source-cleared' || transition.reason === 'empty-source') {
                clearAnnotationProjectionState();
            }
            return;
        }
        if (transition.phase === 'ready') {
            annotationProjectionReady.value = false;
            await feedStoreFromWriterParse(transition);
            return;
        }
        if (transition.phase === 'restore') {
            scheduleSetAnnotationTool(options.annotationTool.value, 'restore annotation tool after tab activation');
            annotations.editor.applyAnnotationSettings(options.annotationSettings.value);
            return;
        }
        if (transition.phase === 'settled') {
            annotations.commentSync.scheduleAnnotationCommentsSync();
        }
    });
    watch(() => [
        options.src.value,
        options.workingCopyPath.value,
    ] as const, ([next], [previous]) => {
        if (next === previous) {
            return;
        }
        options.clearPendingImagePlacement();
        handleSourceChanged(next, previous);
    });
    watch(() => [
        options.workingCopyPath.value,
        options.documentRevisionToken.value,
        documentSession.pdfDocument.value,
    ] as const, (next, previous) => {
        if (next.some((value, index) => value !== previous[index])) {
            annotationProjectionReady.value = false;
            cancelWriterParse();
        }
    }, {flush: 'sync'});
    watch(() => [
        options.workingCopyPath.value,
        options.originalPath.value,
        options.src.value,
        options.documentRevisionToken.value,
        documentSession.pdfDocument.value,
    ] as const, () => {
        if (!documentSession.pdfDocument.value) {
            return;
        }
        const fence = documentSession.captureFence();
        void feedStoreFromWriterParse({
            fence,
            isCurrent: () => documentSession.isCurrent(fence),
        });
    }, {
        flush: 'post',
        immediate: true,
    });
    documentSession.registerDisposable(() => {
        cancelWriterParse();
        unsubscribeDocumentTransitions();
        stopStoreOwnershipRefreshWatch();
        detachProjection();
        annotations.highlight.clearSelectionCache();
        clearAnnotationProjectionState();
    });
    const saveTransaction = usePdfViewerSaveTransaction({
        pdfDocument: documentSession.pdfDocument,
        annotationApplication,
        documentRevisionToken: options.documentRevisionToken,
        documentSession,
        flushAnnotationMutationsForSave: annotationMutationService.flushForSave,
        commitPendingEditorDraftsForSave: annotations.editor.commitPendingFreeTextDraftsForSave,
        getMarkupSubtypeOverrides: annotations.editor.getMarkupSubtypeOverrides,
        getMarkupSubtypeHints: annotations.editor.getMarkupSubtypeHints,
        getAllShapes: shapeComposable.getAllShapes,
        getDeletedEmbeddedShapeAnnotationIds: shapeComposable.getDeletedEmbeddedAnnotationIds,
        getDeletedEmbeddedShapeStableKeys: shapeComposable.getDeletedEmbeddedShapeStableKeys,
    });
    return {
        annotations,
        annotationMutationService,
        annotationApplication,
        captureCanonicalAnnotationRecovery: (additionalDrafts: readonly IAnnotationRecoveryDraft[] = []): ICanonicalAnnotationRecovery => {
            const drafts = Array.from(
                textBoxDrafts,
                ([
                    annotationId,
                    text,
                ]) => {
                    const entity = annotationApplication.value.store.get(asAnnotationId(annotationId));
                    return entity?.kind === 'text-box'
                        ? {
                            annotationId: entity.identity.id,
                            kind: 'text-box' as const,
                            canonicalRevision: entity.revision,
                            text,
                            generation: textBoxDraftGenerations.get(annotationId) ?? 0,
                        }
                        : null;
                },
            ).filter((draft): draft is NonNullable<typeof draft> => draft !== null);
            return captureCanonicalAnnotationRecovery(
                annotationApplication.value.store,
                [
                    ...drafts,
                    ...additionalDrafts,
                ],
            );
        },
        restoreCanonicalAnnotationRecovery: (value: unknown) => {
            const recovery = restoreCanonicalAnnotationRecovery(annotationApplication.value.store, value);
            textBoxDrafts.clear();
            textBoxDraftGenerations.clear();
            recovery.drafts.filter(draft => draft.kind === 'text-box').forEach((draft) => {
                textBoxDrafts.set(draft.annotationId, draft.text);
                textBoxDraftGenerations.set(draft.annotationId, draft.generation);
            });
            projectCanonicalAnnotations();
            return recovery;
        },
        hasCanonicalAnnotationChanges: () => {
            // Keep the framework dependency on the canonical projection.
            void annotationProjection.value;
            return annotationApplication.value.store.hasChangesSinceSavedBaseline()
                || annotationEditorSurface.hasPendingTextBoxDrafts();
        },
        hasCanonicalShapeChanges: () => {
            // Keep the framework dependency on the canonical projection.
            void annotationProjection.value;
            return annotationApplication.value.store.hasChangesSinceSavedBaseline('shape');
        },
        getDeletedCanonicalAnnotationIds: () => Array.from(new Set([
            ...retiredPdfAnnotationIds.value,
            ...annotationApplication.value.store.deletedAnnotationIds(),
            ...annotationApplication.value.store
                .list({includeDeleted: true})
                .filter(entity => entity.deleted)
                .flatMap(entity => [
                    entity.identity.id,
                    entity.identity.pdfRef,
                ].filter((value): value is string => Boolean(value))),
        ])),
        getDeletedPersistedCanonicalAnnotationCount: () => annotationApplication.value.store
            .countDirtyPersistedDeletions(),
        annotationCommentModel,
        clearAnnotationProjection: annotationCommentModel.clearProjection,
        annotationCommentsCache,
        activeCommentStableKey,
        annotationColorCommands,
        focusAnnotationComment,
        deleteAnnotationComment,
        shapeTool,
        shapeComposable,
        selectedShapeCommands,
        removeAnnotationFromDom,
        annotationSettings: options.annotationSettings,
        adoptPersistedManagedShapesOnNextImport: () => undefined,
        clearPendingManagedShapeImportAdoption: () => undefined,
        highlightComposable,
        commentCrud,
        linksByPage: annotations.linksByPage,
        annotationEditorSurface,
        registerShapeHistoryCommand,
        handleSourceChanged,
        appAnnotationHistory,
        canvasHiddenAnnotationIds,
        scheduleSetAnnotationTool,
        ...saveTransaction,
        finalizeImagePlacement: async (payload: IPdfPlacedImageFinalizePayload) => {
            const application = annotationApplication.value;
            const fence = documentSession.captureFence();
            const documentIdentity = annotationDocumentIdentity.value;
            if (options.isAnySaving.value || payload.signal?.aborted) {
                return false;
            }
            const pageNumber = requirePageNumber(payload.pageNumber, documentSession.numPages.value);
            const pageIndex = pageNumberToPageIndex(pageNumber);
            const viewRotation = payload.viewRotation;
            const metric = documentSession.pageMetrics.value[pageIndex];
            if (!metric) {
                return false;
            }
            const id = payload.appAnnotationId ? asAnnotationId(payload.appAnnotationId) : null;
            const previous = id ? application.store.get(id) : null;
            if (id && (!previous || previous.deleted || previous.kind !== 'placed-image' || previous.pageIndex !== pageIndex)) {
                return false;
            }
            try {
                const image = await preparePdfAnnotationRaster(payload);
                if (payload.signal?.aborted || options.isAnySaving.value
                    || annotationApplication.value !== application
                    || annotationDocumentIdentity.value !== documentIdentity
                    || !documentSession.isCurrent(fence)
                    || (id && application.store.get(id)?.revision !== previous?.revision)) {
                    return false;
                }
                const rect = unrotateAnnotationPlacementRect({
                    left: payload.x,
                    top: payload.y,
                    width: payload.width,
                    height: payload.height,
                }, viewRotation, metric);
                const rotation = ((payload.rotationDegrees - viewRotation) % 360 + 360) % 360;
                annotationEditorSurface.commitPendingTextBoxDraftsForSave();
                const created = id
                    ? application.store.updatePlacedImage(id, {
                        rect,
                        rotation,
                        image,
                    })
                    : annotationEditorSurface.createStampAt(pageIndex, rect, image, {rotation});
                annotationEditorSurface.select([created.identity.id]);
                options.emitAnnotationToolAutoReset();
                return true;
            } catch (error) {
                if (!payload.signal?.aborted) {
                    BrowserLogger.warn('annotations', 'Failed to create image annotation', error);
                }
                return false;
            }
        },
    };
};

export type TPdfAnnotationSession = ReturnType<typeof createPdfAnnotationSession>;
