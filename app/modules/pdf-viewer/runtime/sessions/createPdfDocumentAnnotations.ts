import type {
    InjectionKey,
    Ref,
} from 'vue';
import type {
    IAnnotationEditorState,
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

    const documentIdentity = computed(() => (
        options.workingCopyPath.value
            ? `path:${options.workingCopyPath.value}`
            : annotationDocumentKey(options.source.value)
    ));
    function reset(documentKey: string) {
        canonicalMarkupSubtypeHints.clear();
        textBoxDrafts.clear();
        textBoxDraftGenerations.clear();
        application.value = createAnnotationApplication(documentKey);
    }
    watch(documentIdentity, reset, {immediate: true});

    // Canonical records describe the bytes a viewer's PDF.js document holds.
    // Save and file-history undo rewrite the working copy in place and reload
    // the same path, so a viewer reports each document that replaces the one
    // it had loaded, and that starts a fresh store and history. Another viewer
    // reloading the same revision keeps the store the first one started.
    let lastReplacement: {
        view: IPdfDocumentAnnotationsView;
        revision: TDocumentRevisionToken | null;
    } | null = null;
    function replaceLoadedDocument(view: IPdfDocumentAnnotationsView) {
        const revision = options.documentRevisionToken.value;
        if (
            lastReplacement
            && lastReplacement.view !== view
            && revision !== null
            && lastReplacement.revision === revision
        ) {
            return;
        }
        lastReplacement = {
            view,
            revision,
        };
        history.clear();
        reset(documentIdentity.value);
    }

    function setTextBoxDraft(annotationId: string, text: string | null) {
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
