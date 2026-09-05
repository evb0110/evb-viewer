import type { Ref } from 'vue';
import {
    useEventListener,
    useMagicKeys,
    whenever,
} from '@vueuse/core';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/public';
import type { TAnnotationTool } from '@app/types/annotations';
import type { TFitMode } from '@app/types/pdfContracts';
import type { TPdfSource } from '@app/types/pdfUi';
import type { TPdfViewMode } from '@contracts/shared';
import {
    getSpreadStartForPage,
    stepBySpread,
} from '@app/utils/pdfViewMode';
import { shouldHandleRendererMenuAccelerators } from '@app/utils/shouldHandleRendererMenuAccelerators';

interface IPdfViewerForShortcuts {deleteSelectedShape: () => void;}

interface IPageShortcutsDeps {
    isActive: Ref<boolean>;
    /**
     * Whether a document is open and interactive. Paging and the modifier
     * shortcuts key off this rather than `pdfSrc`, which is PDF-only and stays
     * null for DjVu.
     */
    hasInteractiveDocument: Ref<boolean>;
    /** The open PDF, for the shortcuts that only a PDF can service. */
    pdfSrc: Ref<TPdfSource | null>;
    canPrint: Ref<boolean>;
    canSave: Ref<boolean>;
    annotationTool: Ref<TAnnotationTool>;
    pdfViewerRef: Ref<IPdfViewerForShortcuts | null>;
    shapePropertiesPopoverVisible: Ref<boolean>;
    annotationContextMenuVisible: Ref<boolean>;
    pageContextMenuVisible: Ref<boolean>;
    closeAnnotationContextMenu: () => void;
    closePageContextMenu: () => void;
    closeShapeProperties: () => void;
    openSearch: () => void;
    handleAnnotationToolChange: (tool: TAnnotationTool) => void;
    handleZoomIn: () => void;
    handleZoomOut: () => void;
    handleActualSize: () => void;
    handleFitMode: (mode: TFitMode) => void;
    /**
     * Page the keyboard steps from. It is the pending navigation target while a
     * previous command is still travelling, so held PageDown composes instead of
     * replaying the same step against a lagging current page.
     */
    navigationPage: Ref<number>;
    totalPages: Ref<number>;
    viewMode: Ref<TPdfViewMode>;
    handleGoToPage: (page: number, options?: IScrollToPageOptions) => void;
    handleSave: () => void;
    handlePrint: () => void;
    handleToggleSidebar: () => void;
}

function isEditingText(target: EventTarget | null) {
    if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) {
        return false;
    }
    return Boolean(
        target.isContentEditable === true
        || Boolean(target.closest('[contenteditable="true"], [contenteditable=""]'))
        || Boolean(target.closest('input, textarea, select')),
    );
}

function isZoomInKey(event: KeyboardEvent) {
    return event.key === '=' || event.key === '+' || event.code === 'NumpadAdd';
}

function isZoomOutKey(event: KeyboardEvent) {
    return event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract';
}

function isActualSizeKey(event: KeyboardEvent) {
    return event.key === '0' || event.code === 'Digit0' || event.code === 'Numpad0';
}

function isFitWidthKey(event: KeyboardEvent) {
    return event.key === '1' || event.code === 'Digit1' || event.code === 'Numpad1';
}

function isFitHeightKey(event: KeyboardEvent) {
    return event.key === '2' || event.code === 'Digit2' || event.code === 'Numpad2';
}

function isPagingKey(event: KeyboardEvent) {
    return event.key === 'PageUp'
        || event.key === 'PageDown'
        || event.key === 'Home'
        || event.key === 'End';
}

function eventHasCommandModifier(event: KeyboardEvent) {
    return event.ctrlKey || event.metaKey;
}

function targetAsElement(target: EventTarget | null) {
    return typeof HTMLElement !== 'undefined' && target instanceof HTMLElement
        ? target
        : null;
}

