import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import type {
    ComputedRef,
    Ref,
} from 'vue';
import type {
    IPdfPageMetric,
    TPdfSource,
} from '@app/types/pdfUi';
import type { IDocumentViewerRuntime } from '@app/modules/document-viewer/public';
import { commitPdfLoadedOpeningPageGeometry } from '@app/modules/pdf-viewer/runtime/lifecycle/commitPdfLoadedOpeningPageGeometry';

interface IUsePdfOpeningGeometryLifecycleOptions {
    acceptedSource: Readonly<Ref<TPdfSource | null>>;
    chassisAuthority: IDocumentViewerRuntime | null;
    currentPage: ComputedRef<number>;
    documentId: ComputedRef<string | null>;
    numPages: Readonly<Ref<number>>;
    pageMetrics: Readonly<Ref<IPdfPageMetric[]>>;
    pageMetricsVersion: Readonly<Ref<number>>;
    seedTrustedPageGeometry: (input: {
        pageNumber: TPageNumber;
        pageCount: number;
        width: number;
        height: number;
        rotation?: number;
    }) => boolean;
    src: Readonly<Ref<TPdfSource | null>>;
}

/**
 * The opening surface and PDF.js share one page geometry while a document
 * opens: the native opening geometry seeds PDF.js, and the metrics PDF.js
 * loads flow back to the opening surface.
 */
export const usePdfOpeningGeometryLifecycle = (
    options: IUsePdfOpeningGeometryLifecycleOptions,
) => {
    const {
        acceptedSource,
        chassisAuthority,
        currentPage,
        documentId,
        numPages,
        pageMetrics,
        pageMetricsVersion,
        seedTrustedPageGeometry,
        src,
    } = options;

    watch(
        () => [
            documentId.value,
            src.value,
        ] as const,
        ([documentId]) => {
            if (!documentId || !chassisAuthority) {
                return;
            }
            const openingGeometry = chassisAuthority.openSurface.snapshot.value.openingPageGeometry;
            if (
                openingGeometry?.documentId === documentId
                && openingGeometry.pageNumber === currentPage.value
            ) {
                seedTrustedPageGeometry({
                    pageNumber: requirePageNumber(
                        openingGeometry.pageNumber,
                        openingGeometry.pageCount,
                    ),
                    pageCount: openingGeometry.pageCount,
                    width: openingGeometry.width,
                    height: openingGeometry.height,
                    rotation: openingGeometry.rotation,
                });
            }
        },
        {
            flush: 'sync',
            immediate: true,
        },
    );

    watch(
        [
            documentId,
            currentPage,
            numPages,
            pageMetricsVersion,
            acceptedSource,
            () => chassisAuthority?.openSurface.snapshot.value.generation ?? 0,
            () => chassisAuthority?.openSurface.snapshot.value.phase ?? 'idle',
            () => chassisAuthority?.openSurface.snapshot.value.identity?.documentId ?? null,
        ],
        ([
            documentId,
            pageNumber,
            pageCount,
        ]) => {
            const metric = pageMetrics.value[pageNumber - 1];
            const snapshot = chassisAuthority?.openSurface.snapshot.value;
            if (!documentId || !metric || pageCount < 1 || !chassisAuthority || !snapshot?.identity) {
                return;
            }
            commitPdfLoadedOpeningPageGeometry(chassisAuthority, {
                expectedGeneration: snapshot.generation,
                documentId: snapshot.identity.documentId,
                metricSource: acceptedSource.value,
                currentSource: src.value,
                pageNumber: requirePageNumber(pageNumber, pageCount),
                currentPage: requirePageNumber(currentPage.value, pageCount),
                pageCount,
                metric,
            });
        },
        { flush: 'post' },
    );
};
