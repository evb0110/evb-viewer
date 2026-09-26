import type { Page } from 'puppeteer-core';
import { evaluateInPage } from '@tests/e2e/electron/helpers/pageRuntime';
import type { IPdfRenderTraceEntry } from '@contracts/pdfDiagnostics';
import {
    areTimingBudgetsEnforced,
    reportTimingBudgetMiss,
} from '@tests/e2e/electron/helpers/timingBudget';

export type TCommittedSurfaceKind =
    | 'blank'
    | 'committed-canvas'
    | 'committed-empty'
    | 'loader'
    | 'neutral'
    | 'page-shell'
    | 'tool-surface';

export type TCommittedEmptySource = 'live-empty-state';

export interface ICommittedSurfaceRect {
    height: number;
    left: number;
    top: number;
    width: number;
}

export interface ICommittedSurfaceStyle {
    backgroundColor: string;
    borderRadius: string;
    boxShadow: string;
}

export interface ICommittedSurfaceSkeletonDiagnostic {
    display: string;
    intersectsViewport: boolean;
    pageNumber: number | null;
    rect: ICommittedSurfaceRect | null;
}

export interface ICommittedSurfaceTargetCanvasDiagnostic {
    connected: boolean;
    hasSkeleton: boolean;
    pageNumber: number | null;
    rect: ICommittedSurfaceRect | null;
    renderedClass: boolean;
}

export interface ICommittedSurfaceVisiblePdfPageVisual {
    canonicalCanvasId: number | null;
    canonicalCanvasNonblank: boolean;
    canonicalCanvasVisible: boolean;
    pageNumber: number | null;
    skeletonVisible: boolean;
}

export interface ICommittedSurfaceFrame {
    bodyOverflow: number;
    canvasAuthorityReady: boolean;
    canvasConnected?: boolean;
    canvasId?: number | null;
    canvasNonblank: boolean;
    canvasOuterHtml?: string | null;
    canvasPixelHeight?: number | null;
    canvasPixelWidth?: number | null;
    canvasSharesRenderLayer?: boolean;
    committedEmptyElementPath?: string | null;
    committedEmptySource: TCommittedEmptySource | null;
    documentOverflow: number;
    emptyStateOwnsCenter?: boolean;
    elapsedMs: number;
    frame: number;
    /** Diagnostic-only DOM evidence for a visible loader selected by the sampler. */
    loaderOuterHtml?: string | null;
    loaderSelector?: string | null;
    kind: TCommittedSurfaceKind;
    interactionCheckpoint?: string | null;
    openSurfacePhase?: string | null;
    openSurfacePresentation?: string | null;
    openSurfaceDiagnostic?: Record<string, string | undefined> | undefined;
    pdfOpeningDiagnostic?: Record<string, string | undefined> | undefined;
    pdfNavigationDiagnostic?: Record<string, string | undefined> | undefined;
    outerPlaceholderPresent?: boolean;
    outerPlaceholderOwnsCenter?: boolean;
    outerPlaceholderVisible?: boolean;
    pageCanvasChildren?: string[];
    pageCanvasNonzeroCanvasCount?: number;
    pageClassName?: string | null;
    pageVisualState?: string | null;
    outOfFrameSkeletonCount: number;
    pageNumber: number | null;
    shellId: number | null;
    shellRect: ICommittedSurfaceRect | null;
    shellStyle: ICommittedSurfaceStyle | null;
    skeletonCount: number;
    skeletonPages?: Array<number | null>;
    skeletonDiagnostics?: ICommittedSurfaceSkeletonDiagnostic[];
    skeletonSharesShell: boolean;
    skeletonRect: ICommittedSurfaceRect | null;
    skeletonStyle: ICommittedSurfaceStyle | null;
    skeletonDisplay?: string | null;
    topElementPath?: string | null;
    targetPageCanvasDiagnostic?: ICommittedSurfaceTargetCanvasDiagnostic;
    viewportHasHorizontalOverflow: boolean | null;
    viewportClientHeight?: number | null;
    viewportClientWidth?: number | null;
    viewportOverflow: number | null;
    viewportScrollHeight?: number | null;
    viewportScrollLeft?: number | null;
    viewportScrollTop?: number | null;
    viewportScrollWidth?: number | null;
    visiblePdfPageVisuals?: ICommittedSurfaceVisiblePdfPageVisual[];
}

export interface ICommittedSurfaceSamplerError {
    checkpoint: string | null;
    elapsedMs: number;
    frame: number;
    message: string;
}

export interface ICommittedSurfaceTrace {
    errors?: ICommittedSurfaceSamplerError[];
    frames: ICommittedSurfaceFrame[];
}

export interface ICommittedSurfaceSamplerOptions {sampleCanvasPixels?: boolean;}

export interface ICommittedSurfaceSampleWaitOptions {
    interactionCheckpoint?: string;
    kind?: TCommittedSurfaceKind;
    minimumSamples: number;
    pollIntervalMs?: number;
    timeoutMs?: number;
}

export interface ICommittedSurfaceCausalOpenContract {
    maxFirstCanvasMs: number;
    maxFirstPageShellMs: number;
    maxReadyAfterCanvasMs: number;
    requirePageShell: boolean;
    /** Allow the explicit cold-shell handoff before opening geometry exists. */
    allowDeferredOpening?: boolean;
}

export interface ICommittedSurfaceTiming {
    firstCanvasMs: number | null;
    firstPageShellMs: number | null;
    readyAfterCanvasMs: number | null;
}

export interface ICommittedSurfaceInteractionTailContract {
    allowedSkeletonCheckpoints?: readonly string[];
    expectedPageByCheckpoint: Readonly<Record<string, number>>;
    horizontalOverflowCheckpoint: string;
    minStableFrames?: number;
    preserveShellIdentityAcross: ReadonlyArray<readonly string[]>;
    preserveWidthAcross: ReadonlyArray<readonly string[]>;
    stableCheckpoints: readonly string[];
}

function sameRect(
    left: ICommittedSurfaceRect | null,
    right: ICommittedSurfaceRect | null,
    tolerance = 1,
) {
    return Boolean(
        left
        && right
        && Math.abs(left.height - right.height) <= tolerance
        && Math.abs(left.left - right.left) <= tolerance
        && Math.abs(left.top - right.top) <= tolerance
        && Math.abs(left.width - right.width) <= tolerance,
    );
}

function sameStyle(left: ICommittedSurfaceStyle | null, right: ICommittedSurfaceStyle | null) {
    return Boolean(
        left
        && right
        && left.backgroundColor === right.backgroundColor
        && left.borderRadius === right.borderRadius
        && left.boxShadow === right.boxShadow,
    );
}

function ownsPageFrameStyle(style: ICommittedSurfaceStyle | null) {
    return Boolean(
        style
        && style.backgroundColor !== 'rgba(0, 0, 0, 0)'
        && style.backgroundColor !== 'transparent'
        && style.borderRadius !== '0px'
        && style.boxShadow !== 'none',
    );
}

