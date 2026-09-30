import type { Ref } from 'vue';
import type { TAnnotationTool } from '@app/types/annotations';
import type { IWorkspacePdfViewerAnnotationToolsPort } from '@app/modules/workspace-shell/types/workspacePdfViewerPorts.types';

/**
 * The annotation tool one view has picked. Each view of a document has its
 * own, as it has its own selection (behavior contract T4); the tool defaults
 * and keep-active preference stay with the document.
 */
export const useViewAnnotationTool = (deps: {
    pdfViewerRef: Readonly<Ref<IWorkspacePdfViewerAnnotationToolsPort | null>>;
    dragMode: Ref<boolean>;
    annotationKeepActive: Readonly<Ref<boolean>>;
    closeAnnotationContextMenu: () => void;
}) => {
    const annotationTool = ref<TAnnotationTool>('none');

    function handleAnnotationToolChange(tool: TAnnotationTool) {
        deps.pdfViewerRef.value?.prepareAnnotationToolChange?.();
        annotationTool.value = tool;
        deps.dragMode.value = false;
        if (tool !== 'select') {
            deps.pdfViewerRef.value?.clearSelectedShape();
        }
        deps.closeAnnotationContextMenu();
    }

    function handleAnnotationToolAutoReset() {
        if (deps.annotationKeepActive.value && annotationTool.value !== 'note') {
            return;
        }
        annotationTool.value = 'select';
        deps.closeAnnotationContextMenu();
    }

    function handleAnnotationToolCancel() {
        handleAnnotationToolChange('select');
    }

    return {
        annotationTool,
        handleAnnotationToolChange,
        handleAnnotationToolAutoReset,
        handleAnnotationToolCancel,
    };
};
