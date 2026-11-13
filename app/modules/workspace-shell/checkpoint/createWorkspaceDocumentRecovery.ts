import type {IPdfViewerExpose, TPdfDocumentAnnotations} from '@app/modules/pdf-viewer/public';
import type {useMetadataSession} from '@app/modules/workspace-shell/composables/useMetadataSession';
import type {useWorkspaceAnnotationSession} from '@app/modules/workspace-shell/composables/useWorkspaceAnnotationSession';
import type {IWorkspaceDocumentController} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import {readWorkspaceRecoveryMetadata} from '@contracts/workspaceCheckpoint';
import type {IWorkspaceDocumentRecovery} from '@app/types/workspaceDocumentRecovery';
import {getWindowTabsCapability} from '@app/utils/platformWindowTabs';

interface IWorkspaceDocumentRecoveryOptions {
    controller: Pick<IWorkspaceDocumentController, 'snapshot'>;
    pdfViewer: () => IPdfViewerExpose | null;
    pdfDocumentAnnotations: Pick<TPdfDocumentAnnotations, 'application'>;
    annotations: Pick<ReturnType<typeof useWorkspaceAnnotationSession>, 'captureAnnotationNoteDrafts' | 'restoreAnnotationNoteDraft'>;
    metadata: Pick<ReturnType<typeof useMetadataSession>, 'captureRecovery' | 'restoreRecovery'>;
    reportFailure: (cause: unknown) => void;
}

/**
 * A document's unsaved annotations and metadata, kept as the drafts of its store directory. An accepted edit commits
 * them, and so does every new revision of the bytes, since a byte mutation clears the drafts. A commit captures the
 * document as it is when the commit runs, after the commits before it, so an older capture never lands after a newer
 * one. It keeps the stored drafts while the edit state is unavailable, clears them when the working bytes hold
 * everything, and replaces them otherwise.
 */
export function createWorkspaceDocumentRecovery(options: IWorkspaceDocumentRecoveryOptions) {
    const {controller, pdfViewer, annotations, metadata} = options;

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
            || options.pdfDocumentAnnotations.application.value.store.hasChangesSinceWorkingBaseline(edited);
        return unwritten ? recovery : undefined;
    }

    async function write() {
        const recovery = capture();
        const {documentInstanceId, workingCopyPath, revisionInfo} = controller.snapshot.value.identity;
        if (recovery === null || !documentInstanceId || !workingCopyPath || !revisionInfo) return;
        await getWindowTabsCapability().setDocumentDrafts({
            artifactId: 'document-drafts',
            documentInstanceId,
            workingCopyRef: workingCopyPath,
            workingByteRevision: revisionInfo.token,
            annotationMutationGeneration: recovery?.annotationMutationGeneration ?? 0,
            ...(recovery ? {payload: recovery} : {}),
        });
    }

    let tail: Promise<void> = Promise.resolve();
    /** Resolves once the drafts hold the document as it is now, or a newer revision, whose commit follows, superseded it. */
    function commitDrafts() {
        const run = tail.then(write, write);
        tail = run.catch(() => undefined);
        return run;
    }

    /** The commit an accepted edit, or a new revision, starts: a failure is told to the user, never ignored. */
    function commitAcceptedEdit() {
        return commitDrafts().catch(options.reportFailure);
    }

    watch(() => controller.snapshot.value.identity.revisionInfo?.token, (token, previous) => {
        if (token && previous) void commitAcceptedEdit();
    });

    return {
        capture,
        commitDrafts,
        commitAcceptedEdit,
        /** Resolves once the commits started so far are done; their failures were told to the user. */
        whenCommitted: () => tail,
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