/** Returns release-blocking contract violations, keeping Vitest assertions out of the helper. */
export function findCommittedSurfaceContractViolations(
    trace: ICommittedSurfaceTrace,
    options: {allowDeferredOpening?: boolean} = {},
) {
    const violations = trace.errors?.map(error => (
        `surface sampler failed at frame ${String(error.frame)} (${error.checkpoint ?? 'unmarked'}): ${error.message}`
    )) ?? [];
    const frames = trace.frames;
    if (frames.length < 2) {
        return ['fewer than two animation frames were sampled'];
    }

    for (const frame of frames) {
        const isExplicitDeferredOpening = options.allowDeferredOpening === true
            && frame.kind === 'blank'
            && frame.openSurfacePhase === 'pending'
            && frame.pdfNavigationDiagnostic?.openingSurfaceDeferred === 'true';
        if (
            (frame.kind === 'blank' || frame.kind === 'loader' || frame.kind === 'neutral')
            && !isExplicitDeferredOpening
        ) {
            violations.push(`frame ${String(frame.frame)} exposed ${frame.kind}`);
        }
        if (frame.kind === 'committed-empty' && frame.committedEmptySource === null) {
            violations.push(`frame ${String(frame.frame)} claimed committed-empty without visible empty-state content`);
        }
        if (frame.outOfFrameSkeletonCount > 0) {
            violations.push(`frame ${String(frame.frame)} exposed a skeleton outside the actual page canvas wrapper`);
        }
        if (frame.kind === 'committed-canvas' && frame.canvasSharesRenderLayer === false) {
            violations.push(`frame ${String(frame.frame)} canvas escaped the imperative render layer`);
        }
        if (frame.kind === 'committed-canvas' && frame.skeletonCount > 0) {
            violations.push(`frame ${String(frame.frame)} retained a skeleton over the committed visual`);
        }
        if (
            frame.kind === 'page-shell'
            && (
                frame.shellId === null
                || frame.skeletonCount > 1
                || frame.skeletonCount === 1 && !frame.skeletonSharesShell
            )
        ) {
            violations.push(`frame ${String(frame.frame)} did not keep its optional debounced skeleton inside the actual page shell`);
        }
        if (
            frame.kind === 'page-shell'
            && frame.skeletonCount === 1
            && (
                !sameRect(frame.skeletonRect, frame.shellRect)
                || frame.skeletonStyle?.backgroundColor !== frame.shellStyle?.backgroundColor
                || frame.skeletonStyle?.borderRadius !== frame.shellStyle?.borderRadius
                || frame.skeletonStyle?.boxShadow !== 'none'
            )
        ) {
            violations.push(`frame ${String(frame.frame)} skeleton did not fill the wrapper without a competing frame`);
        }
        if (frame.kind === 'page-shell' && !ownsPageFrameStyle(frame.shellStyle)) {
            violations.push(`frame ${String(frame.frame)} shared wrapper did not own the visible page frame style`);
        }
        if (frame.bodyOverflow > 1 || frame.documentOverflow > 1) {
            violations.push(`frame ${String(frame.frame)} leaked horizontal overflow outside the viewer`);
        }
    }

    const overflowStates = frames
        .map(frame => frame.viewportHasHorizontalOverflow)
        .filter((value): value is boolean => value !== null);
    let overflowTransitions = 0;
    for (let index = 1; index < overflowStates.length; index += 1) {
        if (overflowStates[index] !== overflowStates[index - 1]) {
            overflowTransitions += 1;
        }
    }
    if (overflowTransitions > 1) {
        violations.push(`viewer horizontal-overflow state pulsed ${String(overflowTransitions)} times`);
    }

    const finalCanvas = frames.findLast(frame => frame.kind === 'committed-canvas');
    const firstCanvasIndex = finalCanvas
        ? frames.findIndex(frame => (
            frame.kind === 'committed-canvas' && frame.shellId === finalCanvas.shellId
        ))
        : -1;
    if (firstCanvasIndex < 0) {
        violations.push('no committed canvas became visible');
        return violations;
    }
    const firstCanvas = frames[firstCanvasIndex]!;
    if (!firstCanvas.canvasAuthorityReady || firstCanvas.shellId === null) {
        violations.push('the first canvas frame lacked connected render authority');
    }
    if (!ownsPageFrameStyle(firstCanvas.shellStyle)) {
        violations.push('the committed canvas wrapper did not own the visible page frame style');
    }

    // The opening shell may present with fallback dimensions before the
    // document's real geometry is known; geometry stability is only
    // meaningful once the surface first reports committed geometry. Only the
    // leading provisional frames are exempt: a geometry flap after the first
    // valid report must remain a violation.
    const allShellFrames = frames.slice(0, firstCanvasIndex)
        .filter(frame => frame.kind === 'page-shell');
    const firstGeometryIndex = allShellFrames.findIndex(frame => (
        frame.openSurfaceDiagnostic?.openSurfaceHasGeometry !== 'false'
    ));
    const shellFrames = firstGeometryIndex < 0 ? [] : allShellFrames.slice(firstGeometryIndex);
    const firstShell = shellFrames[0];
    if (firstShell) {
        for (const shell of shellFrames.slice(1)) {
            if (shell.pageNumber !== firstShell.pageNumber) {
                violations.push(
                    `page shell target changed from page ${String(firstShell.pageNumber)} to ${String(shell.pageNumber)} at frame ${String(shell.frame)}`,
                );
            }
            if (!sameRect(shell.shellRect, firstShell.shellRect)) {
                violations.push(`page shell geometry changed before canvas commit at frame ${String(shell.frame)}`);
            }
            if (!sameStyle(shell.shellStyle, firstShell.shellStyle)) {
                violations.push(`page shell style changed before canvas commit at frame ${String(shell.frame)}`);
            }
        }
    }
    for (const shell of shellFrames) {
        if (!sameRect(shell.shellRect, firstCanvas.shellRect)) {
            violations.push(
                `page shell geometry changed at canvas commit (frame ${String(shell.frame)}): ${JSON.stringify({
                    canvas: firstCanvas.shellRect,
                    canvasPage: firstCanvas.pageNumber,
                    shell: shell.shellRect,
                    shellPage: shell.pageNumber,
                })}`,
            );
        }
        if (!sameStyle(shell.shellStyle, firstCanvas.shellStyle)) {
            violations.push(`page shell style changed at canvas commit (frame ${String(shell.frame)})`);
        }
        if (shell.skeletonRect && !sameRect(shell.skeletonRect, firstCanvas.shellRect)) {
            violations.push(
                `skeleton geometry changed at canvas commit (frame ${String(shell.frame)}): ${JSON.stringify({
                    canvas: firstCanvas.shellRect,
                    canvasPage: firstCanvas.pageNumber,
                    skeleton: shell.skeletonRect,
                    shellPage: shell.pageNumber,
                })}`,
            );
        }
    }

    // The first canvas is the hand-off boundary, not the beginning of a grace
    // period. Compare every subsequent RAF for this exact wrapper so a
    // one-frame widen/snapback cannot hide before the stable-tail sample.
    const committedCanvasFrames = frames.slice(firstCanvasIndex).filter(frame => (
        frame.kind === 'committed-canvas' && frame.shellId === firstCanvas.shellId
    ));
    for (const canvasFrame of committedCanvasFrames.slice(1)) {
        if (
            !sameRect(canvasFrame.shellRect, firstCanvas.shellRect)
            || !sameStyle(canvasFrame.shellStyle, firstCanvas.shellStyle)
        ) {
            violations.push(`committed canvas geometry or style changed after first paint at frame ${String(canvasFrame.frame)}`);
        }
    }

    const oldCommittedCanvas = frames.slice(0, firstCanvasIndex).find(frame => (
        frame.kind === 'committed-canvas'
        && frame.shellId !== firstCanvas.shellId
    ));
    if (oldCommittedCanvas) {
        const oldFrames = frames.slice(0, firstCanvasIndex).filter(frame => (
            frame.kind === 'committed-canvas' && frame.shellId === oldCommittedCanvas.shellId
        ));
        for (const oldFrame of oldFrames) {
            if (
                !sameRect(oldFrame.shellRect, oldCommittedCanvas.shellRect)
                || !sameStyle(oldFrame.shellStyle, oldCommittedCanvas.shellStyle)
            ) {
                violations.push(`old committed surface changed before swap (frame ${String(oldFrame.frame)})`);
            }
        }
        if (frames.slice(firstCanvasIndex + 1).some(frame => frame.shellId === oldCommittedCanvas.shellId)) {
            violations.push('old committed surface returned after the new surface swap');
        }
    }

    const stableTail = frames.filter(frame => frame.kind === 'committed-canvas').slice(-10);
    if (stableTail.length < 10) {
        violations.push('fewer than ten committed-canvas RAFs were observed');
    } else {
        const baseline = stableTail[0]!;
        for (const frame of stableTail.slice(1)) {
            if (
                frame.shellId !== baseline.shellId
                || !sameRect(frame.shellRect, baseline.shellRect)
                || !sameStyle(frame.shellStyle, baseline.shellStyle)
                || frame.viewportHasHorizontalOverflow !== baseline.viewportHasHorizontalOverflow
            ) {
                violations.push(`committed canvas was not stable through frame ${String(frame.frame)}`);
            }
        }
    }

    return violations;
}

