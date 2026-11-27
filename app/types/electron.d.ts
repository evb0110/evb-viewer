import type {TDocumentRef} from '@contracts/documentRef';
import type {ITypedStagedArtifact} from '@contracts/stagedArtifacts';
import type {IEvbTestApi} from '@app/types/evbTestApi';

/**
 * Opaque handle for the raw preload bridge exposed on `window.electronAPI`.
 * `Window` intentionally omits `electronAPI` in `app/` so renderer code cannot
 * call unadapted preload methods directly and must go through
 * `getRawElectronPlatformApi()` in `app/utils/electronPlatformBridge.ts`,
 * which adapts `AbortSignal` options before crossing `contextBridge`.
 */
export type TRawElectronBridgeHandle = object;

export interface IElectronBridgeWindow extends Window {
    electronAPI?: TRawElectronBridgeHandle;
}

declare global {
    interface Window {
        __evbTransferAuthorityCommittedReadBarrier?: () => void | Promise<void>;
        __allowRendererFileOpenForAutomation?: (path: TDocumentRef) => Promise<boolean>;
        __deferDocumentOpenForAutomation?: (path: TDocumentRef) => boolean;
        __releaseDocumentOpenForAutomation?: (path: TDocumentRef) => boolean;
        __evbTestApi?: IEvbTestApi;
        __stagedPdfNativeMutationCommitBarrierForAutomation?: (stagedArtifact: ITypedStagedArtifact) => Promise<void> | void;
        __openFileDirect?: (path: TDocumentRef) => Promise<boolean>;
        __handleSave?: () => Promise<unknown>;
        __appReady?: boolean;
        __appReadyAt?: number;
        __logLevel?: unknown;
    }
}

export {};
