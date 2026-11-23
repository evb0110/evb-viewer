import type {
    IDocumentNavigationTicket,
    IDocumentOpenSurfaceSnapshot,
} from '@app/modules/document-viewer/public';
import { createPageNavigationRequest } from '@app/modules/document-viewer/navigation/documentNavigationRequest';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { shallowRef } from 'vue';
import { createPdfReloadWaiter } from '@app/modules/pdf-viewer/engine/pdf-reload-waiter/createPdfReloadWaiter';
import type { TPdfReloadOutcome } from '@app/modules/pdf-viewer/engine/pdf-reload-waiter/pdfReloadWaiterViewer';
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
    const settledSurface = {
        phase: 'ready',
        presentation: 'committed',
    } as const;

    function createSurface() {
        const snapshot = shallowRef(cast<IDocumentOpenSurfaceSnapshot>({
            generation: 1,
            identity: {
                documentId: 'document',
                documentRevision: 'revision-a',
            },
            ...settledSurface,
        }));
        const viewportSession = shallowRef(cast<{lifecycle: string}>({lifecycle: 'ready'}));
        const navigationTicket = shallowRef<IDocumentNavigationTicket | null>(null);
        return {
            openSurface: cast<Parameters<typeof createPdfReloadWaiter>[0]['openSurface']>({
                snapshot,
                viewportSession,
                navigationTicket,
            }),
            navigationTicket,
            show: (state: Partial<IDocumentOpenSurfaceSnapshot> = settledSurface) => {
                snapshot.value = cast({
                    ...snapshot.value,
                    generation: 2,
                    identity: {
                        documentId: 'document',
                        documentRevision: 'revision-b',
                    },
                    ...state,
                });
            },
            replace: (state: Partial<IDocumentOpenSurfaceSnapshot>) => {
                snapshot.value = cast({
                    ...snapshot.value,
                    ...state,
                });
            },
            viewportSession,
        };
    }

    function createAdmission() {
        const settled = Promise.withResolvers<TPdfReloadOutcome>();
        const withdraw = vi.fn(() => settled.resolve('withdrawn'));
        return {
            admission: {
                finished: settled.promise,
                withdraw,
            },
            settle: settled.resolve,
            withdraw,
        };
    }

    it('resolves with the viewer\'s receipt once the view settles on the reloaded document', async () => {
        const surface = createSurface();
        const receipt = createAdmission();
        const resetSearchCache = vi.fn();
        let resolved = false;
        const waiter = createPdfReloadWaiter({
            openSurface: surface.openSurface,
            resetSearchCache,
            admission: receipt.admission,
        });
        void waiter.promise.then(() => {
            resolved = true;
        });

        surface.show();
        await vi.waitFor(() => expect(surface.openSurface.snapshot.value.generation).toBe(2));
        await Promise.resolve();
        // Showing the bytes is not the reading point: the receipt is.
        expect(resolved).toBe(false);
        expect(resetSearchCache).not.toHaveBeenCalled();

        receipt.settle('placed');
        await waiter.promise;
        expect(resetSearchCache).toHaveBeenCalledTimes(1);
        expect(receipt.withdraw).not.toHaveBeenCalled();
    });

    it('ends at once when the operation withdraws its admission before reloading', async () => {
        vi.useFakeTimers();
        const surface = createSurface();
        const receipt = createAdmission();
        const resetSearchCache = vi.fn();
        const waiter = createPdfReloadWaiter({
            openSurface: surface.openSurface,
            resetSearchCache,
            admission: receipt.admission,
        });

        waiter.cancel();
        await vi.advanceTimersByTimeAsync(0);
        await waiter.promise;

        expect(receipt.withdraw).toHaveBeenCalled();
        expect(resetSearchCache).not.toHaveBeenCalled();
    });

    it('withdraws an admission whose reload never comes', async () => {
        vi.useFakeTimers();
        const surface = createSurface();
        const receipt = createAdmission();
        const waiter = createPdfReloadWaiter({
            openSurface: surface.openSurface,
            resetSearchCache: vi.fn(),
            admission: receipt.admission,
        });

        await vi.advanceTimersByTimeAsync(8000);
        await waiter.promise;

        expect(receipt.withdraw).toHaveBeenCalledTimes(1);
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
    ])('does not finish a reload whose surface was replaced meanwhile (%s)', async (replacement) => {
        const surface = createSurface();
        const receipt = createAdmission();
        const resetSearchCache = vi.fn();
        const place = vi.fn();
        const waiter = createPdfReloadWaiter({
            openSurface: surface.openSurface,
            resetSearchCache,
            admission: receipt.admission,
            place,
        });

        surface.show({
            phase: 'canvas-committed',
            presentation: 'page-shell',
        });
        await vi.waitFor(() => expect(surface.openSurface.snapshot.value.generation).toBe(2));
        surface.replace({
            ...replacement,
            ...settledSurface,
        });
        receipt.settle('superseded');
        await waiter.promise;

        expect(resetSearchCache).not.toHaveBeenCalled();
        expect(place).not.toHaveBeenCalled();
    });

    it('places a view without an admission once it settles, unless cancelled first', async () => {
        const surface = createSurface();
        const place = vi.fn();
        const waiter = createPdfReloadWaiter({
            openSurface: surface.openSurface,
            resetSearchCache: vi.fn(),
            admission: null,
            place,
        });
        surface.show({
            phase: 'canvas-committed',
            presentation: 'page-shell',
        });
        surface.viewportSession.value = cast({lifecycle: 'opening'});
        await Promise.resolve();
        expect(place).not.toHaveBeenCalled();
        surface.replace(settledSurface);
        surface.viewportSession.value = cast({lifecycle: 'ready'});
        await waiter.promise;
        expect(place).toHaveBeenCalledTimes(1);

        const cancelledSurface = createSurface();
        const cancelledPlace = vi.fn();
        const cancelled = createPdfReloadWaiter({
            openSurface: cancelledSurface.openSurface,
            resetSearchCache: vi.fn(),
            admission: null,
            place: cancelledPlace,
        });
        cancelled.cancel();
        cancelledSurface.show();
        await cancelled.promise;
        expect(cancelledPlace).not.toHaveBeenCalled();
    });

    it('ends at once when the view goes away before its reload arrives', async () => {
        vi.useFakeTimers();
        const surface = createSurface();
        const receipt = createAdmission();
        const waiter = createPdfReloadWaiter({
            openSurface: surface.openSurface,
            resetSearchCache: vi.fn(),
            admission: receipt.admission,
        });
        let resolved = false;
        void waiter.promise.then(() => {
            resolved = true;
        });
        receipt.settle('superseded');
        // No timer advances: the settled admission alone ends the wait.
        await vi.advanceTimersByTimeAsync(0);
        expect(resolved).toBe(true);
    });

    it('ends at once when the reloaded document fails to open', async () => {
        vi.useFakeTimers();
        const surface = createSurface();
        const receipt = createAdmission();
        const resetSearchCache = vi.fn();
        const waiter = createPdfReloadWaiter({
            openSurface: surface.openSurface,
            resetSearchCache,
            admission: receipt.admission,
        });
        surface.show({
            phase: 'pending',
            presentation: 'page-shell',
        });
        await vi.advanceTimersByTimeAsync(0);
        let resolved = false;
        void waiter.promise.then(() => {
            resolved = true;
        });
        surface.replace({phase: 'failed'});
        await vi.advanceTimersByTimeAsync(0);
        expect(resolved).toBe(true);
        expect(resetSearchCache).not.toHaveBeenCalled();
        expect(receipt.withdraw).toHaveBeenCalled();
    });

    it('leaves a moved view where its reader navigated while it opened (R2)', async () => {
        const surface = createSurface();
        const place = vi.fn();
        const waiter = createPdfReloadWaiter({
            openSurface: surface.openSurface,
            resetSearchCache: vi.fn(),
            admission: null,
            place,
        });
        surface.show({
            phase: 'canvas-committed',
            presentation: 'page-shell',
        });
        // The open's own restore ticket is not the reader's command.
        surface.navigationTicket.value = cast({
            generation: 2,
            request: createPageNavigationRequest(1, 'restore'),
        });
        surface.navigationTicket.value = cast({
            generation: 2,
            request: createPageNavigationRequest(5, 'toolbar'),
        });
        surface.navigationTicket.value = null;
        surface.replace(settledSurface);
        await waiter.promise;
        expect(place).not.toHaveBeenCalled();
    });

    it('stops waiting for a placement once the view leaves the document it opened', async () => {
        vi.useFakeTimers();
        const surface = createSurface();
        const placement = Promise.withResolvers<undefined>();
        const waiter = createPdfReloadWaiter({
            openSurface: surface.openSurface,
            resetSearchCache: vi.fn(),
            admission: null,
            place: () => placement.promise,
        });
        let resolved = false;
        void waiter.promise.then(() => {
            resolved = true;
        });
        surface.show();
        await vi.advanceTimersByTimeAsync(0);
        expect(resolved).toBe(false);
        // The cold tab unmounts: its surface empties and the navigation never settles.
        surface.replace({phase: 'idle'});
        await vi.advanceTimersByTimeAsync(0);
        expect(resolved).toBe(true);
    });

    it('keeps a moved-tab waiter pending on a surface error until a newer document supersedes it', async () => {
        vi.useFakeTimers();
        const surface = createSurface();
        const place = vi.fn();
        const waiter = createPdfReloadWaiter({
            openSurface: surface.openSurface,
            resetSearchCache: vi.fn(),
            admission: null,
            place,
        });
        surface.show({
            phase: 'pending',
            presentation: 'page-shell',
        });
        await vi.advanceTimersByTimeAsync(0);
        let resolved = false;
        void waiter.promise.then(() => {
            resolved = true;
        });
        surface.replace({phase: 'failed'});
        await vi.advanceTimersByTimeAsync(0);
        expect(resolved).toBe(false);
        expect(place).not.toHaveBeenCalled();

        surface.replace({
            generation: 3,
            phase: 'pending',
            identity: {
                documentId: 'replacement-doc',
                documentRevision: 'rev-1',
                provisional: false,
            },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(resolved).toBe(true);
        expect(place).not.toHaveBeenCalled();
    });
});