export const usePageShortcuts = <TDeps extends IPageShortcutsDeps>(deps: TDeps) => {
    const {
        isActive,
        hasInteractiveDocument: interactiveDocument,
        pdfSrc,
        canPrint,
        annotationTool,
        shapePropertiesPopoverVisible,
        annotationContextMenuVisible,
        pageContextMenuVisible,
        closeAnnotationContextMenu,
        closePageContextMenu,
        closeShapeProperties,
        openSearch,
    } = deps;

    function handleEscape() {
        if (shapePropertiesPopoverVisible.value) {
            closeShapeProperties();
        }
        if (annotationContextMenuVisible.value) {
            closeAnnotationContextMenu();
        }
        if (pageContextMenuVisible.value) {
            closePageContextMenu();
        }
        if (annotationTool.value !== 'none') {
            deps.handleAnnotationToolChange('none');
        }
    }

    function handleDeleteShortcut(event: KeyboardEvent) {
        if ((event.key !== 'Delete' && event.key !== 'Backspace') || !pdfSrc.value) {
            return false;
        }
        event.preventDefault();
        deps.pdfViewerRef.value?.deleteSelectedShape();
        return true;
    }

    function handlePrintShortcut(event: KeyboardEvent, key: string, shouldHandleRendererAccelerators: boolean) {
        if (key !== 'p' || event.shiftKey || !shouldHandleRendererAccelerators) {
            return false;
        }
        event.preventDefault();
        if (!canPrint.value) {
            return true;
        }
        deps.handlePrint();
        return true;
    }

    function handleSaveShortcut(event: KeyboardEvent, key: string, shouldHandleRendererAccelerators: boolean) {
        if (key !== 's' || event.shiftKey || !shouldHandleRendererAccelerators || !pdfSrc.value) {
            return false;
        }
        event.preventDefault();
        if (!deps.canSave.value) {
            return true;
        }
        deps.handleSave();
        return true;
    }

    function handleSearchShortcut(event: KeyboardEvent, key: string) {
        if (key !== 'f' || event.shiftKey) {
            return false;
        }
        event.preventDefault();
        openSearch();
        return true;
    }

    function preventReactiveLetterShortcut(event: KeyboardEvent, key: string, shouldHandleRendererAccelerators: boolean) {
        if (key === 'b' || key === 'f') {
            event.preventDefault();
        }
        if (key === 's' && !event.shiftKey && shouldHandleRendererAccelerators) {
            event.preventDefault();
        }
    }

    function handleZoomShortcut(event: KeyboardEvent, shouldHandleRendererAccelerators: boolean) {
        if (!shouldHandleRendererAccelerators) {
            return false;
        }
        if (isZoomInKey(event)) {
            event.preventDefault();
            deps.handleZoomIn();
            return true;
        }
        if (isZoomOutKey(event)) {
            event.preventDefault();
            deps.handleZoomOut();
            return true;
        }
        if (isActualSizeKey(event)) {
            event.preventDefault();
            deps.handleActualSize();
            return true;
        }
        if (isFitWidthKey(event)) {
            event.preventDefault();
            deps.handleFitMode('width');
            return true;
        }
        if (isFitHeightKey(event)) {
            event.preventDefault();
            deps.handleFitMode('height');
            return true;
        }
        return false;
    }

    function resolvePagingTargetPage(event: KeyboardEvent, totalPages: number) {
        if (event.key === 'Home') {
            return 1;
        }
        if (event.key === 'End') {
            return totalPages;
        }
        const viewMode = deps.viewMode.value;
        const sourcePage = Math.min(
            Math.max(Math.trunc(deps.navigationPage.value) || 1, 1),
            totalPages,
        );
        const targetPage = stepBySpread(
            sourcePage,
            viewMode,
            totalPages,
            event.key === 'PageDown' ? 1 : -1,
        );
        // stepBySpread returns a spread start; the boundary spread returns the
        // spread the source page already sits in, which must not navigate
        // backwards to that spread's first page.
        return targetPage === getSpreadStartForPage(sourcePage, viewMode, totalPages)
            ? null
            : targetPage;
    }

    function handlePagingShortcut(event: KeyboardEvent) {
        if (!isPagingKey(event) || event.shiftKey || event.altKey || eventHasCommandModifier(event)) {
            return false;
        }
        // A closed document leaves the last one's page count behind, so the count
        // alone must never authorise paging. Without an interactive document,
        // the keys belong to the browser's own scrolling.
        if (!interactiveDocument.value) {
            return false;
        }
        const totalPages = Math.trunc(deps.totalPages.value);
        if (!Number.isFinite(totalPages) || totalPages <= 0) {
            return false;
        }
        event.preventDefault();
        const targetPage = resolvePagingTargetPage(event, totalPages);
        if (targetPage !== null) {
            deps.handleGoToPage(targetPage, {navigationSource: 'toolbar'});
        }
        return true;
    }

    function suppressBrowserDefaultForConflictingAccelerator(event: KeyboardEvent) {
        // Web-only: stop Chromium's built-in handlers (Save Page As, Print,
        // Open File) from hijacking these accelerators. On Electron the
        // OS menu accelerator delivers these shortcuts via menu:save / menu:print
        // IPC and we MUST NOT preventDefault here — doing so suppresses
        // the menu accelerator and makes Cmd+S a no-op in the desktop app.
        if (!shouldHandleRendererMenuAccelerators()) {
            return;
        }
        if (!eventHasCommandModifier(event) || event.altKey) {
            return;
        }
        const key = event.key.toLowerCase();
        if (key === 's' || key === 'p' || key === 'o') {
            event.preventDefault();
        }
    }

    function handleCapturedWebMenuAccelerator(event: KeyboardEvent) {
        if (!shouldHandleRendererMenuAccelerators()) {
            return;
        }
        if (!eventHasCommandModifier(event) || event.altKey) {
            return;
        }

        const key = event.key.toLowerCase();
        if (key !== 's' && key !== 'p' && key !== 'o') {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        if (!isActive.value || event.shiftKey) {
            return;
        }

        if (key === 's') {
            if (!pdfSrc.value || !deps.canSave.value) {
                return;
            }
            deps.handleSave();
            return;
        }
        if (key === 'p') {
            if (!canPrint.value) {
                return;
            }
            deps.handlePrint();
        }
    }

    function handleKeyboardShortcut(event: KeyboardEvent) {
        if (event.defaultPrevented) {
            return;
        }
        suppressBrowserDefaultForConflictingAccelerator(event);

        if (!isActive.value) {
            return;
        }

        const hasMod = eventHasCommandModifier(event);
        if (hasMod && event.altKey) {
            return;
        }

        if (event.key === 'Escape') {
            handleEscape();
            return;
        }

        const key = event.key.toLowerCase();
        const shouldHandleRendererAccelerators = shouldHandleRendererMenuAccelerators();
        if (hasMod) {
            if (handleSaveShortcut(event, key, shouldHandleRendererAccelerators)) {
                return;
            }
            if (handlePrintShortcut(event, key, shouldHandleRendererAccelerators)) {
                return;
            }
        }

        if (!hasMod || !interactiveDocument.value) {
            editableBlocked.value = isEditingText(event.target);
            if (editableBlocked.value) {
                return;
            }
            if (handleDeleteShortcut(event)) {
                return;
            }
            if (handlePagingShortcut(event)) {
                return;
            }
            return;
        }

        if (handleSearchShortcut(event, key)) {
            return;
        }

        editableBlocked.value = isEditingText(event.target);
        if (editableBlocked.value) {
            return;
        }

        preventReactiveLetterShortcut(event, key, shouldHandleRendererAccelerators);
        handleZoomShortcut(event, shouldHandleRendererAccelerators);
    }

    // Tracks whether the most recent keydown targeted an editable element,
    // so the reactive `whenever` watchers can skip those events.
    const editableBlocked = ref(false);

    const keys = useMagicKeys({
        passive: false,
        onEventFired(e) {
            if (e.type !== 'keydown') {
                return;
            }
            handleKeyboardShortcut(e);
        },
    });

    // Reactive guards shared by letter shortcuts
    // Optional chaining required because noUncheckedIndexedAccess is enabled
    // and useMagicKeys exposes keys via an index signature.
    const canFire = computed(() => isActive.value && !editableBlocked.value);
    const hasMod = computed(() => (keys.ctrl?.value ?? false) || (keys.meta?.value ?? false));
    const modReady = computed(() => canFire.value && hasMod.value && !(keys.alt?.value ?? false) && interactiveDocument.value);

    // Letter shortcuts — reactive via whenever
    whenever(() => modReady.value && (keys.b?.value ?? false), () => deps.handleToggleSidebar());
    // Pointerdown — close menus on outside clicks
    function handleGlobalPointerDown(event: PointerEvent) {
        if (!isActive.value) {
            return;
        }

        const target = targetAsElement(event.target);

        if (shapePropertiesPopoverVisible.value && !target?.closest('.annotation-properties')) {
            closeShapeProperties();
        }
        if (annotationContextMenuVisible.value && !target?.closest('.annotation-context-menu')) {
            closeAnnotationContextMenu();
        }
        if (pageContextMenuVisible.value && !target?.closest('.page-context-menu')) {
            closePageContextMenu();
        }
    }

    const windowTarget = typeof window !== 'undefined' && typeof window.addEventListener === 'function'
        ? window
        : null;
    useEventListener(windowTarget, 'pointerdown', handleGlobalPointerDown);
    useEventListener(windowTarget, 'keydown', handleCapturedWebMenuAccelerator, { capture: true });
};
