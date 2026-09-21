import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { IWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import { createDefaultWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import type { TPdfViewMode } from '@contracts/shared';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import {
    getWorkspaceViewModeCommandName,
    type TWorkspaceExposeMethod,
} from '@app/modules/workspace-shell/expose/workspaceExposeDescriptors';

interface IUseShellWorkspaceToolbarOptions {
    activeDocumentRecord: Readonly<Ref<IWorkspaceDocumentRecord | null | undefined>>;
    hasWorkspaceToolbarContent: Readonly<Ref<boolean>>;
}

export const useShellWorkspaceToolbar = (options: IUseShellWorkspaceToolbarOptions) => {
    const shellToolbarOcrPopupOpen = ref(false);
    const shellToolbarZoomDropdownOpen = ref(false);
    const shellToolbarPageDropdownOpen = ref(false);
    const shellToolbarOverflowMenuOpen = ref(false);
    const shellToolbarAppMenuOpen = ref(false);

    const shellToolbarSnapshot = computed<IWorkspaceToolbarSnapshot>(() => (
        options.activeDocumentRecord.value?.toolbarSnapshot ?? createDefaultWorkspaceToolbarSnapshot()
    ));
    const shellToolbarHasPdf = computed(() => shellToolbarSnapshot.value.hasPdf);
    const shellToolbarOcrWorkingCopyPath = computed<TDocumentRef | null>(() => (
        options.activeDocumentRecord.value?.documentIdentity?.documentRef ?? null
    ));
    const shellToolbarOcrDocumentRevision = computed<TDocumentRevisionToken | null>(() => (
        options.activeDocumentRecord.value?.documentIdentity?.token ?? null
    ));
    const showShellToolbar = computed(() => !options.hasWorkspaceToolbarContent.value);

    function createSnapshotFieldModel<TKey extends keyof IWorkspaceToolbarSnapshot>(key: TKey) {
        return computed({
            get: () => shellToolbarSnapshot.value[key],
            set: () => {},
        });
    }

    return {
        handleShellToolbarOverflowSetViewMode(mode: TPdfViewMode, runCommand: (commandName: TWorkspaceExposeMethod) => void) {
            runCommand(getWorkspaceViewModeCommandName(mode));
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
