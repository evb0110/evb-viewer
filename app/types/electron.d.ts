import type { IElectronAPI } from '@contracts/electronApi';
import type { TDocumentRef } from '@contracts/documentRef';
import type { ITypedStagedArtifact } from '@contracts/stagedArtifacts';
import type { IEvbTestApi } from '@app/types/evbTestApi';
import type { IAnnotationSyncAutomationActivity } from '@app/types/annotations';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import type {TClientDiagnosticsPreference} from '@contracts/diagnostics/diagnosticsPreference';
import type {TDiagnosticsCanaryAction} from '@electron/platform-ipc/coreContract';

type TRendererDiagnosticsCanaryKind = 'fatal-ui' | 'renderer' | 'ui-only' | 'worker-parent';

interface IDiagnosticsCanaryMainHealth {
    preference: TClientDiagnosticsPreference;
    transportReady: boolean;
}

interface IEvbDiagnosticsCanaryMainApi {trigger(action: TDiagnosticsCanaryAction): Promise<FailureReceipt | IDiagnosticsCanaryMainHealth | boolean | null>;}

interface IEvbRendererDiagnosticsCanaryApi {
    capture(kind: TRendererDiagnosticsCanaryKind): FailureReceipt;
    directConsoleError(): void;
    getPreference(): TClientDiagnosticsPreference;
    setPreference(preference: TClientDiagnosticsPreference): Promise<boolean>;
}

declare global {
    interface Window {
        electronAPI?: IElectronAPI;
        __evbTransferAuthorityCommittedReadBarrier?: () => void | Promise<void>;
        __allowRendererFileOpenForAutomation?: (path: TDocumentRef) => Promise<boolean>;
        __deferDocumentOpenForAutomation?: (path: TDocumentRef) => boolean;
        __releaseDocumentOpenForAutomation?: (path: TDocumentRef) => boolean;
        __evbTestApi?: IEvbTestApi;
        __evbDiagnosticsCanaryMain?: IEvbDiagnosticsCanaryMainApi;
        __evbRendererDiagnosticsCanary?: IEvbRendererDiagnosticsCanaryApi;
        __evbAnnotationSyncActivity?: IAnnotationSyncAutomationActivity;
        __stagedPdfNativeMutationCommitBarrierForAutomation?: (
            stagedArtifact: ITypedStagedArtifact,
        ) => Promise<void> | void;
        __allowLargeSerializedSaveForAutomation?: boolean;
        __openFileDirect?: (path: TDocumentRef) => Promise<boolean>;
        __handleSave?: () => Promise<unknown>;
        __appReady?: boolean;
        __appReadyAt?: number;
        __logLevel?: unknown;
    }
}

export {};
