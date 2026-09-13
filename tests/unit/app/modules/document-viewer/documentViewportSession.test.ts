import {
    afterEach,
    describe,
    expect,
    it,
    vi,
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
    TDocumentViewportSessionEffect,
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
    effects: TDocumentViewportSessionEffect[] = [];

    dispatch(event: TDocumentViewportSessionEvent) {
        const result = reduceDocumentViewportSession(this.state, event);
        if (result.accepted) this.state = result.state;
        this.effects.push(...result.effects);
        for (const effect of result.effects) {
            if (effect.type !== 'schedule-skeleton-delay') continue;
            setTimeout(() => this.dispatch({
                type: 'skeleton-delay-elapsed',
                generation: effect.generation,
                token: effect.token,
            }), Math.max(0, effect.deadline - Date.now()));
        }
        return result;
    }

    openPrepared(pageNumber = 1, pageCount = 10) {
        return this.dispatch({
            type: 'open-requested',
            identity,
            viewportIntentId: 'open-intent',
            preparedPage: {
                pageNumber,
                pageCount,
                frameKey: `frame-${pageNumber}`,
            },
        });
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

afterEach(() => {
    vi.useRealTimers();
});

describe('DocumentViewportSession', () => {
    it('reports an impossible empty lifecycle with a non-empty visual owner', () => {
        const empty = createEmptyDocumentViewportSession();
        const violations = collectDocumentViewportSessionInvariantViolations({
            ...empty,
            visual: {
                kind: 'page',
                generation: 0,
                pageNumber: 1,
                presentation: 'cold-shell',
                frameKey: null,
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
                presentation: 'cold-shell',
            },
        });
        expect(result.effects).toEqual([]);
        expect(assertDocumentViewportSessionInvariants(harness.state)).toBe(harness.state);
    });

    it('starts a prepared open without a second placeholder and requests its known page', () => {
        const harness = new SessionHarness();
        const result = harness.openPrepared(3, 12);

        expect(harness.state.visual).toEqual({
            kind: 'page',
            generation: 1,
            pageNumber: 3,
            presentation: 'prepared-shell',
            frameKey: 'frame-3',
            error: null,
        });
        expect(result.effects).toEqual([]);
    });

    it('accepts rapid pre-metadata navigation, keeps only latest intent, and clamps on metadata', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
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
            skeletonDelay: {
                token: 'delay-1',
                deadline: 100,
            },
        });
        const latest = harness.dispatch({
            type: 'navigation-requested',
            pageNumber: 99,
            viewportIntentId: 'nav-2',
            skeletonDelay: {
                token: 'delay-2',
                deadline: 110,
            },
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
            presentation: 'cold-shell',
            pageNumber: 99,
        });
        expect(latest.effects.map(effect => effect.type)).toEqual([
            'cancel-skeleton-delay',
            'schedule-skeleton-delay',
        ]);

        const metadata = harness.dispatch({
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
            presentation: 'cold-shell',
            pageNumber: 20,
        });
        expect(metadata.effects).toEqual([]);
    });

    it('never flashes a skeleton when the current canvas commits before the delay', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const harness = new SessionHarness();
        harness.openPrepared();
        harness.settleCurrentPage();
        harness.dispatch({
            type: 'navigation-requested',
            pageNumber: 2,
            viewportIntentId: 'nav-fast',
            skeletonDelay: {
                token: 'delay-fast',
                deadline: 1_120,
            },
        });
        expect(harness.state.visual).toMatchObject({
            kind: 'page',
            presentation: 'cold-shell',
            pageNumber: 2,
        });

        const render = renderFence(harness.state, {requestId: 2});
        harness.dispatch({
            type: 'render-started',
            fence: render,
        });
        vi.advanceTimersByTime(50);
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

        vi.advanceTimersByTime(100);
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
        harness.openPrepared();
        harness.settleCurrentPage();
        harness.dispatch({
            type: 'navigation-requested',
            pageNumber: 2,
            viewportIntentId: 'nav-canvas-first',
            skeletonDelay: {
                token: 'delay-canvas-first',
                deadline: Date.now() + 120,
            },
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
            presentation: 'cold-shell',
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
        harness.openPrepared();
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
        harness.openPrepared(1, 20);
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
            skeletonDelay: {
                token: 'delay-superseded',
                deadline: Date.now() + 120,
            },
        });
        expect(harness.state).toMatchObject({
            lifecycle: 'transitioning',
            requestedPage: 12,
            committedPage: 1,
            observedPage: null,
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
        expect(superseded.effects).toEqual([{
            type: 'cancel-skeleton-delay',
            token: 'delay-superseded',
        }]);
        expect(harness.state).toMatchObject({
            lifecycle: 'ready',
            requestedPage: 1,
            committedPage: 1,
            observedPage: 8,
            viewportIntent: null,
            renderFence: null,
            stagedRenderFence: null,
            stagedViewportFence: null,
            skeletonDelay: null,
            visual: {
                kind: 'page',
                pageNumber: 1,
                presentation: 'canvas',
            },
        });
    });

    it('replaces the committed document with the replacement exact shell immediately', () => {
        const harness = new SessionHarness();
        harness.openPrepared();
        harness.settleCurrentPage();

        harness.dispatch({
            type: 'open-requested',
            identity: {
                documentId: 'replacement',
                revision: 'replacement-revision',
            },
            viewportIntentId: 'replacement-intent',
            preparedPage: {
                pageNumber: 3,
                pageCount: 7,
                frameKey: 'replacement-frame',
            },
        });

        expect(harness.state.visual).toMatchObject({
            kind: 'page',
            presentation: 'prepared-shell',
            pageNumber: 3,
        });
        expect(harness.state.lifecycle).toBe('opening');
    });

    it('switches the target shell to its skeleton only after the supplied deadline', () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000);
        const harness = new SessionHarness();
        harness.openPrepared();
        harness.settleCurrentPage();
        harness.dispatch({
            type: 'navigation-requested',
            pageNumber: 4,
            viewportIntentId: 'nav-slow',
            skeletonDelay: {
                token: 'delay-slow',
                deadline: 2_120,
            },
        });

        vi.advanceTimersByTime(119);
        expect(harness.state.visual).toMatchObject({
            kind: 'page',
            presentation: 'cold-shell',
            pageNumber: 4,
        });
        vi.advanceTimersByTime(1);
        expect(harness.state.visual).toMatchObject({
            kind: 'page',
            presentation: 'skeleton',
            pageNumber: 4,
        });
        expect(harness.state.skeletonDelay).toBeNull();
    });

    it('presents the target skeleton after debounce even before metadata resolves', () => {
        const harness = new SessionHarness();
        harness.dispatch({
            type: 'open-requested',
            identity,
            viewportIntentId: 'open-intent',
        });
        harness.dispatch({
            type: 'navigation-requested',
            pageNumber: 50,
            viewportIntentId: 'nav-before-metadata',
            skeletonDelay: {
                token: 'delay',
                deadline: 100,
            },
        });
        harness.dispatch({
            type: 'skeleton-delay-elapsed',
            generation: 1,
            token: 'delay',
        });
        expect(harness.state.visual).toMatchObject({
            kind: 'page',
            presentation: 'skeleton',
            pageNumber: 50,
        });
        expect(harness.state.skeletonDelay).toBeNull();

        harness.dispatch({
            type: 'metadata-ready',
            generation: 1,
            pageCount: 8,
        });
        expect(harness.state.visual).toMatchObject({
            kind: 'page',
            presentation: 'skeleton',
            pageNumber: 8,
        });
        expect(harness.state.skeletonDelay).toBeNull();
    });

    it('rejects stale generation, render, revision, page, and viewport-intent commits', () => {
        const harness = new SessionHarness();
        harness.openPrepared();
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
        harness.openPrepared();
        const staleRender = renderFence(harness.state);
        harness.dispatch({
            type: 'render-started',
            fence: staleRender,
        });
        const replacement = harness.dispatch({
            type: 'open-requested',
            identity: {
                documentId: 'document-b',
                revision: 'revision-b',
            },
            viewportIntentId: 'replacement-open',
            preparedPage: {
                pageNumber: 1,
                pageCount: 3,
                frameKey: 'replacement-frame',
            },
        });

        expect(replacement.effects).toEqual([]);
        expect(harness.state.generation).toBe(2);
        expect(harness.dispatch({
            type: 'canvas-committed',
            fence: staleRender,
        }).accepted).toBe(false);
        expect(harness.state.identity?.documentId).toBe('document-b');
    });

    it('closes to an atomically empty, recent-open-ready session and fences late work', () => {
        const harness = new SessionHarness();
        harness.openPrepared();
        harness.settleCurrentPage();
        expect(harness.dispatch({
            type: 'page-observed',
            generation: harness.state.generation,
            pageNumber: 6,
        }).accepted).toBe(true);
        const closingGeneration = harness.state.generation;
        expect(canOpenRecentDocument(harness.state)).toBe(false);

        const closing = harness.dispatch({type: 'close-requested'});
        expect(closing.effects).toEqual([]);
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
