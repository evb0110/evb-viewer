import type {
    Component,
    Ref,
} from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import type { IWorkspaceViewerCapabilities } from '@app/types/workspaceExpose';
import type { IDocumentSourceActivation } from '@app/modules/workspace-shell/document-sessions/useDocumentSourceSession';

export type TWorkspaceViewerAdapterId = 'pdf' | 'djvu';
export type TWorkspaceViewerDocumentType = 'pdf' | 'image' | 'djvu';
export type TWorkspaceDocumentDriverId = 'pdfjs' | 'djvu';
export type TWorkspaceViewerRendererKind = 'pdfjs' | 'page-source';

export interface IWorkspaceViewerDriverProfile {
    id: TWorkspaceDocumentDriverId;
    isDjvu: boolean;
    isPdfjs: boolean;
    rendererKind: TWorkspaceViewerRendererKind;
    sourceKind: 'pdf' | 'djvu';
}

export interface IWorkspaceViewerOpenLifecycleState { previousWorkingCopyPath: TDocumentRef | null; }

export interface IWorkspaceViewerLifecycleContext {
    captureDjvuActivation: () => IDocumentSourceActivation | null;
    cleanupDjvuTemp: (expectedActivation: IDocumentSourceActivation) => Promise<boolean>;
    exitDjvuMode: (expectedActivation: IDocumentSourceActivation) => boolean;
    invalidatePendingDjvuOpen: () => void;
    isDjvuMode: Ref<boolean>;
    workingCopyPath: Ref<TDocumentRef | null>;
}

export interface IWorkspaceViewerLifecycleHooks {
    beforeOpen?: () => Promise<void> | void;
    afterOpen?: (
        outcome: TDocumentOpenOutcome,
        state: IWorkspaceViewerOpenLifecycleState,
    ) => Promise<void> | void;
    beforeClose?: () => Promise<void> | void;
}

export interface IWorkspaceViewerAdapter {
    id: TWorkspaceViewerAdapterId;
    driverProfile: IWorkspaceViewerDriverProfile;
    component: Component;
    documentTypes: readonly TWorkspaceViewerDocumentType[];
    capabilities: IWorkspaceViewerCapabilities;
    createLifecycleHooks?: (context: IWorkspaceViewerLifecycleContext) => IWorkspaceViewerLifecycleHooks;
}

export interface IWorkspaceViewerResolveContext {
    djvuSourcePath: TDocumentRef | null;
    isDjvuMode: boolean;
    pdfSourcePath: TDocumentRef | null;
}
