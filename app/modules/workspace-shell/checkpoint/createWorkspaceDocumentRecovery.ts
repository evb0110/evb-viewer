import type {IPdfViewerExpose, TPdfDocumentAnnotations} from '@app/modules/pdf-viewer/public';
import type {useMetadataSession} from '@app/modules/workspace-shell/composables/useMetadataSession';
import type {useWorkspaceAnnotationSession} from '@app/modules/workspace-shell/composables/useWorkspaceAnnotationSession';
import type {IWorkspaceDocumentController} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import {readWorkspaceRecoveryMetadata} from '@contracts/workspaceCheckpoint';
import type {IWorkspaceDocumentRecovery} from '@app/types/workspaceDocumentRecovery';
import {getErrorMessage} from '@app/utils/error';
import {getWindowTabsCapability} from '@app/utils/platformWindowTabs';

interface IWorkspaceDocumentRecoveryOptions {
    controller: Pick<IWorkspaceDocumentController, 'snapshot'>;
    pdfViewer: () => IPdfViewerExpose | null;
    pdfDocumentAnnotations: Pick<TPdfDocumentAnnotations, 'application' | 'textBoxDrafts'>;
    annotations: Pick<ReturnType<typeof useWorkspaceAnnotationSession>, 'captureAnnotationNoteDrafts' | 'getAnnotationNoteDraftsChangeSignature' | 'restoreAnnotationNoteDraft'>;
    metadata: Pick<ReturnType<typeof useMetadataSession>, 'bookmarkState' | 'pageLabelState' | 'captureRecovery' | 'restoreRecovery'>;
    reportFailure: (cause: unknown) => void;
}

/**
 * A document's unsaved annotations, editor text and metadata, kept as the drafts of its store directory. Any change
 * of that state, or a new revision of the bytes (which clears the drafts), makes the drafts stale. One writer brings
 * them up to date: it starts at once and, when the state changed while it ran, runs once more with the state as it
 * is then. A write keeps the stored drafts while the edit state is unavailable, clears them when the working bytes
 * hold everything, and replaces them otherwise. Only actions that need the durable state wait for it.
 */
export function createWorkspaceDocumentRecovery(options: IWorkspaceDocumentRecoveryOptions) {
    const {controller, pdfViewer, pdfDocumentAnnotations, annotations, metadata} = options;

    /** `null`: the edit state is unavailable; `undefined`: the working bytes hold all of it. */
    function capture(): IWorkspaceDocumentRecovery | null | undefined {
        const viewer = pdfViewer();
        if (controller.snapshot.value.phase !== 'presented' || !viewer?.captureCanonicalAnnotationRecovery) return null;
        const recovery: IWorkspaceDocumentRecovery = {
            ...viewer.captureCanonicalAnnotationRecovery((entities) => {
                const revisions = new Map(entities.map(entity => [entity.identity.id, entity.revision]));
                return annotations.captureAnnotationNoteDrafts(id => revisions.get(id) ?? null);
            }),
            metadata: structuredClone(metadata.captureRecovery()),
        };
        // An open editor's text counts as written once the bytes hold that text.
        const drafts = new Map(recovery.drafts.map(draft => [draft.annotationId, draft]));
        const edited = recovery.entities.map((entity) => {
            const draft = drafts.get(entity.identity.id);
            if (!draft || (entity.kind !== 'note' && entity.kind !== 'text-markup' && entity.kind !== 'text-box')) return entity;
            drafts.delete(entity.identity.id);
            return entity.kind === 'text-box'
                ? {...entity, text: draft.text, rect: draft.geometry ?? entity.rect}
                : {...entity, contents: draft.text};
        });
        const unwritten = drafts.size > 0 || recovery.metadata?.bookmarks !== undefined || recovery.metadata?.pageLabels !== undefined
            || pdfDocumentAnnotations.application.value.store.hasChangesSinceWorkingBaseline(edited);
        return unwritten ? recovery : undefined;
    }

    async function write() {
        const recovery = capture();
        const {documentInstanceId, workingCopyPath, revisionInfo} = controller.snapshot.value.identity;
        if (recovery === null || !documentInstanceId || !workingCopyPath || !revisionInfo) return;
        // Refused for an outdated revision: the new revision marks the drafts stale again.
        await getWindowTabsCapability().setDocumentDrafts({
            artifactId: 'document-drafts',
            documentInstanceId,
            workingCopyRef: workingCopyPath,
            workingByteRevision: revisionInfo.token,
            annotationMutationGeneration: recovery?.annotationMutationGeneration ?? 0,
            ...(recovery ? {payload: recovery} : {}),
        });
    }

    let stale = false;
    let running: Promise<void> | null = null;
    let failure: unknown = null;
    // From the claim of recovered drafts until they are applied the writer does not run. After a failed replay the
    // stored drafts stay untouched while this document instance is open.
    let hold: {released: PromiseWithResolvers<void>; failedInstance?: string | null} | null = null;
    const held = () => hold !== null && (hold.failedInstance === undefined || hold.failedInstance === controller.snapshot.value.identity.documentInstanceId);

    async function run() {
        // Changes made in the same task share one write.
        await Promise.resolve();
        while (stale && !held()) {
            stale = false;
            try {
                await write();
                failure = null;
            } catch (error) {
                stale = true;
                // A refusal is told once, not again for every burst that repeats it.
                if (failure === null || getErrorMessage(error) !== getErrorMessage(failure)) options.reportFailure(error);
                failure = error;
                break;
            }
        }
        running = null;
    }

    function markStale() {
        stale = true;
        running ??= run();
    }

    /** Resolves once the drafts hold the unsaved state as it is now; rejects when it could not be stored. */
    async function commitDrafts() {
        if (hold?.failedInstance === undefined) await hold?.released.promise;
        if (stale) running ??= run();
        while (running) await running;
        if (stale && !held() && failure !== null) throw failure;
    }

    watch(() => pdfDocumentAnnotations.application.value.store, (store, _previous, onCleanup) => {
        const unsubscribe = store.subscribe(markStale);
        onCleanup(() => { unsubscribe(); });
    }, {immediate: true});
    watch(() => [
        [...pdfDocumentAnnotations.textBoxDrafts],
        annotations.getAnnotationNoteDraftsChangeSignature(),
        metadata.bookmarkState.bookmarkItems.value,
        metadata.pageLabelState.pageLabelRanges.value,
        controller.snapshot.value.identity.revisionInfo?.token,
    ], markStale, {flush: 'sync'});

    return {
        capture,
        commitDrafts,
        /** Holds the writer while recovered drafts are replayed; the returned settle says whether they were applied. */
        holdDrafts() {
            const current: NonNullable<typeof hold> = {released: Promise.withResolvers<void>()};
            hold = current;
            return (applied: boolean) => {
                if (hold !== current) return;
                current.released.resolve();
                if (!applied) {
                    current.failedInstance = controller.snapshot.value.identity.documentInstanceId;
                    return;
                }
                hold = null;
                markStale();
            };
        },
        /** Puts recovered drafts back through `viewer`, the view the restored tab shows. */
        restoreCanonicalAnnotationRecovery: (viewer: IPdfViewerExpose | null, value: unknown) => {
            const recoveredMetadata = readWorkspaceRecoveryMetadata(value);
            const recovery = viewer?.restoreCanonicalAnnotationRecovery?.(value);
            if (!recovery) throw new Error('Canonical annotation recovery is unavailable');
            recovery.drafts.forEach(draft => annotations.restoreAnnotationNoteDraft(draft));
            if (recoveredMetadata) metadata.restoreRecovery(recoveredMetadata);
            return recovery;
        },
    };
}
