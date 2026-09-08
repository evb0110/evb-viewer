import type * as WorkspaceOrchestration from '@app/modules/workspace-shell/types/workspaceOrchestration.types';

export type TPageAnnotationActionsPdfViewer = Pick<WorkspaceOrchestration.IPdfViewerExpose,
    'commentAtPoint'
    | 'commentSelection'
    | 'deleteAnnotationComment'
    | 'focusAnnotationComment'
    | 'getCurrentPage'
    | 'getViewerContainer'
    | 'highlightSelection'
    | 'invalidatePages'
    | 'removeAnnotationFromDom'
    | 'removeAnnotationFromInternalCache'
    | 'runSaveTransaction'
    | 'selectAnnotationById'
    | 'startImagePlacement'
    | 'updateAnnotationComment'
    | 'updateTextMarkupAnnotationColor'
> & Partial<Pick<WorkspaceOrchestration.IPdfViewerExpose,
    'registerAnnotationHistoryCommand'
    | 'clearPendingImagePlacement'
    | 'rerenderAnnotationPage'
    | 'restorePendingImagePlacement'
    | 'restoreAnnotationToInternalCache'
>>;
