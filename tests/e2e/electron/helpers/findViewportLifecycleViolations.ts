import type {
    ICommittedSurfaceFrame,
    ICommittedSurfaceTrace,
} from '@tests/e2e/electron/helpers/viewerCommittedSurfaceContract';

export interface IViewportLifecycleContract {
    animationFrameToleranceMs?: number;
    expectedFinalPage: number;
    interactionCheckpoint: string;
    minimumSkeletonDelayMs?: number;
    rejectUnexpectedCanvasPages?: boolean;
    requireSkeleton?: boolean;
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
    if (
        frame.kind === 'blank'
        || frame.kind === 'loader'
        || frame.kind === 'neutral'
    ) {
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
        return `frame ${String(frame.frame)} did not keep its optional debounced skeleton inside the sole page-shell owner`;
    }
    if (
        frame.kind !== 'page-shell'
        && frame.skeletonCount > 0
    ) {
        return `frame ${String(frame.frame)} duplicated ${frame.kind} with a skeleton owner`;
    }
    return null;
}

const SKELETON_DEBOUNCE_ALLOWANCE_MS = 250;

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
    }

    // A preceding zoom/navigation transaction may still own the viewport when
    // the next intent is issued. Debounce belongs to the requested target
    // shell, not to any retained/stale page shell sampled before handoff.
    const skeletonFrames = frames.filter(frame => (
        frame.kind === 'page-shell'
        && frame.pageNumber === contract.expectedFinalPage
        && frame.skeletonCount > 0
    ));
    // A resident-canvas or warm reopen commits the target page without any
    // render delay; the skeleton contract only applies when the target page
    // actually had to wait for its render. The skeleton is deliberately
    // debounced, so a bare shell that commits within the debounce allowance
    // owes no skeleton. A missing skeleton is only a violation when another
    // sampled RAF proves that the same bare shell outlived the allowance;
    // elapsed time across an unsampled gap before canvas commit is not visual
    // evidence that the bare shell remained exposed.
    const bareTargetShellFrames = frames.filter(frame => (
        frame.kind === 'page-shell'
        && frame.pageNumber === contract.expectedFinalPage
        && frame.skeletonCount === 0
    ));
    const firstBareTargetShellFrame = bareTargetShellFrames[0];
    const overdueBareShellObserved = firstBareTargetShellFrame
        ? bareTargetShellFrames.some(frame => (
            frame.elapsedMs - firstBareTargetShellFrame.elapsedMs
            > SKELETON_DEBOUNCE_ALLOWANCE_MS
        ))
        : false;
    if (
        contract.requireSkeleton
        && skeletonFrames.length === 0
        && overdueBareShellObserved
    ) {
        violations.push('the controlled slow render never exposed its delayed page skeleton');
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
    if (contract.requireSkeleton === false && skeletonFrames.length > 0) {
        violations.push('the fast render flashed an intermediate page skeleton');
    }
    if (
        contract.minimumSkeletonDelayMs !== undefined
        && skeletonFrames[0]
    ) {
        const firstFrameElapsedMs = frames[0]!.elapsedMs;
        const skeletonDelayMs = skeletonFrames[0].elapsedMs - firstFrameElapsedMs;
        const minimumObservedDelayMs = contract.minimumSkeletonDelayMs
            - (contract.animationFrameToleranceMs ?? 34);
        if (skeletonDelayMs < minimumObservedDelayMs) {
            violations.push(
                `page skeleton appeared after ${String(skeletonDelayMs)}ms; expected the ${String(contract.minimumSkeletonDelayMs)}ms debounce`,
            );
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
