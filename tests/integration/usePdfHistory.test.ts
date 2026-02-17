import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
    type Ref,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { usePdfHistory } from '@app/composables/usePdfHistory';

function cast<T>(obj: unknown): T {
    return obj as T;
}

function createMockDeps(overrides: Partial<Parameters<typeof usePdfHistory>[0]> = {}) {
    return cast<Parameters<typeof usePdfHistory>[0]>({
        pdfDocument: ref<PDFDocumentProxy | null>(null),
        pdfViewerRef: ref<{
            scrollToPage: (page: number) => void;
            undoAnnotation: () => void;
            redoAnnotation: () => void;
        } | null>(null),
        currentPage: ref(1),
        isAnySaving: ref(false),
        isHistoryBusy: ref(false),
        canUndo: ref(true),
        canRedo: ref(true),
        isAnnotationUndoContext: ref(false),
        workingCopyPath: ref<string | null>('/tmp/test.pdf'),
        resetSearchCache: vi.fn(),
        clearOcrCache: vi.fn(),
        undo: vi.fn(async () => true),
        redo: vi.fn(async () => true),
        ...overrides,
    });
}

describe('usePdfHistory', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    it('sets isHistoryBusy during undo and clears it after', async () => {
        const deps = createMockDeps();
        const { handleUndo } = usePdfHistory(deps);

        const undoPromise = handleUndo();

        expect(deps.isHistoryBusy.value).toBe(true);

        await vi.advanceTimersByTimeAsync(9000);
        await undoPromise;

        expect(deps.isHistoryBusy.value).toBe(false);
    });

    it('sets isHistoryBusy during redo and clears it after', async () => {
        const deps = createMockDeps();
        const { handleRedo } = usePdfHistory(deps);

        const redoPromise = handleRedo();

        expect(deps.isHistoryBusy.value).toBe(true);

        await vi.advanceTimersByTimeAsync(9000);
        await redoPromise;

        expect(deps.isHistoryBusy.value).toBe(false);
    });

    it('clears isHistoryBusy even when undo throws', async () => {
        const deps = createMockDeps({undo: vi.fn(async () => { throw new Error('undo failed'); })});
        const { handleUndo } = usePdfHistory(deps);

        await expect(handleUndo()).rejects.toThrow('undo failed');
        expect(deps.isHistoryBusy.value).toBe(false);
    });

    it('does nothing when isAnySaving is true', async () => {
        const deps = createMockDeps({ isAnySaving: ref(true) });
        const { handleUndo } = usePdfHistory(deps);

        await handleUndo();

        expect(deps.undo).not.toHaveBeenCalled();
        expect(deps.isHistoryBusy.value).toBe(false);
    });

    it('does nothing when canUndo is false', async () => {
        const deps = createMockDeps({ canUndo: ref(false) });
        const { handleUndo } = usePdfHistory(deps);

        await handleUndo();

        expect(deps.undo).not.toHaveBeenCalled();
    });

    it('does nothing when canRedo is false', async () => {
        const deps = createMockDeps({ canRedo: ref(false) });
        const { handleRedo } = usePdfHistory(deps);

        await handleRedo();

        expect(deps.redo).not.toHaveBeenCalled();
    });

    it('skips when already busy', async () => {
        const deps = createMockDeps({ isHistoryBusy: ref(true) });
        const { handleUndo } = usePdfHistory(deps);

        await handleUndo();

        expect(deps.undo).not.toHaveBeenCalled();
    });

    it('delegates to undoAnnotation when in annotation context', async () => {
        const undoAnnotation = vi.fn();
        const deps = createMockDeps({
            isAnnotationUndoContext: ref(true),
            pdfViewerRef: ref({
                scrollToPage: vi.fn(),
                undoAnnotation,
                redoAnnotation: vi.fn(),
            }),
        });
        const { handleUndo } = usePdfHistory(deps);

        await handleUndo();

        expect(undoAnnotation).toHaveBeenCalledOnce();
        expect(deps.undo).not.toHaveBeenCalled();
    });

    it('delegates to redoAnnotation when in annotation context', async () => {
        const redoAnnotation = vi.fn();
        const deps = createMockDeps({
            isAnnotationUndoContext: ref(true),
            pdfViewerRef: ref({
                scrollToPage: vi.fn(),
                undoAnnotation: vi.fn(),
                redoAnnotation,
            }),
        });
        const { handleRedo } = usePdfHistory(deps);

        await handleRedo();

        expect(redoAnnotation).toHaveBeenCalledOnce();
        expect(deps.redo).not.toHaveBeenCalled();
    });

    it('clears OCR cache before undo', async () => {
        const deps = createMockDeps();
        const { handleUndo } = usePdfHistory(deps);

        const undoPromise = handleUndo();
        await vi.advanceTimersByTimeAsync(9000);
        await undoPromise;

        expect(deps.clearOcrCache).toHaveBeenCalledWith('/tmp/test.pdf');
    });

    it('resolves waitForPdfReload on timeout when document does not change', async () => {
        const deps = createMockDeps();
        const { waitForPdfReload } = usePdfHistory(deps);

        const promise = waitForPdfReload(3);
        await vi.advanceTimersByTimeAsync(8000);
        await promise;
    });

    it('resolves waitForPdfReload early when pdfDocument changes', async () => {
        const deps = createMockDeps();
        const scrollToPage = vi.fn();
        deps.pdfViewerRef.value = {
            scrollToPage,
            undoAnnotation: vi.fn(),
            redoAnnotation: vi.fn(),
        };
        const { waitForPdfReload } = usePdfHistory(deps);

        const promise = waitForPdfReload(5);

        deps.pdfDocument.value = { numPages: 10 } as PDFDocumentProxy;
        await nextTick();
        await promise;

        expect(deps.resetSearchCache).toHaveBeenCalledOnce();
    });

    it('does not call scrollToPage if doc reference stays the same', async () => {
        const doc = cast<PDFDocumentProxy>({ numPages: 3 });
        const deps = createMockDeps({ pdfDocument: cast<Ref<PDFDocumentProxy | null>>(ref(doc)) });
        const scrollToPage = vi.fn();
        deps.pdfViewerRef.value = {
            scrollToPage,
            undoAnnotation: vi.fn(),
            redoAnnotation: vi.fn(),
        };
        const { waitForPdfReload } = usePdfHistory(deps);

        const promise = waitForPdfReload(2);

        deps.pdfDocument.value = doc;
        await nextTick();
        await vi.advanceTimersByTimeAsync(8000);
        await promise;

        expect(scrollToPage).not.toHaveBeenCalled();
    });

    it('does not clear OCR cache when workingCopyPath is null', async () => {
        const deps = createMockDeps({ workingCopyPath: ref<string | null>(null) });
        const { handleUndo } = usePdfHistory(deps);

        const undoPromise = handleUndo();
        await vi.advanceTimersByTimeAsync(9000);
        await undoPromise;

        expect(deps.clearOcrCache).not.toHaveBeenCalled();
    });

    it('does not wait for reload when undo is a no-op', async () => {
        const deps = createMockDeps({ undo: vi.fn(async () => false) });
        const { handleUndo } = usePdfHistory(deps);

        await handleUndo();

        expect(deps.isHistoryBusy.value).toBe(false);
    });

    it('does not wait for reload when redo is a no-op', async () => {
        const deps = createMockDeps({ redo: vi.fn(async () => false) });
        const { handleRedo } = usePdfHistory(deps);

        await handleRedo();

        expect(deps.isHistoryBusy.value).toBe(false);
    });
});
