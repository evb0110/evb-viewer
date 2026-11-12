import type { IDocumentOpenSurfaceSnapshot } from '@app/modules/document-viewer/public';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import { createPdfReloadWaiter } from '@app/modules/pdf-viewer/engine/pdf-reload-waiter/createPdfReloadWaiter';
import { resolvePdfReloadPage } from '@app/modules/pdf-viewer/engine/pdf-reload-waiter/resolvePdfReloadPage';
import { cast } from '@tests/helpers/cast';

afterEach(() => vi.useRealTimers());

describe('resolvePdfReloadPage', () => {
    it('normalizes the semantic page target', () => {
        expect(resolvePdfReloadPage(3.8)).toBe(3);
        expect(resolvePdfReloadPage(0)).toBe(1);
    });
});

describe('createPdfReloadWaiter', () => {
    function createReloadingSurface() {
        const snapshot = shallowRef(cast<IDocumentOpenSurfaceSnapshot>({
            generation: 1,
            identity: {
                documentId: 'document',
                documentRevision: 'revision-a',
            },
            phase: 'ready',
            presentation: 'committed',
        }));
        return {
            openSurface: cast<Parameters<typeof createPdfReloadWaiter>[0]['openSurface']>({
                snapshot,
                viewportSession: shallowRef({lifecycle: 'ready'}),
            }),
            reload: () => {
                snapshot.value = cast({
                    ...snapshot.value,
                    generation: 2,
                    identity: {
                        documentId: 'document',
                        documentRevision: 'revision-b',
                    },
                });
            },
        };
    }

    it('restores the semantic page after the document reloads', async () => {
        const surface = createReloadingSurface();
        const scrollToPage = vi.fn();
        const waiter = createPdfReloadWaiter({
            pdfViewerRef: ref({scrollToPage}),
            openSurface: surface.openSurface,
            resetSearchCache: vi.fn(),
            pageToRestore: 5,
        });

        surface.reload();
        await waiter.promise;
        expect(scrollToPage).toHaveBeenCalledWith(5);
    });

    it('can wait for reload completion without restoring the viewport', async () => {
        const surface = createReloadingSurface();
        const scrollToPage = vi.fn();
        const resetSearchCache = vi.fn();
        const waiter = createPdfReloadWaiter({
            pdfViewerRef: ref({scrollToPage}),
            openSurface: surface.openSurface,
            resetSearchCache,
            pageToRestore: 8,
            restoreScroll: false,
        });

        surface.reload();
        await waiter.promise;
        expect(resetSearchCache).toHaveBeenCalledOnce();
        expect(scrollToPage).not.toHaveBeenCalled();
    });

    it('restores the page once the reloaded open surface is ready', async () => {
        vi.useFakeTimers();
        const visiblePage = ref(1);
        const surfaceSnapshot = shallowRef(cast<IDocumentOpenSurfaceSnapshot>({
            generation: 1,
            identity: {
                documentId: 'document',
                documentRevision: 'revision-a',
            },
            phase: 'ready',
            presentation: 'committed',
        }));
        const viewportSession = shallowRef(cast({lifecycle: 'ready'}));
        const waiter = createPdfReloadWaiter({
            pdfViewerRef: ref({scrollToPage: page => { visiblePage.value = page; }}),
            openSurface: cast({
                snapshot: surfaceSnapshot,
                viewportSession,
            }),
            resetSearchCache: vi.fn(),
            pageToRestore: 6,
        });

        await Promise.resolve();
        await Promise.resolve();
        expect(visiblePage.value).toBe(1);

        surfaceSnapshot.value = cast({
            generation: 2,
            identity: {
                documentId: 'document',
                documentRevision: 'open-intent:reload',
                provisional: true,
            },
            phase: 'pending',
            presentation: 'page-shell',
        });
        viewportSession.value = cast({lifecycle: 'opening'});
        await vi.advanceTimersByTimeAsync(0);
        expect(visiblePage.value).toBe(1);

        surfaceSnapshot.value = cast({
            generation: 2,
            identity: {
                documentId: 'document',
                documentRevision: 'revision-b',
            },
            phase: 'canvas-committed',
            presentation: 'page-shell',
        });
        viewportSession.value = cast({lifecycle: 'opening'});
        await Promise.resolve();
        expect(visiblePage.value).toBe(1);

        surfaceSnapshot.value = cast({
            generation: 2,
            identity: {
                documentId: 'document',
                documentRevision: 'revision-b',
            },
            phase: 'ready',
            presentation: 'committed',
        });
        viewportSession.value = cast({lifecycle: 'ready'});
        await vi.advanceTimersByTimeAsync(8000);
        await waiter.promise;

        expect(visiblePage.value).toBe(6);
    });

    it.each([
        {generation: 3},
        {identity: {
            documentId: 'replacement',
            documentRevision: 'revision-b',
        }},
        {identity: {
            documentId: 'document',
            documentRevision: 'revision-c',
        }},
    ])('does not place an admitted reload after its surface is replaced (%s)', async (replacement) => {
        vi.useFakeTimers();
        const visiblePage = ref(1);
        const surfaceSnapshot = shallowRef(cast<IDocumentOpenSurfaceSnapshot>({
            generation: 1,
            identity: {
                documentId: 'document',
                documentRevision: 'revision-a',
            },
            phase: 'ready',
            presentation: 'committed',
        }));
        const viewportSession = shallowRef(cast({lifecycle: 'ready'}));
        const waiter = createPdfReloadWaiter({
            pdfViewerRef: ref({scrollToPage: page => { visiblePage.value = page; }}),
            openSurface: cast({
                snapshot: surfaceSnapshot,
                viewportSession,
            }),
            resetSearchCache: () => {},
            pageToRestore: 6,
        });
        surfaceSnapshot.value = cast({
            ...surfaceSnapshot.value,
            generation: 2,
            identity: {
                documentId: 'document',
                documentRevision: 'revision-b',
            },
            phase: 'canvas-committed',
            presentation: 'page-shell',
        });
        viewportSession.value = cast({lifecycle: 'opening'});
        await vi.advanceTimersByTimeAsync(0);

        surfaceSnapshot.value = cast({
            ...surfaceSnapshot.value,
            ...replacement,
            phase: 'ready',
            presentation: 'committed',
        });
        viewportSession.value = cast({lifecycle: 'ready'});
        await waiter.promise;
        expect(visiblePage.value).toBe(1);
    });

    it('keeps replacement protection between readiness and placement', async () => {
        const visiblePage = ref(1);
        const surfaceSnapshot = shallowRef(cast<IDocumentOpenSurfaceSnapshot>({
            generation: 1,
            identity: {
                documentId: 'document',
                documentRevision: 'revision-a',
            },
            phase: 'ready',
            presentation: 'committed',
        }));
        const waiter = createPdfReloadWaiter({
            pdfViewerRef: ref({scrollToPage: page => { visiblePage.value = page; }}),
            openSurface: cast({
                snapshot: surfaceSnapshot,
                viewportSession: shallowRef({lifecycle: 'ready'}),
            }),
            resetSearchCache: () => {
                surfaceSnapshot.value = cast({
                    ...surfaceSnapshot.value,
                    generation: 3,
                });
            },
            pageToRestore: 6,
        });
        surfaceSnapshot.value = cast({
            ...surfaceSnapshot.value,
            generation: 2,
            identity: {
                documentId: 'document',
                documentRevision: 'revision-b',
            },
        });
        await waiter.promise;
        expect(visiblePage.value).toBe(1);
    });

    it.each([
        'cancel',
        'interact',
    ])('keeps the reader position when the pending surface restore is withdrawn (%s)', async (action) => {
        vi.useFakeTimers();
        const visiblePage = ref(1);
        let interactionEpoch = 1;
        const surfaceSnapshot = shallowRef(cast<IDocumentOpenSurfaceSnapshot>({
            generation: 1,
            identity: {
                documentId: 'document',
                documentRevision: 'revision-a',
            },
            phase: 'ready',
            presentation: 'committed',
        }));
        const viewportSession = shallowRef(cast({lifecycle: 'ready'}));
        const waiter = createPdfReloadWaiter({
            pdfViewerRef: ref({
                scrollToPage: page => { visiblePage.value = page; },
                getUserViewportInteractionEpoch: () => interactionEpoch,
            }),
            openSurface: cast({
                snapshot: surfaceSnapshot,
                viewportSession,
            }),
            resetSearchCache: () => {},
            pageToRestore: 6,
        });
        surfaceSnapshot.value = cast({
            ...surfaceSnapshot.value,
            generation: 2,
            identity: {
                documentId: 'document',
                documentRevision: 'revision-b',
            },
            phase: 'canvas-committed',
            presentation: 'page-shell',
        });
        viewportSession.value = cast({lifecycle: 'opening'});
        await vi.advanceTimersByTimeAsync(0);
        if (action === 'cancel') waiter.cancel();
        else interactionEpoch += 1;
        surfaceSnapshot.value = cast({
            ...surfaceSnapshot.value,
            phase: 'ready',
            presentation: 'committed',
        });
        viewportSession.value = cast({lifecycle: 'ready'});
        await waiter.promise;
        expect(visiblePage.value).toBe(1);
    });

    it('does not start a redundant navigation when the open surface already committed the target page', async () => {
        const scrollToPage = vi.fn();
        const surfaceSnapshot = shallowRef(cast<IDocumentOpenSurfaceSnapshot>({
            generation: 1,
            identity: {
                documentId: 'document',
                documentRevision: 'revision-a',
            },
            phase: 'ready',
            presentation: 'committed',
            committedViewport: {pageNumber: 6},
        }));
        const viewportSession = shallowRef(cast({lifecycle: 'ready'}));
        const waiter = createPdfReloadWaiter({
            pdfViewerRef: ref({scrollToPage}),
            openSurface: cast({
                snapshot: surfaceSnapshot,
                viewportSession,
            }),
            resetSearchCache: vi.fn(),
            pageToRestore: 6,
        });

        surfaceSnapshot.value = cast({
            generation: 2,
            identity: {
                documentId: 'document',
                documentRevision: 'revision-b',
            },
            phase: 'ready',
            presentation: 'committed',
            committedViewport: {pageNumber: 6},
        });
        viewportSession.value = cast({lifecycle: 'ready'});
        await waiter.promise;

        expect(scrollToPage).not.toHaveBeenCalled();
    });

    it('contains page restoration failures', async () => {
        const surface = createReloadingSurface();
        const waiter = createPdfReloadWaiter({
            pdfViewerRef: ref({scrollToPage: vi.fn(() => { throw new Error('restore failed'); })}),
            openSurface: surface.openSurface,
            resetSearchCache: vi.fn(),
            pageToRestore: 9,
        });
        surface.reload();
        await expect(waiter.promise).resolves.toBeUndefined();
    });
});
