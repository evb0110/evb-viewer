import type { ITabMetadataCore } from '@contracts/windowTabs';
import type { TDocumentRef } from '@contracts/documentRef';

export interface ITab {
    id: string;
    fileName: ITabMetadataCore['fileName'];
    originalPath: ITabMetadataCore['originalPath'];
    originalBackend?: ITabMetadataCore['originalBackend'];
    documentInstanceId?: ITabMetadataCore['documentInstanceId'];
    isDirty: ITabMetadataCore['isDirty'];
    isDjvu: ITabMetadataCore['isDjvu'];
    /** The checkpoint working copy that must be recovered before source fallback. */
    recoveryWorkingCopyPath?: TDocumentRef;
}

export type TTabUpdate = Partial<Pick<ITab, 'fileName' | 'originalPath' | 'documentInstanceId' | 'isDirty' | 'isDjvu'>>;
