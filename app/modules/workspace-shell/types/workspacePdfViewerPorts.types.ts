import type {
    IDocumentViewerExpose,
    IPdfViewerAnnotationCommandExpose,
    IPdfViewerAnnotationCommentExpose,
    IPdfViewerCropExpose,
    IPdfViewerExpose,
    IPdfViewerSaveExpose,
    IPdfViewerShapeExpose,
} from '@app/modules/pdf-viewer/public';

export type IWorkspacePdfViewerCropPort = IPdfViewerCropExpose;

export type IWorkspacePdfViewerSplitPort = IPdfViewerSaveExpose;

export interface IWorkspacePdfViewerAnnotationToolsPort extends
    Pick<IPdfViewerAnnotationCommandExpose,
        'selectedAnnotations'
        | 'updateSelectedAnnotationProperties'
        | 'canRotateSelectedAnnotations'
        | 'prepareAnnotationToolChange'
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
        | 'captureCanonicalAnnotationRecovery'
        | 'restoreCanonicalAnnotationRecovery'
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
        | 'captureVisibleRegionAsPng'
    > {}

export interface IWorkspacePdfViewerAgentPort extends
    IWorkspacePdfViewerAgentAnnotationCreationPort,
    IWorkspacePdfViewerAgentAnnotationNotePort,
    IWorkspacePdfViewerAgentPageImageCapturePort {}

/** What the document asks any viewer of it about its shared annotation store. */
export interface IWorkspacePdfViewerAnnotationSessionPort extends
    IWorkspacePdfViewerAnnotationChangesPort,
    Pick<IPdfViewerAnnotationCommentExpose, 'updateAnnotationComment'>,
    Pick<IPdfViewerAnnotationCommandExpose,
        'getDeletedCanonicalAnnotationIds'
        | 'getDeletedPersistedCanonicalAnnotationCount'
    > {}