/**
 * Adds the causal empty-to-document timing and authority checks used by the
 * release lane. Every open uses the same canonical page-shell-to-canvas handoff.
 */
export function findCommittedSurfaceCausalOpenViolations(
    trace: ICommittedSurfaceTrace,
    contract: ICommittedSurfaceCausalOpenContract,
) {
    const violations = findCommittedSurfaceContractViolations(
        trace,
        contract.allowDeferredOpening === undefined
            ? {}
            : {allowDeferredOpening: contract.allowDeferredOpening},
    );
    const frames = trace.frames;
    const firstPageShell = frames.find(frame => frame.kind === 'page-shell');
    const firstCanvas = frames.find(frame => frame.kind === 'committed-canvas');

    if (contract.requirePageShell && !firstPageShell) {
        violations.push('no in-frame page shell was presented before the first canvas');
    }
    // Budget misses are timing, not ordering: they fail only where budgets are
    // enforced and are reported everywhere else.
    const budgetMisses: string[] = [];
    if (
        firstPageShell
        && firstPageShell.elapsedMs > contract.maxFirstPageShellMs
    ) {
        budgetMisses.push(
            `first page shell missed its ${String(contract.maxFirstPageShellMs)}ms budget (${String(firstPageShell.elapsedMs)}ms)`,
        );
    }
    if (
        firstCanvas
        && firstCanvas.elapsedMs > contract.maxFirstCanvasMs
    ) {
        budgetMisses.push(
            `first canvas missed its ${String(contract.maxFirstCanvasMs)}ms budget (${String(firstCanvas.elapsedMs)}ms)`,
        );
    }

    if (firstCanvas) {
        const readyFrame = frames.find(frame => (
            frame.frame >= firstCanvas.frame
            && frame.openSurfacePhase === 'ready'
            && frame.openSurfacePresentation === 'committed'
        ));
        if (!readyFrame) {
            violations.push('open surface did not reach ready/committed after the first canvas');
        } else {
            const readyAfterCanvasMs = readyFrame.elapsedMs - firstCanvas.elapsedMs;
            if (readyAfterCanvasMs > contract.maxReadyAfterCanvasMs) {
                budgetMisses.push(
                    `open surface missed its ${String(contract.maxReadyAfterCanvasMs)}ms post-canvas readiness budget (${String(readyAfterCanvasMs)}ms)`,
                );
            }
        }
    }

    const phaseRanks: Readonly<Record<string, number>> = {
        idle: 0,
        pending: 1,
        'geometry-committed': 2,
        'canvas-committed': 3,
        'viewport-committed': 4,
        ready: 5,
    };
    const observedPhases = frames
        .map(frame => ({
            frame: frame.frame,
            phase: frame.openSurfacePhase,
        }))
        .filter((entry): entry is {
            frame: number;
            phase: string;
        } => (
            entry.phase !== null
            && entry.phase !== undefined
            && phaseRanks[entry.phase] !== undefined
        ));
    for (let index = 1; index < observedPhases.length; index += 1) {
        const previous = observedPhases[index - 1]!;
        const current = observedPhases[index]!;
        if (phaseRanks[current.phase]! < phaseRanks[previous.phase]!) {
            violations.push(
                `open-surface authority regressed from ${previous.phase} to ${current.phase} at frame ${String(current.frame)}`,
            );
        }
    }

    if (areTimingBudgetsEnforced()) {
        violations.push(...budgetMisses);
    } else {
        budgetMisses.forEach(reportTimingBudgetMiss);
    }
    return violations;
}

export function summarizeCommittedSurfaceTiming(
    trace: ICommittedSurfaceTrace,
): ICommittedSurfaceTiming {
    const firstPageShell = trace.frames.find(frame => frame.kind === 'page-shell');
    const firstCanvas = trace.frames.find(frame => frame.kind === 'committed-canvas');
    const readyFrame = firstCanvas
        ? trace.frames.find(frame => (
            frame.frame >= firstCanvas.frame
            && frame.openSurfacePhase === 'ready'
            && frame.openSurfacePresentation === 'committed'
        ))
        : undefined;
    return {
        firstCanvasMs: firstCanvas?.elapsedMs ?? null,
        firstPageShellMs: firstPageShell?.elapsedMs ?? null,
        readyAfterCanvasMs: firstCanvas && readyFrame
            ? readyFrame.elapsedMs - firstCanvas.elapsedMs
            : null,
    };
}

/**
 * Validates the interaction tail after the initial canvas has committed. Each
 * stable checkpoint is deliberately marked only after the corresponding view
 * authority settles; all transition RAFs remain in the trace and are checked
 * for placeholder/skeleton regressions and overflow pulses.
 */
