import {parseDocumentRef} from '@contracts/documentRef';
import type {TPdfDocumentView} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import {recordPdfDocumentOriginalAnnotations} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentLoadedRevision';
import type {IPdfAnnotationParseResult} from '@contracts/pdfAnnotationParseTypes';
import {
    applyParsedHighlightTextToStore, commitPdfAnnotationParseToStore,
} from '@app/modules/pdf-viewer/runtime/sessions/commitPdfAnnotationParseToStore';
import {deriveSelectedTextForParsedHighlights} from '@app/modules/pdf-viewer/runtime/sessions/deriveSelectedTextForParsedHighlights';
import {
    getDocumentFilesCapability, getDocumentWorkingCopyCapability,
} from '@app/utils/platformDocuments';
import {BrowserLogger} from '@app/utils/browserLogger';
import {useFailureToast} from '@app/composables/useFailureToast';
import {
    isBrowserFullReadTooLargeError,
    isBrowserWorkerResetError,
} from '@app/platform/browser-api/public';
import type {
    InjectionKey,
    Ref,
} from 'vue';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationMarkerRect,
    TAnnotationCommentsStatus,
} from '@app/types/annotations';
import type {AnnotationEntity} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {compareAnnotationCommentSummaries} from '@app/utils/pdfAnnotationComments';
import type { TPdfSource } from '@app/types/pdfUi';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import { createStaleRevisionError } from '@contracts/documentMutationErrors';
import { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import { AnnotationStore } from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import { usePdfAppAnnotationHistory } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAppAnnotationHistory';

// Pathless sources are keyed by Blob instance because their metadata can collide.
// The `blob-instance:` prefix avoids collisions with file paths.
const annotationBlobIdentities = new WeakMap<Blob, string>();
export function annotationDocumentKey(source: TPdfSource | null) {
    if (!source) return 'no-document';
    if (!(source instanceof Blob)) return `path:${source.path}`;
    const identity = annotationBlobIdentities.get(source) ?? `blob-instance:${crypto.randomUUID()}`;
    annotationBlobIdentities.set(source, identity);
    return identity;
}

/**
 * The store's one subscription: its last snapshot, tombstones included, and
 * the live entities grouped by page. It follows the application when the
 * document replaces its store.
 */
export function useAnnotationStoreSnapshot(application: Readonly<Ref<AnnotationApplication>>) {
    const snapshot = shallowRef<readonly AnnotationEntity[]>([]);
    let stop = () => {};
    watch(application, (next) => {
        stop();
        stop = next.store.subscribe((entities) => { snapshot.value = entities; });
    }, {
        immediate: true,
        flush: 'sync',
    });
    onScopeDispose(() => stop(), true);
    return {
        entities: computed(() => snapshot.value),
        entitiesByPage: computed<ReadonlyMap<number, readonly AnnotationEntity[]>>(() => {
            const grouped = new Map<number, AnnotationEntity[]>();
            snapshot.value.filter(entity => !entity.deleted).forEach((entity) => {
                const page = grouped.get(entity.pageIndex);
                if (page) page.push(entity);
                else grouped.set(entity.pageIndex, [entity]);
            });
            return grouped;
        }),
    };
}

/** What one viewer of the document takes part in: its PDF document, its emits and its text editor. */
export interface IPdfDocumentAnnotationsView {
    document: TPdfDocumentView;
    originalPath: Readonly<Ref<string | null>>;
    emitAnnotationState: (state: IAnnotationEditorState) => void;
    emitAnnotationModified: () => void;
    /** Commits text-box drafts open in this view's editor. */
    commitPendingDraftsForSave: () => void | Promise<void>;
    getPendingTextCompletion?: () => undefined | Promise<unknown>;
    isEditing: (annotationId: string) => boolean;
    /** Where this view's editor shows an open draft, or null when it holds none. */
    getTextBoxDraftRect: (annotationId: string) => IAnnotationMarkerRect | null;
}

export interface ICreatePdfDocumentAnnotationsOptions {
    workingCopyPath: Readonly<Ref<string | null>>;
    source: Readonly<Ref<TPdfSource | null>>;
    documentRevisionToken: Readonly<Ref<TDocumentRevisionToken | null>>;
    documentSession?: Readonly<Ref<unknown>>;
    /** A finished save reads the revision it wrote into a store it left partial. */
    isSaving?: Readonly<Ref<boolean>>;
}

/**
 * One PDF document's canonical annotations: the application store, its undo
 * history and text-box drafts. Every viewer of the document edits and renders
 * this one owner; each viewer keeps its own editor surface, tools and
 * selection. The workspace document creates it; a viewer
 * used on its own creates one for itself.
 */
export const createPdfDocumentAnnotations = (options: ICreatePdfDocumentAnnotationsOptions) => {
    const {t} = useTypedI18n();
    const {presentNoticeToast} = useFailureToast();
    const views = new Set<IPdfDocumentAnnotationsView>();
    const history = usePdfAppAnnotationHistory({
        emitAnnotationState: (state) => {
            views.forEach(view => view.emitAnnotationState(state));
        },
        markModified: () => {
            views.forEach(view => view.emitAnnotationModified());
        },
    });

    function createAnnotationApplication(documentKey: string) {
        return new AnnotationApplication(documentKey, new AnnotationStore({
            get canUndo() { return history.canUndo.value; },
            get canRedo() { return history.canRedo.value; },
            registerCommand: command => history.registerCommand(command),
            forgetCommands: ids => history.forgetCommands(ids),
            undo: () => history.undo(),
            redo: () => history.redo(),
        }));
    }
    const documentIdentity = computed(() => (
        options.workingCopyPath.value
            ? `path:${options.workingCopyPath.value}`
            : annotationDocumentKey(options.source.value)
    ));
    const application = shallowRef(createAnnotationApplication(documentIdentity.value));
    const textBoxDrafts = shallowReactive(new Map<string, string>());
    const textBoxDraftGenerations = new Map<string, number>();
    const textBoxDraftRects = shallowReactive(new Map<string, IAnnotationMarkerRect>());
    // Every view reads the page groups, summaries and tombstones derived from this one snapshot.
    const {
        entities,
        entitiesByPage,
    } = useAnnotationStoreSnapshot(application);
    // A closed document lists nothing; a text box lists the draft a view holds open.
    const comments = computed<IAnnotationCommentSummary[]>(() => (options.source.value
        ? application.value.listCommentSummaries(entities.value).map(comment => Object.freeze({
            ...comment,
            text: (comment.annotationKind === 'text-box' ? textBoxDrafts.get(comment.appAnnotationId ?? '') : undefined) ?? comment.text,
        })).sort(compareAnnotationCommentSummaries)
        : []));
    // Tombstones by id and PDF ref, with creations an undo removed while their redo remains.
    const deletedAnnotationIds = computed(() => new Set<string>([
        ...application.value.store.deletedAnnotationIds(),
        ...entities.value.flatMap(entity => (entity.deleted && entity.identity.pdfRef ? [entity.identity.pdfRef] : [])),
    ]));
    // The store and PDF.js document a read last settled for. A store no read
    // has settled for is loading, not empty; a later read reconciles what it lists.
    const read = shallowRef<{store: AnnotationStore; document: TPdfDocumentView['pdfDocument']['value']} | null>(null);
    const commentsStatus = computed<TAnnotationCommentsStatus>(() => (
        options.source.value && read.value?.store === application.value.store ? 'ready' : 'loading'
    ));
    // A rotation re-projects its pages' geometry: they paint once the store is
    // read for the document the view shows. The plan is not reactive; the read
    // and document comparison come first so callers track them.
    function paintsPage(view: Pick<TPdfDocumentView, 'activeLoadPlan' | 'pdfDocument'>, pageIndex: number) {
        const readForView = read.value?.document === view.pdfDocument.value;
        const plan = view.activeLoadPlan;
        return readForView || plan.rotationDelta === undefined || !plan.pagesToInvalidate?.includes(pageIndex + 1);
    }
    let writerParseTask: {
        matches: (document: NonNullable<TPdfDocumentView['pdfDocument']['value']>, path: string, version: number) => boolean;
        abortController: AbortController;
        promise: Promise<boolean>;
        result?: IPdfAnnotationParseResult;
    } | null = null;
    function cancelWriterParse() {
        writerParseTask?.abortController.abort();
        writerParseTask = null;
    }
    onScopeDispose(cancelWriterParse, true);
    watch(options.documentRevisionToken, cancelWriterParse, {flush: 'sync'});
    // A save before the store read the whole document leaves it partial;
    // `afterSave` reads the revision it wrote, which the PDF.js document predates.
    function feedStoreFromWriterParse(documentSession: TPdfDocumentView, originalPath: Readonly<Ref<string | null>>, afterSave = false) {
        const selectedParsePath = () => {
            const source = options.source.value;
            return parseDocumentRef(options.workingCopyPath.value)
                ?? parseDocumentRef(originalPath.value)
                ?? (source instanceof Blob ? null : parseDocumentRef(source?.path ?? null));
        };
        const parsePath = selectedParsePath();
        const document = documentSession.pdfDocument.value;
        const fence = documentSession.captureFence();
        const revision = options.documentRevisionToken.value;
        const savedRevision = afterSave && !application.value.store.readWholeDocument;
        if (!parsePath || !document
            || (revision !== null && fence.documentRevision !== revision && !savedRevision
                && !fence.documentRevision?.startsWith('load:'))) {
            // A document without a path has no writer annotations to read.
            if (document && !parsePath) read.value = {
                store: application.value.store,
                document,
            };
            return Promise.resolve(false);
        }
        if (writerParseTask?.matches(document, parsePath, fence.documentVersion)) {
            return writerParseTask.promise;
        }
        cancelWriterParse();
        const abortController = new AbortController();
        const targetStore = application.value.store;
        const identity = documentIdentity.value;
        const isCurrent = () => !abortController.signal.aborted
            && documentIdentity.value === identity
            && application.value.store === targetStore
            && documentSession.pdfDocument.value === document
            && documentSession.captureFence().documentVersion === fence.documentVersion
            && options.documentRevisionToken.value === revision
            && selectedParsePath() === parsePath;
        const promise = (async () => {
            const expectedRevisionToken = revision
                ?? await getDocumentFilesCapability().getDocumentRevision(parsePath)
                    .then(value => value.token)
                    .catch((error: unknown) => {
                        BrowserLogger.warn('annotations', 'Failed to read annotation document revision', error);
                        return null;
                    });
            const isProvisionalRevisionFence = fence.documentRevision?.startsWith('load:') ?? false;
            if (!expectedRevisionToken || !isCurrent()
                || (fence.documentRevision !== expectedRevisionToken && !isProvisionalRevisionFence && !savedRevision)) {
                return false;
            }
            try {
                const result = await getDocumentWorkingCopyCapability().parsePdfAnnotations(parsePath, {
                    expectedDocumentRevisionToken: expectedRevisionToken,
                    signal: abortController.signal,
                });
                if (isCurrent()) await recordPdfDocumentOriginalAnnotations(document, result, async () => {
                    const snapshot = await getDocumentWorkingCopyCapability().createWorkingCopyFromPath(parsePath);
                    try {
                        const capturedRevision = await getDocumentFilesCapability().getDocumentRevision(parsePath);
                        if (!isCurrent() || capturedRevision.token !== result.documentRevisionToken) {
                            throw new DOMException('Original annotation source changed during capture', 'AbortError');
                        }
                        return {
                            ref: snapshot,
                            release: () => getDocumentWorkingCopyCapability().cleanupFile(snapshot),
                        };
                    } catch (error) {
                        await getDocumentWorkingCopyCapability().cleanupFile(snapshot);
                        throw error;
                    }
                });
                const committed = commitPdfAnnotationParseToStore({
                    result,
                    isTransitionCurrent: isCurrent,
                    targetStore,
                    currentStore: application.value.store,
                    expectedRevisionToken,
                    currentRevisionToken: options.documentRevisionToken.value ?? expectedRevisionToken,
                    preserveSavedBaseline: options.documentSession !== undefined,
                });
                if (!committed) {
                    return false;
                }
                if (writerParseTask) writerParseTask.result = result;
                void deriveSelectedTextForParsedHighlights({
                    documentSession,
                    result,
                    transition: {isCurrent},
                    signal: abortController.signal,
                }).then((selectedTextByPdfRef) => {
                    if (selectedTextByPdfRef && isCurrent()) {
                        applyParsedHighlightTextToStore({
                            targetStore,
                            selectedTextByPdfRef,
                            parsedEntities: result.entities,
                        });
                    }
                }).catch((error) => {
                    if (!abortController.signal.aborted) {
                        BrowserLogger.warn('annotations', 'Failed to enrich imported writer highlights', error);
                    }
                });
                return true;
            } catch (error) {
                if (isCurrent() && isBrowserFullReadTooLargeError(error)) {
                    presentNoticeToast({
                        tone: 'warning',
                        title: t('errors.browser.annotationsUnavailable'),
                        description: t('errors.browser.annotationsTooLarge'),
                    });
                } else if (isCurrent()) {
                    // A worker reset means the page is leaving; nothing failed.
                    if (!isBrowserWorkerResetError(error)) {
                        BrowserLogger.warn('annotations', 'Failed to import writer PDF annotations', error);
                    }
                    cancelWriterParse();
                }
                return false;
            }
        })();
        writerParseTask = {
            matches: (candidate, path, version) => candidate === document && path === parsePath && version === fence.documentVersion && isCurrent(),
            abortController,
            promise,
        };
        void promise.finally(() => {
            if (targetStore === application.value.store) read.value = {
                store: targetStore,
                document,
            };
        });
        return promise;
    }
    if (options.isSaving) watch(options.isSaving, (saving) => {
        const view = [...views].find(candidate => candidate.document.pdfDocument.value && !candidate.document.pendingPageMutationRevisionSwap);
        if (!saving && view) void feedStoreFromWriterParse(view.document, view.originalPath, true);
    });

    let storeRevision: TDocumentRevisionToken | null = null;
    function reset(documentKey: string) {
        cancelWriterParse();
        storeRevision = null;
        clearTextBoxDrafts();
        application.value = createAnnotationApplication(documentKey);
    }

    // The document session admits revisions before a view can report them.
    // A genuine Open resets the owner even when it reuses the same path.
    if (options.documentSession) {
        watch(options.documentSession, () => { history.clear(); reset(documentIdentity.value); }, {flush: 'sync'});
    }
    watch(options.documentRevisionToken, revision => {
        if (options.documentSession || options.isSaving?.value) storeRevision = revision;
    }, {flush: 'sync'});
    function replaceLoadedDocument(loadedRevision: string | null, duringSave: boolean) {
        const currentRevision = options.documentRevisionToken.value;
        if (currentRevision !== null && (loadedRevision !== currentRevision || storeRevision === currentRevision)) {
            return;
        }
        if (!duringSave) {
            history.clear();
            reset(documentIdentity.value);
        }
        storeRevision = currentRevision;
    }

    // Saves and OCR retain accepted edits. The native parse reconciles the
    // replacement bytes with this store instead of discarding pending edits.
    function adoptCurrentRevision() {
        storeRevision = options.documentRevisionToken.value;
    }

    function setTextBoxDraft(annotationId: string, text: string | null) {
        if (text === null) {
            textBoxDrafts.delete(annotationId);
            textBoxDraftGenerations.delete(annotationId);
            textBoxDraftRects.delete(annotationId);
            return;
        }
        textBoxDrafts.set(annotationId, text);
        textBoxDraftGenerations.set(annotationId, (textBoxDraftGenerations.get(annotationId) ?? 0) + 1);
    }

    function clearTextBoxDrafts() {
        for (const id of textBoxDrafts.keys()) setTextBoxDraft(id, null);
    }

    function restoreTextBoxDrafts(drafts: ReadonlyArray<{
        annotationId: string;
        text: string;
        generation: number;
    }>) {
        clearTextBoxDrafts();
        drafts.forEach((draft) => {
            textBoxDrafts.set(draft.annotationId, draft.text);
            textBoxDraftGenerations.set(draft.annotationId, draft.generation);
        });
    }

    // Viewers receive the owner as a prop; it must stay a plain object whose
    // refs are its own, never a deep reactive proxy.
    return markRaw({
        application,
        history,
        documentIdentity,
        /** The store's last snapshot, tombstones included; readers derive from it. */
        entities,
        entitiesByPage,
        comments,
        commentsStatus,
        deletedAnnotationIds,
        paintsPage,
        textBoxDrafts,
        textBoxDraftGenerations,
        textBoxDraftRects,
        setTextBoxDraft,
        restoreTextBoxDrafts,
        replaceLoadedDocument,
        adoptCurrentRevision,
        feedStoreFromWriterParse,
        getWriterParseResult: () => writerParseTask?.result ?? null,
        /** Joins the read of the revision a view presents, starting it if none runs; null while no view has its document. */
        joinRead() {
            const view = [...views].find(candidate => candidate.document.pdfDocument.value);
            return view ? feedStoreFromWriterParse(view.document, view.originalPath) : null;
        },
        /** The rectangle of a draft in the viewer whose editor holds it open. */
        getTextBoxDraftRect(annotationId: string) {
            return [...views].map(view => view.getTextBoxDraftRect(annotationId)).find(rect => rect !== null)
                ?? textBoxDraftRects.get(annotationId) ?? null;
        },
        // One editor per annotation: editing it in one viewer first commits the
        // editor another viewer holds open, as clicking elsewhere does in one.
        commitDraftIfOpen(annotationId: string, except: IPdfDocumentAnnotationsView) {
            const others = [...views].filter(view => view !== except && view.isEditing(annotationId));
            return others.length ? Promise.all(others.map(view => Promise.resolve(view.commitPendingDraftsForSave()))).then(() => {}) : undefined;
        },
        getPendingTextCompletion() {
            const pending = [...views].flatMap(view => view.getPendingTextCompletion?.() ?? []);
            return pending.length ? Promise.all(pending).then(() => {}) : undefined;
        },
        /**
         * Commits every viewer's open text-box drafts, so a save sees them all.
         * `joinRead` also waits for the read in flight, so a write sees dirty
         * geometry in its bytes' page frame. A read that failed or was
         * superseded refuses the write as stale; one that keeps its task (too
         * large to import) moved nothing.
         */
        async commitPendingDraftsForSave(options: {joinRead?: true} = {}) {
            await Promise.all([...views].map(view => Promise.resolve(view.commitPendingDraftsForSave())));
            if (textBoxDrafts.size) throw new Error('Missing required text draft editor');
            const task = options.joinRead ? writerParseTask : null;
            if (task && !await task.promise && writerParseTask !== task) {
                throw createStaleRevisionError({message: 'The annotation re-read did not land'});
            }
        },
        /** Adds a viewer; the returned function removes it. */
        attachView(view: IPdfDocumentAnnotationsView) {
            views.add(view);
            return () => {
                const pending = view.commitPendingDraftsForSave() ?? undefined;
                view.commitPendingDraftsForSave = view.getPendingTextCompletion = () => pending;
                const release = () => { views.delete(view); };
                return Promise.resolve(pending).then(release, release);
            };
        },
    });
};

export type TPdfDocumentAnnotations = ReturnType<typeof createPdfDocumentAnnotations>;

/** A workspace provides its document's owner to the viewer it mounts. */
export const pdfDocumentAnnotationsKey: InjectionKey<TPdfDocumentAnnotations> = Symbol('pdfDocumentAnnotations');
