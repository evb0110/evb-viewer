import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { IWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import { createDefaultWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import type { TPdfViewMode } from '@contracts/shared';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';

interface IUseShellWorkspaceToolbarOptions {
    activeDocumentSession: Readonly<Ref<IWorkspaceDocumentController | null>>;
    hasWorkspaceToolbarContent: Readonly<Ref<boolean>>;
}

export const useShellWorkspaceToolbar = (options: IUseShellWorkspaceToolbarOptions) => {
    const shellToolbarOcrPopupOpen = ref(false);
    const shellToolbarZoomDropdownOpen = ref(false);
    const shellToolbarPageDropdownOpen = ref(false);
    const shellToolbarOverflowMenuOpen = ref(false);
    const shellToolbarAppMenuOpen = ref(false);

    const shellToolbarSnapshot = computed<IWorkspaceToolbarSnapshot>(() => (
        options.activeDocumentSession.value?.toolbarSnapshot.value ?? createDefaultWorkspaceToolbarSnapshot()
    ));
    const shellToolbarHasPdf = computed(() => shellToolbarSnapshot.value.hasPdf);
    const shellToolbarOcrWorkingCopyPath = computed<TDocumentRef | null>(() => (
        options.activeDocumentSession.value?.snapshot.value.identity.revisionInfo?.documentRef ?? null
    ));
    const shellToolbarOcrDocumentRevision = computed<TDocumentRevisionToken | null>(() => (
        options.activeDocumentSession.value?.snapshot.value.identity.revisionInfo?.token ?? null
    ));
    const showShellToolbar = computed(() => !options.hasWorkspaceToolbarContent.value);

    function createSnapshotFieldModel<TKey extends keyof IWorkspaceToolbarSnapshot>(key: TKey) {
        return computed({
            get: () => shellToolbarSnapshot.value[key],
            set: () => {},
        });
    }

    return {
        handleShellToolbarOverflowSetViewMode(mode: TPdfViewMode, runCommand: (commandName: string) => void) {
            runCommand(mode === 'single'
                ? 'handleViewModeSingle'
                : mode === 'facing' ? 'handleViewModeFacing' : 'handleViewModeFacingFirstSingle');
        },
        shellToolbarAppMenuOpen,
        shellToolbarEffectiveZoom: createSnapshotFieldModel('effectiveZoom'),
        shellToolbarFitMode: createSnapshotFieldModel('fitMode'),
        shellToolbarHasPdf,
        shellToolbarOcrDocumentRevision,
        shellToolbarOcrPopupOpen,
        shellToolbarOcrWorkingCopyPath,
        shellToolbarOverflowMenuOpen,
        shellToolbarPageDropdownOpen,
        shellToolbarSnapshot,
        shellToolbarViewMode: createSnapshotFieldModel('viewMode'),
        shellToolbarZoom: createSnapshotFieldModel('zoom'),
        shellToolbarZoomMode: createSnapshotFieldModel('zoomMode'),
        shellToolbarZoomDropdownOpen,
        showShellToolbar,
    };
};
