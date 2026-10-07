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
import { recordPdfDocumentLoadedRevision } from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentLoadedRevision';
import { resolveVisiblePageLabelsDuringMetadataRefresh } from '@app/modules/pdf-viewer/engine/page-labels/resolveVisiblePageLabelsDuringMetadataRefresh';
import type {IPdfPageLabelRange} from '@app/types/pdfContracts';
import { PAGE_LABEL_DENSE_READ_MAX_PAGES } from '@app/modules/document-viewer/pageLabels';
import { cast } from '@tests/helpers/cast';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';

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
    it.each([
        {ranges: []},
        {ranges: [{
            startPage: 1,
            style: 'r' as const,
            prefix: 'Accepted ',
            startNumber: 1,
        }]},
    ])(
        'keeps recovered label edits over an in-flight base-byte read, including empty ranges',
        async ({ranges}) => {
            const source = usePageLabelState({
                pdfDocument: ref(null),
                totalPages: ref(3),
                markDirty: vi.fn(),
            });
            // Both cases replace an existing label range, so [] means an accepted deletion.
            source.handlePageLabelRangesUpdate([{
                startPage: 1,
                style: 'D',
                prefix: 'Original ',
                startNumber: 1,
            }]);
            source.handlePageLabelRangesUpdate(ranges);
            const recovery = source.captureRecovery();
            expect(recovery).toBeDefined();
            const pending = createDeferred<string[] | null>();
            const doc = createPdfDocumentRef(3, () => pending.promise);
            const restored = usePageLabelState({
                pdfDocument: doc,
                totalPages: ref(3),
                markDirty: vi.fn(),
            });
            const reading = restored.syncPageLabelsFromDocument(doc.value);
            restored.restoreRecovery(recovery!);
            pending.resolve([
                'Original 1',
                'Original 2',
                'Original 3',
            ]);
            await reading;
            expect(restored.readPageLabelWindow(1, 3)).toEqual(ranges.length
                ? [
                    'Accepted i',
                    'Accepted ii',
                    'Accepted iii',
                ]
                : [
                    '1',
                    '2',
                    '3',
                ]);
            expect(restored.pageLabelsDirty.value).toBe(true);
            expect(restored.pageLabelsResolved.value).toBe(true);
            restored.markPageLabelsSaved();
            expect(restored.captureRecovery()).toBeUndefined();
        },
    );

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

    it('keeps labels unresolved when document labels throw', async () => {
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
        expect(state.pageLabelRanges.value).toEqual([]);
        expect(state.pageLabelsDirty.value).toBe(false);
        expect(state.pageLabelsResolved.value).toBe(false);
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

    it('keeps labels through a same-shape revision of the working copy and clears them for another document', async () => {
        const workingCopyPath = ref(requireDocumentRef('/tmp/work.pdf'));
        const firstDocument = cast<IPdfDocument>({
            numPages: 2,
            getPageLabels: vi.fn(async () => [
                'i',
                '1',
            ]),
        });
        const pdfDocument = cast<Ref<IPdfDocument | null>>(ref(firstDocument));
        const state = usePageLabelState({
            pdfDocument,
            totalPages: ref(2),
            markDirty: vi.fn(),
            workingCopyPath,
        });
        await state.syncPageLabelsFromDocument(pdfDocument.value);

        const rotatedLabels = createDeferred<string[] | null>();
        const rotatedRevision = cast<IPdfDocument>({
            numPages: 2,
            getPageLabels: vi.fn(() => rotatedLabels.promise),
        });
        pdfDocument.value = rotatedRevision;
        const rotatedSync = state.syncPageLabelsFromDocument(pdfDocument.value);

        expect(state.pageLabels.value).toEqual([
            'i',
            '1',
        ]);
        rotatedLabels.resolve([
            'i',
            '1',
        ]);
        await rotatedSync;

        const otherLabels = createDeferred<string[] | null>();
        const otherDocument = cast<IPdfDocument>({
            numPages: 2,
            getPageLabels: vi.fn(() => otherLabels.promise),
        });
        workingCopyPath.value = requireDocumentRef('/tmp/other.pdf');
        pdfDocument.value = otherDocument;
        const otherSync = state.syncPageLabelsFromDocument(pdfDocument.value);

        expect(state.pageLabels.value).toBeNull();
        otherLabels.resolve(null);
        await otherSync;
    });

    it('keeps edited labels when another view\'s PDF.js document of the same revision takes over', async () => {
        const workingCopyPath = ref(requireDocumentRef('/tmp/work.pdf'));
        const documentRevisionToken = ref(requireDocumentRevisionToken('revision-1'));
        const createView = () => cast<IPdfDocument>({
            numPages: 3,
            getPageLabels: vi.fn(async () => null),
        });
        const pdfDocument = cast<Ref<IPdfDocument | null>>(ref(createView()));
        const onPageLabelsSynchronized = vi.fn();
        const onDocumentBytesChanged = vi.fn();
        const state = usePageLabelState({
            pdfDocument,
            totalPages: ref(3),
            markDirty: vi.fn(),
            workingCopyPath,
            documentRevisionToken,
            onPageLabelsSynchronized,
            onDocumentBytesChanged,
        });
        await vi.waitFor(() => expect(onPageLabelsSynchronized).toHaveBeenCalledTimes(1));
        const edited: IPdfPageLabelRange[] = [{
            startPage: 1,
            style: 'r',
            prefix: '',
            startNumber: 1,
        }];
        state.handlePageLabelRangesUpdate(edited);

        // The user activates the other view: its document holds the same bytes.
        pdfDocument.value = createView();
        await nextTick();
        await Promise.resolve();

        expect(state.pageLabelsDirty.value).toBe(true);
        expect(state.pageLabelRanges.value).toEqual(edited);
        expect(state.pageLabels.value).toEqual([
            'i',
            'ii',
            'iii',
        ]);
        expect(onDocumentBytesChanged).toHaveBeenCalledTimes(1);

        // A new revision is new bytes, read again.
        documentRevisionToken.value = requireDocumentRevisionToken('revision-2');
        pdfDocument.value = createView();
        await vi.waitFor(() => expect(onPageLabelsSynchronized).toHaveBeenCalledTimes(2));
        expect(state.pageLabelsDirty.value).toBe(false);
        expect(onDocumentBytesChanged).toHaveBeenCalledTimes(2);
    });

    it('keeps edited labels while the view in use has not loaded its PDF.js document yet', async () => {
        const documentRevisionToken = ref(requireDocumentRevisionToken('revision-1'));
        const pdfDocument = cast<Ref<IPdfDocument | null>>(ref(cast<IPdfDocument>({
            numPages: 3,
            getPageLabels: vi.fn(async () => null),
        })));
        const onPageLabelsSynchronized = vi.fn();
        const state = usePageLabelState({
            pdfDocument,
            totalPages: ref(3),
            markDirty: vi.fn(),
            workingCopyPath: ref(requireDocumentRef('/tmp/work.pdf')),
            documentRevisionToken,
            onPageLabelsSynchronized,
        });
        await vi.waitFor(() => expect(onPageLabelsSynchronized).toHaveBeenCalledTimes(1));
        const edited: IPdfPageLabelRange[] = [{
            startPage: 1,
            style: 'R',
            prefix: '',
            startNumber: 1,
        }];
        state.handlePageLabelRangesUpdate(edited);

        // A new split view, or a remounting one, is in use before its document loads.
        pdfDocument.value = null;
        await nextTick();
        await Promise.resolve();
        pdfDocument.value = cast<IPdfDocument>({
            numPages: 3,
            getPageLabels: vi.fn(async () => null),
        });
        await nextTick();
        await Promise.resolve();

        expect(state.pageLabelsDirty.value).toBe(true);
        expect(state.pageLabelRanges.value).toEqual(edited);
        expect(onPageLabelsSynchronized).toHaveBeenCalledTimes(1);
    });

    it('keeps labels edited after a save that rewrote the working copy under both views', async () => {
        const documentRevisionToken = ref(requireDocumentRevisionToken('revision-1'));
        const createView = () => {
            const view = cast<IPdfDocument>({
                numPages: 3,
                getPageLabels: vi.fn(async () => null),
            });
            recordPdfDocumentLoadedRevision(view, 'revision-1');
            return view;
        };
        const leftView = createView();
        const rightView = createView();
        const pdfDocument = cast<Ref<IPdfDocument | null>>(ref(leftView));
        const onPageLabelsSynchronized = vi.fn();
        const state = usePageLabelState({
            pdfDocument,
            totalPages: ref(3),
            markDirty: vi.fn(),
            workingCopyPath: ref(requireDocumentRef('/tmp/work.pdf')),
            documentRevisionToken,
            onPageLabelsSynchronized,
        });
        await vi.waitFor(() => expect(onPageLabelsSynchronized).toHaveBeenCalledTimes(1));
        state.handlePageLabelRangesUpdate([{
            startPage: 1,
            style: 'R',
            prefix: '',
            startNumber: 1,
        }]);

        // Save writes the labels into revision 2 in place; neither view reloads.
        documentRevisionToken.value = requireDocumentRevisionToken('revision-2');
        state.markPageLabelsSaved();
        const editedAfterSave: IPdfPageLabelRange[] = [{
            startPage: 1,
            style: 'r',
            prefix: 'x-',
            startNumber: 1,
        }];
        state.handlePageLabelRangesUpdate(editedAfterSave);

        pdfDocument.value = rightView;
        await nextTick();
        await Promise.resolve();

        expect(state.pageLabelsDirty.value).toBe(true);
        expect(state.pageLabelRanges.value).toEqual(editedAfterSave);
        expect(onPageLabelsSynchronized).toHaveBeenCalledTimes(1);
        expect(rightView.getPageLabels).not.toHaveBeenCalled();
    });

    it('reads labels again from another view when the read of the same revision failed', async () => {
        const failingView = cast<IPdfDocument>({
            numPages: 2,
            getPageLabels: vi.fn(async () => {
                throw new Error('bad labels');
            }),
        });
        const pdfDocument = cast<Ref<IPdfDocument | null>>(ref(failingView));
        const state = usePageLabelState({
            pdfDocument,
            totalPages: ref(2),
            markDirty: vi.fn(),
            workingCopyPath: ref(requireDocumentRef('/tmp/work.pdf')),
            documentRevisionToken: ref(requireDocumentRevisionToken('revision-1')),
        });
        await vi.waitFor(() => expect(failingView.getPageLabels).toHaveBeenCalled());
        await Promise.resolve();
        expect(state.pageLabelsResolved.value).toBe(false);

        pdfDocument.value = cast<IPdfDocument>({
            numPages: 2,
            getPageLabels: vi.fn(async () => [
                'Cover',
                'Body',
            ]),
        });

        await vi.waitFor(() => expect(state.pageLabelsResolved.value).toBe(true));
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

    it('keeps dense PDF.js label reads unresolved without allocating a label array', async () => {
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
        expect(state.pageLabelRanges.value).toEqual([]);
        expect(state.pageLabelsResolved.value).toBe(false);
        expect(state.labelAt(1)).toBe('1');
        expect(state.labelAt(totalPages)).toBe(String(totalPages));
        expect(state.readPageLabelWindow(totalPages - 1)).toEqual([
            String(totalPages - 1),
            String(totalPages),
        ]);
    });

    it('uses compact catalog ranges when PDF.js cannot read dense labels', async () => {
        const totalPages = PAGE_LABEL_DENSE_READ_MAX_PAGES + 1;
        const readPageLabelRanges = vi.fn(async (): Promise<IPdfPageLabelRange[]> => [
            {
                startPage: 1,
                style: 'r',
                prefix: '',
                startNumber: 1,
            },
            {
                startPage: totalPages,
                style: 'D',
                prefix: 'Appendix ',
                startNumber: 1,
            },
        ]);
        const pdfDocument = createPdfDocumentRef(totalPages, vi.fn(async () => {
            throw new Error('dense PDF.js page-label reads must stay skipped');
        }));
        const state = usePageLabelState({
            pdfDocument,
            totalPages: ref(totalPages),
            workingCopyPath: ref(requireDocumentRef('/tmp/work.pdf')),
            markDirty: vi.fn(),
            readPageLabelRanges,
        });

        await state.syncPageLabelsFromDocument(pdfDocument.value);

        expect(readPageLabelRanges).toHaveBeenCalled();
        expect(state.pageLabelsResolved.value).toBe(true);
        expect(state.pageLabelRanges.value).toEqual([
            {
                startPage: 1,
                style: 'r',
                prefix: '',
                startNumber: 1,
            },
            {
                startPage: totalPages,
                style: 'D',
                prefix: 'Appendix ',
                startNumber: 1,
            },
        ]);
        expect(state.labelAt(1)).toBe('i');
        expect(state.labelAt(totalPages)).toBe('Appendix 1');
    });

    it('keeps the last successful labels unresolved after a transient read failure', async () => {
        let shouldFail = false;
        const pdfDocument = createPdfDocumentRef(2, async () => {
            if (shouldFail) {
                throw new Error('temporary label read failure');
            }
            return [
                'Cover',
                'Body',
            ];
        });
        const state = usePageLabelState({
            pdfDocument,
            totalPages: ref(2),
            markDirty: vi.fn(),
        });

        await state.syncPageLabelsFromDocument(pdfDocument.value);
        shouldFail = true;
        await state.syncPageLabelsFromDocument(pdfDocument.value);

        expect(state.pageLabels.value).toEqual([
            'Cover',
            'Body',
        ]);
        expect(state.pageLabelsResolved.value).toBe(false);
    });

    it('keeps invalid label results unresolved', async () => {
        const pdfDocument = createPdfDocumentRef(2, async () => ['only one label']);
        const state = usePageLabelState({
            pdfDocument,
            totalPages: ref(2),
            markDirty: vi.fn(),
        });

        await state.syncPageLabelsFromDocument(pdfDocument.value);

        expect(state.pageLabels.value).toBeNull();
        expect(state.pageLabelRanges.value).toEqual([]);
        expect(state.pageLabelsResolved.value).toBe(false);
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