export function findCommittedSurfaceInteractionTailViolations(
    trace: ICommittedSurfaceTrace,
    contract: ICommittedSurfaceInteractionTailContract,
) {
    const violations = trace.errors?.map(error => (
        `surface sampler failed at frame ${String(error.frame)} (${error.checkpoint ?? 'unmarked'}): ${error.message}`
    )) ?? [];
    const frames = trace.frames;
    const minStableFrames = contract.minStableFrames ?? 10;
    const allowedSkeletonCheckpoints = new Set(contract.allowedSkeletonCheckpoints ?? []);
    const checkpointOrder = new Map<string, number>();
    for (const frame of frames) {
        if (frame.interactionCheckpoint && !checkpointOrder.has(frame.interactionCheckpoint)) {
            checkpointOrder.set(frame.interactionCheckpoint, checkpointOrder.size);
        }
        const checkpoint = frame.interactionCheckpoint ?? '';
        const allowsSkeleton = allowedSkeletonCheckpoints.has(checkpoint);
        if (
            frame.kind === 'blank'
            || frame.kind === 'loader'
            || frame.kind === 'neutral'
            || (frame.kind === 'page-shell' && !allowsSkeleton)
        ) {
            violations.push(
                `frame ${String(frame.frame)} exposed ${frame.kind} after the first canvas committed`,
            );
        }
        if ((frame.skeletonCount > 0 || frame.outOfFrameSkeletonCount > 0) && !allowsSkeleton) {
            violations.push(`frame ${String(frame.frame)} reintroduced a skeleton during interaction`);
        }
        if (allowsSkeleton && (frame.kind === 'page-shell' || frame.skeletonCount > 0)) {
            const expectedPage = contract.expectedPageByCheckpoint[checkpoint];
            // The debounce window intentionally presents the exact target page
            // frame without a skeleton. Once the skeleton appears, it must be
            // the sole in-frame visual owned by that same frame.
            if (frame.kind !== 'page-shell' || frame.outOfFrameSkeletonCount !== 0 || (
                frame.skeletonCount > 0
                && (frame.skeletonCount !== 1 || !frame.skeletonSharesShell)
            )) {
                violations.push(
                    `frame ${String(frame.frame)} exposed a non-canonical skeleton during ${checkpoint}`,
                );
            }
            // A cleared zero-sized canvas node is inert DOM, not a degraded or
            // stale presented raster. Only nonzero backing stores violate the
            // page-not-ready contract.
            if (
                (frame.pageCanvasNonzeroCanvasCount ?? 0) > 0
                || ((frame.canvasPixelWidth ?? 0) > 0 && (frame.canvasPixelHeight ?? 0) > 0)
            ) {
                violations.push(
                    `frame ${String(frame.frame)} retained an obsolete canvas during ${checkpoint}`,
                );
            }
            if (expectedPage !== undefined && frame.pageNumber !== expectedPage) {
                violations.push(
                    `frame ${String(frame.frame)} showed page ${String(frame.pageNumber)} instead of ${String(expectedPage)} during ${checkpoint}`,
                );
            }
        }
        if (frame.outerPlaceholderVisible || frame.outerPlaceholderOwnsCenter) {
            violations.push(`frame ${String(frame.frame)} reintroduced the empty placeholder during interaction`);
        }
        if (frame.bodyOverflow > 1 || frame.documentOverflow > 1) {
            violations.push(`frame ${String(frame.frame)} leaked horizontal overflow outside the viewer`);
        }
    }

    const canvasFrames = frames.filter(frame => frame.kind === 'committed-canvas');
    const baselineStyle = canvasFrames[0]?.shellStyle ?? null;
    const shellIdsByPage = new Map<number, Set<number>>();
    for (const frame of canvasFrames.slice(1)) {
        if (!sameStyle(frame.shellStyle, baselineStyle)) {
            violations.push(`page-frame style changed at interaction frame ${String(frame.frame)}`);
        }
    }
    for (const frame of canvasFrames) {
        if (frame.pageNumber === null || frame.shellId === null) {
            continue;
        }
        const shellIds = shellIdsByPage.get(frame.pageNumber) ?? new Set<number>();
        shellIds.add(frame.shellId);
        shellIdsByPage.set(frame.pageNumber, shellIds);
    }
    for (const [
        pageNumber,
        shellIds,
    ] of shellIdsByPage) {
        if (shellIds.size > 1) {
            violations.push(
                `page ${String(pageNumber)} swapped shell identity during interaction (${[...shellIds].join(', ')})`,
            );
        }
    }

    const stableFramesByCheckpoint = new Map<string, ICommittedSurfaceFrame[]>();
    for (const checkpoint of contract.stableCheckpoints) {
        const checkpointFrames = frames.filter(frame => frame.interactionCheckpoint === checkpoint);
        stableFramesByCheckpoint.set(checkpoint, checkpointFrames);
        if (checkpointFrames.length < minStableFrames) {
            violations.push(
                `checkpoint ${checkpoint} sampled ${String(checkpointFrames.length)} RAFs; expected at least ${String(minStableFrames)}`,
            );
            continue;
        }
        const stableTail = checkpointFrames.slice(-minStableFrames);
        const baseline = stableTail[0]!;
        const expectedPage = contract.expectedPageByCheckpoint[checkpoint];
        for (const frame of stableTail) {
            if (frame.kind !== 'committed-canvas') {
                violations.push(`checkpoint ${checkpoint} exposed ${frame.kind} at frame ${String(frame.frame)}`);
            }
            if (expectedPage !== undefined && frame.pageNumber !== expectedPage) {
                violations.push(
                    `checkpoint ${checkpoint} showed page ${String(frame.pageNumber)} instead of ${String(expectedPage)}`,
                );
            }
            if (frame.shellId !== baseline.shellId) {
                violations.push(`checkpoint ${checkpoint} swapped page-shell identity at frame ${String(frame.frame)}`);
            }
            if (!sameRect(frame.shellRect, baseline.shellRect)) {
                violations.push(`checkpoint ${checkpoint} changed page-shell geometry at frame ${String(frame.frame)}`);
            }
            if (!sameStyle(frame.shellStyle, baseline.shellStyle)) {
                violations.push(`checkpoint ${checkpoint} changed page-shell style at frame ${String(frame.frame)}`);
            }
            if (
                Math.abs((frame.viewportScrollHeight ?? 0) - (baseline.viewportScrollHeight ?? 0)) > 1
                || Math.abs((frame.viewportScrollWidth ?? 0) - (baseline.viewportScrollWidth ?? 0)) > 1
            ) {
                violations.push(`checkpoint ${checkpoint} changed its settled scroll extent at frame ${String(frame.frame)}`);
            }
        }
    }

    for (const group of contract.preserveShellIdentityAcross) {
        const baselines = group.map(checkpoint => stableFramesByCheckpoint.get(checkpoint)?.at(-1));
        const baseline = baselines[0];
        for (let index = 1; index < baselines.length; index += 1) {
            const frame = baselines[index];
            if (baseline && frame && frame.shellId !== baseline.shellId) {
                violations.push(`page-shell identity changed across ${group.join(' -> ')}`);
                break;
            }
        }
    }
    for (const group of contract.preserveWidthAcross) {
        const baselines = group.map(checkpoint => stableFramesByCheckpoint.get(checkpoint)?.at(-1));
        const baselineWidth = baselines[0]?.shellRect?.width;
        for (let index = 1; index < baselines.length; index += 1) {
            const width = baselines[index]?.shellRect?.width;
            if (
                baselineWidth !== undefined
                && width !== undefined
                && Math.abs(width - baselineWidth) > 1
            ) {
                violations.push(`page-shell width changed across ${group.join(' -> ')}`);
                break;
            }
        }
    }

    const overflowCheckpointIndex = checkpointOrder.get(contract.horizontalOverflowCheckpoint);
    if (overflowCheckpointIndex === undefined) {
        violations.push(`missing horizontal-overflow checkpoint ${contract.horizontalOverflowCheckpoint}`);
        return violations;
    }
    const preZoomCanvasFrames = canvasFrames.filter(frame => {
        const checkpointIndex = frame.interactionCheckpoint
            ? checkpointOrder.get(frame.interactionCheckpoint)
            : undefined;
        return (checkpointIndex ?? -1) < overflowCheckpointIndex;
    });
    const preZoomWidth = preZoomCanvasFrames[0]?.shellRect?.width;
    for (const frame of preZoomCanvasFrames.slice(1)) {
        if (
            preZoomWidth !== undefined
            && frame.shellRect
            && Math.abs(frame.shellRect.width - preZoomWidth) > 1
        ) {
            violations.push(`page-shell width pulsed before high zoom at frame ${String(frame.frame)}`);
        }
    }
    let sawIntendedOverflow = false;
    let overflowTransitions = 0;
    let previousOverflow: boolean | null = null;
    for (const frame of frames) {
        const checkpointIndex = frame.interactionCheckpoint
            ? checkpointOrder.get(frame.interactionCheckpoint)
            : undefined;
        const overflow = frame.viewportHasHorizontalOverflow;
        if (overflow === null) {
            continue;
        }
        if (previousOverflow !== null && overflow !== previousOverflow) {
            overflowTransitions += 1;
        }
        previousOverflow = overflow;
        if ((checkpointIndex ?? -1) < overflowCheckpointIndex && overflow) {
            violations.push(`viewer exposed premature horizontal overflow at frame ${String(frame.frame)}`);
        }
        if ((checkpointIndex ?? -1) >= overflowCheckpointIndex && overflow) {
            sawIntendedOverflow = true;
        }
    }
    if (!sawIntendedOverflow) {
        violations.push('high zoom never produced intended viewer-owned horizontal overflow');
    }
    if (overflowTransitions > 1) {
        violations.push(`viewer horizontal-overflow state pulsed ${String(overflowTransitions)} times during interaction`);
    }

    return violations;
}

