const MAX_ASSERTED_TOOLBAR_BODY_LAG_MS = 750;
const MAX_ASSERTED_BLANK_RUN_MS = 250;
const MAX_ASSERTED_INTERMEDIATE_VISUAL_AFTER_CLICK_RUN_MS = 120;
export const MAX_ASSERTED_TARGET_FEEDBACK_GEOMETRY_DELTA_PX = 2;

interface IPdfNavigationBlinkAssertionSummary {
    bodyCanvasReadyAtMs: number | null;
    bodyVisualReadyAtMs: number | null;
    finalTargetPage: number | null;
    lastClickAtMs: number | null;
    latePostClickSwapCount: number;
    maxCenteredBlankAfterClickRunMs: number;
    maxIntermediateVisualAfterClickRunMs: number;
    maxToolbarBodyLagMs: number;
    nonFinalPagedCommitAfterFinalRequestCount: number;
    nonFinalWorkspacePageAcceptAfterFinalRequestCount: number;
    outgoingVisualGeometryBaselineFound: boolean;
    outgoingVisualGeometryHeightDeltaPx: number;
    outgoingVisualGeometryWidthDeltaPx: number;
    postReadyUnstableSampleCount: number;
    rasterSchedulerSnapshots: unknown[];
    skeletonAfterVisualSampleCount: number;
    skeletonVisualOverlapSampleCount: number;
    targetCanvasRegressionSampleCount: number;
    targetFeedbackHeightDeltaPx: number;
    targetFeedbackWidthDeltaPx: number;
    translucentSkeletonCanvasOverlapSampleCount: number;
}

function hasValidRasterSchedulerSnapshot(snapshots: unknown[]) {
    return snapshots.some((snapshot) => {
        if (typeof snapshot !== 'object' || snapshot === null) {
            return false;
        }
        const candidate = snapshot as Record<string, unknown>;
        return (
            typeof candidate.accepting === 'boolean' &&
            typeof candidate.queueDepth === 'number' &&
            Number.isFinite(candidate.queueDepth) &&
            candidate.queueDepth >= 0 &&
            typeof candidate.reservedPixels === 'number' &&
            Number.isFinite(candidate.reservedPixels) &&
            candidate.reservedPixels >= 0 &&
            typeof candidate.queuedByLane === 'object' &&
            candidate.queuedByLane !== null &&
            typeof candidate.inFlightByLane === 'object' &&
            candidate.inFlightByLane !== null &&
            Array.isArray(candidate.inFlightPages) &&
            Array.isArray(candidate.residentPages)
        );
    });
}

