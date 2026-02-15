import {
    nextTick,
    type Ref,
} from 'vue';
import { useEventListener } from '@vueuse/core';
import type { TAnnotationTool } from '@app/types/annotations';

interface IPdfViewerForShortcuts {
    cancelCommentPlacement: () => void;
    deleteSelectedShape: () => void;
}

interface ISidebarForShortcuts {focusSearch: () => void | Promise<void>;}

export interface IPageShortcutsDeps {
    pdfSrc: Ref<unknown>;
    showSettings: Ref<boolean>;
    annotationPlacingPageNote: Ref<boolean>;
    pdfViewerRef: Ref<IPdfViewerForShortcuts | null>;
    sidebarRef: Ref<ISidebarForShortcuts | null>;
    shapePropertiesPopoverVisible: Ref<boolean>;
    annotationContextMenuVisible: Ref<boolean>;
    pageContextMenuVisible: Ref<boolean>;
    closeAnnotationContextMenu: () => void;
    closePageContextMenu: () => void;
    closeShapeProperties: () => void;
    openSearch: () => void;
    openAnnotations: () => void;
    handleAnnotationToolChange: (tool: TAnnotationTool) => void;
}

export const usePageShortcuts = (deps: IPageShortcutsDeps) => {
    const {
        pdfSrc,
        sidebarRef,
        shapePropertiesPopoverVisible,
        annotationContextMenuVisible,
        pageContextMenuVisible,
        closeAnnotationContextMenu,
        closePageContextMenu,
        closeShapeProperties,
        openSearch,
    } = deps;
    const shortcutListenerCleanups: Array<() => void> = [];

    function handleGlobalShortcut(event: KeyboardEvent) {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && pdfSrc.value) {
            event.preventDefault();
            openSearch();
            nextTick(() => sidebarRef.value?.focusSearch());
        }
    }

    function handleGlobalPointerDown(event: PointerEvent) {
        const target = event.target instanceof HTMLElement ? event.target : null;

        if (shapePropertiesPopoverVisible.value) {
            if (!target?.closest('.annotation-properties')) {
                closeShapeProperties();
            }
        }

        if (annotationContextMenuVisible.value) {
            if (!target?.closest('.annotation-context-menu')) {
                closeAnnotationContextMenu();
            }
        }

        if (pageContextMenuVisible.value) {
            if (!target?.closest('.page-context-menu')) {
                closePageContextMenu();
            }
        }
    }

    function setupShortcuts() {
        shortcutListenerCleanups.push(useEventListener(window, 'keydown', handleGlobalShortcut));
        shortcutListenerCleanups.push(useEventListener(window, 'pointerdown', handleGlobalPointerDown));
    }

    function cleanupShortcuts() {
        while (shortcutListenerCleanups.length > 0) {
            const cleanup = shortcutListenerCleanups.pop();
            cleanup?.();
        }
    }

    return {
        setupShortcuts,
        cleanupShortcuts,
    };
};
