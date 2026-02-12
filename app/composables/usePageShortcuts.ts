import {
    nextTick,
    type Ref,
} from 'vue';
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

function isTypingTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    if (target.isContentEditable) {
        return true;
    }
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return true;
    }
    return Boolean(target.closest('[contenteditable="true"], [contenteditable=""]'));
}

export const usePageShortcuts = (deps: IPageShortcutsDeps) => {
    const {
        pdfSrc,
        showSettings,
        annotationPlacingPageNote,
        pdfViewerRef,
        sidebarRef,
        shapePropertiesPopoverVisible,
        annotationContextMenuVisible,
        pageContextMenuVisible,
        closeAnnotationContextMenu,
        closePageContextMenu,
        closeShapeProperties,
        openSearch,
        openAnnotations,
        handleAnnotationToolChange,
    } = deps;

    function handleGlobalShortcut(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            closeAnnotationContextMenu();
            closePageContextMenu();
            closeShapeProperties();
            pdfViewerRef.value?.cancelCommentPlacement();
            annotationPlacingPageNote.value = false;
        }

        if ((event.metaKey || event.ctrlKey) && event.key === ',') {
            event.preventDefault();
            showSettings.value = true;
            return;
        }

        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && pdfSrc.value) {
            event.preventDefault();
            openSearch();
            nextTick(() => sidebarRef.value?.focusSearch());
            return;
        }

        if (!pdfSrc.value) {
            return;
        }

        if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) {
            return;
        }

        const key = event.key.toLowerCase();
        switch (key) {
            case 'v':
                handleAnnotationToolChange('none');
                return;
            case 'h':
                openAnnotations();
                handleAnnotationToolChange('highlight');
                return;
            case 'u':
                openAnnotations();
                handleAnnotationToolChange('underline');
                return;
            case 's':
                openAnnotations();
                handleAnnotationToolChange('strikethrough');
                return;
            case 'i':
                openAnnotations();
                handleAnnotationToolChange('draw');
                return;
            case 't':
                openAnnotations();
                handleAnnotationToolChange('text');
                return;
            case 'r':
                openAnnotations();
                handleAnnotationToolChange('rectangle');
                return;
            case 'c':
                openAnnotations();
                handleAnnotationToolChange('circle');
                return;
            case 'l':
                openAnnotations();
                handleAnnotationToolChange('line');
                return;
            case 'a':
                openAnnotations();
                handleAnnotationToolChange('arrow');
                return;
            case 'escape':
                handleAnnotationToolChange('none');
                return;
            case 'delete':
            case 'backspace':
                pdfViewerRef.value?.deleteSelectedShape();
                return;
            default:
                return;
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
        window.addEventListener('keydown', handleGlobalShortcut);
        window.addEventListener('pointerdown', handleGlobalPointerDown);
    }

    function cleanupShortcuts() {
        window.removeEventListener('keydown', handleGlobalShortcut);
        window.removeEventListener('pointerdown', handleGlobalPointerDown);
    }

    return {
        setupShortcuts,
        cleanupShortcuts,
    };
};
