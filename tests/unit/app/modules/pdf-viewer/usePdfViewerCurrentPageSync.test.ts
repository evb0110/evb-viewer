import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    ref,
    shallowRef,
} from 'vue';
import { cast } from '@tests/helpers/cast';

vi.mock('@app/utils/asyncHelpers', () => ({waitForVisualFrames: vi.fn(async () => {})}));

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {diagnostic: vi.fn()}}));

const { usePdfViewerCurrentPageSync } = await import(
    '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync'
);

describe('usePdfViewerCurrentPageSync', () => {
    it('emits direct current-page sync when the updater mutates before returning', async () => {
        const currentPage = ref(1);
        const emitCurrentPage = vi.fn();
        const updateCurrentPage = vi.fn(() => {
            currentPage.value = 2;
            return 2;
        });
        const scope = effectScope();

        try {
            const sync = scope.run(() => usePdfViewerCurrentPageSync({
                viewerContainer: ref(cast<HTMLElement>({ querySelectorAll: () => [] })),
                numPages: ref(10),
                visibleRange: ref({
                    start: 2,
                    end: 2,
                }),
                currentPage,
                pdfDocument: shallowRef<IPdfDocument | null>(cast({})),
                isLoading: ref(false),
                getMostVisiblePage: vi.fn(() => 2),
                updateCurrentPage,
                emitCurrentPage,
            }));
            if (!sync) {
                throw new Error('Failed to create current-page sync');
            }

            await sync.syncCurrentPageFromViewport({ source: 'load-from-source' });

            expect(updateCurrentPage).toHaveBeenCalledOnce();
            expect(currentPage.value).toBe(2);
            expect(emitCurrentPage).toHaveBeenCalledExactlyOnceWith(2);
        } finally {
            scope.stop();
        }
    });

    it('invalidates stabilized current-page sync when the document changes mid-sample', async () => {
        const pdfDocument = shallowRef<IPdfDocument | null>(cast({}));
        const emitCurrentPage = vi.fn();
        const getMostVisiblePage = vi.fn(() => 2);
        const scope = effectScope();

        try {
            const sync = scope.run(() => usePdfViewerCurrentPageSync({
                viewerContainer: ref(cast<HTMLElement>({
                    clientHeight: 800,
                    clientWidth: 600,
                    scrollLeft: 0,
                    scrollTop: 0,
                    querySelectorAll: () => [],
                })),
                numPages: ref(10),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                currentPage: ref(1),
                pdfDocument,
                isLoading: ref(false),
                getMostVisiblePage,
                updateCurrentPage: vi.fn(() => 2),
                emitCurrentPage,
            }));
            if (!sync) {
                throw new Error('Failed to create current-page sync');
            }

            const syncPromise = sync.syncCurrentPageFromViewport({
                source: 'test',
                stabilize: true,
            });
            expect(getMostVisiblePage).toHaveBeenCalledOnce();

            pdfDocument.value = null;
            await syncPromise;

            expect(emitCurrentPage).not.toHaveBeenCalled();
        } finally {
            scope.stop();
        }
    });

    it('does not sample direct viewport sync while navigation authority rejects viewport input', async () => {
        const currentPage = ref(5);
        const updateCurrentPage = vi.fn(() => {
            currentPage.value = 1;
            return 1;
        });
        const emitCurrentPage = vi.fn();
        const commitCurrentPageFromViewport = vi.fn();
        const scope = effectScope();

        try {
            const sync = scope.run(() => usePdfViewerCurrentPageSync({
                viewerContainer: ref(cast<HTMLElement>({ querySelectorAll: () => [] })),
                numPages: ref(10),
                visibleRange: ref({
                    start: 5,
                    end: 5,
                }),
                currentPage,
                pdfDocument: shallowRef<IPdfDocument | null>(cast({})),
                isLoading: ref(false),
                getMostVisiblePage: vi.fn(() => 1),
                updateCurrentPage,
                emitCurrentPage,
                canSyncCurrentPageFromViewport: vi.fn(() => false),
                commitCurrentPageFromViewport,
            }));
            if (!sync) {
                throw new Error('Failed to create current-page sync');
            }

            await sync.syncCurrentPageFromViewport({ source: 'scroll' });

            expect(updateCurrentPage).not.toHaveBeenCalled();
            expect(commitCurrentPageFromViewport).not.toHaveBeenCalled();
            expect(currentPage.value).toBe(5);
            expect(emitCurrentPage).not.toHaveBeenCalled();
        } finally {
            scope.stop();
        }
    });

    it('drops stabilized viewport sync when navigation becomes active before commit', async () => {
        const currentPage = ref(5);
        const emitCurrentPage = vi.fn();
        const getMostVisiblePage = vi.fn(() => 1);
        const commitCurrentPageFromViewport = vi.fn();
        let canSync = true;
        const scope = effectScope();

        try {
            const sync = scope.run(() => usePdfViewerCurrentPageSync({
                viewerContainer: ref(cast<HTMLElement>({
                    clientHeight: 800,
                    clientWidth: 600,
                    scrollLeft: 0,
                    scrollTop: 0,
                    querySelectorAll: () => [],
                })),
                numPages: ref(10),
                visibleRange: ref({
                    start: 5,
                    end: 5,
                }),
                currentPage,
                pdfDocument: shallowRef<IPdfDocument | null>(cast({})),
                isLoading: ref(false),
                getMostVisiblePage,
                updateCurrentPage: vi.fn(() => 1),
                emitCurrentPage,
                canSyncCurrentPageFromViewport: vi.fn(() => canSync),
                commitCurrentPageFromViewport,
            }));
            if (!sync) {
                throw new Error('Failed to create current-page sync');
            }

            const syncPromise = sync.syncCurrentPageFromViewport({
                source: 'rerender',
                stabilize: true,
            });
            expect(getMostVisiblePage).toHaveBeenCalledOnce();

            canSync = false;
            await syncPromise;

            expect(commitCurrentPageFromViewport).not.toHaveBeenCalled();
            expect(currentPage.value).toBe(5);
            expect(emitCurrentPage).not.toHaveBeenCalled();
        } finally {
            scope.stop();
        }
    });
});