export function findInitialRenderAuthorityViolations(
    entries: readonly IPdfRenderTraceEntry[],
    targetPage: number,
) {
    const firstCanvasMountIndex = entries.findIndex(entry => (
        entry.event === 'renderer-canvas-mounted'
        && entry.payload.pageNumber === targetPage
    ));
    if (firstCanvasMountIndex < 0) {
        return [`no render trace canvas mount was recorded for page ${String(targetPage)}`];
    }

    const violations: string[] = [];
    const preCanvasEntries = entries.slice(0, firstCanvasMountIndex + 1);
    const requestIds = new Set(preCanvasEntries
        .filter(entry => (
            entry.event === 'renderer-single-page-begin'
            && entry.payload.pageNumber === targetPage
        ))
        .map(entry => entry.payload.requestId)
        .filter((requestId): requestId is number => typeof requestId === 'number'));
    if (requestIds.size !== 1) {
        violations.push(
            `expected one page-${String(targetPage)} render authority before first canvas, observed request IDs ${JSON.stringify([...requestIds])}`,
        );
    }

    const competingEvents = preCanvasEntries.filter(entry => (
        (
            entry.event === 'renderer-canvas-render-cancel-existing-task'
            && entry.payload.pageNumber === targetPage
        )
        || entry.event === 'navigation-viewport-authority-retry'
    ));
    if (competingEvents.length > 0) {
        violations.push(`competing pre-canvas authority events: ${JSON.stringify(competingEvents)}`);
    }

    return violations;
}

/**
 * Installs the observer before the open gesture. Sampling only on RAF makes every
 * entry a browser-presentable frame and prevents mutation-only intermediate DOM
 * states from being mistaken for a flash the user could see.
 */
