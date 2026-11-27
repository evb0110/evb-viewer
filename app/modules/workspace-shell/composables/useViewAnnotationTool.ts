import type { Ref } from 'vue';
import type { TAnnotationTool } from '@app/types/annotations';
import type { TDocumentSidebarTab } from '@app/modules/document-viewer/public';
import type { IWorkspacePdfViewerAnnotationToolsPort } from '@app/modules/workspace-shell/types/workspacePdfViewerPorts.types';

/**
 * The annotation tool one view has picked. Each view of a document has its
 * own, as it has its own selection (behavior contract T4); the tool defaults
 * and keep-active preference stay with the document.
 */
export const useViewAnnotationTool = (deps: {
    pdfViewerRef: Readonly<Ref<IWorkspacePdfViewerAnnotationToolsPort | null>>;
    dragMode: Ref<boolean>;
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<TDocumentSidebarTab>;
    annotationKeepActive: Readonly<Ref<boolean>>;
    closeAnnotationContextMenu: () => void;
}) => {
    const annotationTool = ref<TAnnotationTool>('none');

    /**
     * This view's one interaction command: once an open text edit has
     * finished, it sets the tool, the hand (which leaves the text selection)
     * and the sidebar tab to show; without one the sidebar stays as it was.
     */
    function handleAnnotationToolChange(tool: TAnnotationTool, interaction: {
        dragMode?: boolean;
        sidebarTab?: TDocumentSidebarTab;
    } = {}) {
        const apply = () => {
            annotationTool.value = tool;
            deps.dragMode.value = interaction.dragMode === true;
            if (interaction.dragMode) {window.getSelection()?.removeAllRanges();}
            if (interaction.sidebarTab) {
                deps.showSidebar.value = true;
                deps.sidebarTab.value = interaction.sidebarTab;
            }
            deps.closeAnnotationContextMenu();
            return true;
        };
        const pending = deps.pdfViewerRef.value?.prepareAnnotationToolChange?.();
        return pending ? pending.then(apply, () => false) : apply();
    }

    function handleAnnotationToolAutoReset() {
        if (deps.annotationKeepActive.value && annotationTool.value !== 'note') {
            return;
        }
        annotationTool.value = 'select';
        deps.closeAnnotationContextMenu();
    }

    function handleAnnotationToolCancel() {
        return handleAnnotationToolChange('select');
    }

    return {
        annotationTool,
        handleAnnotationToolChange,
        handleAnnotationToolAutoReset,
        handleAnnotationToolCancel,
    };
};
