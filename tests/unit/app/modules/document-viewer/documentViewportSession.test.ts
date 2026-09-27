import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    assertDocumentViewportSessionInvariants,
    canOpenRecentDocument,
    collectDocumentViewportSessionInvariantViolations,
    createEmptyDocumentViewportSession,
    reduceDocumentViewportSession,
} from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
import type {
    IDocumentViewportCommitFence,
    IDocumentViewportRenderFence,
    IDocumentViewportSessionState,
    TDocumentViewportSessionEvent,
} from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';

const identity = {
    documentId: 'document-a',
    revision: 'revision-a',
} as const;

function renderFence(
    state: IDocumentViewportSessionState,
    overrides: Partial<IDocumentViewportRenderFence> = {},
): IDocumentViewportRenderFence {
    return {
        generation: state.generation,
        revision: state.identity?.revision ?? 'missing',
        pageNumber: state.requestedPage,
        viewportIntentId: state.viewportIntent?.id ?? 'missing',
        renderVersion: 1,
        requestId: 1,
        ...overrides,
    };
}

function viewportFence(
    state: IDocumentViewportSessionState,
    overrides: Partial<IDocumentViewportCommitFence> = {},
): IDocumentViewportCommitFence {
    return {
        generation: state.generation,
        revision: state.identity?.revision ?? 'missing',
        pageNumber: state.requestedPage,
        viewportIntentId: state.viewportIntent?.id ?? 'missing',
        geometryRevision: 1,
        interactionEpoch: 1,
        ...overrides,
    };
}

class SessionHarness {
    state = createEmptyDocumentViewportSession();

    dispatch(event: TDocumentViewportSessionEvent) {
        const result = reduceDocumentViewportSession(this.state, event);
        if (result.accepted) this.state = result.state;
        return result;
    }

    openWithMetadata(pageNumber = 1, pageCount = 10) {
        const result = this.dispatch({
            type: 'open-requested',
            identity,
            viewportIntentId: 'open-intent',
            initialPage: pageNumber,
        });
        this.dispatch({
            type: 'metadata-ready',
            generation: this.state.generation,
            pageCount,
        });
        return result;
    }

    settleCurrentPage() {
        const render = renderFence(this.state);
        expect(this.dispatch({
            type: 'render-started',
            fence: render,
        }).accepted).toBe(true);
        expect(this.dispatch({
            type: 'canvas-committed',
            fence: render,
        }).accepted).toBe(true);
        expect(this.dispatch({
            type: 'viewport-committed',
            fence: viewportFence(this.state),
        }).accepted).toBe(true);
        expect(this.dispatch({
            type: 'visual-ready',
            fence: render,
        }).accepted).toBe(true);
    }
}

