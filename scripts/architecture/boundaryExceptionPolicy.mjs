export const SCRIPTS_TO_APP_ALLOWED_EDGES = Object.freeze([
    'scripts/diagnostics/pdfTraceEntryGuards.ts -> app/utils/logPdfNav.ts',
    'scripts/diagnostics/pdfTraceEntryGuards.ts -> app/utils/pdfRenderTrace.ts',
    'scripts/diagnostics/runPdfSkeletonNavigationDiagnostics.ts -> app/types/workspaceExpose.ts',
    'scripts/diagnostics/runPdfSkeletonNavigationDiagnostics.ts -> app/utils/logPdfNav.ts',
    'scripts/diagnostics/runPdfSkeletonNavigationDiagnostics.ts -> app/utils/pdfRenderTrace.ts',
    'scripts/diagnostics/pdfNavigationBlinkTrace.ts -> app/types/evbTestApi.ts',
]);

export const ANNOTATION_STORAGE_PRIVATE_ACCESS_ALLOWED_FILES = Object.freeze(['app/modules/pdf-viewer/runtime/save/pdfjsAnnotationDiagnostics.ts']);

export const PDF_VIEWER_ENGINE_RETAINED_BACK_EDGES = Object.freeze([Object.freeze({
    source: 'app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations.ts',
    targetRoots: Object.freeze([
        'app/modules/pdf-viewer/annotations/pdf-page-iteration',
        'app/modules/pdf-viewer/annotations/pdf-refs',
    ]),
})]);
