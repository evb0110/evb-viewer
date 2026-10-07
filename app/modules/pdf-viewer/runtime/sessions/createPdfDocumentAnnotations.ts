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

    // The working-copy revision the store was last started or kept for.
    let storeRevision: TDocumentRevisionToken | null = null;
    const documentIdentity = computed(() => (
        options.workingCopyPath.value
            ? `path:${options.workingCopyPath.value}`
            : annotationDocumentKey(options.source.value)
    ));
    function reset(documentKey: string) {
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