describe('DocumentViewportSession', () => {
    it('reports an impossible empty lifecycle with a non-empty visual owner', () => {
        const empty = createEmptyDocumentViewportSession();
        const violations = collectDocumentViewportSessionInvariantViolations({
            ...empty,
            visual: {
                kind: 'page',
                generation: 0,
                pageNumber: 1,
                presentation: 'skeleton',
                error: null,
            },
        });

        expect(violations).toContain('empty session must have the empty visual owner');
    });

    it('starts a cold open with an immediate, total page-shell visual owner', () => {
        const harness = new SessionHarness();
        const result = harness.dispatch({
            type: 'open-requested',
            identity,
            viewportIntentId: 'open-intent',
        });

        expect(result.accepted).toBe(true);
        expect(harness.state).toMatchObject({
            generation: 1,
            lifecycle: 'opening',
            requestedPage: 1,
            pageCount: null,
            visual: {
                kind: 'page',
                generation: 1,
                pageNumber: 1,
                presentation: 'skeleton',
            },
        });
        expect(assertDocumentViewportSessionInvariants(harness.state)).toBe(harness.state);
    });

    it('accepts rapid pre-metadata navigation, keeps only latest intent, and clamps on metadata', () => {
        const harness = new SessionHarness();
        harness.dispatch({
            type: 'open-requested',
            identity,
            viewportIntentId: 'open-intent',
        });

        const first = harness.dispatch({
            type: 'navigation-requested',
            pageNumber: 12,
            viewportIntentId: 'nav-1',
        });
        const latest = harness.dispatch({
            type: 'navigation-requested',
            pageNumber: 99,
            viewportIntentId: 'nav-2',
        });

        expect(first.accepted).toBe(true);
        expect(latest.accepted).toBe(true);
        expect(harness.state.requestedPage).toBe(99);
        expect(harness.state.viewportIntent).toMatchObject({
            id: 'nav-2',
            pageNumber: 99,
        });
        expect(harness.state.visual).toMatchObject({
            kind: 'page',
            presentation: 'skeleton',
            pageNumber: 99,
        });

        harness.dispatch({
            type: 'metadata-ready',
            generation: harness.state.generation,
            pageCount: 20,
        });
        expect(harness.state.requestedPage).toBe(20);
        expect(harness.state.viewportIntent).toMatchObject({
            id: 'nav-2',
            pageNumber: 20,
        });
        expect(harness.state.visual).toMatchObject({
            kind: 'page',
            presentation: 'skeleton',
            pageNumber: 20,
        });
    });

    it('commits a navigation visual after both canvas and viewport are ready', () => {
        const harness = new SessionHarness();
        harness.openWithMetadata();
        harness.settleCurrentPage();
        harness.dispatch({
            type: 'navigation-requested',
            pageNumber: 2,
            viewportIntentId: 'nav-fast',
        });
        expect(harness.state.visual).toMatchObject({
            kind: 'page',
            presentation: 'skeleton',
            pageNumber: 2,
        });

        const render = renderFence(harness.state, {requestId: 2});
        harness.dispatch({
            type: 'render-started',
            fence: render,
        });
        harness.dispatch({
            type: 'canvas-committed',
            fence: render,
        });
        harness.dispatch({
            type: 'viewport-committed',
            fence: viewportFence(harness.state),
        });
        harness.dispatch({
            type: 'visual-ready',
            fence: render,
        });
        expect(harness.state.visual).toMatchObject({
            kind: 'page',
            presentation: 'canvas',
            pageNumber: 2,
        });

        expect(harness.state.visual).toMatchObject({
            kind: 'page',
            presentation: 'canvas',
            pageNumber: 2,
        });
        expect(harness.state.lifecycle).toBe('ready');
        expect(harness.state.committedPage).toBe(2);
    });

    it('keeps the target not-ready until both canvas and viewport commit', () => {
        const harness = new SessionHarness();
        harness.openWithMetadata();
        harness.settleCurrentPage();
        harness.dispatch({
            type: 'navigation-requested',
            pageNumber: 2,
            viewportIntentId: 'nav-canvas-first',
        });
        const render = renderFence(harness.state, {requestId: 2});
        harness.dispatch({
            type: 'render-started',
            fence: render,
        });
        harness.dispatch({
            type: 'canvas-committed',
            fence: render,
        });

        expect(harness.state.visual).toMatchObject({
            kind: 'page',
            presentation: 'skeleton',
            pageNumber: 2,
        });
        expect(harness.state.committedPage).toBe(1);

        harness.dispatch({
            type: 'viewport-committed',
            fence: viewportFence(harness.state),
        });
        expect(harness.state.visual).toMatchObject({
            kind: 'page',
            presentation: 'canvas',
            pageNumber: 2,
        });
    });

    it('commits same-page ready refinements without leaving an unmatched staged fence', () => {
        const harness = new SessionHarness();
        harness.openWithMetadata();
        harness.settleCurrentPage();
        const previousRender = harness.state.committedRenderFence;
        const refinementRender = renderFence(harness.state, {
            renderVersion: 2,
            requestId: 2,
        });
        const refinementViewport = viewportFence(harness.state, {geometryRevision: 2});

        harness.dispatch({
            type: 'render-started',
            fence: refinementRender,
        });
        expect(harness.dispatch({
            type: 'viewport-committed',
            fence: refinementViewport,
        }).accepted).toBe(true);
        expect(harness.state.lifecycle).toBe('ready');
        expect(harness.state.stagedViewportFence).toBeNull();
        expect(harness.state.committedRenderFence).toEqual(previousRender);
        expect(harness.state.committedViewportFence).toEqual(refinementViewport);

        expect(harness.dispatch({
            type: 'canvas-committed',
            fence: refinementRender,
        }).accepted).toBe(true);
        expect(harness.state.stagedRenderFence).toBeNull();
        expect(harness.state.stagedViewportFence).toBeNull();
        expect(harness.state.committedRenderFence).toEqual(refinementRender);
        expect(harness.state.committedViewportFence).toEqual(refinementViewport);
    });

    it('separates settled page observation from commands and lets user scroll supersede navigation', () => {
        const harness = new SessionHarness();
        harness.openWithMetadata(1, 20);
        harness.settleCurrentPage();

        expect(harness.dispatch({
            type: 'page-observed',
            generation: harness.state.generation,
            pageNumber: 6,
        }).accepted).toBe(true);
        expect(harness.state).toMatchObject({
            lifecycle: 'ready',
            requestedPage: 1,
            committedPage: 1,
            observedPage: 6,
        });

        harness.dispatch({
            type: 'navigation-requested',
            pageNumber: 12,
            viewportIntentId: 'nav-superseded',
        });
        expect(harness.state).toMatchObject({
            lifecycle: 'transitioning',
            requestedPage: 12,
            committedPage: 1,
            observedPage: 6,
        });
        expect(harness.state.committedRenderFence?.pageNumber).toBe(1);
        expect(harness.state.committedViewportFence?.pageNumber).toBe(1);

        expect(harness.dispatch({
            type: 'viewport-committed',
            fence: viewportFence(harness.state),
        }).accepted).toBe(true);
        expect(harness.state.stagedViewportFence?.pageNumber).toBe(12);
        expect(harness.state.committedViewportFence?.pageNumber).toBe(1);

        const superseded = harness.dispatch({
            type: 'navigation-superseded-by-user',
            generation: harness.state.generation,
            pageNumber: 8,
        });
        expect(superseded.accepted).toBe(true);
        expect(harness.state).toMatchObject({
            lifecycle: 'ready',
            requestedPage: 1,
            committedPage: 1,
            observedPage: 8,
            viewportIntent: {pageNumber: 1},
            renderFence: null,
            stagedRenderFence: null,
            stagedViewportFence: null,
            visual: {
                kind: 'page',
                pageNumber: 1,
                presentation: 'canvas',
            },
        });
    });

    it('replaces the committed document with the replacement shell immediately', () => {
        const harness = new SessionHarness();
        harness.openWithMetadata();
        harness.settleCurrentPage();

        harness.dispatch({
            type: 'open-requested',
            identity: {
                documentId: 'replacement',
                revision: 'replacement-revision',
            },
            viewportIntentId: 'replacement-intent',
            initialPage: 3,
        });

        expect(harness.state.visual).toMatchObject({
            kind: 'page',
            presentation: 'skeleton',
            pageNumber: 3,
        });
        expect(harness.state.lifecycle).toBe('opening');
    });

    it('rejects stale generation, render, revision, page, and viewport-intent commits', () => {
        const harness = new SessionHarness();
        harness.openWithMetadata();
        const activeRender = renderFence(harness.state);
        harness.dispatch({
            type: 'render-started',
            fence: activeRender,
        });
        const staleFences: IDocumentViewportRenderFence[] = [
            {
                ...activeRender,
                generation: 0,
            },
            {
                ...activeRender,
                revision: 'old-revision',
            },
            {
                ...activeRender,
                pageNumber: 2,
            },
            {
                ...activeRender,
                viewportIntentId: 'old-intent',
            },
            {
                ...activeRender,
                requestId: 999,
            },
        ];
        for (const fence of staleFences) {
            expect(harness.dispatch({
                type: 'canvas-committed',
                fence,
            }).accepted).toBe(false);
        }
        expect(harness.dispatch({
            type: 'viewport-committed',
            fence: viewportFence(harness.state, {viewportIntentId: 'old-intent'}),
        }).accepted).toBe(false);
        expect(harness.state.committedRenderFence).toBeNull();
        expect(harness.state.committedViewportFence).toBeNull();
        expect(harness.state.stagedRenderFence).toBeNull();
        expect(harness.state.stagedViewportFence).toBeNull();
    });

    it('supersedes old generation commits when another document opens', () => {
        const harness = new SessionHarness();
        harness.openWithMetadata();
        const staleRender = renderFence(harness.state);
        harness.dispatch({
            type: 'render-started',
            fence: staleRender,
        });
        harness.dispatch({
            type: 'open-requested',
            identity: {
                documentId: 'document-b',
                revision: 'revision-b',
            },
            viewportIntentId: 'replacement-open',
        });

        expect(harness.state.generation).toBe(2);
        expect(harness.dispatch({
            type: 'canvas-committed',
            fence: staleRender,
        }).accepted).toBe(false);
        expect(harness.state.identity?.documentId).toBe('document-b');
    });

    it('closes to an atomically empty, recent-open-ready session and fences late work', () => {
        const harness = new SessionHarness();
        harness.openWithMetadata();
        harness.settleCurrentPage();
        expect(harness.dispatch({
            type: 'page-observed',
            generation: harness.state.generation,
            pageNumber: 6,
        }).accepted).toBe(true);
        const closingGeneration = harness.state.generation;
        expect(canOpenRecentDocument(harness.state)).toBe(false);

        harness.dispatch({type: 'close-requested'});
        expect(harness.state.observedPage).toBeNull();
        expect(canOpenRecentDocument(harness.state)).toBe(false);
        const closed = harness.dispatch({
            type: 'close-committed',
            generation: closingGeneration,
        });

        expect(closed.accepted).toBe(true);
        expect(harness.state).toEqual(createEmptyDocumentViewportSession(closingGeneration));
        expect(canOpenRecentDocument(harness.state)).toBe(true);
        expect(harness.dispatch({
            type: 'metadata-ready',
            generation: closingGeneration,
            pageCount: 10,
        }).accepted).toBe(false);
    });
});
