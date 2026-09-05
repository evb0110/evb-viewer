import type {
    IDocumentViewerExpose,
    IPdfViewerAnnotationCommandExpose,
    IPdfViewerAnnotationCommentExpose,
    IPdfViewerCropExpose,
    IPdfViewerExpose,
    IPdfViewerRegionCaptureExpose,
    IPdfViewerSaveExpose,
    IPdfViewerShapeExpose,
} from '@app/modules/pdf-viewer/public';

export type IWorkspacePdfViewerCropPort = IPdfViewerCropExpose;

export type IWorkspacePdfViewerSplitPort = IPdfViewerSaveExpose;

export interface IWorkspaceDocumentViewerNavigationPort extends Pick<IDocumentViewerExpose,
    'getCurrentPage'
    | 'scrollToPage'
> {}

export type IWorkspaceDocumentViewerSplitPort = IWorkspaceDocumentViewerNavigationPort;

export type IWorkspacePdfViewerRegionCapturePort = IPdfViewerRegionCaptureExpose;

export interface IWorkspacePdfViewerShortcutsPort extends Pick<IPdfViewerShapeExpose,
    'deleteSelectedShape'
> {}

export interface IWorkspacePdfViewerPageOpsPort extends
    Pick<IPdfViewerExpose, 'invalidatePages'>,
    Pick<IPdfViewerSaveExpose, 'runSaveTransaction'> {}

export interface IWorkspacePdfViewerAnnotationToolsPort extends
    Pick<IPdfViewerShapeExpose,
        'clearSelectedShape'
        | 'getSelectedShape'
        | 'selectedShapeId'
        | 'updateShape'
    >,
    Pick<IPdfViewerAnnotationCommandExpose,
        'selectedTextBox'
        | 'getSelectedTextBox'
        | 'updateSelectedTextBoxProperties'
    > {}

export interface IWorkspacePdfViewerAnnotationChangesPort extends
    Pick<IPdfViewerShapeExpose,
        'getAllShapes'
        | 'hasShapes'
    >,
    Pick<IPdfViewerSaveExpose,
        'runSaveTransaction'
    >,
    Pick<IPdfViewerAnnotationCommandExpose,
        'hasCanonicalShapeChanges'
    > {}

export interface IWorkspacePdfViewerAnnotationNotesPort extends Pick<IPdfViewerAnnotationCommentExpose,
    'updateAnnotationComment'
> {}

export interface IWorkspacePdfViewerAgentAnnotationNotePort extends
    Pick<IPdfViewerAnnotationCommentExpose,
        'moveAnnotationMarker'
        | 'updateAnnotationComment'
    >,
    Pick<IPdfViewerAnnotationCommandExpose,
        'registerAnnotationHistoryCommand'
    > {}

export interface IWorkspacePdfViewerAgentAnnotationCreationPort extends Pick<IPdfViewerAnnotationCommandExpose,
    'createPointNoteAnnotation'
    | 'createShapeAnnotation'
    | 'createTextMarkupFromText'
> {}

export interface IWorkspacePdfViewerAgentPageImageCapturePort extends
    Pick<IDocumentViewerExpose,
        'getViewerContainer'
        | 'scrollToPage'
    >,
    Pick<IPdfViewerExpose,
        'ensurePageMetricsInRange'
    > {}

export interface IWorkspacePdfViewerAgentPort extends
    IWorkspacePdfViewerAgentAnnotationCreationPort,
    IWorkspacePdfViewerAgentAnnotationNotePort,
    IWorkspacePdfViewerAgentPageImageCapturePort {}

export interface IWorkspacePdfViewerExposeAutomationPort extends
    Partial<Pick<IPdfViewerAnnotationCommandExpose,
        'commentAtPoint'
        | 'getAnnotationStorageDebugState'
        | 'highlightSelection'
    >>,
    Partial<Pick<IPdfViewerShapeExpose,
        'getAllShapes'
        | 'getDeletedEmbeddedShapeAnnotationIds'
        | 'getDeletedEmbeddedShapeStableKeys'
    >> {}

export interface IWorkspacePdfViewerAnnotationSessionPort extends
    IWorkspacePdfViewerAnnotationToolsPort,
    IWorkspacePdfViewerAnnotationChangesPort,
    IWorkspacePdfViewerAnnotationNotesPort {}

export interface IWorkspacePdfViewerInteractionPort extends
    IWorkspacePdfViewerShortcutsPort,
    IWorkspacePdfViewerCropPort,
    IWorkspacePdfViewerSplitPort,
    IWorkspacePdfViewerRegionCapturePort {}

export type IWorkspacePdfViewerDocumentControlsPort = IWorkspacePdfViewerPageOpsPort;
