import type {
    IScanCleanupDocumentCanvasPlan,
    IScanCleanupPreviewRequest,
} from '@contracts/electronApiScanCleanup';
import {scanCleanupLayoutSignature} from '@contracts/scanCleanupPageOverrides';

// PNG preview bytes are read by the rendering-owned pipeline, never document PDFs.

/** Stable identity for two equivalent preview requests. */
export function previewIdentityKey(request: Omit<IScanCleanupPreviewRequest, 'detail'>) {
    return JSON.stringify({
        sourcePdfPath: request.sourcePdfPath,
        documentRevision: request.documentRevision,
        pageNumber: request.pageNumber,
        options: request.options,
        documentPrior: request.documentPrior ?? null,
        outputModeRecommendation: request.outputModeRecommendation ?? null,
        softAlphaForegroundRecommendation: request.softAlphaForegroundRecommendation ?? null,
        pagePlanEvidence: request.pagePlanEvidence ?? null,
        placementAnchors: request.placementAnchors ?? null,
        layoutDetectionComplete: request.options.matchPageSize
            ? request.layoutDetectionComplete === true
            : false,
        layouts: request.options.matchPageSize
            ? scanCleanupLayoutSignature(request.layoutByPage ?? {})
            : '',
    });
}

/** Identity for a base analysis after its document canvas is resolved. */
export function baseAnalysisKey(
    request: Omit<IScanCleanupPreviewRequest, 'detail'>,
    documentCanvas: IScanCleanupDocumentCanvasPlan | null,
) {
    const {
        outputModeRecommendation: _outputModeRecommendation,
        softAlphaForegroundRecommendation: _softAlphaForegroundRecommendation,
        ...geometryRequest
    } = request;
    return JSON.stringify({
        identity: previewIdentityKey(geometryRequest),
        documentCanvas,
    });
}
