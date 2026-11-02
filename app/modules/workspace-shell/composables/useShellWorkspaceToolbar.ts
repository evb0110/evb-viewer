import type { Ref } from 'vue';
import {
    useEventListener,
    useResizeObserver,
} from '@vueuse/core';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { IWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import { createDefaultWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import type { TPdfViewMode } from '@contracts/shared';
import type {
    IWorkspaceDocumentController,
    IWorkspaceDocumentView,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';

interface IUseShellWorkspaceToolbarOptions {
    activeDocumentSession: Readonly<Ref<IWorkspaceDocumentController | null>>;
    activeDocumentView: Readonly<Ref<IWorkspaceDocumentView | null>>;
    hasWorkspaceToolbarContent: Readonly<Ref<boolean>>;
    /** The reader toolbar the shell shows while no workspace toolbar is mounted. */
    fallbackToolbar: Readonly<Ref<HTMLElement | null>>;
    /** The toolbar the active workspace teleported into the shell. */
    workspaceToolbar: Readonly<Ref<HTMLElement | null>>;
    /** The toolbar's threshold set changes with the assistant toggle it shows. */
    assistantToggleShown: Readonly<Ref<boolean>>;
    /** The window's toolbar row is out of view: the shell is inactive, on a tool page or in zen mode. */
    isToolbarHidden: () => boolean;
}

export const useShellWorkspaceToolbar = (options: IUseShellWorkspaceToolbarOptions) => {
    const shellToolbarOcrPopupOpen = ref(false);
    const shellToolbarZoomDropdownOpen = ref(false);
    const shellToolbarPageDropdownOpen = ref(false);
    // The window's menus: one each per window, whichever document is active.
    const shellToolbarOverflowMenuOpen = ref(false);
    const shellToolbarAppMenuOpen = ref(false);

    // An open is the tab controller's phase from the command that starts it;
    // the workspace fills in its toolbar snapshot only once it has mounted.
    const isActiveTabOpening = computed(() => options.activeDocumentSession.value?.snapshot.value.phase === 'opening');
    const shellToolbarSnapshot = computed<IWorkspaceToolbarSnapshot>(() => {
        return options.activeDocumentView.value?.toolbarSnapshot.value ?? createDefaultWorkspaceToolbarSnapshot();
    });
    const shellToolbarHasPdf = computed(() => shellToolbarSnapshot.value.toolbarHasPdf || isActiveTabOpening.value);
    const shellToolbarDocumentBusy = computed(() => shellToolbarSnapshot.value.documentBusy || isActiveTabOpening.value);
    const shellToolbarOcrWorkingCopyPath = computed<TDocumentRef | null>(() => (
        options.activeDocumentSession.value?.snapshot.value.identity.revisionInfo?.documentRef ?? null
    ));
    const shellToolbarOcrDocumentRevision = computed<TDocumentRevisionToken | null>(() => (
        options.activeDocumentSession.value?.snapshot.value.identity.revisionInfo?.token ?? null
    ));
    const showShellToolbar = computed(() => !options.hasWorkspaceToolbarContent.value);
    // Scan cleanup brings its own toolbar, without the window's menus.
    const showShellMenus = computed(() => options.activeDocumentView.value?.viewState.value.surfaceMode !== 'scan-cleanup');

    // The reader toolbar's container queries decide which of its groups show,
    // so the prerendered page already has the final layout. More tools lists
    // what they hid; it reads the tier they set on the shown toolbar's probe.
    const shellToolbarCollapseTier = ref(0);
    const shownToolbar = computed(() => (
        showShellToolbar.value ? options.fallbackToolbar.value : options.workspaceToolbar.value
    ));
    function readCollapseTier() {
        const probe = shownToolbar.value?.querySelector('.toolbar-collapse-probe');
        shellToolbarCollapseTier.value = probe
            ? Number.parseInt(getComputedStyle(probe).getPropertyValue('--toolbar-collapse-tier'), 10) || 0
            : 0;
    }
    // The tier changes with the toolbar's width (and its rem-based height when
    // the UI scale changes), when another toolbar is shown, or with the layout's
    // threshold set, which can switch without a resize when the assistant
    // setting loads.
    useResizeObserver(shownToolbar, readCollapseTier);
    watch(options.assistantToggleShown, readCollapseTier, {flush: 'post'});

    // Opening one window menu closes the other and the active view's popovers.
    function updateShellMenuOpen(menu: Ref<boolean>, open: boolean) {
        menu.value = open;
        if (!open) {
            return;
        }
        for (const other of [
            shellToolbarAppMenuOpen,
            shellToolbarOverflowMenuOpen,
            shellToolbarOcrPopupOpen,
            shellToolbarZoomDropdownOpen,
            shellToolbarPageDropdownOpen,
        ]) {
            if (other !== menu) {
                other.value = false;
            }
        }
        options.activeDocumentView.value?.mountedWorkspace.value?.closeAllDropdowns();
    }
    // The menus outlive tab, pane and document changes; they close only when
    // the row that holds their triggers leaves the screen.
    watch(() => options.isToolbarHidden() || !showShellMenus.value, (hidden) => {
        if (hidden) {
            shellToolbarAppMenuOpen.value = false;
            shellToolbarOverflowMenuOpen.value = false;
        }
    });
    // A dialog takes over from a window menu, whichever command or shortcut opened it.
    useEventListener('focusin', (event) => {
        if (event.target instanceof Element && event.target.closest('[role="dialog"], [role="alertdialog"]')) {
            shellToolbarAppMenuOpen.value = false;
            shellToolbarOverflowMenuOpen.value = false;
        }
    });

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
        shellToolbarAppMenuOpen: computed({
            get: () => shellToolbarAppMenuOpen.value,
            set: open => updateShellMenuOpen(shellToolbarAppMenuOpen, open),
        }),
        shellToolbarCollapseTier,
        shellToolbarDocumentBusy,
        shellToolbarFitMode: createSnapshotFieldModel('fitMode'),
        shellToolbarHasPdf,
        isActiveTabOpening,
        shellToolbarOcrDocumentRevision,
        shellToolbarOcrPopupOpen,
        shellToolbarOcrWorkingCopyPath,
        shellToolbarOverflowMenuOpen: computed({
            get: () => shellToolbarOverflowMenuOpen.value,
            set: open => updateShellMenuOpen(shellToolbarOverflowMenuOpen, open),
        }),
        shellToolbarPageDropdownOpen,
        shellToolbarSnapshot,
        shellToolbarViewMode: createSnapshotFieldModel('viewMode'),
        shellToolbarZoom: createSnapshotFieldModel('zoom'),
        shellToolbarZoomMode: createSnapshotFieldModel('zoomMode'),
        shellToolbarZoomDropdownOpen,
        showShellMenus,
        showShellToolbar,
    };
};
