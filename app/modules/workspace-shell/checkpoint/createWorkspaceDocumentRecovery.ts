import {
    CANONICAL_ANNOTATION_RECOVERY_VERSION, isAnnotationRecoveryWritten, type IPdfViewerExpose, type TPdfDocumentAnnotations,
} from '@app/modules/pdf-viewer/public';
import type {useMetadataSession} from '@app/modules/workspace-shell/composables/useMetadataSession';
import type {useWorkspaceAnnotationSession} from '@app/modules/workspace-shell/composables/useWorkspaceAnnotationSession';
import type {IWorkspaceDocumentController} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import {isRecord} from '@contracts/runtimeGuards';
import {readWorkspaceRecoveryMetadata} from '@contracts/workspaceCheckpoint';
import type {IWorkspaceDocumentRecovery} from '@app/types/workspaceDocumentRecovery';
import {getErrorMessage} from '@app/utils/error';
import {getWindowTabsCapability} from '@app/utils/platformWindowTabs';

interface IDraftHold {
    released: PromiseWithResolvers<void>;
    failedInstance?: string | null;
    /** A draft the replay could not apply, such as one naming no recovered annotation, stays stored as a failed replay. */
    retained?: boolean;
}

interface IWorkspaceDocumentRecoveryOptions {
    controller: Pick<IWorkspaceDocumentController, 'snapshot'>;
    pdfViewer: () => IPdfViewerExpose | null;
    pdfDocumentAnnotations: Pick<TPdfDocumentAnnotations, 'application' | 'textBoxDrafts' | 'joinRead' | 'commentsStatus'>;
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
        if (controller.snapshot.value.phase !== 'presented' || !viewer?.captureCanonicalAnnotationRecovery) {return null;}
        const recovery: IWorkspaceDocumentRecovery = {
            ...viewer.captureCanonicalAnnotationRecovery(revisionOf => annotations.captureAnnotationNoteDrafts(revisionOf)),
            metadata: structuredClone(metadata.captureRecovery()),
        };
        const unwritten = !isAnnotationRecoveryWritten(recovery)
            || recovery.metadata?.bookmarks !== undefined || recovery.metadata?.pageLabels !== undefined;
        return unwritten ? recovery : undefined;
    }

    async function write() {
        const recovery = capture();
        const {documentInstanceId, workingCopyPath, revisionInfo} = controller.snapshot.value.identity;
        if (recovery === null || !documentInstanceId || !workingCopyPath || !revisionInfo) {return;}
        const stored = await getWindowTabsCapability().setDocumentDrafts({
            artifactId: 'document-drafts',
            documentInstanceId,
            workingCopyRef: workingCopyPath,
            workingByteRevision: revisionInfo.token,
            annotationMutationGeneration: recovery?.annotationMutationGeneration ?? 0,
            ...(recovery ? {payload: recovery} : {}),
        });
        if (stored) {return;}
        // Refused for a revision a newer one replaced meanwhile: the drafts are written again for that one.
        if (controller.snapshot.value.identity.revisionInfo?.token !== revisionInfo.token) {
            stale = true;
            return;
        }
        throw new Error('Document drafts could not be stored for the current revision');
    }

    let stale = false;
    let running: Promise<void> | null = null;
    let failure: unknown = null;
    // From the claim of recovered drafts until they are applied the writer does not run. After a failed replay, and
    // while a replay waits for a read no view can join yet, the stored drafts are the only copy: they stay untouched
    // while this document instance is open, and nothing that commits the drafts first may replace them.
    let hold: IDraftHold | null = null;
    // A replay waiting for the first read of a document no view has loaded, such as a tab restored in the background.
    let deferred: {hold: IDraftHold; value: unknown; revision: string | undefined} | null = null;
    const held = () => hold !== null && (hold.failedInstance === undefined || hold.failedInstance === controller.snapshot.value.identity.documentInstanceId);

    async function run() {
        // Changes made in the same task share one write.
        await Promise.resolve();
        while (stale && !held()) {
            stale = false;
            try {
                await write();
                if (!stale) {failure = null;}
            } catch (error) {
                stale = true;
                // A refusal is told once, not again for every burst that repeats it.
                if (failure === null || getErrorMessage(error) !== getErrorMessage(failure)) {options.reportFailure(error);}
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

    /**
     * Resolves once the drafts hold the unsaved state as it is now. Rejects while recovered drafts that were not applied
     * stay stored, and when the state could not be stored, unless `failedWrite` is 'reported': the writer told that
     * failure, and a caller whose own commit holds the edits, as a Save's does, goes on without the drafts.
     */
    async function commitDrafts(failedWrite: 'reject' | 'reported' = 'reject') {
        if (hold?.failedInstance === undefined) {await hold?.released.promise;}
        if (held()) {throw new Error('Recovered annotation drafts that were not applied stay stored');}
        if (stale) {running ??= run();}
        while (running) {await running;}
        if (failedWrite === 'reject' && stale && !held() && failure !== null) {throw failure;}
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
    watch(() => pdfDocumentAnnotations.commentsStatus.value, (status) => {
        const waiting = deferred;
        const joined = status === 'ready' && waiting ? pdfDocumentAnnotations.joinRead() : null;
        if (!waiting || !joined) {return;}
        deferred = null;
        void joined.then((read) => {
            const {documentInstanceId, revisionInfo} = controller.snapshot.value.identity;
            if (!read || hold !== waiting.hold || documentInstanceId !== waiting.hold.failedInstance || revisionInfo?.token !== waiting.revision) {
                return;
            }
            if (replay(pdfViewer(), waiting.value).draftErrors?.length) {return;}
            hold = null;
            markStale();
        }).catch(options.reportFailure);
    });

    function replay(viewer: IPdfViewerExpose | null, value: unknown) {
        const recoveredMetadata = readWorkspaceRecoveryMetadata(value);
        const recovery = viewer?.restoreCanonicalAnnotationRecovery?.(value);
        if (!recovery) {throw new Error('Canonical annotation recovery is unavailable');}
        recovery.drafts.forEach(draft => annotations.restoreAnnotationNoteDraft(draft));
        if (recoveredMetadata) {metadata.restoreRecovery(recoveredMetadata);}
        if (recovery.draftErrors?.length) {
            if (hold) {hold.retained = true;}
            options.reportFailure(new Error('Recovered editor text that matches no recovered annotation stays stored'));
        }
        return recovery;
    }

    return {
        capture,
        commitDrafts,
        /** Holds the writer while recovered drafts are replayed; the returned settle says whether they were applied. */
        holdDrafts() {
            const current: IDraftHold = {released: Promise.withResolvers<void>()};
            hold?.released.resolve();
            hold = current;
            return (applied: boolean) => {
                if (hold !== current) {return;}
                current.released.resolve();
                if (!applied || current.retained) {
                    current.failedInstance = controller.snapshot.value.identity.documentInstanceId;
                    return;
                }
                hold = null;
                markStale();
            };
        },
        /**
         * Puts recovered drafts back through `viewer`, the view the restored tab shows. A plan of changes applies onto
         * the read of the recovered bytes, which holds everything else, and drafts captured from another read take that
         * read's geometry, so both wait for it; when it fails they stay stored. While no view has the document loaded,
         * the replay waits for its first read and the drafts stay held.
         */
        restoreCanonicalAnnotationRecovery: async (viewer: IPdfViewerExpose | null, value: unknown) => {
            const readRevision = isRecord(value) ? value.annotationReadRevision : undefined;
            const {documentInstanceId, revisionInfo} = controller.snapshot.value.identity;
            const plan = isRecord(value) && value.version === CANONICAL_ANNOTATION_RECOVERY_VERSION;
            const unread = plan && pdfDocumentAnnotations.application.value.store.readRevision !== (revisionInfo?.token ?? null);
            if (unread || (readRevision !== undefined && readRevision !== revisionInfo?.token)) {
                const joined = pdfDocumentAnnotations.joinRead();
                if (joined === null) {
                    // The settle of the hold this replaces no longer releases the writer; resolve any caller awaiting it.
                    const waiting: IDraftHold = {released: Promise.withResolvers<void>(), failedInstance: documentInstanceId};
                    waiting.released.resolve();
                    hold?.released.resolve();
                    hold = waiting;
                    deferred = {hold: waiting, value, revision: revisionInfo?.token};
                    return null;
                }
                if (!await joined) {throw new Error('The recovered document\'s annotations could not be read');}
                // The drafts belong to the bytes they were admitted for; a document that changed meanwhile keeps them stored.
                const current = controller.snapshot.value.identity;
                if (current.documentInstanceId !== documentInstanceId || current.revisionInfo?.token !== revisionInfo?.token) {
                    throw new Error('The recovered document changed while its annotations were read');
                }
            }
            return replay(viewer, value);
        },
    };
}
