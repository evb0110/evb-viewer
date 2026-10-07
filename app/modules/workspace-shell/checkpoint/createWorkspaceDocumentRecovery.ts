import type {IPdfViewerExpose} from '@app/modules/pdf-viewer/public';
import type {useWorkspaceAnnotationSession} from '@app/modules/workspace-shell/composables/useWorkspaceAnnotationSession';
import type {useMetadataSession} from '@app/modules/workspace-shell/composables/useMetadataSession';
import {readWorkspaceRecoveryMetadata} from '@contracts/workspaceCheckpoint';
import type {
    IWorkspaceDocumentRecovery, IWorkspaceDocumentRecoveryPort,
} from '@app/types/workspaceDocumentRecovery';

/** Extends the existing annotation artifact with edits owned by the document. */
export function createWorkspaceDocumentRecovery(options: {
    pdfViewer: () => IPdfViewerExpose | null;
    annotations: Pick<ReturnType<typeof useWorkspaceAnnotationSession>, 'captureAnnotationNoteDrafts' | 'restoreAnnotationNoteDraft'>;
    metadata: Pick<ReturnType<typeof useMetadataSession>, 'captureRecovery' | 'restoreRecovery'>;
}): Required<IWorkspaceDocumentRecoveryPort> {
    const {
        pdfViewer, annotations, metadata,
    } = options;
    return {
        captureCanonicalAnnotationRecovery: (): IWorkspaceDocumentRecovery | null => {
            const viewer = pdfViewer();
            const initial = viewer?.captureCanonicalAnnotationRecovery?.();
            if (!initial || !viewer?.captureCanonicalAnnotationRecovery) return null;
            const drafts = annotations.captureAnnotationNoteDrafts(annotationId => (
                initial.entities.find(entity => entity.identity.id === annotationId)?.revision ?? null
            ));
            return {
                ...viewer.captureCanonicalAnnotationRecovery(drafts),
                metadata: metadata.captureRecovery(),
            };
        },
        restoreCanonicalAnnotationRecovery: (value: unknown) => {
            const recoveredMetadata = readWorkspaceRecoveryMetadata(value);
            const recovery = pdfViewer()?.restoreCanonicalAnnotationRecovery?.(value);
            if (!recovery) throw new Error('Canonical annotation recovery is unavailable');
            recovery.drafts.forEach(draft => annotations.restoreAnnotationNoteDraft(draft));
            if (recoveredMetadata) metadata.restoreRecovery(recoveredMetadata);
            return recovery;
        },
    };
}
