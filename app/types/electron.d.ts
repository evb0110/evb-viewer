import type { IElectronAPI } from '@contracts/electronApi';
import type { TDocumentRef } from '@contracts/documentRef';
import type { ITypedStagedArtifact } from '@contracts/stagedArtifacts';
import type { IEvbTestApi } from '@app/types/evbTestApi';

declare global {
    interface Window {
        electronAPI?: IElectronAPI;
        __evbTransferAuthorityCommittedReadBarrier?: () => void | Promise<void>;
        __allowRendererFileOpenForAutomation?: (path: TDocumentRef) => Promise<boolean>;
        __deferDocumentOpenForAutomation?: (path: TDocumentRef) => boolean;
        __releaseDocumentOpenForAutomation?: (path: TDocumentRef) => boolean;
        __evbTestApi?: IEvbTestApi;
        __stagedPdfNativeMutationCommitBarrierForAutomation?: (
            stagedArtifact: ITypedStagedArtifact,
        ) => Promise<void> | void;
        __openFileDirect?: (path: TDocumentRef) => Promise<boolean>;
        __handleSave?: () => Promise<unknown>;
        __appReady?: boolean;
        __appReadyAt?: number;
        __logLevel?: unknown;
    }
}

export {};
