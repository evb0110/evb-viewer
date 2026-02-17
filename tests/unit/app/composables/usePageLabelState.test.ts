import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    type Ref,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { usePageLabelState } from '@app/composables/pdf/usePageLabelState';
import type { IPdfPageLabelRange } from '@app/types/pdf';

function cast<T>(obj: unknown): T {
    return obj as T;
}

function createPdfDocumentRef(
    numPages: number,
    getPageLabels: () => Promise<string[] | null>,
) {
    return cast<Ref<PDFDocumentProxy | null>>(ref({
        numPages,
        getPageLabels,
    }));
}

async function flushAsyncWork() {
    await Promise.resolve();
    await Promise.resolve();
}

describe('usePageLabelState', () => {
    it('loads labels from document when available', async () => {
        const markDirty = vi.fn();
        const state = usePageLabelState({
            pdfDocument: createPdfDocumentRef(3, async () => [
                'i',
                'ii',
                'iii',
            ]),
            totalPages: ref(3),
            markDirty,
        });

        await flushAsyncWork();

        expect(state.pageLabels.value).toEqual([
            'i',
            'ii',
            'iii',
        ]);
        expect(state.pageLabelsDirty.value).toBe(false);
    });

    it('falls back to default labels when document labels throw', async () => {
        const markDirty = vi.fn();
        const state = usePageLabelState({
            pdfDocument: createPdfDocumentRef(2, async () => {
                throw new Error('bad labels');
            }),
            totalPages: ref(2),
            markDirty,
        });

        await flushAsyncWork();

        expect(state.pageLabels.value).toBeNull();
        expect(state.pageLabelRanges.value).toEqual([{
            startPage: 1,
            style: 'D',
            prefix: '',
            startNumber: 1,
        }]);
        expect(state.pageLabelsDirty.value).toBe(false);
    });

    it('marks dirty only when label ranges actually change', () => {
        const markDirty = vi.fn();
        const state = usePageLabelState({
            pdfDocument: cast<Ref<PDFDocumentProxy | null>>(ref(null)),
            totalPages: ref(5),
            markDirty,
        });

        const ranges: IPdfPageLabelRange[] = [{
            startPage: 1,
            style: 'D',
            prefix: 'P-',
            startNumber: 1,
        }];

        state.handlePageLabelRangesUpdate(ranges);
        expect(state.pageLabelsDirty.value).toBe(true);
        expect(markDirty).toHaveBeenCalledTimes(1);

        markDirty.mockClear();
        state.handlePageLabelRangesUpdate(ranges);
        expect(markDirty).not.toHaveBeenCalled();
    });
});
