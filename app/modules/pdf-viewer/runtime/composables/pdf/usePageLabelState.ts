import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { Ref } from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import { isEqual } from 'es-toolkit/predicate';
import type {IPdfPageLabelRange} from '@app/types/pdfContracts';
import {
    createPageLabelModel,
    derivePageLabelRangesFromLabels,
    getPageLabelWindow,
    materializePageLabelsForCompatibility,
    normalizePageLabelRanges,
    PAGE_LABEL_DENSE_READ_MAX_PAGES,
    PAGE_LABEL_SMALL_COMPATIBILITY_MAX_PAGES,
    type IDocumentPageLabelModel,
} from '@app/utils/document-viewer/pageLabels';
import { BrowserLogger } from '@app/utils/browserLogger';
import { runGuardedTask } from '@app/utils/asyncGuard';

export const usePageLabelState = (deps: {
    pdfDocument: Ref<IPdfDocument | null>;
    totalPages: Ref<number>;
    markDirty: () => void;
    onPageLabelsSynchronized?: () => void;
    onPageLabelsDirty?: () => void;
    onPageLabelsSaved?: () => void;
}) => {
    const {
        pdfDocument,
        totalPages,
        onPageLabelsSynchronized,
        onPageLabelsDirty,
        onPageLabelsSaved,
    } = deps;

    const pageLabels = ref<string[] | null>(null);
    // Replaced wholesale, never mutated in place, and posted to the
    // serialization worker: deep reactivity would hand out a Proxy that
    // structured clone refuses.
    const pageLabelRanges = shallowRef<IPdfPageLabelRange[]>([]);
    const pageLabelModel = shallowRef<IDocumentPageLabelModel>(createPageLabelModel(
        Math.max(0, totalPages.value),
        [],
    ));
    const pageLabelsDirty = ref(false);
    const pageLabelsResolved = ref(true);
    let pageLabelSyncGeneration = 0;
    let pageLabelRevision = 0;
    let disposed = false;

    function updatePageLabelModel(
        totalPagesValue: number,
        ranges: readonly IPdfPageLabelRange[],
        labels: readonly string[] | null = null,
    ) {
        const normalizedRanges = normalizePageLabelRanges(ranges, totalPagesValue);
        pageLabelRanges.value = normalizedRanges;
        pageLabelModel.value = createPageLabelModel(totalPagesValue, normalizedRanges);
        pageLabels.value = totalPagesValue <= PAGE_LABEL_SMALL_COMPATIBILITY_MAX_PAGES
            ? materializePageLabelsForCompatibility(
                totalPagesValue,
                normalizedRanges,
                labels,
            )
            : null;
    }

    async function syncPageLabelsFromDocument(doc: IPdfDocument | null) {
        const syncGeneration = ++pageLabelSyncGeneration;
        const isCurrentSync = () => (
            !disposed
            && pageLabelSyncGeneration === syncGeneration
            && pdfDocument.value === doc
        );

        if (!isCurrentSync()) {
            return;
        }

        if (!doc) {
            if (totalPages.value <= 0) {
                pageLabels.value = null;
                pageLabelRanges.value = [];
                pageLabelModel.value = createPageLabelModel(0, []);
            } else {
                pageLabelModel.value = createPageLabelModel(
                    totalPages.value,
                    pageLabelRanges.value,
                );
            }
            pageLabelsDirty.value = false;
            pageLabelsResolved.value = true;
            onPageLabelsSynchronized?.();
            return;
        }

        pageLabelsResolved.value = false;

        try {
            let labels: string[] | null = null;
            if (doc.numPages <= PAGE_LABEL_DENSE_READ_MAX_PAGES) {
                try {
                    const raw = await doc.getPageLabels();
                    labels = raw && raw.length === doc.numPages ? raw : null;
                } catch (error) {
                    BrowserLogger.debug(
                        'page-labels',
                        'Failed to read page labels from PDF document',
                        error,
                    );
                    labels = null;
                }
            } else {
                BrowserLogger.debug('page-labels', 'Skipped dense PDF.js page-label read', {pageCount: doc.numPages});
            }

            if (!isCurrentSync()) {
                return;
            }
            const nextRanges = derivePageLabelRangesFromLabels(
                labels,
                doc.numPages,
            );
            updatePageLabelModel(doc.numPages, nextRanges, labels);
            pageLabelsDirty.value = false;
            pageLabelRevision += 1;
        } finally {
            if (isCurrentSync()) {
                pageLabelsResolved.value = true;
                onPageLabelsSynchronized?.();
            }
        }
    }

    function markPageLabelsSaved() {
        pageLabelsDirty.value = false;
        onPageLabelsSaved?.();
    }

    function handlePageLabelRangesUpdate(ranges: IPdfPageLabelRange[]) {
        if (totalPages.value <= 0) {
            return;
        }

        const normalized = normalizePageLabelRanges(ranges, totalPages.value);
        const currentNormalized = normalizePageLabelRanges(
            pageLabelRanges.value,
            totalPages.value,
        );
        const unchanged = isEqual(normalized, currentNormalized);
        if (unchanged) {
            const expectedLabels = totalPages.value <= PAGE_LABEL_SMALL_COMPATIBILITY_MAX_PAGES
                ? materializePageLabelsForCompatibility(totalPages.value, normalized)
                : null;
            if (!isEqual(pageLabels.value, expectedLabels)) {
                updatePageLabelModel(totalPages.value, normalized);
            }
            return;
        }
        updatePageLabelModel(totalPages.value, normalized);
        pageLabelsDirty.value = true;
        pageLabelRevision += 1;
        onPageLabelsDirty?.();
    }

    function getPageLabelsRevision() {
        return pageLabelRevision;
    }

    function labelAt(page: number) {
        return pageLabelModel.value.labelAt(page);
    }

    function readPageLabelWindow(startPage: number, endPageOrCount?: number) {
        return pageLabelModel.value.readWindow(startPage, endPageOrCount);
    }

    function getPageLabelWindowForState(startPage: number, endPageOrCount?: number) {
        return getPageLabelWindow(
            pageLabelModel.value.totalPages,
            pageLabelModel.value.ranges,
            startPage,
            endPageOrCount,
        );
    }

    function scheduleSyncPageLabelsFromDocument(doc: IPdfDocument | null) {
        runGuardedTask(() => syncPageLabelsFromDocument(doc), {
            category: 'background-diagnostic',
            scope: 'page-labels',
            message: 'Failed to synchronize page labels from PDF document',
        });
    }

    watch(
        pdfDocument,
        (doc) => {
            if (doc) {
                pageLabelsResolved.value = false;
            }
            scheduleSyncPageLabelsFromDocument(doc);
        },
        { immediate: true },
    );

    watch(totalPages, (nextTotalPages) => {
        if (pdfDocument.value) {
            return;
        }
        if (nextTotalPages <= 0) {
            pageLabels.value = null;
            pageLabelRanges.value = [];
        }
        pageLabelModel.value = createPageLabelModel(
            Math.max(0, nextTotalPages),
            pageLabelRanges.value,
        );
    });

    tryOnScopeDispose(() => {
        disposed = true;
        pageLabelSyncGeneration += 1;
    });

    return {
        pageLabels,
        pageLabelModel,
        pageLabelRanges,
        pageLabelSegments: computed(() => pageLabelModel.value.segments),
        pageLabelsDirty,
        pageLabelsResolved,
        labelAt,
        readPageLabelWindow,
        getPageLabelWindow: getPageLabelWindowForState,
        syncPageLabelsFromDocument,
        markPageLabelsSaved,
        getPageLabelsRevision,
        handlePageLabelRangesUpdate,
    };
};
