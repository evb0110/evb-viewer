import {createPageNavigationRequest} from '@app/modules/document-viewer/navigation/documentNavigationRequest';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createDocumentOpenSurfaceSession,
    resolveDocumentOpenSurfaceViewportPolicy,
    shouldProjectDocumentViewportScroll,
    shouldPresentDocumentOpenEmptyPlaceholder,
} from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
import type { IDocumentOpenSurfaceRenderFence } from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
import type { IDocumentPageSource } from '@app/modules/document-viewer/source/documentPageSource';
import {requireDocumentRef} from '@contracts/documentRef';

const DEFAULT_LAYOUT_GEOMETRY = {
    width: 612,
    height: 792,
    margin: 20,
};

function beginSurface(
    session: ReturnType<typeof createDocumentOpenSurfaceSession>,
    documentId = 'a.pdf',
    documentRevision = 'rev-a',
) {
    return session.begin({
        documentId,
        documentRevision,
        ...(documentRevision.startsWith('open-intent:') ? {provisional: true} : {}),
    });
}

function commitDefaultGeometry(
    session: ReturnType<typeof createDocumentOpenSurfaceSession>,
    generation: number,
    overrides: Partial<typeof DEFAULT_LAYOUT_GEOMETRY> = {},
) {
    return session.commitGeometry(generation, {
        ...DEFAULT_LAYOUT_GEOMETRY,
        ...overrides,
    });
}

function createRenderFence(
    session: ReturnType<typeof createDocumentOpenSurfaceSession>,
    generation: number,
    documentRevision = 'rev-a',
    overrides: Partial<{
        renderVersion: number;
        requestId: number;
        pageNumber: number;
    }> = {},
) {
    return session.createRenderFence({
        generation,
        documentRevision,
        renderVersion: 1,
        requestId: 1,
        pageNumber: 1,
        ...overrides,
    })!;
}

function commitReadySurface(
    session: ReturnType<typeof createDocumentOpenSurfaceSession>,
    fence: IDocumentOpenSurfaceRenderFence,
) {
    session.commitCanvas(fence);
    session.commitViewport(createViewportCommit(fence));
    session.markReady(fence);
}

function openingGeometry(
    documentId: string,
    pageCount: number,
    overrides: Partial<{
        pageNumber: number;
        width: number;
        height: number;
        rotation: number;
    }> = {},
) {
    return {
        documentId,
        pageNumber: 1,
        pageCount,
        width: 612,
        height: 792,
        rotation: 0,
        ...overrides,
    };
}

function openingFrame(
    generation: number,
    overrides: Partial<{
        ownerId: string;
        pageNumber: number;
        intentKey: string;
        style: {
            width: string;
            height: string;
        };
    }> = {},
) {
    return {
        generation,
        ownerId: 'pdfjs',
        pageNumber: 1,
        intentKey: 'fit-width:1',
        style: {
            width: '612px',
            height: '792px',
        },
        ...overrides,
    };
}

function createViewportCommit(fence: IDocumentOpenSurfaceRenderFence) {
    return {
        generation: fence.generation,
        documentRevision: fence.documentRevision,
        viewportIntentId: fence.viewportIntentId,
        documentGeometryRevision: 1,
        interactionEpoch: 0,
        pageNumber: fence.pageNumber,
        left: 0,
        top: 0,
    };
}

function createPageSource(documentRef: string): IDocumentPageSource {
    return {
        kind: 'pdf',
        documentRef: requireDocumentRef(documentRef),
        pageCount: 1,
        getPageMetrics: vi.fn(async () => ({
            widthPoints: 612,
            heightPoints: 792,
            rotation: 0 as const,
        })),
        renderPage: vi.fn(),
        dispose: vi.fn(),
    };
}

