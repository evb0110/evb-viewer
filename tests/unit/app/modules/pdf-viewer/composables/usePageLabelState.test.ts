import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
} from 'vue';
import type { Ref } from 'vue';
import { usePageLabelState } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePageLabelState';
import { resolveVisiblePageLabelsDuringMetadataRefresh } from '@app/modules/pdf-viewer/engine/page-labels/resolveVisiblePageLabelsDuringMetadataRefresh';
import type {IPdfPageLabelRange} from '@app/types/pdfContracts';
import { PAGE_LABEL_DENSE_READ_MAX_PAGES } from '@app/utils/document-viewer/pageLabels';
import { cast } from '@tests/helpers/cast';

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return {
        promise,
        resolve,
    };
}

function createPdfDocumentRef(
    numPages: number,
    getPageLabels: () => Promise<string[] | null>,
) {
    return cast<Ref<IPdfDocument | null>>(ref({
        numPages,
        getPageLabels,
    }));
}

describe('usePageLabelState', () => {
    it('keeps complete labels visible while refreshed document metadata is unresolved', () => {
        const labels = [
            'i',
            'ii',
            '1',
        ];

        expect(resolveVisiblePageLabelsDuringMetadataRefresh({
            pageLabels: labels,
            pageLabelsResolved: false,
            isSaving: false,
            totalPages: 3,
        })).toBe(labels);
    });

    it('hides incomplete labels while refreshed document metadata is unresolved', () => {
        expect(resolveVisiblePageLabelsDuringMetadataRefresh({
            pageLabels: ['i'],
            pageLabelsResolved: false,
            isSaving: false,
            totalPages: 3,
        })).toBeNull();
    });

    it('loads labels from document when available', async () => {
        const markDirty = vi.fn();
        const pdfDocument = createPdfDocumentRef(3, async () => [
            'i',
            'ii',
            'iii',
        ]);
        const state = usePageLabelState({
            pdfDocument,
            totalPages: ref(3),
            markDirty,
        });

        await state.syncPageLabelsFromDocument(pdfDocument.value);

        expect(state.pageLabels.value).toEqual([
            'i',
            'ii',
            'iii',
        ]);
        expect(state.pageLabelsDirty.value).toBe(false);
    });

    it('falls back to default labels when document labels throw', async () => {
        const markDirty = vi.fn();
        const pdfDocument = createPdfDocumentRef(2, async () => {
            throw new Error('bad labels');
        });
        const state = usePageLabelState({
            pdfDocument,
            totalPages: ref(2),
            markDirty,
        });

        await state.syncPageLabelsFromDocument(pdfDocument.value);

        expect(state.pageLabels.value).toBeNull();
        expect(state.pageLabelRanges.value).toEqual([{
            startPage: 1,
            style: 'D',
            prefix: '',
            startNumber: 1,
        }]);
        expect(state.pageLabelsDirty.value).toBe(false);
    });

    it('collapses implicit default labels to null when the document exposes numeric labels', async () => {
        const markDirty = vi.fn();
        const pdfDocument = createPdfDocumentRef(3, async () => [
            '1',
            '2',
            '3',
        ]);
        const state = usePageLabelState({
            pdfDocument,
            totalPages: ref(3),
            markDirty,
        });

        await state.syncPageLabelsFromDocument(pdfDocument.value);

        expect(state.pageLabels.value).toBeNull();
        expect(state.pageLabelRanges.value).toEqual([{
            startPage: 1,
            style: 'D',
            prefix: '',
            startNumber: 1,
        }]);
    });

    it('ignores label sync results from a document that has been replaced', async () => {
        const staleLabels = createDeferred<string[] | null>();
        const staleDocument = cast<IPdfDocument>({
            numPages: 2,
            getPageLabels: vi.fn(() => staleLabels.promise),
        });
        const freshDocument = cast<IPdfDocument>({
            numPages: 2,
            getPageLabels: vi.fn(async () => [
                'Cover',
                'Body',
            ]),
        });
        const pdfDocument = cast<Ref<IPdfDocument | null>>(ref(staleDocument));
        const state = usePageLabelState({
            pdfDocument,
            totalPages: ref(2),
            markDirty: vi.fn(),
        });

        pdfDocument.value = freshDocument;
        await nextTick();
        await state.syncPageLabelsFromDocument(freshDocument);

        expect(state.pageLabels.value).toEqual([
            'Cover',
            'Body',
        ]);

        staleLabels.resolve([
            'old-1',
            'old-2',
        ]);
        await Promise.resolve();
        await Promise.resolve();

        expect(state.pageLabels.value).toEqual([
            'Cover',
            'Body',
        ]);
    });

    it('marks page labels dirty only when label ranges actually change', () => {
        const markDirty = vi.fn();
        const onPageLabelsDirty = vi.fn();
        const state = usePageLabelState({
            pdfDocument: cast<Ref<IPdfDocument | null>>(ref(null)),
            totalPages: ref(5),
            markDirty,
            onPageLabelsDirty,
        });

        const ranges: IPdfPageLabelRange[] = [{
            startPage: 1,
            style: 'D',
            prefix: 'P-',
            startNumber: 1,
        }];

        state.handlePageLabelRangesUpdate(ranges);
        expect(state.pageLabelsDirty.value).toBe(true);
        expect(markDirty).not.toHaveBeenCalled();
        expect(onPageLabelsDirty).toHaveBeenCalledTimes(1);

        markDirty.mockClear();
        onPageLabelsDirty.mockClear();
        state.handlePageLabelRangesUpdate(ranges);
        expect(markDirty).not.toHaveBeenCalled();
        expect(onPageLabelsDirty).not.toHaveBeenCalled();
    });

    it('repairs missing visible labels when the canonical ranges are unchanged', () => {
        const onPageLabelsDirty = vi.fn();
        const state = usePageLabelState({
            pdfDocument: cast<Ref<IPdfDocument | null>>(ref(null)),
            totalPages: ref(4),
            markDirty: vi.fn(),
            onPageLabelsDirty,
        });
        const ranges: IPdfPageLabelRange[] = [
            {
                startPage: 1,
                style: null,
                prefix: 'Cover',
                startNumber: 1,
            },
            {
                startPage: 2,
                style: 'D',
                prefix: '',
                startNumber: 1,
            },
        ];

        state.handlePageLabelRangesUpdate(ranges);
        state.markPageLabelsSaved();
        state.pageLabels.value = null;
        onPageLabelsDirty.mockClear();

        state.handlePageLabelRangesUpdate(ranges);

        expect(state.pageLabels.value).toEqual([
            'Cover',
            '1',
            '2',
            '3',
        ]);
        expect(state.pageLabelsDirty.value).toBe(false);
        expect(onPageLabelsDirty).not.toHaveBeenCalled();
    });

    it('collapses default numbering edits back to null labels', () => {
        const state = usePageLabelState({
            pdfDocument: cast<Ref<IPdfDocument | null>>(ref(null)),
            totalPages: ref(4),
            markDirty: vi.fn(),
        });

        state.handlePageLabelRangesUpdate([{
            startPage: 1,
            style: 'D',
            prefix: '',
            startNumber: 1,
        }]);

        expect(state.pageLabels.value).toBeNull();
        expect(state.pageLabelsDirty.value).toBe(false);
    });

    it('preserves labels while a loaded document is transiently unavailable', async () => {
        const state = usePageLabelState({
            pdfDocument: cast<Ref<IPdfDocument | null>>(ref(null)),
            totalPages: ref(3),
            markDirty: vi.fn(),
        });

        state.handlePageLabelRangesUpdate([{
            startPage: 1,
            style: 'r',
            prefix: '',
            startNumber: 1,
        }]);
        await state.syncPageLabelsFromDocument(null);

        expect(state.pageLabels.value).toEqual([
            'i',
            'ii',
            'iii',
        ]);
        expect(state.pageLabelRanges.value).toEqual([{
            startPage: 1,
            style: 'r',
            prefix: '',
            startNumber: 1,
        }]);
        expect(state.pageLabelsDirty.value).toBe(false);
    });

    it('clears labels when no document pages remain', async () => {
        const state = usePageLabelState({
            pdfDocument: cast<Ref<IPdfDocument | null>>(ref(null)),
            totalPages: ref(0),
            markDirty: vi.fn(),
        });

        state.pageLabels.value = ['i'];
        state.pageLabelRanges.value = [{
            startPage: 1,
            style: 'r',
            prefix: '',
            startNumber: 1,
        }];

        await state.syncPageLabelsFromDocument(null);

        expect(state.pageLabels.value).toBeNull();
        expect(state.pageLabelRanges.value).toEqual([]);
        expect(state.pageLabelsDirty.value).toBe(false);
    });

    it('invokes sync and save callbacks when labels rebaseline', async () => {
        const onPageLabelsSynchronized = vi.fn();
        const onPageLabelsSaved = vi.fn();
        const state = usePageLabelState({
            pdfDocument: cast<Ref<IPdfDocument | null>>(ref(null)),
            totalPages: ref(0),
            markDirty: vi.fn(),
            onPageLabelsSynchronized,
            onPageLabelsSaved,
        });

        await state.syncPageLabelsFromDocument(null);
        state.markPageLabelsSaved();

        expect(onPageLabelsSynchronized).toHaveBeenCalled();
        expect(onPageLabelsSaved).toHaveBeenCalledOnce();
    });

    it('does not request a dense PDF.js label array for xlarge documents', async () => {
        const totalPages = PAGE_LABEL_DENSE_READ_MAX_PAGES + 1;
        const getPageLabels = vi.fn(async () => {
            throw new Error('xlarge PDF.js label reads must stay bounded');
        });
        const pdfDocument = createPdfDocumentRef(totalPages, getPageLabels);
        const state = usePageLabelState({
            pdfDocument,
            totalPages: ref(totalPages),
            markDirty: vi.fn(),
        });

        await state.syncPageLabelsFromDocument(pdfDocument.value);

        expect(getPageLabels).not.toHaveBeenCalled();
        expect(state.pageLabels.value).toBeNull();
        expect(state.pageLabelRanges.value).toEqual([{
            startPage: 1,
            style: 'D',
            prefix: '',
            startNumber: 1,
        }]);
        expect(state.labelAt(1)).toBe('1');
        expect(state.labelAt(totalPages)).toBe(String(totalPages));
        expect(state.readPageLabelWindow(totalPages - 1)).toEqual([
            String(totalPages - 1),
            String(totalPages),
        ]);
    });

    it('updates an xlarge model by ranges without creating a labels array', () => {
        const totalPages = 1_000_000;
        const state = usePageLabelState({
            pdfDocument: cast<Ref<IPdfDocument | null>>(ref(null)),
            totalPages: ref(totalPages),
            markDirty: vi.fn(),
        });

        state.handlePageLabelRangesUpdate([{
            startPage: 400_000,
            style: 'D',
            prefix: 'Section ',
            startNumber: 1,
        }]);

        expect(state.pageLabels.value).toBeNull();
        expect(state.labelAt(399_999)).toBe('399999');
        expect(state.labelAt(400_000)).toBe('Section 1');
        expect(state.labelAt(totalPages)).toBe('Section 600001');
        expect(state.readPageLabelWindow(399_999, 400_002)).toEqual([
            '399999',
            'Section 1',
            'Section 2',
            'Section 3',
        ]);
    });
});
