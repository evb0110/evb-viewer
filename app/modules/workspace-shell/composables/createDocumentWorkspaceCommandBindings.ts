import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IPdfOptimizeProgress,
    TOpenFileResult,
} from '@contracts/electronApiDocuments';
import type { TStartSection } from '@app/types/startSection';
import type { IWorkspaceSplitCacheSessionState } from '@app/modules/workspace-shell/composables/workspaceSplitTypes';
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
    splitCacheSession?: IWorkspaceSplitCacheSessionState | null | undefined;
    startSection?: TStartSection | undefined;
}

export interface IDocumentWorkspaceEmits {
    'update:start-section': [section: TStartSection];
    'open-in-new-tab': [result: TDocumentRef | TOpenFileResult];
    'request-close-tab': [];
    'open-settings': [];
    'open-combine': [];
    'toggle-fullscreen': [];
}

interface IDocumentWorkspaceCommandEmitter {
    (event: 'update:start-section', section: TStartSection): void;
    (event: 'open-settings'): void;
    (event: 'open-combine'): void;
    (event: 'toggle-fullscreen'): void;
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
    surfaceMode: Ref<string>;
    discardScanCleanupState: () => void;
    handleOptimizeProgress: (progress: IPdfOptimizeProgress) => void;
    attach: () => void;
    detach: () => void;
}) => {
    let unsubscribeOptimizeProgress: (() => void) | null = null;
    onMounted(() => {
        unsubscribeOptimizeProgress = getDocumentMenuCapability().onPdfOptimizeProgress((progress) => {
            options.handleOptimizeProgress(progress);
        });
        options.attach();
    });
    onBeforeUnmount(() => {
        if (options.surfaceMode.value === 'scan-cleanup') {
            options.discardScanCleanupState();
        }
        unsubscribeOptimizeProgress?.();
        unsubscribeOptimizeProgress = null;
        options.detach();
    });
};
