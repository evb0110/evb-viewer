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
} from '@app/modules/document-viewer/public';
import { BrowserLogger } from '@app/utils/browserLogger';
import { runGuardedTask } from '@app/utils/asyncGuard';
import type {TDocumentRef} from '@contracts/documentRef';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';

export const usePageLabelState = (deps: {
    pdfDocument: Readonly<Ref<IPdfDocument | null>>;
    totalPages: Readonly<Ref<number>>;
    markDirty: () => void;
    workingCopyPath?: Ref<TDocumentRef | null>;
    documentRevisionToken?: Readonly<Ref<TDocumentRevisionToken | null>>;
    readPageLabelRanges?: () => Promise<IPdfPageLabelRange[]>;
    onPageLabelsSynchronized?: () => void;
    onPageLabelsDirty?: () => void;
    onPageLabelsSaved?: () => void;
    /** Another document's bytes arrived, so what was read from the last ones is stale. */
    onDocumentBytesChanged?: () => void;
}) => {
    const {
        pdfDocument,
        totalPages,
        onPageLabelsSynchronized,
        onPageLabelsDirty,
        onPageLabelsSaved,
        onDocumentBytesChanged,
        workingCopyPath,
        documentRevisionToken,
        readPageLabelRanges,
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
    let lastResolvedDocument: IPdfDocument | null = null;
    let lastResolvedPath: TDocumentRef | null = null;

    // Every view of a working copy holds its own PDF.js document of the same
    // bytes, and the document in use follows the view in use. The labels
    // belong to the bytes: a working-copy revision when there is one,
    // otherwise the PDF.js document itself.
    function documentBytesOf(doc: IPdfDocument | null) {
        const path = workingCopyPath?.value ?? null;
        const revision = documentRevisionToken?.value ?? null;
        return doc && path !== null && revision !== null ? `${path}\n${revision}` : doc;
    }
    // Reported bytes, and the bytes a read succeeded for: a failed read is
    // retried from whichever view offers the same bytes next.
    let noticedDocumentBytes: ReturnType<typeof documentBytesOf> | undefined;
    let resolvedDocumentBytes: ReturnType<typeof documentBytesOf> | undefined;
    function isWorkingCopyRevisionKnown() {
        return (workingCopyPath?.value ?? null) !== null && (documentRevisionToken?.value ?? null) !== null;
    }

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
        const sourcePath = workingCopyPath?.value ?? null;
        const sourceRevision = documentRevisionToken?.value ?? null;
        const sourceBytes = documentBytesOf(doc);
        const isCurrentSync = () => (
            !disposed
            && pageLabelSyncGeneration === syncGeneration
            && documentBytesOf(pdfDocument.value) === sourceBytes
            && (workingCopyPath === undefined || workingCopyPath.value === sourcePath)
            && (documentRevisionToken === undefined || documentRevisionToken.value === sourceRevision)
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
            resolvedDocumentBytes = sourceBytes;
            onPageLabelsSynchronized?.();
            return;
        }

        // A new revision of the same working copy with the same page count
        // (a rotation, for example) keeps showing its labels until the reread
        // lands; any other document change must not show the previous labels.
        const isSameShapeRevision = lastResolvedDocument !== null
            && sourcePath !== null
            && lastResolvedPath === sourcePath
            && lastResolvedDocument.numPages === doc.numPages;
        if (lastResolvedDocument !== null && lastResolvedDocument !== doc && !isSameShapeRevision) {
            updatePageLabelModel(totalPages.value, []);
        }
        pageLabelsResolved.value = false;
        let resolvedThisSync = false;

        const readCompactRanges = async () => {
            if (!readPageLabelRanges || sourcePath === null) {
                return null;
            }
            try {
                const ranges = await readPageLabelRanges();
                return isCurrentSync() ? ranges : null;
            } catch (error) {
                BrowserLogger.debug(
                    'page-labels',
                    'Failed to read compact page labels from PDF catalog',
                    error,
                );
                return null;
            }
        };

        try {
            let labels: string[] | null = null;
            let compactRanges: IPdfPageLabelRange[] | null = null;
            if (doc.numPages <= PAGE_LABEL_DENSE_READ_MAX_PAGES) {
                try {
                    const raw = await doc.getPageLabels();
                    if (raw === null) {
                        labels = null;
                    } else if (raw.length === doc.numPages && raw.every(label => typeof label === 'string')) {
                        labels = raw;
                    } else {
                        BrowserLogger.debug(
                            'page-labels',
                            'Received invalid page labels from PDF document',
                            {pageCount: doc.numPages},
                        );
                        return;
                    }
                } catch (error) {
                    BrowserLogger.debug(
                        'page-labels',
                        'Failed to read page labels from PDF document',
                        error,
                    );
                    return;
                }
            } else {
                compactRanges = await readCompactRanges();
                if (compactRanges === null) {
                    BrowserLogger.debug('page-labels', 'Skipped dense PDF.js page-label read', {pageCount: doc.numPages});
                    return;
                }
            }

            if (!isCurrentSync()) {
                return;
            }
            const nextRanges = compactRanges
                ?? derivePageLabelRangesFromLabels(labels, doc.numPages);
            updatePageLabelModel(doc.numPages, nextRanges, labels);
            pageLabelsDirty.value = false;
            pageLabelRevision += 1;
            lastResolvedDocument = doc;
            lastResolvedPath = sourcePath;
            resolvedDocumentBytes = sourceBytes;
            resolvedThisSync = true;
        } finally {
            if (isCurrentSync() && resolvedThisSync) {
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
            // A view switch changes the PDF.js document, not the bytes: the
            // labels read from them, and any edit made since, stay. A view
            // still loading its PDF.js document shows the same working copy.
            if (!doc && isWorkingCopyRevisionKnown()) {
                return;
            }
            const bytes = documentBytesOf(doc);
            if (bytes !== noticedDocumentBytes) {
                noticedDocumentBytes = bytes;
                onDocumentBytesChanged?.();
            }
            if (doc && bytes === resolvedDocumentBytes) {
                return;
            }
            if (doc) {
                pageLabelsResolved.value = false;
            }
            scheduleSyncPageLabelsFromDocument(doc);
        },
        { immediate: true },
    );

    watch(totalPages, (nextTotalPages) => {
        // Without a PDF.js document the count only matters when there is no
        // working copy either; a loading view's count says nothing yet.
        if (pdfDocument.value || isWorkingCopyRevisionKnown()) {
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
