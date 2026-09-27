import {
    describe,
    expect,
    it,
} from 'vitest';
import {findViewportLifecycleViolations} from '@tests/e2e/electron/helpers/findViewportLifecycleViolations';
import type {ICommittedSurfaceFrame} from '@tests/e2e/electron/helpers/viewerCommittedSurfaceContract';

const CHECKPOINT = 'slow-page-transition';
const TARGET_PAGE = 7;

function frame(
    sequence: number,
    elapsedMs: number,
    overrides: Partial<ICommittedSurfaceFrame>,
): ICommittedSurfaceFrame {
    return {
        bodyOverflow: 0,
        canvasAuthorityReady: false,
        canvasNonblank: false,
        committedEmptySource: null,
        documentOverflow: 0,
        elapsedMs,
        frame: sequence,
        interactionCheckpoint: CHECKPOINT,
        kind: 'page-shell',
        outOfFrameSkeletonCount: 0,
        pageNumber: TARGET_PAGE,
        shellId: TARGET_PAGE,
        shellRect: null,
        shellStyle: null,
        skeletonCount: 0,
        skeletonRect: null,
        skeletonSharesShell: false,
        skeletonStyle: null,
        viewportHasHorizontalOverflow: false,
        viewportOverflow: 0,
        ...overrides,
    };
}

function bareShell(sequence: number, elapsedMs: number) {
    return frame(sequence, elapsedMs, {pageVisualState: 'none'});
}

function committedCanvas(sequence: number, elapsedMs: number) {
    return frame(sequence, elapsedMs, {
        canvasAuthorityReady: true,
        canvasNonblank: true,
        kind: 'committed-canvas',
        pageVisualState: 'ready',
    });
}

describe('viewport lifecycle sampling', () => {
    it('starts Recent lifecycle ownership at the open-surface claim', () => {
        const violations = findViewportLifecycleViolations({frames: [
            frame(1, 0, {
                kind: 'committed-empty',
                openSurfacePhase: 'idle',
                openSurfacePresentation: 'idle',
                pageNumber: null,
                shellId: null,
            }),
            frame(2, 20, {
                openSurfacePhase: 'opening',
                openSurfacePresentation: 'opening',
            }),
            committedCanvas(3, 40),
        ]}, {
            expectedFinalPage: TARGET_PAGE,
            interactionCheckpoint: CHECKPOINT,
            startAtOpenSurfaceClaim: true,
        });

        expect(violations).toEqual([]);
    });

    it('still rejects Recent after the open surface has been claimed', () => {
        const violations = findViewportLifecycleViolations({frames: [
            frame(1, 0, {
                openSurfacePhase: 'opening',
                openSurfacePresentation: 'opening',
            }),
            frame(2, 20, {
                kind: 'committed-empty',
                openSurfacePhase: 'idle',
                openSurfacePresentation: 'idle',
                pageNumber: null,
                shellId: null,
            }),
            committedCanvas(3, 40),
        ]}, {
            expectedFinalPage: TARGET_PAGE,
            interactionCheckpoint: CHECKPOINT,
            startAtOpenSurfaceClaim: true,
        });

        expect(violations).toContain(
            'frame 2 retained the Recent surface after navigation was requested',
        );
    });

    it('accepts a skeleton or a resident canvas on the target page', () => {
        const violations = findViewportLifecycleViolations({frames: [
            frame(1, 0, {
                pageVisualState: 'none',
                skeletonCount: 1,
                skeletonSharesShell: true,
            }),
            frame(2, 16, {
                pageVisualState: 'ready',
                skeletonCount: 0,
            }),
            committedCanvas(3, 620),
        ]}, {
            expectedFinalPage: TARGET_PAGE,
            interactionCheckpoint: CHECKPOINT,
        });

        expect(violations).toEqual([]);
    });

    it('rejects a bare target page on the first sampled frame', () => {
        const violations = findViewportLifecycleViolations({frames: [
            bareShell(1, 0),
            committedCanvas(2, 267),
        ]}, {
            expectedFinalPage: TARGET_PAGE,
            interactionCheckpoint: CHECKPOINT,
        });

        expect(violations).toContain('frame 1 exposed a bare pending target page');
    });
});
