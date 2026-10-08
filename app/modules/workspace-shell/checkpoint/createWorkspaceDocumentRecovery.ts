import type {IPdfViewerExpose} from '@app/modules/pdf-viewer/public';
import type {TDocumentContext} from '@app/modules/workspace-shell/documentContext';
import {readWorkspaceRecoveryMetadata} from '@contracts/workspaceCheckpoint';
import type {
    IWorkspaceDocumentRecovery, IWorkspaceDocumentRecoveryPort,
} from '@app/types/workspaceDocumentRecovery';

/** Extends the existing annotation artifact with edits owned by the document. */
export function createWorkspaceDocumentRecovery(
    document: Pick<TDocumentContext, 'file' | 'annotations' | 'metadata'>,
    pdfViewer: () => IPdfViewerExpose | null,
): Required<IWorkspaceDocumentRecoveryPort> {
    const {
        file, annotations, metadata,
    } = document;
    return {
        getWorkspaceDocumentRecoveryChangeSignature: () => {
            // These owner refs are the reactive edge for their existing revisions.
            void metadata.bookmarkState.bookmarkItems.value;
            void metadata.pageLabelState.pageLabelRanges.value;
            return [
                file.originalPath.value,
                file.workingCopyPath.value,
                file.requiresSaveAsOnFirstSave.value,
                pdfViewer()?.getCanonicalAnnotationRecoveryChangeSignature?.() ?? null,
                metadata.bookmarkState.bookmarksDirty.value ? metadata.bookmarkState.getBookmarksRevision() : null,
                metadata.pageLabelState.pageLabelsDirty.value ? metadata.pageLabelState.getPageLabelsRevision() : null,
                annotations.getAnnotationSaveStateToken(),
                annotations.getAnnotationNoteDraftsChangeSignature(),
            ];
        },
        captureCanonicalAnnotationRecovery: (): IWorkspaceDocumentRecovery | null => {
            const viewer = pdfViewer();
            if (!viewer?.captureCanonicalAnnotationRecovery) return null;
            return {
                ...viewer.captureCanonicalAnnotationRecovery((entities) => {
                    const revisions = new Map(entities.map(entity => [
                        entity.identity.id,
                        entity.revision,
                    ]));
                    return annotations.captureAnnotationNoteDrafts(id => revisions.get(id) ?? null);
                }),
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
