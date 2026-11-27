import {pdfViewerDomClasses} from '@app/modules/pdf-viewer/dom/pdf-viewer-dom/pdfViewerDomClasses';

export const pdfViewerDomSelectors = {
    pageContainer: `.${pdfViewerDomClasses.pageContainer}`,
    renderedPageContainer: `.${pdfViewerDomClasses.renderedPageContainer}`,
    pageCanvas: `.${pdfViewerDomClasses.pageCanvas}`,
    pageCanvasElement: `.${pdfViewerDomClasses.pageCanvas} canvas`,
    textLayer: `.${pdfViewerDomClasses.textLayer}`,
    textLayerAny: `.${pdfViewerDomClasses.textLayer}, .${pdfViewerDomClasses.textLayerPdfjs}`,
    annotationLayer: `.${pdfViewerDomClasses.annotationLayer}`,
    annotationLayerAny: `.${pdfViewerDomClasses.annotationLayer}, .${pdfViewerDomClasses.annotationLayerPdfjs}`,
    annotationEditorLayer: `.${pdfViewerDomClasses.annotationEditorLayer}`,
    annotationEditorLayerAny: `.${pdfViewerDomClasses.annotationEditorLayer}, .${pdfViewerDomClasses.annotationEditorLayerPdfjs}`,
    pageSkeleton: `.${pdfViewerDomClasses.pageSkeleton}`,
} as const;
