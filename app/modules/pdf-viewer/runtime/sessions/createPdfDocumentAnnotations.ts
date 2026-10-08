import {parseDocumentRef} from '@contracts/documentRef';
import type {TPdfDocumentView} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import type {ITextMarkupEntity} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {
    applyParsedHighlightTextToStore, commitPdfAnnotationParseToStore,
} from '@app/modules/pdf-viewer/runtime/sessions/commitPdfAnnotationParseToStore';
import {deriveSelectedTextForParsedHighlights} from '@app/modules/pdf-viewer/runtime/sessions/deriveSelectedTextForParsedHighlights';
import {pdfAnnotationRefKey} from '@app/modules/pdf-viewer/runtime/sessions/mapPdfAnnotationParseEntity';
import {
    getDocumentFilesCapability, getDocumentWorkingCopyCapability,
} from '@app/utils/platformDocuments';
import {BrowserLogger} from '@app/utils/browserLogger';
import type {
    InjectionKey,
    Ref,
} from 'vue';
import type {
    IAnnotationEditorState,
    IAnnotationMarkerRect,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { TPdfSource } from '@app/types/pdfUi';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import { AnnotationStore } from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import { usePdfAppAnnotationHistory } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAppAnnotationHistory';

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

export function annotationDocumentKey(source: TPdfSource | null) {
    if (!source) {
        return 'no-document';
    }
    return source instanceof Blob
        ? annotationBlobIdentity(source)
        : `path:${source.path}`;
}

/** What one viewer of the document takes part in: its emits and its editor's pending drafts. */
export interface IPdfDocumentAnnotationsView {
    emitAnnotationState: (state: IAnnotationEditorState) => void;
    emitAnnotationModified: () => void;
    /** Re-projects this view after an undo or redo replayed the store. */
    onHistoryReplay: () => void;
    /** Commits text-box drafts open in this view's editor. */
    commitPendingDraftsForSave: () => void;
    /** Commits this view's open draft of one annotation, when it has one. */
    commitDraftIfOpen: (annotationId: string) => void;
    /** Where this view's editor shows an open draft, or null when it holds none. */
    getTextBoxDraftRect: (annotationId: string) => IAnnotationMarkerRect | null;
}

export interface ICreatePdfDocumentAnnotationsOptions {
    workingCopyPath: Readonly<Ref<string | null>>;
    source: Readonly<Ref<TPdfSource | null>>;
    documentRevisionToken: Readonly<Ref<TDocumentRevisionToken | null>>;
}

/**
 * One PDF document's canonical annotations: the application store, its undo
 * history, text-box drafts and markup subtype hints. Every viewer of the
 * document edits and renders this one owner; each viewer keeps its own editor
 * surface, tools and selection. The workspace document creates it; a viewer
 * used on its own creates one for itself.
 */
export const createPdfDocumentAnnotations = (options: ICreatePdfDocumentAnnotationsOptions) => {
    const views = new Set<IPdfDocumentAnnotationsView>();
    const history = usePdfAppAnnotationHistory({
        emitAnnotationState: (state) => {
            views.forEach(view => view.emitAnnotationState(state));
        },
        markModified: () => {
            views.forEach(view => view.emitAnnotationModified());
        },
    });
    history.setReplayEffect(() => {
        views.forEach(view => view.onHistoryReplay());
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
    const application = shallowRef(createAnnotationApplication('no-document'));
    const canonicalMarkupSubtypeHints = new Map<string, TMarkupSubtype>();
    const textBoxDrafts = new Map<string, string>();
    const textBoxDraftGenerations = new Map<string, number>();

    let writerParseTask: {
        document: NonNullable<TPdfDocumentView['pdfDocument']['value']>;
        version: number;
        revision: TDocumentRevisionToken | null;
        path: string;
        abortController: AbortController;
        promise: Promise<boolean>;
    } | null = null;
    function cancelWriterParse() {
        writerParseTask?.abortController.abort();
        writerParseTask = null;
    }
    onScopeDispose(cancelWriterParse, true);
    watch(options.documentRevisionToken, cancelWriterParse, {flush: 'sync'});

    function feedStoreFromWriterParse(documentSession: TPdfDocumentView, originalPath: Readonly<Ref<string | null>>) {
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
        if (!parsePath || !document
            || (revision !== null && fence.documentRevision !== revision
                && !fence.documentRevision?.startsWith('load:'))) {
            return Promise.resolve(false);
        }
        if (writerParseTask?.document === document
            && writerParseTask.version === fence.documentVersion
            && writerParseTask.revision === revision
            && writerParseTask.path === parsePath) {
            return writerParseTask.promise;
        }
        cancelWriterParse();
        const abortController = new AbortController();
        const targetStore = application.value.store;
        const identity = documentIdentity.value;
        // The producer follows the shared resource, not the first viewer's
        // load token or lifetime. Detaching a linked view cannot cancel it.
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
                    .catch(() => null);
            const isProvisionalRevisionFence = fence.documentRevision?.startsWith('load:') ?? false;
            if (!expectedRevisionToken || !isCurrent()
                || (fence.documentRevision !== expectedRevisionToken && !isProvisionalRevisionFence)) {
                return false;
            }
            const targetStoreMutationEpoch = targetStore.mutationEpoch;
            try {
                const result = await getDocumentWorkingCopyCapability().parsePdfAnnotations(parsePath, {
                    expectedDocumentRevisionToken: expectedRevisionToken,
                    signal: abortController.signal,
                });
                const committed = commitPdfAnnotationParseToStore({
                    result,
                    isTransitionCurrent: isCurrent,
                    targetStore,
                    currentStore: application.value.store,
                    targetStoreMutationEpoch,
                    expectedRevisionToken,
                    currentRevisionToken: options.documentRevisionToken.value ?? expectedRevisionToken,
                });
                if (!committed) {
                    return false;
                }
                const parsedMarkupGeometryByPdfRef = new Map<string, ITextMarkupEntity['quadPoints']>();
                result.entities.forEach((entry) => {
                    if (entry.kind === 'highlight') {
                        parsedMarkupGeometryByPdfRef.set(
                            pdfAnnotationRefKey(entry.objectNumber, entry.generationNumber),
                            entry.quadPoints.map(rect => ({...rect})),
                        );
                    }
                });
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
                            parsedMarkupGeometryByPdfRef,
                        });
                    }
                }).catch((error) => {
                    if (!abortController.signal.aborted) {
                        BrowserLogger.debug('annotations', 'Failed to enrich imported writer highlights', error);
                    }
                });
                return true;
            } catch (error) {
                if (!abortController.signal.aborted) {
                    BrowserLogger.warn('annotations', 'Failed to import writer PDF annotations', error);
                }
                return false;
            }
        })().then((committed) => {
            if (!committed && writerParseTask?.abortController === abortController) {
                writerParseTask = null;
            }
            return committed;
        }, (error: unknown) => {
            if (writerParseTask?.abortController === abortController) {
                writerParseTask = null;
            }
            throw error;
        });
        writerParseTask = {
            document,
            version: fence.documentVersion,
            revision,
            path: parsePath,
            abortController,
            promise,
        };
        return promise;
    }

    // The working-copy revision the store was last started or kept for.
    let storeRevision: TDocumentRevisionToken | null = null;
    const documentIdentity = computed(() => (
        options.workingCopyPath.value
            ? `path:${options.workingCopyPath.value}`
            : annotationDocumentKey(options.source.value)
    ));
    function reset(documentKey: string) {
        cancelWriterParse();
        storeRevision = null;
        canonicalMarkupSubtypeHints.clear();
        textBoxDrafts.clear();
        textBoxDraftGenerations.clear();
        application.value = createAnnotationApplication(documentKey);
    }
    watch(documentIdentity, reset, {immediate: true});

    // Canonical records describe the bytes a viewer's PDF.js document holds.
    // Save and file-history undo rewrite the working copy in place and reload
    // the same path, so each viewer reports the revision of the document that
    // replaced the one it had loaded. The store follows the document's current
    // revision: the first report of it starts a fresh store and history,
    // later reports of the same revision keep it, and a report of an older
    // revision, from a viewer that finished loading after the document moved
    // on, changes nothing. A revision a save wrote from this store keeps it.
    // Without revision tokens only a reload during a save keeps the store.
    function replaceLoadedDocument(loadedRevision: string | null, duringSave: boolean) {
        const currentRevision = options.documentRevisionToken.value;
        if (currentRevision !== null) {
            if (loadedRevision !== currentRevision || storeRevision === currentRevision) {
                return;
            }
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

    // One editor per annotation: editing it in one viewer first commits the
    // draft another viewer still has open, as clicking elsewhere does in one.
    function setTextBoxDraft(view: IPdfDocumentAnnotationsView, annotationId: string, text: string | null) {
        if (text !== null) {
            views.forEach((other) => {
                if (other !== view) {
                    other.commitDraftIfOpen(annotationId);
                }
            });
        }
        if (text === null) {
            textBoxDrafts.delete(annotationId);
            textBoxDraftGenerations.delete(annotationId);
            return;
        }
        textBoxDrafts.set(annotationId, text);
        textBoxDraftGenerations.set(annotationId, (textBoxDraftGenerations.get(annotationId) ?? 0) + 1);
    }

    function restoreTextBoxDrafts(drafts: ReadonlyArray<{
        annotationId: string;
        text: string;
        generation: number;
    }>) {
        textBoxDrafts.clear();
        textBoxDraftGenerations.clear();
        drafts.forEach((draft) => {
            textBoxDrafts.set(draft.annotationId, draft.text);
            textBoxDraftGenerations.set(draft.annotationId, draft.generation);
        });
    }

    /** Adds a viewer; the returned function removes it. */
    function attachView(view: IPdfDocumentAnnotationsView) {
        views.add(view);
        return () => {
            views.delete(view);
        };
    }

    // Viewers receive the owner as a prop; it must stay a plain object whose
    // refs are its own, never a deep reactive proxy.
    return markRaw({
        application,
        history,
        documentIdentity,
        canonicalMarkupSubtypeHints,
        textBoxDrafts,
        textBoxDraftGenerations,
        setTextBoxDraft,
        restoreTextBoxDrafts,
        replaceLoadedDocument,
        adoptCurrentRevision,
        feedStoreFromWriterParse,
        /** The rectangle of a draft in the viewer whose editor holds it open. */
        getTextBoxDraftRect(annotationId: string) {
            for (const view of views) {
                const rect = view.getTextBoxDraftRect(annotationId);
                if (rect) {
                    return rect;
                }
            }
            return null;
        },
        /** Commits every viewer's open text-box drafts, so a save sees them all. */
        commitPendingDraftsForSave() {
            views.forEach(view => view.commitPendingDraftsForSave());
        },
        attachView,
    });
};

export type TPdfDocumentAnnotations = ReturnType<typeof createPdfDocumentAnnotations>;

/** A workspace provides its document's owner to the viewer it mounts. */
export const pdfDocumentAnnotationsKey: InjectionKey<TPdfDocumentAnnotations> = Symbol('pdfDocumentAnnotations');