export async function installCommittedSurfaceSampler(
    page: Page,
    options: ICommittedSurfaceSamplerOptions = {},
) {
    await evaluateInPage(page, (sampleCanvasPixels: boolean) => {
        const testWindow = window as typeof window & {
            __committedSurfaceAnimationFrame?: number;
            __committedSurfaceElementIds?: WeakMap<Element, number>;
            __committedSurfaceErrors?: ICommittedSurfaceSamplerError[];
            __committedSurfaceFrames?: ICommittedSurfaceFrame[];
            __committedSurfaceInteractionCheckpoint?: string | null;
        };
        if (testWindow.__committedSurfaceAnimationFrame !== undefined) {
            window.cancelAnimationFrame(testWindow.__committedSurfaceAnimationFrame);
        }

        const startedAt = performance.now();
        let frame = 0;
        let nextElementId = 1;
        testWindow.__committedSurfaceElementIds = new WeakMap<Element, number>();
        testWindow.__committedSurfaceErrors = [];
        testWindow.__committedSurfaceFrames = [];
        testWindow.__committedSurfaceInteractionCheckpoint = null;

        const isVisible = (element: HTMLElement | null) => {
            if (!element?.isConnected) {
                return false;
            }
            let ancestor: HTMLElement | null = element;
            while (ancestor) {
                const ancestorStyle = window.getComputedStyle(ancestor);
                if (
                    ancestorStyle.display === 'none'
                    || ancestorStyle.visibility === 'hidden'
                    || Number(ancestorStyle.opacity || '1') === 0
                ) {
                    return false;
                }
                ancestor = ancestor.parentElement;
            }
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && rect.bottom > 0
                && rect.right > 0
                && rect.top < window.innerHeight
                && rect.left < window.innerWidth
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0;
        };
        const toRect = (element: HTMLElement | null): ICommittedSurfaceRect | null => {
            if (!element) {
                return null;
            }
            const rect = element.getBoundingClientRect();
            return {
                height: Math.round(rect.height * 100) / 100,
                left: Math.round(rect.left * 100) / 100,
                top: Math.round(rect.top * 100) / 100,
                width: Math.round(rect.width * 100) / 100,
            };
        };
        const toStyle = (element: HTMLElement | null): ICommittedSurfaceStyle | null => {
            if (!element) {
                return null;
            }
            const style = window.getComputedStyle(element);
            return {
                backgroundColor: style.backgroundColor,
                borderRadius: style.borderRadius,
                boxShadow: style.boxShadow,
            };
        };
        // Keep every predicate used by the injected callback in this browser
        // closure. Puppeteer serializes the callback without module scope, so
        // referencing the contract-side helper would terminate sampling only
        // when a transition first exercises this fallback branch.
        const browserOwnsPageFrameStyle = (style: ICommittedSurfaceStyle | null) => Boolean(
            style
            && style.backgroundColor !== 'rgba(0, 0, 0, 0)'
            && style.backgroundColor !== 'transparent'
            && style.borderRadius !== '0px'
            && style.boxShadow !== 'none',
        );
        const getElementId = (element: Element | null) => {
            if (!element) {
                return null;
            }
            const ids = testWindow.__committedSurfaceElementIds!;
            const existing = ids.get(element);
            if (existing !== undefined) {
                return existing;
            }
            const id = nextElementId++;
            ids.set(element, id);
            return id;
        };
        const ownsVisibleCenter = (element: HTMLElement | null) => {
            if (!element || !isVisible(element)) {
                return false;
            }
            const rect = element.getBoundingClientRect();
            const left = Math.max(0, rect.left);
            const right = Math.min(window.innerWidth, rect.right);
            const top = Math.max(0, rect.top);
            const bottom = Math.min(window.innerHeight, rect.bottom);
            if (right <= left || bottom <= top) {
                return false;
            }
            const topElement = document.elementFromPoint(
                left + ((right - left) / 2),
                top + ((bottom - top) / 2),
            );
            if (topElement && element.contains(topElement)) {
                return true;
            }
            // Visual transition shells deliberately ignore pointer input so the
            // stable chassis remains interactive. `elementFromPoint` omits such
            // elements even when they are the visible surface, so geometry is
            // the appropriate ownership proof for a pointer-transparent shell.
            return window.getComputedStyle(element).pointerEvents === 'none';
        };
        const describeElementPath = (element: Element | null) => {
            const parts: string[] = [];
            let current = element;
            while (current && parts.length < 8) {
                const htmlElement = current as HTMLElement;
                const id = htmlElement.id ? `#${htmlElement.id}` : '';
                const classes = Array.from(htmlElement.classList).slice(0, 6).map(name => `.${name}`).join('');
                const state = [
                    htmlElement.dataset.openSurfacePhase
                        ? `[data-open-surface-phase=${htmlElement.dataset.openSurfacePhase}]`
                        : '',
                    htmlElement.dataset.openSurfacePresentation
                        ? `[data-open-surface-presentation=${htmlElement.dataset.openSurfacePresentation}]`
                        : '',
                    htmlElement.dataset.loading ? `[data-loading=${htmlElement.dataset.loading}]` : '',
                ].join('');
                parts.push(`${current.tagName.toLowerCase()}${id}${classes}${state}`);
                current = current.parentElement;
            }
            return parts.join(' > ');
        };
        const canvasHasNonblankPixels = (canvas: HTMLCanvasElement | null) => {
            if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
                return false;
            }
            try {
                const context = canvas.getContext('2d', {willReadFrequently: true});
                if (!context) {
                    return false;
                }
                const hasContrast = (pixels: Uint8ClampedArray) => {
                    for (let offset = 0; offset < pixels.length; offset += 4) {
                        if (
                            (pixels[offset + 3] ?? 0) > 0
                            && (
                                (pixels[offset] ?? 255) < 252
                                || (pixels[offset + 1] ?? 255) < 252
                                || (pixels[offset + 2] ?? 255) < 252
                            )
                        ) {
                            return true;
                        }
                    }
                    return false;
                };
                const gridSize = 12;
                for (let index = 0; index < gridSize; index += 1) {
                    const y = Math.min(
                        canvas.height - 1,
                        Math.floor(((index + 0.5) * canvas.height) / gridSize),
                    );
                    if (hasContrast(context.getImageData(0, y, canvas.width, 1).data)) {
                        return true;
                    }
                    const x = Math.min(
                        canvas.width - 1,
                        Math.floor(((index + 0.5) * canvas.width) / gridSize),
                    );
                    if (hasContrast(context.getImageData(x, 0, 1, canvas.height).data)) {
                        return true;
                    }
                }
            } catch {
                return false;
            }
            return false;
        };

        const capture = () => {
            frame += 1;
            try {
                const activeHost = document.querySelector<HTMLElement>(
                    '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
                ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
                const presentationFallback = document.querySelector<HTMLElement>(
                    '.editor-pane.is-active .workspace-host.is-presentation-fallback',
                );
                let host = isVisible(activeHost)
                    ? activeHost
                    : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).find(isVisible) ?? null;
                if (isVisible(presentationFallback) && ownsVisibleCenter(presentationFallback)) {
                    host = presentationFallback;
                }
                const viewport = host?.querySelector<HTMLElement>('[data-document-viewer-chassis-viewport]')
                ?? host?.querySelector<HTMLElement>('#pdf-viewer')
                ?? null;
                const visibleNeutral = Array.from(host?.querySelectorAll<HTMLElement>(
                    '[data-document-open-surface="neutral"], .workspace-host-document-open-fallback',
                ) ?? []).find(ownsVisibleCenter) ?? null;
                const visibleLoader = Array.from(host?.querySelectorAll<HTMLElement>(
                    '.workspace-host__loading, .document-loading, .pdf-loading, .pdf-loading-overlay',
                ) ?? []).find(ownsVisibleCenter) ?? null;
                const visibleToolSurface = Array.from(host?.querySelectorAll<HTMLElement>(
                    '.scan-cleanup-surface',
                ) ?? []).find(ownsVisibleCenter) ?? null;
                const outerPlaceholder = host?.querySelector<HTMLElement>('.workspace-host__start') ?? null;
                const visibleLiveEmptyState = Array.from(
                    outerPlaceholder?.querySelectorAll<HTMLElement>('.empty-state') ?? [],
                ).find(ownsVisibleCenter) ?? null;
                const committedEmptyElement = visibleLiveEmptyState;
                const committedEmptySource: TCommittedEmptySource | null = visibleLiveEmptyState
                    ? 'live-empty-state'
                    : null;
                const chassis = host?.querySelector<HTMLElement>('.document-viewer-chassis') ?? null;
                const visiblePages = Array.from(host?.querySelectorAll<HTMLElement>(
                    '.page_container[data-page], [data-testid="document-page-source-page"][data-page-number]',
                ) ?? [])
                    .filter(isVisible);
                const page = visiblePages.find(ownsVisibleCenter) ?? visiblePages.find(candidate => {
                    const rect = candidate.getBoundingClientRect();
                    return rect.top < window.innerHeight && rect.bottom > 0;
                }) ?? visiblePages[0] ?? null;
                const isPageSource = page?.matches('[data-testid="document-page-source-page"]') ?? false;
                const pageCanvas = page?.querySelector<HTMLElement>('.page_canvas')
                ?? (isPageSource ? page : null);
                const pageCanvasRenderLayer = pageCanvas?.querySelector<HTMLElement>(
                    ':scope > .page_canvas__render-layer',
                ) ?? null;
                const canvas = page?.querySelector<HTMLCanvasElement>(
                    '.page_canvas__render-layer canvas',
                ) ?? null;
                const pageSourceImage = page?.querySelector<HTMLImageElement>(
                    ':scope > [data-testid="document-page-source-image"]',
                ) ?? null;
                const canvasRect = canvas?.getBoundingClientRect() ?? null;
                const pageSourceImageRect = pageSourceImage?.getBoundingClientRect() ?? null;
                const skeletonCandidates = Array.from(host?.querySelectorAll<HTMLElement>(
                    '.document-page-skeleton, .document-source-viewer__skeleton',
                ) ?? [])
                    .filter(isVisible);
                // The page-source skeleton wrapper renders the shared
                // DocumentPageSkeleton inside itself, so both selectors match
                // one logical skeleton. Keep only the outermost element of
                // each nest; competing ownership means separate skeletons,
                // not a wrapper and its own content.
                const skeletons = skeletonCandidates.filter(candidate => !skeletonCandidates.some(
                    other => other !== candidate && other.contains(candidate),
                ));
                const viewportRect = viewport?.getBoundingClientRect() ?? null;
                const intersectsViewport = (candidate: HTMLElement) => {
                    const rect = candidate.getBoundingClientRect();
                    return Boolean(
                        viewportRect
                    && rect.right > viewportRect.left
                    && rect.left < viewportRect.right
                    && rect.bottom > viewportRect.top
                    && rect.top < viewportRect.bottom,
                    );
                };
                const viewportSkeletons = skeletons.filter(intersectsViewport);
                const exactSkeletons = viewportSkeletons.filter(candidate => pageCanvas?.contains(candidate));
                // A neighbor page's skeleton sliver can intersect the viewport
                // edge in continuous scroll; it belongs to that page's own
                // container. Out-of-frame counts true orphans that no page
                // container owns, plus strays that claim the tracked page
                // from a foreign container (a duplicate skeleton owner).
                const trackedPageNumber = page
                    ? Number(page.dataset.page ?? page.dataset.pageNumber ?? 0) || null
                    : null;
                const orphanSkeletons = viewportSkeletons.filter((candidate) => {
                    if (pageCanvas?.contains(candidate)) {
                        return false;
                    }
                    const owner = candidate.closest<HTMLElement>('.page_container, [data-testid="document-page-source-page"], .document-source-viewer__page');
                    if (!owner) {
                        return true;
                    }
                    const ownerPageNumber = Number(owner.dataset.page ?? owner.dataset.pageNumber ?? 0) || null;
                    return trackedPageNumber !== null && ownerPageNumber === trackedPageNumber;
                });
                const skeleton = exactSkeletons[0] ?? null;
                const canvasNonblank = sampleCanvasPixels && canvasHasNonblankPixels(canvas);
                // `page_container--rendered` is applied by the render coordinator only
                // after the render task commits; it is the white-page fallback where
                // pixel contrast deliberately cannot prove readiness.
                const renderAuthorityReady = Boolean(
                    page?.classList.contains('page_container--rendered')
                || page?.dataset.initialCanvasCommitted === 'true'
                || canvas?.dataset.rendered === 'true',
                );
                // Runtime-owned presentation authority. A page is canonical only
                // after the current render commits; replacement intent clears the
                // previous bitmap instead of retaining stale pixels.
                const pageVisualAuthorityReady = page?.dataset.pageVisual === 'ready';
                const pageSourceAuthorityReady = Boolean(
                    pageSourceImage?.isConnected
                && pageSourceImage.complete
                && pageSourceImage.naturalWidth > 0
                && pageSourceImage.naturalHeight > 0
                && pageSourceImageRect
                && pageSourceImageRect.width > 0
                && pageSourceImageRect.height > 0
                && page?.dataset.pageSourceVisual === 'fresh',
                );
                const canvasAuthorityReady = pageSourceAuthorityReady || Boolean(
                    canvas?.isConnected
                && canvasRect
                && canvas.width > 0
                && canvas.height > 0
                && canvasRect.width > 0
                && canvasRect.height > 0
                // Pixel contrast alone does not make an uncommitted canvas the
                // current visual authority. Only the canonical render commit
                // may coexist with the page presentation state.
                && exactSkeletons.length === 0
                && (renderAuthorityReady || pageVisualAuthorityReady),
                );

                let kind: TCommittedSurfaceKind = 'blank';
                if (visibleNeutral) {
                    kind = 'neutral';
                } else if (visibleLoader) {
                    kind = 'loader';
                } else if (visibleToolSurface) {
                    kind = 'tool-surface';
                } else if (canvasAuthorityReady && pageCanvas && ownsVisibleCenter(page)) {
                    kind = 'committed-canvas';
                } else if (
                    page
                && pageCanvas
                && ownsVisibleCenter(page)
                && (
                    exactSkeletons.length > 0
                    || page.classList.contains('document-viewer-chassis__opening-page')
                        || browserOwnsPageFrameStyle(toStyle(pageCanvas))
                )
                ) {
                    kind = 'page-shell';
                } else if (committedEmptyElement) {
                    kind = 'committed-empty';
                }

                const hostRect = host?.getBoundingClientRect() ?? null;
                const topElement = hostRect && hostRect.width > 0 && hostRect.height > 0
                    ? document.elementFromPoint(
                        Math.max(0, hostRect.left) + (
                            (Math.min(window.innerWidth, hostRect.right) - Math.max(0, hostRect.left)) / 2
                        ),
                        Math.max(0, hostRect.top) + (
                            (Math.min(window.innerHeight, hostRect.bottom) - Math.max(0, hostRect.top)) / 2
                        ),
                    )
                    : null;
                const loaderSelector = visibleLoader
                    ? [
                        '.workspace-host__loading',
                        '.document-loading',
                        '.pdf-loading',
                        '.pdf-loading-overlay',
                    ].find(selector => visibleLoader.matches(selector)) ?? null
                    : null;

                const pdfOpeningDiagnostic = document.querySelector<HTMLElement>('[data-pdf-opening-diagnostic="true"]');
                const pdfViewerHost = host?.querySelector<HTMLElement>('[data-pdf-viewer-host]') ?? null;
                const requestedTargetPage = Number(
                    chassis?.dataset.viewportRequestedPage
                ?? pdfViewerHost?.dataset.pdfNavigationHandoffTarget
                ?? 0,
                ) || null;
                const targetPage = requestedTargetPage === null
                    ? null
                    : host?.querySelector<HTMLElement>(`.page_container[data-page="${String(requestedTargetPage)}"]`) ?? null;
                const targetCanvas = targetPage?.querySelector<HTMLCanvasElement>(
                    '.page_canvas__render-layer canvas',
                ) ?? null;
                const targetCanvasRect = targetCanvas?.getBoundingClientRect() ?? null;
                const visiblePdfPageVisuals = visiblePages
                    .filter(candidate => (
                        candidate.matches('.page_container[data-page]')
                        && intersectsViewport(candidate)
                    ))
                    .map((candidate) => {
                        const canonicalCanvas = candidate.querySelector<HTMLCanvasElement>(
                            '.page_canvas__render-layer canvas',
                        );
                        const skeleton = candidate.querySelector<HTMLElement>(
                            '.document-page-skeleton',
                        );
                        return {
                            canonicalCanvasId: getElementId(canonicalCanvas),
                            canonicalCanvasNonblank: sampleCanvasPixels
                                && canvasHasNonblankPixels(canonicalCanvas),
                            canonicalCanvasVisible: isVisible(canonicalCanvas),
                            pageNumber: Number(candidate.dataset.page ?? 0) || null,
                            skeletonVisible: isVisible(skeleton),
                        };
                    });
                testWindow.__committedSurfaceFrames!.push({
                    bodyOverflow: Math.max(0, Math.round(document.body.scrollWidth - document.body.clientWidth)),
                    canvasAuthorityReady,
                    canvasConnected: canvas?.isConnected ?? pageSourceImage?.isConnected ?? false,
                    canvasId: getElementId(canvas ?? pageSourceImage),
                    canvasNonblank: canvasNonblank || pageSourceAuthorityReady,
                    canvasOuterHtml: canvas?.outerHTML ?? pageSourceImage?.outerHTML ?? null,
                    canvasPixelHeight: canvas?.height ?? pageSourceImage?.naturalHeight ?? null,
                    canvasPixelWidth: canvas?.width ?? pageSourceImage?.naturalWidth ?? null,
                    canvasSharesRenderLayer: isPageSource
                        ? Boolean(pageSourceImage && pageSourceImage.parentElement === pageCanvas)
                        : Boolean(
                            canvas
                        && pageCanvasRenderLayer
                        && canvas.closest('.page_canvas__render-layer') === pageCanvasRenderLayer,
                        ),
                    committedEmptyElementPath: committedEmptyElement
                        ? describeElementPath(committedEmptyElement)
                        : null,
                    committedEmptySource,
                    documentOverflow: Math.max(
                        0,
                        Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth),
                    ),
                    elapsedMs: Math.round(performance.now() - startedAt),
                    emptyStateOwnsCenter: ownsVisibleCenter(visibleLiveEmptyState),
                    frame,
                    kind,
                    interactionCheckpoint: testWindow.__committedSurfaceInteractionCheckpoint ?? null,
                    loaderOuterHtml: visibleLoader?.outerHTML ?? null,
                    loaderSelector,
                    openSurfacePhase: viewport?.dataset.openSurfacePhase ?? null,
                    openSurfacePresentation: chassis?.dataset.openSurfacePresentation ?? null,
                    openSurfaceDiagnostic: chassis ? {...chassis.dataset} : undefined,
                    pdfOpeningDiagnostic: pdfOpeningDiagnostic ? {...pdfOpeningDiagnostic.dataset} : undefined,
                    pdfNavigationDiagnostic: pdfViewerHost ? {...pdfViewerHost.dataset} : undefined,
                    outOfFrameSkeletonCount: orphanSkeletons.length,
                    outerPlaceholderPresent: outerPlaceholder !== null,
                    outerPlaceholderOwnsCenter: ownsVisibleCenter(outerPlaceholder),
                    outerPlaceholderVisible: isVisible(outerPlaceholder),
                    pageCanvasChildren: Array.from(pageCanvas?.children ?? []).map((child) => {
                        const element = child as HTMLElement;
                        const classes = Array.from(element.classList).join('.');
                        const dimensions = child instanceof HTMLCanvasElement
                            ? `[${String(child.width)}x${String(child.height)}]`
                            : '';
                        return `${child.tagName.toLowerCase()}${classes ? `.${classes}` : ''}${dimensions}`;
                    }),
                    pageCanvasNonzeroCanvasCount: Array.from(
                        pageCanvas?.querySelectorAll<HTMLCanvasElement>(
                            '.page_canvas__render-layer canvas',
                        ) ?? [],
                    ).filter((candidate) => {
                        const rect = candidate.getBoundingClientRect();
                        return candidate.isConnected
                        && candidate.width > 0
                        && candidate.height > 0
                        && rect.width > 0
                        && rect.height > 0;
                    }).length,
                    pageClassName: page?.className ?? null,
                    pageVisualState: page?.dataset.pageVisual ?? null,
                    pageNumber: page
                        ? Number(page.dataset.page ?? page.dataset.pageNumber ?? 0) || null
                        : null,
                    shellId: getElementId(pageCanvas),
                    shellRect: toRect(pageCanvas),
                    shellStyle: toStyle(pageCanvas),
                    // Target-owned skeletons only: a neighbor page's skeleton
                    // intersecting the viewport edge belongs to that page and
                    // is not competing skeleton ownership for this frame.
                    skeletonCount: exactSkeletons.length,
                    skeletonPages: skeletons.map(candidate => {
                        const owner = candidate.closest<HTMLElement>(
                            '.page_container[data-page], [data-testid="document-page-source-page"][data-page-number]',
                        );
                        return owner
                            ? Number(owner.dataset.page ?? owner.dataset.pageNumber ?? 0) || null
                            : null;
                    }),
                    skeletonDiagnostics: skeletons.map((candidate) => {
                        const owner = candidate.closest<HTMLElement>(
                            '.page_container[data-page], [data-testid="document-page-source-page"][data-page-number]',
                        );
                        const rect = candidate.getBoundingClientRect();
                        return {
                            display: window.getComputedStyle(candidate).display,
                            intersectsViewport: Boolean(
                                viewportRect
                            && rect.right > viewportRect.left
                            && rect.left < viewportRect.right
                            && rect.bottom > viewportRect.top
                            && rect.top < viewportRect.bottom,
                            ),
                            pageNumber: owner
                                ? Number(owner.dataset.page ?? owner.dataset.pageNumber ?? 0) || null
                                : null,
                            rect: toRect(candidate),
                        };
                    }),
                    skeletonSharesShell: Boolean(
                        skeleton
                    && exactSkeletons.length === 1
                    && (
                        isPageSource
                            ? skeleton.parentElement === pageCanvas
                            : skeleton.closest('.page_canvas') === pageCanvas
                                && skeleton.closest('.page_canvas__render-layer') === null
                    ),
                    ),
                    skeletonRect: toRect(skeleton),
                    skeletonStyle: toStyle(skeleton),
                    skeletonDisplay: skeleton ? window.getComputedStyle(skeleton).display : null,
                    topElementPath: describeElementPath(topElement),
                    targetPageCanvasDiagnostic: {
                        connected: targetCanvas?.isConnected ?? false,
                        hasSkeleton: Boolean(targetPage?.querySelector('.document-page-skeleton')),
                        pageNumber: requestedTargetPage,
                        rect: targetCanvasRect && targetCanvasRect.width > 0 && targetCanvasRect.height > 0
                            ? toRect(targetCanvas)
                            : null,
                        renderedClass: targetPage?.classList.contains('page_container--rendered') ?? false,
                    },
                    viewportHasHorizontalOverflow: viewport
                        ? viewport.scrollWidth > viewport.clientWidth + 1
                        : null,
                    viewportClientHeight: viewport?.clientHeight ?? null,
                    viewportClientWidth: viewport?.clientWidth ?? null,
                    viewportOverflow: viewport
                        ? Math.max(0, Math.round(viewport.scrollWidth - viewport.clientWidth))
                        : null,
                    viewportScrollHeight: viewport?.scrollHeight ?? null,
                    viewportScrollLeft: viewport ? Math.round(viewport.scrollLeft) : null,
                    viewportScrollTop: viewport ? Math.round(viewport.scrollTop) : null,
                    viewportScrollWidth: viewport?.scrollWidth ?? null,
                    visiblePdfPageVisuals,
                });
            } catch (error) {
                testWindow.__committedSurfaceErrors!.push({
                    checkpoint: testWindow.__committedSurfaceInteractionCheckpoint ?? null,
                    elapsedMs: Math.round(performance.now() - startedAt),
                    frame,
                    message: error instanceof Error
                        ? `${error.name}: ${error.message}`
                        : String(error),
                });
            } finally {
                // A transient DOM read can race a Vue/PDF.js page replacement.
                // Keep the causal sampler alive so later checkpoints remain
                // observable, while returning the error as release-blocking
                // evidence instead of misreporting an empty checkpoint tail.
                testWindow.__committedSurfaceAnimationFrame = window.requestAnimationFrame(capture);
            }
        };
        capture();
    }, options.sampleCanvasPixels !== false);
}

