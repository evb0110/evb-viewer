import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    isViewerInteractionReady,
    type IViewerInteractionReadinessSnapshot,
} from '@tests/e2e/electron/helpers/isViewerInteractionReady';

function createSnapshot(
    overrides: Partial<IViewerInteractionReadinessSnapshot> = {},
): IViewerInteractionReadinessSnapshot {
    return {
        mode: 'chassis',
        hasPageTrack: true,
        openSurfacePhase: 'ready',
        openSurfacePresentation: 'committed',
        pageTrackDisplay: 'block',
        pageTrackOpacity: 1,
        pageTrackVisibility: 'visible',
        viewportDisplay: 'block',
        viewportOpacity: 1,
        viewportVisibility: 'visible',
        ...overrides,
    };
}

describe('viewer interaction readiness', () => {
    it('accepts a committed chassis viewport whose nested page track has no legacy pdfViewer class', () => {
        expect(isViewerInteractionReady(createSnapshot())).toBe(true);
    });

    it.each([
        {openSurfacePhase: 'viewport-committed'},
        {openSurfacePresentation: 'opening'},
        {pageTrackDisplay: 'none'},
        {pageTrackOpacity: 0},
        {viewportVisibility: 'hidden'},
    ])('rejects a chassis that is not yet safely interactive: %o', (overrides) => {
        expect(isViewerInteractionReady(createSnapshot(overrides))).toBe(false);
    });

    it('retains the legacy non-chassis PDF viewer contract', () => {
        expect(isViewerInteractionReady(createSnapshot({
            mode: 'legacy',
            openSurfacePhase: null,
            openSurfacePresentation: null,
        }))).toBe(true);
    });
});