describe('document open surface session', () => {
    it('publishes native preview ownership without leaving the opening surface blank', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'large.pdf', 'revision-large');

        expect(session.snapshot.value.nativeOpeningPreviewState).toBe('inactive');
        expect(session.setNativeOpeningPreviewState(generation, 'loading')).toBe(true);
        expect(session.snapshot.value.nativeOpeningPreviewState).toBe('loading');
        expect(session.setNativeOpeningPreviewState(generation, 'settled')).toBe(true);
        expect(session.snapshot.value.nativeOpeningPreviewState).toBe('settled');
        expect(session.setNativeOpeningPreviewState(generation, 'failed')).toBe(true);
        expect(session.snapshot.value.nativeOpeningPreviewState).toBe('failed');

        session.reset();
        expect(session.snapshot.value.nativeOpeningPreviewState).toBe('inactive');
    });

    it('rejects navigation until an opening session owns the document', () => {
        const session = createDocumentOpenSurfaceSession();

        for (let page = 2; page <= 6; page += 1) {
            expect(session.requestNavigation(page)).toBe(1);
        }
        expect(session.viewportSession.value.identity).toBeNull();
        expect(session.viewportSession.value.requestedPage).toBe(1);

        session.begin({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:1',
        });

        expect(session.viewportSession.value.identity).toEqual({
            documentId: 'scan.pdf',
            revision: 'open-intent:1',
        });
        expect(session.viewportSession.value.requestedPage).toBe(1);
        expect(session.viewportSession.value.viewportIntent?.pageNumber).toBe(1);
    });

    it('starts a restored open transaction at its semantic page and rejects mismatched cached geometry', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'scan.djvu',
            documentRevision: 'open-intent:restore',
        }, {
            documentId: 'scan.djvu',
            pageNumber: 1,
            pageCount: 1532,
            width: 612,
            height: 792,
            rotation: 0,
        }, 880);

        expect(session.viewportSession.value).toMatchObject({
            generation,
            lifecycle: 'opening',
            requestedPage: 880,
            viewportIntent: {pageNumber: 880},
        });
        expect(session.snapshot.value.openingPageGeometry).toBeNull();
    });

    it('clears unclaimed navigation when the surface resets', () => {
        const session = createDocumentOpenSurfaceSession();
        session.requestNavigation(6);

        session.reset();
        session.begin({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:1',
        });

        expect(session.viewportSession.value.requestedPage).toBe(1);
    });

    it('keeps one generation authority across close and reopen', () => {
        const session = createDocumentOpenSurfaceSession();
        session.begin({
            documentId: 'first.pdf',
            documentRevision: 'revision-1',
        });
        session.reset();

        const surfaceGeneration = session.begin({
            documentId: 'second.pdf',
            documentRevision: 'revision-2',
        });
        expect(session.viewportSession.value.generation).toBe(surfaceGeneration);
        expect(session.commitGeometry(surfaceGeneration, {
            width: 612,
            height: 792,
            margin: 20,
        })).toBe(true);
        const fence = session.createRenderFence({
            generation: surfaceGeneration,
            documentRevision: 'revision-2',
            renderVersion: 2,
            requestId: 1,
            pageNumber: 1,
        });

        expect(fence).not.toBeNull();
        expect(session.commitCanvas(fence!)).toBe(true);
        expect(session.commitViewport(createViewportCommit(fence!))).toBe(true);
        expect(session.markReady(fence!)).toBe(true);
        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'ready',
            committedPage: 1,
        });
    });

    it('projects free scroll as observation and recovers a pending navigation without a skeleton state', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'scan.pdf', 'revision-1');
        session.metadataReady(20);
        commitDefaultGeometry(session, generation);
        const fence = createRenderFence(session, generation, 'revision-1');
        commitReadySurface(session, fence);

        expect(session.observeViewportPage(6)).toBe(6);
        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'ready',
            requestedPage: 1,
            committedPage: 1,
            observedPage: 6,
        });
        expect(session.invalidateResidentVisual(1)).toBe(false);
        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'ready',
            requestedPage: 1,
            committedPage: 1,
            observedPage: 6,
        });

        session.requestNavigation(12);
        expect(session.viewportSession.value.lifecycle).toBe('transitioning');
        const targetFence = createRenderFence(session, generation, 'revision-1', {
            renderVersion: 1,
            requestId: 2,
            pageNumber: 12,
        });
        expect(session.commitViewport(createViewportCommit(targetFence))).toBe(true);
        expect(session.viewportSession.value.stagedViewportFence?.pageNumber).toBe(12);
        expect(session.viewportSession.value.committedViewportFence?.pageNumber).toBe(1);
        expect(session.observeViewportPage(8, {supersedeNavigation: true})).toBe(8);
        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'ready',
            requestedPage: 1,
            committedPage: 1,
            observedPage: 8,
            stagedRenderFence: null,
            stagedViewportFence: null,
        });
        expect(session.snapshot.value).toMatchObject({
            phase: 'ready',
            presentation: 'committed',
        });
    });

    it('invalidates an out-of-range committed page when refreshed metadata shrinks', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'edited.pdf', 'pdfjs:1');
        session.metadataReady(12);
        commitDefaultGeometry(session, generation);
        const openingFence = createRenderFence(session, generation, 'pdfjs:1');
        commitReadySurface(session, openingFence);
        session.requestNavigation(7, 0);
        const pageSevenFence = createRenderFence(session, generation, 'pdfjs:1', {
            renderVersion: 1,
            requestId: 2,
            pageNumber: 7,
        });
        commitReadySurface(session, pageSevenFence);
        session.requestNavigation(8, 0);
        expect(session.observeViewportPage(7, {supersedeNavigation: true})).toBe(7);
        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'ready',
            requestedPage: 7,
            committedPage: 7,
            viewportIntent: {pageNumber: 7},
        });

        expect(() => session.metadataReady(3)).not.toThrow();
        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'transitioning',
            requestedPage: 3,
            committedPage: null,
            observedPage: null,
            pageCount: 3,
            renderFence: null,
            stagedRenderFence: null,
            stagedViewportFence: null,
            committedRenderFence: null,
            committedViewportFence: null,
            viewportIntent: {pageNumber: 3},
            visual: {
                kind: 'page',
                pageNumber: 3,
                presentation: 'skeleton',
            },
        });
        expect(session.snapshot.value).toMatchObject({
            phase: 'geometry-committed',
            presentation: 'page-shell',
            committedRender: null,
            committedViewport: null,
        });
        expect(session.commitCanvas(pageSevenFence)).toBe(false);
        expect(session.commitViewport(createViewportCommit(pageSevenFence))).toBe(false);
        expect(session.markReady(pageSevenFence)).toBe(false);
        expect(session.viewportSession.value.visual).toMatchObject({
            kind: 'page',
            pageNumber: 3,
            presentation: 'skeleton',
        });
        expect(session.snapshot.value).toMatchObject({
            phase: 'geometry-committed',
            presentation: 'page-shell',
            committedRender: null,
            committedViewport: null,
        });

        const pageThreeFence = createRenderFence(session, generation, 'pdfjs:1', {
            renderVersion: 1,
            requestId: 3,
            pageNumber: 3,
        });
        commitReadySurface(session, pageThreeFence);
        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'ready',
            requestedPage: 3,
            committedPage: 3,
            pageCount: 3,
        });
    });

    it('clamps the paint target without manufacturing a new command when metadata shrinks', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'edited.pdf', 'pdfjs:1');
        session.metadataReady(12);
        commitDefaultGeometry(session, generation);
        const openingFence = createRenderFence(session, generation, 'pdfjs:1');
        commitReadySurface(session, openingFence);
        session.requestNavigation(7, 0);
        const navigationTicket = session.navigationTicket.value;
        expect(navigationTicket).not.toBeNull();
        const pageSevenFence = createRenderFence(session, generation, 'pdfjs:1', {
            renderVersion: 1,
            requestId: 2,
            pageNumber: 7,
        });
        commitReadySurface(session, pageSevenFence);
        const priorIntentId = session.viewportSession.value.viewportIntent?.id;
        expect(priorIntentId).toBeTruthy();

        expect(session.metadataReady(3)).toBe(true);
        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'transitioning',
            requestedPage: 3,
            committedPage: null,
            viewportIntent: {pageNumber: 3},
        });
        expect(session.viewportSession.value.viewportIntent?.id).toBe(priorIntentId);
        expect(session.navigationTicket.value?.signal).toBe(navigationTicket?.signal);
        expect(session.isNavigationCurrent(navigationTicket!)).toBe(true);
        expect(session.reportNavigation(navigationTicket!, {
            kind: 'placed',
            page: 3,
            left: 0,
            top: 0,
            geometryRevision: 1,
            interactionEpoch: 0,
        })).toBe(true);
        expect(session.snapshot.value).toMatchObject({
            phase: 'geometry-committed',
            presentation: 'page-shell',
        });
        expect(shouldPresentDocumentOpenEmptyPlaceholder(session.snapshot.value)).toBe(false);
    });

    it('dispatches an explicit command back to the stale requested page after free scrolling', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'scan.djvu', 'djvu:1');
        session.metadataReady(20);
        commitDefaultGeometry(session, generation);
        const openingFence = createRenderFence(session, generation, 'djvu:1');
        commitReadySurface(session, openingFence);

        expect(session.observeViewportPage(20)).toBe(20);
        const previousIntentId = session.viewportSession.value.viewportIntent?.id;
        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'ready',
            requestedPage: 1,
            committedPage: 1,
            observedPage: 20,
        });

        expect(session.requestNavigation(1, 0)).toBe(1);
        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'transitioning',
            requestedPage: 1,
            committedPage: 1,
            observedPage: 20,
            visual: {
                kind: 'page',
                pageNumber: 1,
                presentation: 'skeleton',
            },
        });
        expect(session.viewportSession.value.viewportIntent?.id).not.toBe(previousIntentId);
    });

    it('projects open, metadata, navigation debounce, and close through one viewport session', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'scan.pdf', 'revision-1');
        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'opening',
            requestedPage: 1,
            committedPage: null,
            visual: {
                kind: 'page',
                presentation: 'cold-shell',
            },
        });
        vi.advanceTimersByTime(119);
        expect(session.viewportSession.value.visual).toMatchObject({presentation: 'cold-shell'});
        vi.advanceTimersByTime(1);
        expect(session.viewportSession.value.visual).toMatchObject({presentation: 'skeleton'});
        expect(session.commitOpeningPageGeometry(generation, openingGeometry('scan.pdf', 20, {
            pageNumber: 1,
            width: 612,
            height: 792,
            rotation: 0,
        }))).toBe(true);
        expect(session.viewportSession.value.pageCount).toBe(20);

        expect(session.requestNavigation(7, 120)).toBe(7);
        expect(session.viewportSession.value.visual).toMatchObject({
            kind: 'page',
            presentation: 'cold-shell',
            pageNumber: 7,
        });
        vi.advanceTimersByTime(120);
        expect(session.viewportSession.value.visual).toMatchObject({
            kind: 'page',
            presentation: 'skeleton',
            pageNumber: 7,
        });

        session.reset();
        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'empty',
            identity: null,
            committedPage: null,
        });
        vi.useRealTimers();
    });

    it('cannot let a superseded skeleton deadline overwrite a newer page or committed canvas', () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000);
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'scan.djvu', 'djvu:1');
        expect(session.commitOpeningPageGeometry(generation, openingGeometry('scan.djvu', 10, {
            pageNumber: 1,
            width: 600,
            height: 800,
            rotation: 0,
        }))).toBe(true);
        expect(session.commitGeometry(generation, {
            width: 600,
            height: 800,
            margin: 16,
        })).toBe(true);

        vi.advanceTimersByTime(50);
        session.requestNavigation(2, 120);
        vi.advanceTimersByTime(70);
        expect(session.viewportSession.value.visual).toMatchObject({
            pageNumber: 2,
            presentation: 'cold-shell',
        });

        session.requestNavigation(3, 120);
        const fence = createRenderFence(session, generation, 'djvu:1', {
            renderVersion: 1,
            requestId: 3,
            pageNumber: 3,
        });
        expect(session.commitCanvas(fence)).toBe(true);
        expect(session.commitViewport(createViewportCommit(fence))).toBe(true);
        expect(session.markReady(fence)).toBe(true);

        vi.advanceTimersByTime(1_000);
        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'ready',
            requestedPage: 3,
            committedPage: 3,
            visual: {
                pageNumber: 3,
                presentation: 'canvas',
            },
        });
        vi.useRealTimers();
    });

    it('orders same-page commands by ticket and rejects the earlier placement', async () => {
        const session = createDocumentOpenSurfaceSession();
        beginSurface(session);
        session.metadataReady(10);
        const first = session.navigate({
            ...createPageNavigationRequest(7, 'search'),
            target: {
                kind: 'text-anchor',
                page: 7,
                text: 'first passage',
            },
        })!;
        const second = session.navigate({
            ...createPageNavigationRequest(7, 'search'),
            target: {
                kind: 'text-anchor',
                page: 7,
                text: 'second passage',
            },
        })!;
        await expect(first.finished).resolves.toEqual({
            kind: 'superseded',
            by: 'command',
        });
        expect(first.signal.aborted).toBe(true);
        expect(session.navigationTicket.value?.request.target).toEqual(second.request.target);
        expect(session.reportNavigation(first, {
            kind: 'placed',
            page: 7,
            left: 0,
            top: 700,
            geometryRevision: 1,
            interactionEpoch: 0,
        })).toBe(false);
        expect(session.reportNavigation(second, {
            kind: 'placed',
            page: 7,
            left: 0,
            top: 770,
            geometryRevision: 1,
            interactionEpoch: 0,
        })).toBe(true);
        expect(session.viewportSession.value.observedPage).toBe(7);
        expect(session.snapshot.value.committedViewport?.top).toBe(770);
        expect(session.snapshot.value.phase).not.toBe('ready');
    });

    it('owns unresolved destinations before resolution and ends pending work on close', async () => {
        const session = createDocumentOpenSurfaceSession();
        beginSurface(session);
        const named = session.navigate({
            ...createPageNavigationRequest(1, 'bookmark'),
            target: {
                kind: 'named-dest',
                destination: 'chapter',
            },
        })!;
        expect(session.viewportSession.value.viewportIntent?.pageNumber).toBeNull();
        const replacement = session.navigate(createPageNavigationRequest(9, 'toolbar'))!;
        expect(session.reportNavigation(named, {
            kind: 'resolved',
            page: 3,
        })).toBe(false);
        expect(session.navigationTicket.value?.id).toBe(replacement.id);
        session.reset();
        await expect(replacement.finished).resolves.toEqual({kind: 'document-ended'});
        expect(session.reportNavigation(replacement, {
            kind: 'arrived',
            page: 9,
        })).toBe(false);
        expect(session.navigationTicket.value).toBeNull();
        expect(session.viewportSession.value.lifecycle).toBe('empty');
    });

    it('resolves a named destination without replacing its semantic request', () => {
        const session = createDocumentOpenSurfaceSession();
        beginSurface(session);
        const ticket = session.navigate({
            ...createPageNavigationRequest(1, 'bookmark'),
            target: {
                kind: 'named-dest',
                destination: 'chapter',
            },
        })!;
        expect(session.reportNavigation(ticket, {
            kind: 'resolved',
            page: 8,
        })).toBe(true);
        expect(session.navigationTicket.value).toBe(ticket);
        expect(session.viewportSession.value.requestedPage).toBe(8);
        expect(session.viewportSession.value.observedPage).toBeNull();
        expect(session.reportNavigation(ticket, {
            kind: 'resolved',
            page: 9,
        })).toBe(false);
    });

    it('keeps a newer command when placement publishes synchronously to an observer', async () => {
        const session = createDocumentOpenSurfaceSession();
        beginSurface(session);
        const first = session.navigate(createPageNavigationRequest(7, 'toolbar'))!;
        const stop = watch(() => session.viewportSession.value.observedPage, page => {
            if (page === 7) session.navigate(createPageNavigationRequest(9, 'toolbar'));
        }, {flush: 'sync'});
        expect(session.reportNavigation(first, {
            kind: 'placed',
            page: 7,
            left: 0,
            top: 700,
            geometryRevision: 1,
            interactionEpoch: 0,
        })).toBe(false);
        stop();
        await expect(first.finished).resolves.toEqual({
            kind: 'superseded',
            by: 'command',
        });
        expect(session.navigationTicket.value?.request.target).toEqual({
            kind: 'page',
            page: 9,
        });
        expect(session.viewportSession.value.observedPage).toBe(7);
    });

    it('finishes a failed page request and accepts navigation to another page', async () => {
        const session = createDocumentOpenSurfaceSession();
        beginSurface(session);
        const failed = session.navigate(createPageNavigationRequest(7, 'toolbar'))!;
        expect(session.reportNavigation(failed, {
            kind: 'failed',
            reason: 'raster-failed',
        })).toBe(true);
        await expect(failed.finished).resolves.toEqual({
            kind: 'failed',
            reason: 'raster-failed',
        });
        expect(session.navigationTicket.value).toBeNull();
        const retry = session.navigate(createPageNavigationRequest(9, 'toolbar'));
        expect(retry?.request.target).toEqual({
            kind: 'page',
            page: 9,
        });
        expect(session.viewportSession.value.lifecycle).toBe('transitioning');
    });

    it('retargets empty-surface ownership without resizing its measured opening shell', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.beginPrepared({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:1',
            provisional: true,
        }, {
            documentId: 'scan.pdf',
            ownerId: 'opening-frame-owner',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            layoutKey: '900x700',
            policyKey: 'width:single:fit-width:1',
            sourceRevisionKey: 'scan.pdf:28',
            style: {
                width: '612px',
                height: '792px',
            },
            geometry: {
                documentId: 'scan.pdf',
                pageNumber: 1,
                pageCount: 20,
                width: 612,
                height: 792,
                rotation: 0,
            },
        });
        expect(generation).toBe(1);

        expect(session.requestNavigation(7)).toBe(7);
        expect(session.snapshot.value).toMatchObject({
            generation,
            presentation: 'page-shell',
            openingPageGeometry: {
                pageNumber: 7,
                width: 612,
                height: 792,
            },
            openingPageFrame: {
                pageNumber: 7,
                style: {
                    width: '612px',
                    height: '792px',
                },
            },
        });
        expect(session.viewportSession.value.requestedPage).toBe(7);
        expect(session.viewportSession.value).toMatchObject({
            generation,
            requestedPage: 7,
            visual: {
                kind: 'page',
                pageNumber: 7,
            },
        });
    });

    it('retargets a stale opening frame even when the destination was already requested', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'scan.djvu', 'open-intent:1');

        expect(session.requestNavigation(18)).toBe(18);
        expect(session.commitOpeningPageGeometry(generation, openingGeometry('scan.djvu', 100, {
            pageNumber: 1,
            width: 600,
            height: 800,
            rotation: 0,
        }))).toBe(true);
        expect(session.commitOpeningPageFrame(generation, openingFrame(generation, {
            ownerId: 'late-frame-owner',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            style: {
                width: '600px',
                height: '800px',
            },
        }))).toBe(true);

        const previousIntent = session.viewportSession.value.viewportIntent?.id;
        const previousGeometry = session.snapshot.value.geometry;
        const previousFrameStyle = session.snapshot.value.openingPageFrame?.style;
        expect(session.requestNavigation(18)).toBe(18);
        expect(session.viewportSession.value.viewportIntent?.id).not.toBe(previousIntent);
        expect(session.snapshot.value.geometry).toEqual(previousGeometry);
        expect(session.snapshot.value.openingPageGeometry).toMatchObject({
            pageNumber: 18,
            width: 600,
            height: 800,
        });
        expect(session.snapshot.value.openingPageFrame).toMatchObject({
            pageNumber: 18,
            style: previousFrameStyle,
        });
        expect(session.viewportSession.value).toMatchObject({
            requestedPage: 18,
            visual: {
                kind: 'page',
                pageNumber: 18,
            },
        });
    });
    it('accepts authoritative transient page geometry without a cache fingerprint', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'scan.pdf', 'pdfjs:4');

        expect(session.commitOpeningPageGeometry(generation, openingGeometry('scan.pdf', 431, {
            pageNumber: 1,
            width: 612,
            height: 792,
            rotation: 0,
        }))).toBe(true);
        expect(session.snapshot.value.openingPageGeometry).toEqual({
            documentId: 'scan.pdf',
            pageNumber: 1,
            pageCount: 431,
            width: 612,
            height: 792,
            rotation: 0,
        });
    });

    it('carries exact prevalidated geometry into the empty-to-document generation', () => {
        const session = createDocumentOpenSurfaceSession();
        const openingPageGeometry = {
            documentId: 'scan.pdf',
            pageNumber: 1,
            pageCount: 431,
            width: 612,
            height: 792,
            rotation: 0,
            size: 28_000_000,
            modifiedAt: 1_750_000_000_000,
        };

        session.begin({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:1',
        }, openingPageGeometry);
        openingPageGeometry.width = 1;

        expect(session.snapshot.value.openingPageGeometry).toEqual({
            ...openingPageGeometry,
            width: 612,
        });
    });

    it('rejects opening geometry that belongs to a different document identity', () => {
        const session = createDocumentOpenSurfaceSession();
        const wrongGeometry = {
            documentId: 'wrong.pdf',
            pageNumber: 7,
            pageCount: 10,
            width: 612,
            height: 792,
            rotation: 0,
        };
        const generation = session.begin({
            documentId: 'expected.pdf',
            documentRevision: 'open-intent:1',
        }, wrongGeometry);

        expect(session.snapshot.value.openingPageGeometry).toBeNull();
        expect(session.viewportSession.value.requestedPage).toBe(1);
        expect(session.commitOpeningPageGeometry(generation, wrongGeometry)).toBe(false);
        expect(session.snapshot.value.openingPageGeometry).toBeNull();
    });

    it('joins late prevalidated geometry only into the current pending generation', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'scan.pdf', 'open-intent:1');
        const geometry = {
            documentId: 'scan.pdf',
            pageNumber: 1,
            pageCount: 431,
            width: 612,
            height: 792,
            rotation: 0,
            size: 28_000_000,
            modifiedAt: 1_750_000_000_000,
        };

        expect(session.commitOpeningPageGeometry(generation, geometry)).toBe(true);
        geometry.width = 1;
        expect(session.snapshot.value.openingPageGeometry?.width).toBe(612);

        const nextGeneration = session.begin({...session.snapshot.value.identity!});
        expect(session.commitOpeningPageGeometry(generation, geometry)).toBe(false);
        expect(nextGeneration).toBe(generation + 1);
    });

    it('uses the same empty page-shell transition for a replacement open', () => {
        const session = createDocumentOpenSurfaceSession();
        session.begin({
            documentId: 'first.pdf',
            documentRevision: 'open-intent:1',
        });
        expect(session.snapshot.value.presentation).toBe('idle');

        const generation = session.snapshot.value.generation;
        commitDefaultGeometry(session, generation);
        const fence = createRenderFence(session, generation, 'open-intent:1');
        commitReadySurface(session, fence);

        const replacementGeneration = session.begin({
            documentId: 'second.pdf',
            documentRevision: 'open-intent:2',
        }, {
            documentId: 'second.pdf',
            pageNumber: 1,
            pageCount: 12,
            width: 612,
            height: 792,
            rotation: 0,
        });
        expect(session.snapshot.value.presentation).toBe('idle');
        expect(session.commitOpeningPageFrame(replacementGeneration, openingFrame(replacementGeneration))).toBe(true);
        expect(session.snapshot.value.presentation).toBe('page-shell');
    });
    it('atomically promotes a provisional revision without revoking its visual generation', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'pending.pdf', 'open-intent:1');
        session.requestNavigation(6);
        const provisionalFence = createRenderFence(session, generation, 'open-intent:1', {
            renderVersion: 1,
            requestId: 1,
            pageNumber: 6,
        });
        const provisionalViewport = createViewportCommit(provisionalFence);

        const claimedGeneration = session.acquireSource({
            documentId: 'pending.pdf',
            documentRevision: 'canonical-revision',
        }, session.snapshot.value.generation);

        expect(claimedGeneration).toBe(generation);
        expect(session.snapshot.value.identity?.documentRevision).toBe('canonical-revision');
        expect(session.viewportSession.value).toMatchObject({
            generation,
            requestedPage: 6,
            identity: {
                documentId: 'pending.pdf',
                revision: 'canonical-revision',
            },
        });
        expect(session.createRenderFence({
            ...provisionalFence,
            generation: claimedGeneration!,
        })).toBeNull();
        expect(session.commitCanvas(provisionalFence)).toBe(false);
        expect(session.commitViewport(provisionalViewport)).toBe(false);
        expect(session.createRenderFence({
            ...provisionalFence,
            generation: claimedGeneration!,
            documentRevision: 'canonical-revision',
        })?.documentRevision).toBe('canonical-revision');
    });

    it('preserves committed geometry when a provisional identity is refined before rendering', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'pending.pdf', 'open-intent:1');
        expect(session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 20,
        })).toBe(true);

        const claimedGeneration = session.acquireSource({
            documentId: 'pending.pdf',
            documentRevision: 'load:1',
        }, session.snapshot.value.generation);
        expect(claimedGeneration).toBe(generation);
        expect(session.snapshot.value).toMatchObject({
            generation: claimedGeneration,
            phase: 'geometry-committed',
            identity: {
                documentId: 'pending.pdf',
                documentRevision: 'load:1',
            },
            geometry: {
                width: 612,
                height: 792,
                margin: 20,
            },
            openingPageGeometry: null,
            openingPageFrame: null,
            committedRender: null,
            committedViewport: null,
        });
    });

    it('rejects caller revision mismatches instead of relabelling render evidence', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'pending.pdf', 'load:1');
        const input = {
            generation,
            documentRevision: 'open-intent:1',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        };

        expect(session.createRenderFence(input)).toBeNull();
        expect(session.createRenderFence({
            ...input,
            documentRevision: 'load:1',
        })).toEqual({
            ...input,
            documentRevision: 'load:1',
            viewportIntentId: 'open:1',
        });
    });

    it('rejects late provisional refinement instead of turning it into a new open', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'pending.pdf', 'open-intent:1');
        commitDefaultGeometry(session, generation);
        const fence = createRenderFence(session, generation, 'open-intent:1');
        expect(session.commitCanvas(fence)).toBe(true);
        expect(session.commitViewport(createViewportCommit(fence))).toBe(true);
        expect(session.acquireSource({
            documentId: 'pending.pdf',
            documentRevision: 'load:1',
        }, generation)).toBeNull();
        expect(session.snapshot.value.generation).toBe(generation);
        expect(session.snapshot.value.identity?.documentRevision).toBe('open-intent:1');
        expect(session.markReady(fence)).toBe(true);
    });

    it('rejects a stale source acquisition after another document owns the surface', () => {
        const session = createDocumentOpenSurfaceSession();
        const first = session.begin({
            documentId: 'a.pdf',
            documentRevision: 'rev-a',
        });
        const second = session.begin({
            documentId: 'b.pdf',
            documentRevision: 'rev-b',
        });
        expect(session.acquireSource({
            documentId: 'a.pdf',
            documentRevision: 'late-a',
        }, first)).toBeNull();
        expect(session.acquireSource({
            documentId: 'a.pdf',
            documentRevision: 'late-a',
        }, second)).toBeNull();
        expect(session.snapshot.value.generation).toBe(second);
        expect(session.snapshot.value.identity?.documentId).toBe('b.pdf');
    });

    it('rejects canvas commits from a superseded open generation', () => {
        const session = createDocumentOpenSurfaceSession();
        const firstGeneration = session.begin({
            documentId: 'a.pdf',
            documentRevision: 'rev-a',
        });
        const staleFence = session.createRenderFence({
            generation: firstGeneration,
            documentRevision: 'rev-a',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        });
        expect(firstGeneration).toBe(1);
        expect(staleFence).not.toBeNull();

        session.begin({
            documentId: 'b.pdf',
            documentRevision: 'rev-b',
        });

        expect(session.commitCanvas(staleFence!)).toBe(false);
        expect(session.snapshot.value.phase).toBe('pending');
        expect(session.snapshot.value.identity?.documentId).toBe('b.pdf');
    });

    it('rejects every late commit after teardown reset and a replacement begin', () => {
        const session = createDocumentOpenSurfaceSession();
        const firstGeneration = session.begin({
            documentId: 'a.pdf',
            documentRevision: 'rev-a',
        }, {
            documentId: 'a.pdf',
            pageNumber: 1,
            pageCount: 1,
            width: 612,
            height: 792,
            rotation: 0,
        });
        expect(session.commitGeometry(firstGeneration, {
            width: 612,
            height: 792,
            margin: 20,
        })).toBe(true);
        const staleFence = session.createRenderFence({
            generation: firstGeneration,
            documentRevision: 'rev-a',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        });
        expect(staleFence).not.toBeNull();

        session.reset();
        const replacementGeneration = session.begin({
            documentId: 'b.pdf',
            documentRevision: 'rev-b',
        });

        expect(session.commitCanvas(staleFence!)).toBe(false);
        expect(session.commitOpeningPageGeometry(firstGeneration, openingGeometry('a.pdf', 1, {
            pageNumber: 1,
            width: 612,
            height: 792,
            rotation: 0,
        }))).toBe(false);
        expect(session.snapshot.value).toMatchObject({
            generation: replacementGeneration,
            identity: {
                documentId: 'b.pdf',
                documentRevision: 'rev-b',
            },
            phase: 'pending',
            openingPageGeometry: null,
            openingPageFrame: null,
            committedRender: null,
            committedViewport: null,
        });
    });

    it('requires exact committed render identity before releasing the surface', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'a.pdf', 'rev-a');
        expect(session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 20,
        })).toBe(true);
        const committedFence = createRenderFence(session, generation, 'rev-a', {
            renderVersion: 3,
            requestId: 7,
            pageNumber: 1,
        });
        const differentRequest = {
            ...committedFence,
            requestId: 8,
        };

        expect(session.commitCanvas(committedFence)).toBe(true);
        expect(session.markReady(differentRequest)).toBe(false);
        expect(session.snapshot.value.phase).toBe('canvas-committed');
        expect(session.commitViewport(createViewportCommit({
            ...differentRequest,
            pageNumber: 2,
        }))).toBe(false);
        expect(session.snapshot.value.phase).toBe('canvas-committed');
        expect(session.snapshot.value.committedViewport).toBeNull();
        expect(session.commitViewport(createViewportCommit(committedFence))).toBe(true);
        expect(session.snapshot.value.phase).toBe('viewport-committed');
        expect(session.markReady(committedFence)).toBe(true);
        expect(session.snapshot.value).toMatchObject({
            phase: 'ready',
            presentation: 'committed',
        });
    });

    it('settles ready-phase navigation from the current requested-page render and viewport commits', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'scan.djvu', 'djvu:1');
        session.metadataReady(12);
        session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 16,
        });
        const openingFence = createRenderFence(session, generation, 'djvu:1');
        session.commitCanvas(openingFence);
        session.commitViewport(createViewportCommit(openingFence));
        expect(session.markReady(openingFence)).toBe(true);

        expect(session.requestNavigation(7)).toBe(7);
        const navigationFence = createRenderFence(session, generation, 'djvu:1', {
            renderVersion: 1,
            requestId: 2,
            pageNumber: 7,
        });
        expect(session.commitCanvas(openingFence)).toBe(false);
        expect(session.commitCanvas(navigationFence)).toBe(true);
        expect(session.commitViewport(createViewportCommit(navigationFence))).toBe(true);
        expect(session.markReady(navigationFence)).toBe(true);

        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'ready',
            requestedPage: 7,
            committedPage: 7,
            visual: {
                kind: 'page',
                pageNumber: 7,
                presentation: 'canvas',
            },
        });
        expect(session.snapshot.value).toMatchObject({
            phase: 'ready',
            presentation: 'committed',
            committedRender: navigationFence,
            committedViewport: {pageNumber: 7},
        });
    });

    it('does not bind a late opening-page completion to a newer early-navigation intent', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'scan.pdf', 'pdfjs:1');
        session.metadataReady(20);
        commitDefaultGeometry(session, generation);
        const openingFence = createRenderFence(session, generation, 'pdfjs:1');
        const openingViewport = createViewportCommit(openingFence);

        expect(session.requestNavigation(7)).toBe(7);
        expect(session.createRenderFence({
            generation,
            documentRevision: 'pdfjs:1',
            renderVersion: 2,
            requestId: 2,
            pageNumber: 1,
        })).toBeNull();
        expect(session.commitCanvas(openingFence)).toBe(false);
        expect(session.commitViewport(openingViewport)).toBe(false);
        expect(session.snapshot.value).toMatchObject({
            phase: 'geometry-committed',
            committedRender: null,
            committedViewport: null,
        });
        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'opening',
            requestedPage: 7,
            committedRenderFence: null,
            committedViewportFence: null,
        });

        const navigationFence = createRenderFence(session, generation, 'pdfjs:1', {
            renderVersion: 1,
            requestId: 3,
            pageNumber: 7,
        });
        expect(navigationFence.viewportIntentId).not.toBe(openingFence.viewportIntentId);
        expect(session.commitCanvas(navigationFence)).toBe(true);
        expect(session.commitViewport(createViewportCommit(navigationFence))).toBe(true);
        expect(session.markReady(navigationFence)).toBe(true);
        expect(session.viewportSession.value.committedPage).toBe(7);
    });

    it('leaves both session snapshots untouched when a viewport commit has a rejected intent', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'scan.pdf', 'pdfjs:1');
        commitDefaultGeometry(session, generation);
        const fence = createRenderFence(session, generation, 'pdfjs:1');
        expect(session.commitCanvas(fence)).toBe(true);
        const surfaceBefore = session.snapshot.value;
        const viewportBefore = session.viewportSession.value;

        expect(session.commitViewport({
            ...createViewportCommit(fence),
            viewportIntentId: 'superseded-intent',
        })).toBe(false);
        expect(session.snapshot.value).toBe(surfaceBefore);
        expect(session.viewportSession.value).toBe(viewportBefore);
        expect(session.snapshot.value.committedViewport).toBeNull();
        expect(session.viewportSession.value.committedViewportFence).toBeNull();
    });

    it('terminalizes a failed current navigation without letting the skeleton timer survive', () => {
        vi.useFakeTimers();
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'scan.djvu', 'djvu:1');
        session.metadataReady(12);
        session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 16,
        });
        const openingFence = createRenderFence(session, generation, 'djvu:1');
        commitReadySurface(session, openingFence);

        session.requestNavigation(7, 120);
        const navigationFence = createRenderFence(session, generation, 'djvu:1', {
            renderVersion: 1,
            requestId: 2,
            pageNumber: 7,
        });
        expect(session.reject(navigationFence, 'Unable to display page 7')).toBe(true);
        vi.advanceTimersByTime(120);

        expect(session.snapshot.value).toMatchObject({
            phase: 'failed',
            presentation: 'failed',
            failure: 'Unable to display page 7',
        });
        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'failed',
            requestedPage: 7,
            skeletonDelay: null,
            visual: {
                kind: 'page',
                pageNumber: 7,
                presentation: 'error',
                error: 'Unable to display page 7',
            },
        });
        expect(session.reject(openingFence, 'stale opening failure')).toBe(false);
        vi.useRealTimers();
    });

    it('terminalizes a page-source failure that occurs before a render fence exists', () => {
        vi.useFakeTimers();
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'oversized.pdf', 'native:1');
        session.metadataReady(431);
        session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 16,
        });
        const openingFence = createRenderFence(session, generation, 'native:1');
        commitReadySurface(session, openingFence);

        session.requestNavigation(5, 120);
        expect(session.viewportSession.value.renderFence).toBeNull();
        expect(session.failPageTransition(5, 'Native preview failed')).toBe(true);
        vi.advanceTimersByTime(120);

        expect(session.snapshot.value).toMatchObject({
            phase: 'failed',
            presentation: 'failed',
            failure: 'Native preview failed',
        });
        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'failed',
            requestedPage: 5,
            skeletonDelay: null,
            failure: 'Native preview failed',
            visual: {
                kind: 'page',
                pageNumber: 5,
                presentation: 'error',
                error: 'Native preview failed',
            },
        });
        expect(session.failPageTransition(4, 'stale')).toBe(false);
        vi.useRealTimers();
    });

    it('generation-fences the replacement page shell until its joined commit', () => {
        const session = createDocumentOpenSurfaceSession();
        const firstGeneration = session.begin({
            documentId: 'a.pdf',
            documentRevision: 'rev-a',
        });
        commitDefaultGeometry(session, firstGeneration);
        const firstFence = createRenderFence(session, firstGeneration, 'rev-a');
        session.commitCanvas(firstFence);
        session.commitViewport(createViewportCommit(firstFence));
        expect(session.markReady(firstFence)).toBe(true);

        const secondGeneration = session.begin({
            documentId: 'b.pdf',
            documentRevision: 'rev-b',
        }, {
            documentId: 'b.pdf',
            pageNumber: 1,
            pageCount: 2,
            width: 700,
            height: 900,
            rotation: 0,
        });
        expect(session.commitOpeningPageFrame(secondGeneration, openingFrame(secondGeneration, {
            ownerId: 'pdfjs',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            style: {
                width: '700px',
                height: '900px',
            },
        }))).toBe(true);
        expect(session.snapshot.value.presentation).toBe('page-shell');

        const supersededGeneration = session.begin({...session.snapshot.value.identity!});
        expect(session.snapshot.value.presentation).toBe('idle');
        expect(session.snapshot.value.openingPageFrame).toBeNull();
        session.commitGeometry(supersededGeneration, {
            width: 700,
            height: 900,
            margin: 20,
        });
        const replacementFence = createRenderFence(session, supersededGeneration, 'rev-b', {
            renderVersion: 2,
            requestId: 3,
            pageNumber: 1,
        });
        session.commitCanvas(replacementFence);
        session.commitViewport(createViewportCommit(replacementFence));

        expect(session.markReady(replacementFence)).toBe(true);
        expect(session.snapshot.value).toMatchObject({
            phase: 'ready',
            presentation: 'committed',
        });
    });

    it('does not expose an empty-to-document page shell before frame and geometry commit', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'a.pdf', 'rev-a');

        expect(session.snapshot.value).toMatchObject({presentation: 'idle'});
        expect(session.commitOpeningPageFrame(generation, openingFrame(generation))).toBe(true);
        expect(session.snapshot.value.presentation).toBe('idle');
        expect(session.commitOpeningPageGeometry(generation, openingGeometry('a.pdf', 431, {
            pageNumber: 1,
            width: 612,
            height: 792,
            rotation: 0,
        }))).toBe(true);
        expect(session.snapshot.value.presentation).toBe('page-shell');
        expect(session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 20,
        })).toBe(true);
        expect(session.snapshot.value.presentation).toBe('page-shell');
    });

    it('presents an exact opening shell when its frame arrives after opening geometry', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'a.pdf',
            documentRevision: 'rev-a',
        }, {
            documentId: 'a.pdf',
            pageNumber: 7,
            pageCount: 431,
            width: 612,
            height: 792,
            rotation: 0,
        });

        expect(session.snapshot.value.presentation).toBe('idle');
        expect(session.commitOpeningPageFrame(generation, openingFrame(generation, {
            ownerId: 'pdfjs',
            pageNumber: 7,
            intentKey: 'fit-width:1',
            style: {
                width: '612px',
                height: '792px',
            },
        }))).toBe(true);
        expect(session.snapshot.value.presentation).toBe('page-shell');
        expect(session.snapshot.value.geometry).toBeNull();
    });

    it('atomically begins a prepared empty-surface open without exposing pending idle', () => {
        const session = createDocumentOpenSurfaceSession();
        const snapshots: Array<{
            phase: string;
            presentation: string;
        }> = [];
        watch(session.snapshot, value => snapshots.push({
            phase: value.phase,
            presentation: value.presentation,
        }), {flush: 'sync'});

        const generation = session.beginPrepared({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:prepared',
            provisional: true,
        }, {
            documentId: 'scan.pdf',
            ownerId: 'document-viewer-runtime:1',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            layoutKey: '0:1000x800',
            policyKey: 'width:single:fit-width:1',
            sourceRevisionKey: '28000000:42',
            style: {
                width: '960px',
                height: '1280px',
            },
            geometry: {
                documentId: 'scan.pdf',
                pageNumber: 1,
                pageCount: 431,
                width: 600,
                height: 800,
                rotation: 0,
            },
        });

        expect(generation).toBe(1);
        expect(snapshots).toEqual([{
            phase: 'pending',
            presentation: 'page-shell',
        }]);
        expect(session.snapshot.value).toMatchObject({
            phase: 'pending',
            presentation: 'page-shell',
            openingPageGeometry: {documentId: 'scan.pdf'},
            openingPageFrame: {
                generation: 1,
                ownerId: 'document-viewer-runtime:1',
            },
        });
    });

    it('keeps one page-shell owner while the PDF loader promotes its revision', () => {
        const session = createDocumentOpenSurfaceSession();
        const presentations: string[] = [];
        watch(session.snapshot, value => presentations.push(value.presentation), {flush: 'sync'});
        const generation = session.beginPrepared({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:prepared',
            provisional: true,
        }, {
            documentId: 'scan.pdf',
            ownerId: 'document-viewer-runtime:1',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            layoutKey: '0:1000x800',
            policyKey: 'width:single:fit-width:1',
            sourceRevisionKey: '28000000:42',
            style: {
                width: '960px',
                height: '1280px',
            },
            geometry: {
                documentId: 'scan.pdf',
                pageNumber: 1,
                pageCount: 431,
                width: 600,
                height: 800,
                rotation: 0,
            },
        })!;

        expect(session.acquireSource({
            documentId: 'scan.pdf',
            documentRevision: 'pdf-source:42',
        }, session.snapshot.value.generation)).toBe(generation);
        expect(session.snapshot.value).toMatchObject({
            generation,
            presentation: 'page-shell',
            identity: {documentRevision: 'pdf-source:42'},
            openingPageFrame: {
                generation,
                ownerId: 'document-viewer-runtime:1',
            },
        });
        expect(session.clearOpeningPageFrame(generation, 'document-viewer-runtime:1')).toBe(false);
        expect(presentations).toEqual([
            'page-shell',
            'page-shell',
        ]);
    });

    it('rejects a mismatched prepared frame without changing the empty surface', () => {
        const session = createDocumentOpenSurfaceSession();
        expect(session.beginPrepared({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:prepared',
            provisional: true,
        }, {
            documentId: 'other.pdf',
            ownerId: 'document-viewer-runtime:1',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            layoutKey: '0:1000x800',
            policyKey: 'width:single:fit-width:1',
            sourceRevisionKey: '28000000:42',
            style: {width: '960px'},
            geometry: {
                documentId: 'other.pdf',
                pageNumber: 1,
                pageCount: 1,
                width: 600,
                height: 800,
                rotation: 0,
            },
        })).toBeNull();
        expect(session.snapshot.value).toMatchObject({
            phase: 'idle',
            presentation: 'idle',
            identity: null,
        });
    });

    it('does not present an opening frame for a different page', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'a.pdf',
            documentRevision: 'rev-a',
        }, {
            documentId: 'a.pdf',
            pageNumber: 7,
            pageCount: 431,
            width: 612,
            height: 792,
            rotation: 0,
        });

        expect(session.commitOpeningPageFrame(generation, openingFrame(generation))).toBe(true);
        expect(session.snapshot.value.presentation).toBe('idle');
    });

    it('makes the opening surface the sole owner of empty-placeholder handoff', () => {
        const session = createDocumentOpenSurfaceSession();
        expect(shouldPresentDocumentOpenEmptyPlaceholder(session.snapshot.value)).toBe(true);

        const generation = beginSurface(session, 'scan.pdf', 'open-intent:1');
        expect(shouldPresentDocumentOpenEmptyPlaceholder(session.snapshot.value)).toBe(true);

        session.commitOpeningPageFrame(generation, openingFrame(generation, {
            ownerId: 'pdfjs',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            style: {
                width: '760px',
                height: '1224px',
            },
        }));
        expect(shouldPresentDocumentOpenEmptyPlaceholder(session.snapshot.value)).toBe(true);

        session.commitGeometry(generation, {
            width: 760,
            height: 1224,
            margin: 20,
        });
        expect(shouldPresentDocumentOpenEmptyPlaceholder(session.snapshot.value)).toBe(false);

        const failedSession = createDocumentOpenSurfaceSession();
        const failedGeneration = failedSession.begin({
            documentId: 'broken.pdf',
            documentRevision: 'open-intent:2',
        });
        failedSession.fail(failedGeneration, 'load failed');
        expect(shouldPresentDocumentOpenEmptyPlaceholder(failedSession.snapshot.value)).toBe(false);

        failedSession.reset();
        expect(shouldPresentDocumentOpenEmptyPlaceholder(failedSession.snapshot.value)).toBe(true);
    });

    it('owns and generation-fences the exact opening page frame', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'scan.pdf', 'open-intent:1');
        const style = {
            width: '612px',
            height: '792px',
        };

        expect(session.commitOpeningPageFrame(generation, {
            generation,
            ownerId: 'pdfjs',
            pageNumber: 7,
            intentKey: 'custom:3.92',
            style,
        })).toBe(true);
        style.width = '1px';
        expect(session.snapshot.value.openingPageFrame).toMatchObject({
            generation,
            pageNumber: 7,
            intentKey: 'custom:3.92',
            style: {
                width: '612px',
                height: '792px',
            },
        });

        const nextGeneration = session.begin({...session.snapshot.value.identity!});
        expect(session.snapshot.value.openingPageFrame).toBeNull();
        expect(session.commitOpeningPageFrame(generation, {
            generation,
            ownerId: 'pdfjs',
            pageNumber: 7,
            intentKey: 'custom:3.92',
            style,
        })).toBe(false);
        expect(nextGeneration).toBe(generation + 1);
    });

    it('prevents one renderer from clearing or overwriting another renderer frame', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'scan.djvu', 'open-intent:1');
        expect(session.commitOpeningPageFrame(generation, openingFrame(generation, {
            ownerId: 'page-source:1',
            pageNumber: 1,
            intentKey: 'page-source:fit-width:1',
            style: {
                width: '612px',
                height: '792px',
            },
        }))).toBe(true);
        expect(session.commitOpeningPageFrame(generation, openingFrame(generation, {
            ownerId: 'pdfjs',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            style: {
                width: '1px',
                height: '1px',
            },
        }))).toBe(false);
        expect(session.clearOpeningPageFrame(generation, 'pdfjs')).toBe(false);
        expect(session.clearOpeningPageFrame(generation, 'page-source:1')).toBe(false);
        expect(session.snapshot.value.openingPageFrame?.ownerId).toBe('page-source:1');
    });

    it('retires the previous opening page source before publishing its replacement', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, '/tmp/dictionary.pdf', 'open-intent:source');
        const firstSource = createPageSource('/tmp/dictionary.pdf');
        const secondSource = createPageSource('/tmp/dictionary.pdf');
        const retireFirst = vi.fn();
        const retireSecond = vi.fn();

        expect(session.publishOpeningPageSource(generation, firstSource, retireFirst)).toBe(true);
        expect(session.openingPageSource.value?.dispose).toBe(firstSource.dispose);

        expect(session.publishOpeningPageSource(generation, secondSource, retireSecond)).toBe(true);
        expect(retireFirst).toHaveBeenCalledOnce();
        expect(session.openingPageSource.value?.dispose).toBe(secondSource.dispose);

        session.reset();
        expect(retireSecond).toHaveBeenCalledOnce();
        expect(session.openingPageSource.value).toBeNull();
    });

    it('atomically retires the opening frame when the committed surface becomes ready', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'scan.djvu', 'open-intent:ready');
        expect(session.commitOpeningPageFrame(generation, {
            generation,
            ownerId: 'page-source:1',
            pageNumber: 1,
            intentKey: 'page-source:fit-width:1',
            style: {
                height: '792px',
                width: '612px',
            },
        })).toBe(true);
        expect(session.commitGeometry(generation, {
            height: 792,
            margin: 16,
            width: 612,
        })).toBe(true);
        const fence = createRenderFence(session, generation, 'open-intent:ready');
        expect(session.commitCanvas(fence)).toBe(true);
        expect(session.commitViewport(createViewportCommit(fence))).toBe(true);

        expect(session.markReady(fence)).toBe(true);
        expect(session.snapshot.value).toMatchObject({
            openingPageFrame: null,
            phase: 'ready',
            presentation: 'committed',
        });
    });

    it('keeps a committed PDF.js canvas behind the staged frame until validation authorizes it', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.beginPrepared({
            documentId: 'dictionary.pdf',
            documentRevision: 'open-intent:held',
        }, {
            documentId: 'dictionary.pdf',
            ownerId: 'test-chassis',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            layoutKey: '1000x800',
            policyKey: 'width:single:fit-width:1',
            sourceRevisionKey: '170496793:1724000000000',
            style: {
                width: '900px',
                height: '1165px',
            },
            geometry: {
                documentId: 'dictionary.pdf',
                pageNumber: 1,
                pageCount: 1_859,
                width: 612,
                height: 792,
                rotation: 0,
                size: 170_496_793,
                modifiedAt: 1_724_000_000_000,
            },
        });
        expect(generation).not.toBeNull();
        if (generation === null) throw new Error('Expected prepared opening generation');
        expect(session.holdReadyForValidation(generation, '170496793:1724000000000')).toBe(true);
        expect(session.commitGeometry(generation, {
            height: 1_165,
            margin: 16,
            width: 900,
        })).toBe(true);
        const fence = createRenderFence(session, generation, 'open-intent:held');
        expect(session.commitCanvas(fence)).toBe(true);
        expect(session.commitViewport(createViewportCommit(fence))).toBe(true);

        expect(session.markReady(fence)).toBe(false);
        expect(session.snapshot.value.openingPageFrame).not.toBeNull();
        expect(session.releaseReadyAfterValidation(
            generation,
            '170496793:1724000000000',
        )).toEqual({
            authorized: true,
            ready: true,
        });
        expect(session.snapshot.value).toMatchObject({
            openingPageFrame: null,
            phase: 'ready',
            presentation: 'committed',
        });
    });

    it('fails closed when validation rejects an already-rendered speculative canvas', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'dictionary.pdf', 'open-intent:invalid');
        expect(session.commitOpeningPageFrame(generation, {
            ...openingFrame(generation),
            sourceRevisionKey: '170496793:1724000000000',
        })).toBe(true);
        expect(session.holdReadyForValidation(generation, '170496793:1724000000000')).toBe(true);
        commitDefaultGeometry(session, generation);
        const fence = createRenderFence(session, generation, 'open-intent:invalid');
        expect(session.commitCanvas(fence)).toBe(true);
        expect(session.commitViewport(createViewportCommit(fence))).toBe(true);

        expect(session.fail(generation, 'parser validation failed')).toBe(true);
        expect(session.snapshot.value).toMatchObject({
            committedRender: fence,
            failure: 'parser validation failed',
            openingPageFrame: null,
            phase: 'failed',
        });
        expect(session.markReady(fence)).toBe(false);
    });

    it('fences a staged opening raster by generation, document revision, and page', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'dictionary.pdf', 'open-intent:111');
        expect(session.commitOpeningPageFrame(generation, {
            ...openingFrame(generation),
            sourceRevisionKey: '170496793:1724000000000',
        })).toBe(true);
        const preview = {
            documentId: 'dictionary.pdf',
            documentRevision: 'open-intent:111',
            objectUrl: 'blob:native-page-one',
            pageNumber: 1,
            renderedWidth: 1_200,
            sourceRevisionKey: '170496793:1724000000000',
        };

        expect(session.commitOpeningPagePreview(generation, {
            ...preview,
            documentRevision: 'open-intent:stale',
        })).toBe(false);
        expect(session.commitOpeningPagePreview(generation, {
            ...preview,
            pageNumber: 2,
        })).toBe(false);
        expect(session.commitOpeningPagePreview(generation, {
            ...preview,
            documentId: 'other.pdf',
        })).toBe(false);
        expect(session.commitOpeningPagePreview(generation, {
            ...preview,
            sourceRevisionKey: '170496793:1724000000001',
        })).toBe(false);
        expect(session.commitOpeningPagePreview(generation, preview)).toBe(true);
        expect(session.snapshot.value.openingPageFrame?.preview).toEqual(preview);

        const replacementGeneration = session.begin({
            documentId: 'replacement.pdf',
            documentRevision: 'open-intent:replacement',
        });
        expect(replacementGeneration).toBeGreaterThan(generation);
        expect(session.commitOpeningPagePreview(generation, preview)).toBe(false);
        expect(session.snapshot.value.openingPageFrame).toBeNull();
    });

    it('presents the canonical shell when its owned frame arrives after geometry', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'scan.djvu', 'open-intent:1');
        expect(session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 16,
        })).toBe(true);
        expect(session.snapshot.value.presentation).toBe('idle');
        expect(session.commitOpeningPageFrame(generation, openingFrame(generation, {
            ownerId: 'page-source:1',
            pageNumber: 1,
            intentKey: 'page-source:fit-width:1',
            style: {
                width: '612px',
                height: '792px',
            },
        }))).toBe(true);
        expect(session.snapshot.value.presentation).toBe('page-shell');
    });

    it('restarts a failed replacement through the empty page-shell surface', () => {
        const session = createDocumentOpenSurfaceSession();
        const initialGeneration = session.begin({
            documentId: 'a.pdf',
            documentRevision: 'rev-a',
        });
        commitDefaultGeometry(session, initialGeneration);
        const initialFence = createRenderFence(session, initialGeneration, 'rev-a');
        commitReadySurface(session, initialFence);

        const failedGeneration = session.begin({
            documentId: 'b.pdf',
            documentRevision: 'rev-b',
        });
        expect(session.fail(failedGeneration, 'load failed')).toBe(true);
        const retryGeneration = session.begin({
            documentId: 'b.pdf',
            documentRevision: 'rev-b:retry',
        });

        expect(session.snapshot.value).toMatchObject({
            generation: retryGeneration,
            phase: 'pending',
            presentation: 'idle',
        });
    });

    it('rejects older requests after a newer canvas has committed', () => {
        const session = createDocumentOpenSurfaceSession();
        session.begin({
            documentId: 'a.pdf',
            documentRevision: 'rev-a',
        });
        const generation = session.snapshot.value.generation;
        commitDefaultGeometry(session, generation);
        const newer = createRenderFence(session, generation, 'rev-a', {
            renderVersion: 4,
            requestId: 10,
            pageNumber: 1,
        });
        const older = {
            ...newer,
            requestId: 9,
        };

        expect(session.commitCanvas(newer)).toBe(true);
        expect(session.commitCanvas(older)).toBe(false);
        expect(session.snapshot.value.committedRender).toEqual(newer);
    });

    it('keeps render ordering monotonic when the renderer feature hot-swaps', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'a.pdf', 'rev-a');
        commitDefaultGeometry(session, generation);
        const firstRenderer = session.claimRenderOwner();
        for (let requestId = 1; requestId <= 3; requestId += 1) {
            const fence = session.createOwnedRenderFence(firstRenderer, {
                generation,
                documentRevision: 'rev-a',
                rendererVersion: 4,
                rendererRequestId: requestId,
                pageNumber: 1,
            });
            expect(fence).not.toBeNull();
            expect(session.commitCanvas(fence!)).toBe(true);
        }

        const preHandoffFence = session.createOwnedRenderFence(firstRenderer, {
            generation,
            documentRevision: 'rev-a',
            rendererVersion: 5,
            rendererRequestId: 1,
            pageNumber: 1,
        })!;
        const replacementRenderer = session.claimRenderOwner();
        const replacementFence = session.createOwnedRenderFence(replacementRenderer, {
            generation,
            documentRevision: 'rev-a',
            rendererVersion: 1,
            rendererRequestId: 1,
            pageNumber: 1,
        });
        expect(replacementFence).not.toBeNull();
        expect(session.commitCanvas(preHandoffFence)).toBe(false);
        expect(session.createOwnedRenderFence(firstRenderer, {
            generation,
            documentRevision: 'rev-a',
            rendererVersion: 6,
            rendererRequestId: 1,
            pageNumber: 1,
        })).toBeNull();
        expect(session.commitCanvas(replacementFence!)).toBe(true);
        expect(session.snapshot.value.committedRender).toEqual(replacementFence);

        const latePreviousRendererFence = session.createOwnedRenderFence(firstRenderer, {
            generation,
            documentRevision: 'rev-a',
            rendererVersion: 5,
            rendererRequestId: 1,
            pageNumber: 1,
        });
        expect(latePreviousRendererFence).toBeNull();
        expect(session.snapshot.value.committedRender).toEqual(replacementFence);
    });

    it('adopts an older resident page canvas as a new commit for the current renderer owner', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'a.pdf', 'rev-a');
        commitDefaultGeometry(session, generation);
        const owner = session.claimRenderOwner();
        const newerRender = session.createOwnedRenderFence(owner, {
            generation,
            documentRevision: 'rev-a',
            rendererVersion: 8,
            rendererRequestId: 20,
            pageNumber: 1,
        })!;
        expect(session.commitCanvas(newerRender)).toBe(true);

        session.requestNavigation(2, 0);
        const residentCanvas = session.createOwnedResidentRenderFence(owner, {
            generation,
            documentRevision: 'rev-a',
            pageNumber: 2,
        });
        expect(residentCanvas).not.toBeNull();
        expect(session.commitCanvas(residentCanvas!)).toBe(true);
        expect(session.snapshot.value.committedRender).toEqual(residentCanvas);
    });

    it('does not replace a current-generation canvas commit with a late failure', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'a.pdf', 'rev-a');
        commitDefaultGeometry(session, generation);
        const fence = createRenderFence(session, generation, 'rev-a');
        expect(session.commitCanvas(fence)).toBe(true);

        expect(session.fail(generation, 'late recovery failure')).toBe(false);
        expect(session.snapshot.value.phase).toBe('canvas-committed');
        expect(session.snapshot.value.failure).toBeNull();
    });

    it('rejects an old render after an explicit source reload', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'a.pdf', 'rev-a');
        const fence = createRenderFence(session, generation, 'rev-a');

        expect(session.acquireSource({
            documentId: 'a.pdf',
            documentRevision: 'rev-b',
        }, generation)).toBe(2);
        expect(session.commitCanvas(fence)).toBe(false);
        expect(session.snapshot.value.phase).toBe('pending');
    });

    it('does not accept guessed or invalid geometry', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'a.pdf', 'rev-a');

        expect(session.commitGeometry(generation, {
            width: 0,
            height: 792,
            margin: 20,
        })).toBe(false);
        expect(session.snapshot.value.geometry).toBeNull();
        expect(session.snapshot.value.phase).toBe('pending');
    });

    it('keeps scrollbar gutters out of geometry and enables legitimate overflow only after an exact commit', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'a.pdf', 'rev-a');
        expect(resolveDocumentOpenSurfaceViewportPolicy(session.snapshot.value)).toEqual({
            overflow: 'hidden',
            scrollbarGutter: 'stable',
            committedMargin: null,
        });
        session.commitGeometry(generation, {
            width: 3_060,
            height: 3_960,
            margin: 20,
        });
        const fence = createRenderFence(session, generation, 'rev-a', {
            renderVersion: 2,
            requestId: 3,
            pageNumber: 1,
        });
        commitReadySurface(session, fence);

        expect(resolveDocumentOpenSurfaceViewportPolicy(session.snapshot.value)).toEqual({
            overflow: 'auto',
            scrollbarGutter: 'stable',
            committedMargin: 20,
        });
    });

    it('projects scroll position only from a fully committed viewport session', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'scan.djvu', 'revision-1');
        expect(shouldProjectDocumentViewportScroll(
            session.snapshot.value,
            session.viewportSession.value,
        )).toBe(false);

        session.commitOpeningPageGeometry(generation, openingGeometry('scan.djvu', 20, {
            pageNumber: 1,
            width: 612,
            height: 792,
            rotation: 0,
        }));
        session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 16,
        });
        const fence = createRenderFence(session, generation, 'revision-1');
        commitReadySurface(session, fence);

        expect(shouldProjectDocumentViewportScroll(
            session.snapshot.value,
            session.viewportSession.value,
        )).toBe(true);

        session.requestNavigation(2);
        expect(shouldProjectDocumentViewportScroll(
            session.snapshot.value,
            session.viewportSession.value,
        )).toBe(false);
    });

    it('keeps animation-frame sampling monotonic across same-turn DOM mutations', async () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'a.pdf', 'rev-a');
        const sampledPhases = [session.snapshot.value.phase];
        await Promise.resolve().then(() => {
            commitDefaultGeometry(session, generation);
            const fence = createRenderFence(session, generation, 'rev-a');
            commitReadySurface(session, fence);
        });
        sampledPhases.push(session.snapshot.value.phase);

        expect(sampledPhases).toEqual([
            'pending',
            'ready',
        ]);
        expect(session.snapshot.value.committedRender?.requestId).toBe(1);
    });

    it('accepts a late valid canvas from the failed generation and clears its failure', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'slow-scan.pdf', 'rev-1');
        commitDefaultGeometry(session, generation);
        session.fail(generation, 'initial render recovery exhausted');

        const fence = session.createRenderFence({
            generation,
            documentRevision: 'rev-1',
            renderVersion: 1,
            requestId: 9,
            pageNumber: 1,
        });

        expect(fence).not.toBeNull();
        expect(session.commitCanvas(fence!)).toBe(true);
        expect(session.commitViewport(createViewportCommit(fence!))).toBe(true);
        expect(session.markReady(fence!)).toBe(true);
        expect(session.snapshot.value).toMatchObject({
            generation,
            phase: 'ready',
            failure: null,
        });
    });

    it('rejects a late success from a superseded failed generation', () => {
        const session = createDocumentOpenSurfaceSession();
        const failedGeneration = session.begin({
            documentId: 'old.pdf',
            documentRevision: 'old-rev',
        });
        commitDefaultGeometry(session, failedGeneration);
        session.fail(failedGeneration, 'old failure');
        session.begin({
            documentId: 'new.pdf',
            documentRevision: 'new-rev',
        });

        expect(session.createRenderFence({
            generation: failedGeneration,
            documentRevision: 'old-rev',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        })).toBeNull();
    });

    it('records an actionable reason when a canvas arrives before geometry', () => {
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const session = createDocumentOpenSurfaceSession();
        const generation = beginSurface(session, 'saved-result.pdf', 'open-intent:1');
        const fence = createRenderFence(session, generation, 'open-intent:1');

        expect(session.commitCanvas(fence)).toBe(false);
        expect(session.getDiagnosticHistory().at(-1)).toMatchObject({
            event: 'commit-canvas',
            accepted: false,
            reason: 'geometry-not-committed',
            generation,
            phase: 'pending',
            requestedPage: 1,
            operationId: `document-open:${String(generation)}:open-intent:1`,
            details: {fence},
        });
        consoleWarn.mockRestore();
    });
});
