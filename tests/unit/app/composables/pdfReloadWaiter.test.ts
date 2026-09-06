import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
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
    it('restores the semantic page after the document reloads', async () => {
        const pdfDocument = shallowRef<IPdfDocument | null>(cast({ id: 'before' }));
        const scrollToPage = vi.fn();
        const waiter = createPdfReloadWaiter({
            pdfDocument,
            pdfViewerRef: ref({scrollToPage}),
            resetSearchCache: vi.fn(),
            pageToRestore: 5,
        });

        pdfDocument.value = cast({ id: 'after' });
        await waiter.promise;
        expect(scrollToPage).toHaveBeenCalledWith(5);
    });

    it('can wait for reload completion without restoring the viewport', async () => {
        const pdfDocument = shallowRef<IPdfDocument | null>(cast({ id: 'before' }));
        const scrollToPage = vi.fn();
        const resetSearchCache = vi.fn();
        const waiter = createPdfReloadWaiter({
            pdfDocument,
            pdfViewerRef: ref({scrollToPage}),
            resetSearchCache,
            pageToRestore: 8,
            restoreScroll: false,
        });

        pdfDocument.value = cast({ id: 'after' });
        await waiter.promise;
        expect(resetSearchCache).toHaveBeenCalledOnce();
        expect(scrollToPage).not.toHaveBeenCalled();
    });

    it('waits for viewer settle before restoring the page', async () => {
        const pdfDocument = shallowRef<IPdfDocument | null>(cast({ id: 'before' }));
        const scrollToPage = vi.fn();
        let settle = () => {};
        const settled = new Promise<void>((resolve) => {
            settle = resolve;
        });
        const waiter = createPdfReloadWaiter({
            pdfDocument,
            pdfViewerRef: ref({
                scrollToPage,
                waitForViewerLoadSettled: () => settled,
            }),
            resetSearchCache: vi.fn(),
            pageToRestore: 4,
        });

        pdfDocument.value = cast({ id: 'after' });
        await Promise.resolve();
        expect(scrollToPage).not.toHaveBeenCalled();
        settle();
        await waiter.promise;
        expect(scrollToPage).toHaveBeenCalledWith(4);
    });

    it('skips stale restoration after user viewport interaction', async () => {
        const pdfDocument = shallowRef<IPdfDocument | null>(cast({ id: 'before' }));
        const scrollToPage = vi.fn();
        let epoch = 1;
        let settle = () => {};
        const settled = new Promise<void>((resolve) => {
            settle = resolve;
        });
        const waiter = createPdfReloadWaiter({
            pdfDocument,
            pdfViewerRef: ref({
                scrollToPage,
                waitForViewerLoadSettled: () => settled,
                getUserViewportInteractionEpoch: () => epoch,
            }),
            resetSearchCache: vi.fn(),
            pageToRestore: 4,
        });

        pdfDocument.value = cast({ id: 'after' });
        await Promise.resolve();
        epoch = 2;
        settle();
        await waiter.promise;
        expect(scrollToPage).not.toHaveBeenCalled();
    });

    it('contains page restoration failures', async () => {
        const pdfDocument = shallowRef<IPdfDocument | null>(cast({ id: 'before' }));
        const waiter = createPdfReloadWaiter({
            pdfDocument,
            pdfViewerRef: ref({scrollToPage: vi.fn(() => { throw new Error('restore failed'); })}),
            resetSearchCache: vi.fn(),
            pageToRestore: 9,
        });
        pdfDocument.value = cast({ id: 'after' });
        await expect(waiter.promise).resolves.toBeUndefined();
    });
});
