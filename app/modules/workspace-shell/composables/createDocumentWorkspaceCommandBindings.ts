import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IPdfOptimizeProgress,
    TOpenFileResult,
} from '@contracts/electronApiDocuments';
import type { TStartSection } from '@app/types/startSection';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IDocumentOpeningPageFrameAuthority } from '@app/modules/document-viewer/public';
import type { IWorkspaceSplitCacheSessionState } from '@app/modules/workspace-shell/composables/workspaceSplitTypes';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type { Ref } from 'vue';
import { getDocumentMenuCapability } from '@app/utils/platformDocuments';

export interface IDocumentWorkspaceProps {
    tabId: string;
    isActive: boolean;
    isRenderActive?: boolean | undefined;
    isTabTransitionBusy: boolean;
    isFullscreen: boolean;
    fullscreenSupported: boolean;
    isWorkspaceLayoutResizing?: boolean | undefined;
    documentSession: IWorkspaceDocumentController;
    initialViewState?: ITabViewSessionState | null | undefined;
    pendingDocumentOpen?: boolean | undefined;
    pendingDocumentPath?: TDocumentRef | null | undefined;
    suppressEmptyState?: boolean | undefined;
    splitCacheSession?: IWorkspaceSplitCacheSessionState | null | undefined;
    startSection?: TStartSection | undefined;
}

export interface IDocumentWorkspaceEmits {
    'update-document-record': [record: IWorkspaceDocumentRecord];
    'update:start-section': [section: TStartSection];
    'open-in-new-tab': [result: TDocumentRef | TOpenFileResult];
    'request-close-tab': [];
    'open-settings': [];
    'open-combine': [];
    'toggle-fullscreen': [];
    'viewer-owner-ready': [authority: IDocumentOpeningPageFrameAuthority];
    'expose-ready': [expose: IWorkspaceExpose];
    'expose-released': [expose: IWorkspaceExpose];
}

interface IDocumentWorkspaceCommandEmitter {
    (event: 'update:start-section', section: TStartSection): void;
    (event: 'open-settings'): void;
    (event: 'open-combine'): void;
    (event: 'toggle-fullscreen'): void;
}
interface IDocumentWorkspaceLifecycleEmitter {
    (event: 'expose-ready', expose: IWorkspaceExpose): void;
    (event: 'expose-released', expose: IWorkspaceExpose): void;
}

export function createDocumentWorkspaceCommandBindings(emit: IDocumentWorkspaceCommandEmitter) {
    return {
        handleStartSectionUpdate: (section: TStartSection) => emit('update:start-section', section),
        handleOpenSettings: () => emit('open-settings'),
        handleOpenCombine: () => emit('open-combine'),
        handleToggleFullscreen: () => emit('toggle-fullscreen'),
    };
}

export const useDocumentWorkspaceLifecycle = (options: {
    emit: IDocumentWorkspaceLifecycleEmitter;
    workspaceExpose: IWorkspaceExpose;
    surfaceMode: Ref<string>;
    discardScanCleanupState: () => void;
    disposeDeferredSearch: () => void;
    handleOptimizeProgress: (progress: IPdfOptimizeProgress) => void;
}) => {
    let unsubscribeOptimizeProgress: (() => void) | null = null;
    onMounted(() => {
        unsubscribeOptimizeProgress = getDocumentMenuCapability().onPdfOptimizeProgress((progress) => {
            options.handleOptimizeProgress(progress);
        });
        options.emit('expose-ready', options.workspaceExpose);
    });
    onBeforeUnmount(() => {
        if (options.surfaceMode.value === 'scan-cleanup') {
            options.discardScanCleanupState();
        }
        options.disposeDeferredSearch();
        unsubscribeOptimizeProgress?.();
        unsubscribeOptimizeProgress = null;
        options.emit('expose-released', options.workspaceExpose);
    });
};