export async function markCommittedSurfaceInteractionCheckpoint(page: Page, checkpoint: string) {
    await evaluateInPage(page, (nextCheckpoint: string) => {
        const testWindow = window as typeof window & {__committedSurfaceInteractionCheckpoint?: string | null;};
        testWindow.__committedSurfaceInteractionCheckpoint = nextCheckpoint;
    }, checkpoint);
}

export async function waitForCommittedSurfaceSamples(
    page: Page,
    options: ICommittedSurfaceSampleWaitOptions,
) {
    const timeoutMs = options.timeoutMs ?? 20_000;
    const pollIntervalMs = options.pollIntervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    let observedSamples = 0;
    while (Date.now() <= deadline) {
        observedSamples = await evaluateInPage(page, (
            kind: TCommittedSurfaceKind | null,
            interactionCheckpoint: string | null,
        ) => {
            const frames = (window as typeof window & {__committedSurfaceFrames?: ICommittedSurfaceFrame[];})
                .__committedSurfaceFrames ?? [];
            return frames.filter(frame => (
                (kind === null || frame.kind === kind)
                && (
                    interactionCheckpoint === null
                    || frame.interactionCheckpoint === interactionCheckpoint
                )
            )).length;
        }, options.kind ?? null, options.interactionCheckpoint ?? null);
        if (observedSamples >= options.minimumSamples) {
            return observedSamples;
        }
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    throw new Error(
        `Timed out after ${String(timeoutMs)}ms waiting for ${String(options.minimumSamples)} committed-surface samples; observed ${String(observedSamples)}`,
    );
}

export async function stopCommittedSurfaceSampler(page: Page): Promise<ICommittedSurfaceTrace> {
    return evaluateInPage(page, () => {
        const testWindow = window as typeof window & {
            __committedSurfaceAnimationFrame?: number;
            __committedSurfaceElementIds?: WeakMap<Element, number>;
            __committedSurfaceErrors?: ICommittedSurfaceSamplerError[];
            __committedSurfaceFrames?: ICommittedSurfaceFrame[];
            __committedSurfaceInteractionCheckpoint?: string | null;
        };
        if (testWindow.__committedSurfaceAnimationFrame !== undefined) {
            window.cancelAnimationFrame(testWindow.__committedSurfaceAnimationFrame);
            delete testWindow.__committedSurfaceAnimationFrame;
        }
        const errors = testWindow.__committedSurfaceErrors ?? [];
        const frames = testWindow.__committedSurfaceFrames ?? [];
        delete testWindow.__committedSurfaceErrors;
        delete testWindow.__committedSurfaceFrames;
        delete testWindow.__committedSurfaceElementIds;
        delete testWindow.__committedSurfaceInteractionCheckpoint;
        return {
            errors,
            frames,
        };
    });
}
