import {
    ref,
    watch,
    type Ref,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { IPdfPageLabelRange } from '@app/types/pdf';
import {
    buildPageLabelsFromRanges,
    derivePageLabelRangesFromLabels,
    normalizePageLabelRanges,
} from '@app/utils/pdf-page-labels';

export const usePageLabelState = (deps: {
    pdfDocument: Ref<PDFDocumentProxy | null>;
    totalPages: Ref<number>;
    markDirty: () => void;
}) => {
    const {
        pdfDocument,
        totalPages,
        markDirty,
    } = deps;

    const pageLabels = ref<string[] | null>(null);
    const pageLabelRanges = ref<IPdfPageLabelRange[]>([]);
    const pageLabelsDirty = ref(false);

    async function syncPageLabelsFromDocument(doc: PDFDocumentProxy | null) {
        if (!doc) {
            pageLabels.value = null;
            pageLabelRanges.value = [];
            pageLabelsDirty.value = false;
            return;
        }

        let labels: string[] | null = null;
        try {
            const raw = await doc.getPageLabels();
            labels = raw && raw.length === doc.numPages ? raw : null;
        } catch {
            labels = null;
        }

        pageLabels.value = labels;
        pageLabelRanges.value = derivePageLabelRangesFromLabels(labels, doc.numPages);
        pageLabelsDirty.value = false;
    }

    function markPageLabelsSaved() {
        pageLabelsDirty.value = false;
    }

    function handlePageLabelRangesUpdate(ranges: IPdfPageLabelRange[]) {
        if (totalPages.value <= 0) {
            return;
        }

        const normalized = normalizePageLabelRanges(ranges, totalPages.value);
        const currentNormalized = normalizePageLabelRanges(pageLabelRanges.value, totalPages.value);
        const unchanged = JSON.stringify(normalized) === JSON.stringify(currentNormalized);
        if (unchanged) {
            return;
        }
        pageLabelRanges.value = normalized;
        pageLabels.value = buildPageLabelsFromRanges(totalPages.value, normalized);
        pageLabelsDirty.value = true;
        markDirty();
    }

    watch(
        pdfDocument,
        (doc) => {
            void syncPageLabelsFromDocument(doc);
        },
        { immediate: true },
    );

    return {
        pageLabels,
        pageLabelRanges,
        pageLabelsDirty,
        syncPageLabelsFromDocument,
        markPageLabelsSaved,
        handlePageLabelRangesUpdate,
    };
};
