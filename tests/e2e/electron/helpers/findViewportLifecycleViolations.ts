import {
    isOpeningBeforePageGeometry,
    type ICommittedSurfaceFrame,
    type ICommittedSurfaceTrace,
} from '@tests/e2e/electron/helpers/viewerCommittedSurfaceContract';

export interface IViewportLifecycleContract {
    expectedFinalPage: number;
    interactionCheckpoint: string;
    rejectUnexpectedCanvasPages?: boolean;
    startAtOpenSurfaceClaim?: boolean;
}

function getCheckpointFrames(
    trace: ICommittedSurfaceTrace,
    contract: IViewportLifecycleContract,
) {
    const checkpointFrames = trace.frames.filter(
        frame => frame.interactionCheckpoint === contract.interactionCheckpoint,
    );
    if (!contract.startAtOpenSurfaceClaim) {
        return checkpointFrames;
    }

    // A Recent click first attempts to open the persisted path.
    // Retain those raw-click frames in the trace for diagnostics, but begin
    // the viewport-ownership contract only once the open transaction
    // positively claims its surface.
    const firstClaimedFrameIndex = checkpointFrames.findIndex(frame => (
        Boolean(frame.openSurfacePhase && frame.openSurfacePhase !== 'idle')
        || Boolean(frame.openSurfacePresentation && frame.openSurfacePresentation !== 'idle')
        || frame.kind === 'page-shell'
    ));
    return firstClaimedFrameIndex >= 0
        ? checkpointFrames.slice(firstClaimedFrameIndex)
        : [];
}

function findVisibleOwnerViolation(frame: ICommittedSurfaceFrame) {
    if (frame.kind === 'blank' && !isOpeningBeforePageGeometry(frame) || frame.kind === 'loader') {
        return `frame ${String(frame.frame)} exposed ${frame.kind} instead of one viewport owner: ${JSON.stringify({
            navigation: frame.pdfNavigationDiagnostic,
            openSurface: frame.openSurfaceDiagnostic,
            pageNumber: frame.pageNumber,
            shellRect: frame.shellRect,
            skeletons: frame.skeletonDiagnostics,
            targetCanvas: frame.targetPageCanvasDiagnostic,
        })}`;
    }
    if (frame.outOfFrameSkeletonCount > 0) {
        return `frame ${String(frame.frame)} exposed ${String(frame.outOfFrameSkeletonCount)} out-of-frame skeletons: ${JSON.stringify({
            navigation: frame.pdfNavigationDiagnostic,
            openSurface: frame.openSurfaceDiagnostic,
            skeletons: frame.skeletonDiagnostics,
            targetCanvas: frame.targetPageCanvasDiagnostic,
        })}`;
    }
    if (
        frame.kind === 'page-shell'
        && (
            frame.skeletonCount > 1
            || frame.skeletonCount === 1 && !frame.skeletonSharesShell
            || frame.shellId === null
        )
    ) {
        return `frame ${String(frame.frame)} did not keep its skeleton inside the sole page-shell owner`;
    }
    if (
        frame.kind !== 'page-shell'
        && frame.skeletonCount > 0
    ) {
        return `frame ${String(frame.frame)} duplicated ${frame.kind} with a skeleton owner`;
    }
    return null;
}

/**
 * Release contract for a single interaction generation. It deliberately
 * consumes RAF evidence rather than internal renderer state so stale commits,
 * blank frames, and skeleton ownership bugs remain observable end to end.
 */
export function findViewportLifecycleViolations(
    trace: ICommittedSurfaceTrace,
    contract: IViewportLifecycleContract,
) {
    const violations: string[] = [];
    const frames = getCheckpointFrames(trace, contract);
    if (frames.length < 2) {
        return [`checkpoint ${contract.interactionCheckpoint} sampled fewer than two RAFs`];
    }

    for (const frame of frames) {
        const ownerViolation = findVisibleOwnerViolation(frame);
        if (ownerViolation) {
            violations.push(ownerViolation);
        }
        if (frame.kind === 'committed-empty') {
            violations.push(`frame ${String(frame.frame)} retained the Recent surface after navigation was requested`);
        }
        if (
            frame.kind === 'page-shell'
            && frame.pageNumber === contract.expectedFinalPage
            && frame.openSurfacePresentation !== 'opening'
            && frame.pageVisualState !== 'ready'
            && frame.skeletonCount === 0
        ) {
            violations.push(`frame ${String(frame.frame)} exposed a bare pending target page`);
        }
    }

    if (contract.rejectUnexpectedCanvasPages) {
        for (const frame of frames) {
            if (
                frame.kind === 'committed-canvas'
                && frame.pageNumber !== contract.expectedFinalPage
            ) {
                violations.push(
                    `superseded page ${String(frame.pageNumber)} committed instead of page ${String(contract.expectedFinalPage)}`,
                );
            }
        }
    }
    const finalTargetFrameIndex = frames.findIndex(frame => (
        frame.kind === 'committed-canvas'
        && frame.pageNumber === contract.expectedFinalPage
    ));
    if (finalTargetFrameIndex < 0) {
        violations.push(`page ${String(contract.expectedFinalPage)} never committed a canvas`);
        return violations;
    }

    for (const frame of frames.slice(finalTargetFrameIndex + 1)) {
        if (
            frame.kind === 'committed-canvas'
            && frame.pageNumber !== contract.expectedFinalPage
        ) {
            violations.push(
                `stale page ${String(frame.pageNumber)} committed after page ${String(contract.expectedFinalPage)}`,
            );
        }
    }

    return violations;
}
