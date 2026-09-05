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
import { runGuardedTask } from '@app/utils/asyncGuard';
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
import type {
    IPdfDocumentTransition,
    TPdfDocumentSession,
} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import {commitPdfAnnotationParseToStore} from '@app/modules/pdf-viewer/runtime/sessions/commitPdfAnnotationParseToStore';
import type { TPdfViewportSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import type { TPdfRenderingSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfRenderingSession';
import type { IAnnotationContextMenuPayload } from '@app/modules/pdf-viewer/engine/annotationContextMenuPayload';
import type {
    IAnnotationCreationFailureReport,
    TAnnotationCreationFailureReason,
    TAnnotationCreationOutcome,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationCreationOutcome.types';
import {
    mintAnnotationId,
    normalizeAnnotationText,
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
import { useAnnotationTextSelectionCache } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationTextSelectionCache';
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
import { resolvePdfAnnotationSelectionGeometry } from '@app/modules/pdf-viewer/runtime/sessions/resolvePdfAnnotationSelectionGeometry';
import { deriveSelectedTextForParsedHighlights } from '@app/modules/pdf-viewer/runtime/sessions/deriveSelectedTextForParsedHighlights';
import { findPdfPageContainer } from '@app/modules/pdf-viewer/dom/pdf-viewer-dom/findPdfPageContainer';
import { subtypeForAnnotationTool } from '@app/modules/pdf-viewer/runtime/sessions/subtypeForAnnotationTool';
import type {
    ICreateTextMarkupFromTextOptions,
    ICreateTextMarkupFromTextResult,
} from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerExpose.types';
import type {IPdfPlacedImageFinalizePayload} from '@app/types/pdfImagePlacement';
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
    emitAnnotationSetting: (payload: TAnnotationSettingChange) => void;
    emitAnnotationCommentClick: (comment: IAnnotationCommentSummary) => void;
    reportAnnotationFailure?: (failure: IAnnotationCreationFailureReport) => void;
    emitShapeContextMenu: Parameters<typeof usePdfShapeTool>[0]['emitShapeContextMenu'];
    // Temporary command seam. #193 removes the legacy workspace persistence
    // route once the writer owns stamp byte storage end to end.
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
    finalizeImagePlacement?: ((payload: IPdfPlacedImageFinalizePayload) => void | Promise<boolean>) | undefined;
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

function buildRangeFromPageText(
    pageContainer: HTMLElement,
    options: {
        text: string;
        occurrence?: number;
        caseSensitive?: boolean;
        wholeWord?: boolean
    },
) {
    const spans = Array.from(pageContainer.querySelectorAll<HTMLElement>('.text-layer span, .textLayer span'))
        .filter(span => !span.parentElement?.closest('span'));
    const positions: Array<{
        node: Text;
        offset: number
    }> = [];
    let text = '';
    spans.forEach((span, spanIndex) => {
        if (spanIndex > 0 && text && !text.endsWith(' ')) {
            text += ' ';
            positions.push({
                node: span.firstChild as Text,
                offset: 0,
            });
        }
        const node = span.firstChild;
        if (!(node instanceof Text)) {
            return;
        }
        Array.from(node.data).forEach((character, offset) => {
            if (/\s/u.test(character)) {
                if (!text.endsWith(' ')) {
                    text += ' ';
                    positions.push({
                        node,
                        offset,
                    });
                }
                return;
            }
            text += character;
            positions.push({
                node,
                offset,
            });
        });
    });
    while (text.endsWith(' ')) {
        text = text.slice(0, -1);
        positions.pop();
    }
    const query = options.text.trim().replace(/\s+/gu, ' ');
    const haystack = options.caseSensitive === true ? text : text.toLocaleLowerCase();
    const needle = options.caseSensitive === true ? query : query.toLocaleLowerCase();
    let cursor = 0;
    let found = 0;
    while (cursor <= haystack.length) {
        const startOffset = haystack.indexOf(needle, cursor);
        if (startOffset < 0) {
            return null;
        }
        const endOffset = startOffset + needle.length;
        const before = haystack[startOffset - 1] ?? '';
        const after = haystack[endOffset] ?? '';
        if (!options.wholeWord || (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after))) {
            found += 1;
            if (found === Math.max(1, Math.trunc(options.occurrence ?? 1))) {
                const start = positions[startOffset];
                const end = positions[endOffset - 1];
                if (!start || !end) {
                    return null;
                }
                const range = document.createRange();
                range.setStart(start.node, start.offset);
                range.setEnd(end.node, end.offset + 1);
                return {
                    range,
                    matchedText: text.slice(startOffset, endOffset),
                };
            }
        }
        cursor = startOffset + Math.max(1, needle.length);
    }
    return null;
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
    const annotationCommentModel = usePdfAnnotationCommentModel({
        isAnySaving: options.isAnySaving,
        annotationProjection,
        ingestSummaries: () => undefined,
        getShapeAnnotationCommentSummaries: shapeTool.getShapeAnnotationCommentSummaries,
        emitAnnotationComments: options.emitAnnotationComments,
    });
    const {
        annotationCommentsCache,
        activeCommentStableKey,
    } = annotationCommentModel;
    function projectCanonicalAnnotations() {
        const nextStoreOwnedPdfAnnotationIds = new Set(
            annotationApplication.value.store
                .list({includeDeleted: true})
                .map(entity => normalizePdfJsAnnotationId(entity.identity.pdfRef))
                .filter((id): id is string => Boolean(id)),
        );
        if (!sameStringSet(storeOwnedPdfAnnotationIds.value, nextStoreOwnedPdfAnnotationIds)) {
            storeOwnedPdfAnnotationIds.value = nextStoreOwnedPdfAnnotationIds;
        }
        const projected = annotationApplication.value.listCommentSummaries();
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
        if (!replacesLoadedDocument || options.isAnySaving.value) {
            return;
        }
        appAnnotationHistory.clear();
        resetAnnotationApplication(annotationDocumentIdentity.value);
    });
    onScopeDispose(() => stopAnnotationApplicationProjection());

    const linkAnnotations = ref<ILinkAnnotation[]>([]);
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
    const {
        editor,
        selectionMarkupStyle,
    } = createPdfAnnotationEditorCompatibility({
        annotationApplication,
        annotationSettings: options.annotationSettings,
        canonicalMarkupSubtypeHints,
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
        activeTool: options.annotationTool,
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
            return {
                pageView: [
                    0,
                    0,
                    metric.width,
                    metric.height,
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
    provide(annotationEditorSurfaceKey, annotationEditorSurface);
    async function createSelectionMarkup(
        range: Range,
        withNote: boolean,
        requestedSubtype?: TMarkupSubtype,
    ): Promise<TAnnotationCreationOutcome> {
        const geometry = await resolvePdfAnnotationSelectionGeometry({
            documentSession,
            viewerContainer: options.viewerContainer.value,
            range,
        });
        if (geometry.status === 'stale') {
            return {status: 'cancelled'};
        }
        if (geometry.status === 'failed') {
            return {
                status: 'failed',
                reason: geometry.reason,
            };
        }
        const subtype = requestedSubtype ?? subtypeForAnnotationTool(options.annotationTool.value);
        const style = selectionMarkupStyle(subtype);
        const created = appAnnotationHistory.runTransaction(() => geometry.pages.map(page => (
            annotationEditorSurface.createHighlightFromSelection(
                page.pageNumber - 1,
                page.quadPoints,
                {
                    subtype,
                    color: style.color,
                    opacity: style.opacity,
                    selectedText: page.selectedText,
                },
            )
        )));
        const createdIds = created.map(entity => entity.identity.id);
        annotationEditorSurface.select(createdIds);
        options.emitAnnotationModified();
        const firstCreated = created[0];
        if (withNote) {
            if (firstCreated) {
                const comment = findCanonicalAnnotationComment(annotationApplication.value, firstCreated.identity.id);
                emitAnnotationOpenNoteWithReconciliation(comment);
            }
        }
        return firstCreated
            ? {
                status: 'created',
                annotationId: firstCreated.identity.id,
            }
            : {
                status: 'failed',
                reason: 'selection-not-in-text-layer',
            };
    }
    const failCommentAtPoint = createAnnotationCreationFailureReporter(options.reportAnnotationFailure);
    async function commentAtPoint(
        pageNumber: number,
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
            Math.max(0, Math.trunc(pageNumber) - 1),
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
        await Promise.resolve();
        const range = explicitRange ?? textSelectionCache.getSelectionRangeForCommentAction();
        if (!range) {
            return {
                status: 'failed',
                reason: 'no-selection',
            } as const;
        }
        return createSelectionMarkup(range, withNote);
    }
    async function highlightSelection() {
        return (await highlightSelectionInternal()).status === 'created';
    }
    async function commentSelection() {
        return (await highlightSelectionInternal(true)).status === 'created';
    }
    async function maybeApplySelectionMarkup(explicitRange: Range | null = null) {
        if (!isSelectionMarkupTool(options.annotationTool.value)) {
            return false;
        }
        return (await highlightSelectionInternal(false, explicitRange)).status === 'created';
    }
    async function createTextMarkupFromText(
        target: ICreateTextMarkupFromTextOptions,
    ): Promise<ICreateTextMarkupFromTextResult> {
        await Promise.resolve();
        const pageNumber = Number.isFinite(target.pageNumber)
            ? Math.max(1, Math.trunc(target.pageNumber))
            : viewport.currentPage.value;
        const requestedText = target.text.trim();
        const occurrence = typeof target.occurrence === 'number' && Number.isFinite(target.occurrence)
            ? Math.max(1, Math.trunc(target.occurrence))
            : 1;
        const subtype: ICreateTextMarkupFromTextResult['subtype'] = target.markup === 'underline'
            ? 'Underline'
            : target.markup === 'strikethrough'
                ? 'StrikeOut'
                : target.markup === 'squiggly'
                    ? 'Squiggly'
                    : 'Highlight';
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
        const outcome = await createSelectionMarkup(match.range, target.withNote === true, subtype);
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
            pageNumber: target?.pageNumber ?? null,
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
    function handleDocumentPointerUp(event: PointerEvent) {
        if (event.button !== 0 || !options.isActive.value || !isSelectionMarkupTool(options.annotationTool.value)) {
            return;
        }
        const viewerContainer = options.viewerContainer.value;
        if (!viewerContainer || !(event.target instanceof Node) || !viewerContainer.contains(event.target)) {
            return;
        }
        const selection = document.getSelection();
        const range = selection && selection.rangeCount > 0
            ? selection.getRangeAt(0).cloneRange()
            : null;
        if (!range || range.collapsed) {
            return;
        }
        runGuardedTask(
            () => maybeApplySelectionMarkup(range),
            {
                category: 'user-visible-operation',
                scope: 'annotations',
                message: 'Failed to apply selection markup on pointer up',
            },
        );
    }
    if (typeof document !== 'undefined') {
        const handleSelectionChange = () => {
            if (options.isActive.value) {
                textSelectionCache.cacheCurrentTextSelection();
            }
        };
        document.addEventListener('selectionchange', handleSelectionChange, {passive: true});
        document.addEventListener('pointerup', handleDocumentPointerUp, {passive: true});
        documentSession.registerDisposable(() => {
            document.removeEventListener('selectionchange', handleSelectionChange);
            document.removeEventListener('pointerup', handleDocumentPointerUp);
        });
    }
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
            viewport.singlePageScroll.scrollToPage(comment.pageNumber, {markerRect: comment.markerRect});
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
    const canvasHiddenAnnotationIds = computed(() => new Set(storeOwnedPdfAnnotationIds.value));
    const annotationProjectionReady = ref(!(options.workingCopyPath.value && options.documentRevisionToken.value && documentSession.pdfDocument.value));
    const detachProjection = rendering.attachAnnotationProjection({
        hiddenAnnotationIds: storeOwnedPdfAnnotationIds,
        annotationProjectionReady,
        canvasHiddenAnnotationIds,
        pageCommitted: () => undefined,
    });
    const stopStoreOwnershipRefreshWatch = createPdfAnnotationOwnershipRefreshWatch({
        documentSession,
        viewport,
        rendering,
        storeOwnedPdfAnnotationIds,
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
        const parsePath = options.workingCopyPath.value ?? options.originalPath.value ?? (options.src.value instanceof Blob ? null : options.src.value?.path ?? null);
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
            annotationProjectionReady.value = true;
            return;
        }
        writerParseAbortController?.abort();
        const request = ++writerParseRequest;
        const abortController = new AbortController();
        writerParseAbortController = abortController;
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
                selectedTextByPdfRef.forEach((selectedText, pdfRef) => {
                    const id = targetStore.resolveExternal({pdfRef});
                    if (id) {
                        targetStore.updateTextMarkupSelectedText(id, selectedText);
                    }
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
            if (writerParseAbortController === abortController) {
                writerParseAbortController = null;
                if (request === writerParseRequest && transition.isCurrent()) {
                    annotationProjectionReady.value = true;
                }
            }
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
    });
    return {
        annotations,
        annotationMutationService,
        annotationApplication,
        hasCanonicalAnnotationChanges: () => {
            // Keep the framework dependency on the canonical projection.
            void annotationProjection.value;
            return annotationApplication.value.store.hasChangesSinceSavedBaseline();
        },
        hasCanonicalShapeChanges: () => {
            // Keep the framework dependency on the canonical projection.
            void annotationProjection.value;
            return annotationApplication.value.store.hasChangesSinceSavedBaseline('shape');
        },
        getDeletedCanonicalAnnotationIds: () => Array.from(new Set(
            annotationApplication.value.store
                .list({includeDeleted: true})
                .filter(entity => entity.deleted)
                .flatMap(entity => [
                    entity.identity.id,
                    entity.identity.pdfRef,
                ].filter((value): value is string => Boolean(value))),
        )),
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
            const finalizer = options.finalizeImagePlacement;
            if (!finalizer) {
                return false;
            }
            const canonicalPayload = payload.annotationId
                ? payload
                : {
                    ...payload,
                    stableKey: payload.stableKey ?? mintAnnotationId(),
                };
            return await finalizer(canonicalPayload) ?? true;
        },
    };
};

export type TPdfAnnotationSession = ReturnType<typeof createPdfAnnotationSession>;
