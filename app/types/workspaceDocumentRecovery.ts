import type {ICanonicalAnnotationRecovery} from '@app/modules/pdf-viewer/public';
import type {IWorkspaceMetadataRecovery} from '@contracts/workspaceCheckpoint';

export interface IWorkspaceDocumentRecovery extends ICanonicalAnnotationRecovery {metadata?: IWorkspaceMetadataRecovery;}
export interface IWorkspaceDocumentRecoveryPort {
    captureCanonicalAnnotationRecovery?: () => IWorkspaceDocumentRecovery | null;
    restoreCanonicalAnnotationRecovery?: (value: unknown) => ICanonicalAnnotationRecovery;
}