export function assertPdfNavigationBlinkTraceSummary(summary: IPdfNavigationBlinkAssertionSummary) {
    const failures: string[] = [];
    if (!hasValidRasterSchedulerSnapshot(summary.rasterSchedulerSnapshots)) {
        failures.push('no valid raster scheduler snapshot was captured');
    }
    if (summary.skeletonVisualOverlapSampleCount > 0) {
        failures.push(`skeleton overlapped visual content in ${summary.skeletonVisualOverlapSampleCount} samples`);
    }
    if (summary.translucentSkeletonCanvasOverlapSampleCount > 0) {
        failures.push(
            'translucent skeleton overlapped mounted canvas in ' + `${summary.translucentSkeletonCanvasOverlapSampleCount} samples`,
        );
    }
    if (summary.skeletonAfterVisualSampleCount > 0) {
        failures.push(`skeleton appeared after visual readiness in ${summary.skeletonAfterVisualSampleCount} samples`);
    }
    if (summary.postReadyUnstableSampleCount > 0) {
        failures.push(`body was unstable after final target became visual in ${summary.postReadyUnstableSampleCount} samples`);
    }
    if (summary.targetCanvasRegressionSampleCount > 0) {
        failures.push(`target canvas regressed after readiness in ${summary.targetCanvasRegressionSampleCount} samples`);
    }
    if (summary.latePostClickSwapCount > 0) {
        failures.push(`target visual signature changed after clicks stopped ${summary.latePostClickSwapCount} times`);
    }
    if (summary.nonFinalPagedCommitAfterFinalRequestCount > 0) {
        failures.push(`non-final paged target committed after final request ${summary.nonFinalPagedCommitAfterFinalRequestCount} times`);
    }
    if (summary.nonFinalWorkspacePageAcceptAfterFinalRequestCount > 0) {
        failures.push(
            `workspace accepted non-final viewer page after final request ${summary.nonFinalWorkspacePageAcceptAfterFinalRequestCount} times`,
        );
    }
    if (summary.maxIntermediateVisualAfterClickRunMs > MAX_ASSERTED_INTERMEDIATE_VISUAL_AFTER_CLICK_RUN_MS) {
        failures.push(
            `intermediate centered visual page after clicks ran for ${summary.maxIntermediateVisualAfterClickRunMs}ms` +
                ` exceeding ${MAX_ASSERTED_INTERMEDIATE_VISUAL_AFTER_CLICK_RUN_MS}ms`,
        );
    }
    if (summary.maxToolbarBodyLagMs > MAX_ASSERTED_TOOLBAR_BODY_LAG_MS) {
        failures.push(`toolbar/body feedback lag ${summary.maxToolbarBodyLagMs}ms exceeded ${MAX_ASSERTED_TOOLBAR_BODY_LAG_MS}ms`);
    }
    if (summary.maxCenteredBlankAfterClickRunMs > MAX_ASSERTED_BLANK_RUN_MS) {
        failures.push(
            `centered blank visual run after clicks ${summary.maxCenteredBlankAfterClickRunMs}ms exceeded ${MAX_ASSERTED_BLANK_RUN_MS}ms`,
        );
    }
    if (
        summary.targetFeedbackHeightDeltaPx > MAX_ASSERTED_TARGET_FEEDBACK_GEOMETRY_DELTA_PX ||
        summary.targetFeedbackWidthDeltaPx > MAX_ASSERTED_TARGET_FEEDBACK_GEOMETRY_DELTA_PX
    ) {
        failures.push(
            `target feedback geometry changed by width=${summary.targetFeedbackWidthDeltaPx}px` +
                ` height=${summary.targetFeedbackHeightDeltaPx}px` +
                ` exceeding ${MAX_ASSERTED_TARGET_FEEDBACK_GEOMETRY_DELTA_PX}px`,
        );
    }
    if (summary.lastClickAtMs !== null && summary.finalTargetPage !== null && !summary.outgoingVisualGeometryBaselineFound) {
        failures.push('no outgoing visual geometry baseline was captured before the navigation click');
    }
    if (
        summary.outgoingVisualGeometryHeightDeltaPx > MAX_ASSERTED_TARGET_FEEDBACK_GEOMETRY_DELTA_PX ||
        summary.outgoingVisualGeometryWidthDeltaPx > MAX_ASSERTED_TARGET_FEEDBACK_GEOMETRY_DELTA_PX
    ) {
        failures.push(
            `outgoing committed visual geometry changed by width=${summary.outgoingVisualGeometryWidthDeltaPx}px` +
                ` height=${summary.outgoingVisualGeometryHeightDeltaPx}px before target arrival` +
                ` exceeding ${MAX_ASSERTED_TARGET_FEEDBACK_GEOMETRY_DELTA_PX}px`,
        );
    }
    if (summary.bodyVisualReadyAtMs === null) {
        failures.push('final target was never observed with visual-ready body content');
    }
    if (summary.bodyCanvasReadyAtMs === null) {
        failures.push('final target was never observed with centered canvas content');
    }

    if (failures.length > 0) {
        throw new Error(`PDF navigation blink trace assertions failed:\n${failures.join('\n')}`);
    }
}
