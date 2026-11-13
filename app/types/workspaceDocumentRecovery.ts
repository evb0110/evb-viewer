import type {ICanonicalAnnotationRecovery} from '@app/modules/pdf-viewer/public';
import type {IWorkspaceMetadataRecovery} from '@contracts/workspaceCheckpoint';

export interface IWorkspaceDocumentRecovery extends ICanonicalAnnotationRecovery {metadata?: IWorkspaceMetadataRecovery;}
export interface IWorkspaceDocumentRecoveryPort {
    /** The document references the window's checkpoint names, for its change signature. */
    getWorkspaceDocumentRefsSignature?: () => readonly unknown[];
    /** What the document's drafts would hold now: `null` while the edit state is unavailable, `undefined` when the working bytes hold all of it. */
    captureCanonicalAnnotationRecovery?: () => IWorkspaceDocumentRecovery | null | undefined;
    /** Resolves once the document's drafts hold its unsaved work as it is now; rejects when it could not be stored. */
    commitDocumentDrafts?: () => Promise<void>;
    restoreCanonicalAnnotationRecovery?: (value: unknown) => ICanonicalAnnotationRecovery;
}
