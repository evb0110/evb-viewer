import type {ICanonicalAnnotationRecovery} from '@app/modules/pdf-viewer/public';
import type {IWorkspaceMetadataRecovery} from '@contracts/workspaceCheckpoint';

export interface IWorkspaceDocumentRecovery extends ICanonicalAnnotationRecovery {metadata?: IWorkspaceMetadataRecovery;}
export interface IWorkspaceDocumentRecoveryPort {
    getWorkspaceDocumentRecoveryChangeSignature?: () => readonly unknown[];
    captureCanonicalAnnotationRecovery?: () => IWorkspaceDocumentRecovery | null;
    restoreCanonicalAnnotationRecovery?: (value: unknown) => ICanonicalAnnotationRecovery;
}
