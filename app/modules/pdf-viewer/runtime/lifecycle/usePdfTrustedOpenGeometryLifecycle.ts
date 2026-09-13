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
import type { IDocumentViewerChassisAuthority } from '@app/modules/document-viewer/public';
import { writeTrustedPdfOpenGeometry } from '@app/modules/pdf-viewer/runtime/lifecycle/pdfTrustedOpenGeometryCache';
import { commitPdfLoadedOpeningPageGeometry } from '@app/modules/pdf-viewer/runtime/lifecycle/commitPdfLoadedOpeningPageGeometry';

interface IUsePdfTrustedOpenGeometryLifecycleOptions {
    acceptedSource: Readonly<Ref<TPdfSource | null>>;
    chassisAuthority: IDocumentViewerChassisAuthority | null;
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

export const usePdfTrustedOpenGeometryLifecycle = (
    options: IUsePdfTrustedOpenGeometryLifecycleOptions,
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
    const trustedGeometryStat = shallowRef<{
        size: number;
        modifiedAt?: number;
    } | null>(null);

    watch(
        () => [
            documentId.value,
            src.value,
        ] as const,
        ([
            documentId,
            sourceAtLookup,
        ]) => {
            trustedGeometryStat.value = null;
            if (!documentId || !chassisAuthority) {
                return;
            }

            const prevalidatedGeometry = chassisAuthority.openSurface.snapshot.value.openingPageGeometry;
            if (
                prevalidatedGeometry?.documentId === documentId
                && prevalidatedGeometry.pageNumber === currentPage.value
            ) {
                if (
                    'size' in prevalidatedGeometry
                    && typeof prevalidatedGeometry.size === 'number'
                    && 'modifiedAt' in prevalidatedGeometry
                    && typeof prevalidatedGeometry.modifiedAt === 'number'
                ) {
                    trustedGeometryStat.value = {
                        size: prevalidatedGeometry.size,
                        modifiedAt: prevalidatedGeometry.modifiedAt,
                    };
                }
                seedTrustedPageGeometry({
                    pageNumber: requirePageNumber(
                        prevalidatedGeometry.pageNumber,
                        prevalidatedGeometry.pageCount,
                    ),
                    pageCount: prevalidatedGeometry.pageCount,
                    width: prevalidatedGeometry.width,
                    height: prevalidatedGeometry.height,
                    rotation: prevalidatedGeometry.rotation,
                });
                // The main-process opening-geometry capability already
                // fingerprinted this exact original source. Do not issue a
                // second file:stat for the original path: renderer file I/O is
                // deliberately limited to its managed working copy, and a
                // close/reopen can retire that mapping while this watcher is
                // still awaiting IPC.
                if (trustedGeometryStat.value) {
                    return;
                }
            }

            if (sourceAtLookup && !(sourceAtLookup instanceof Blob)) {
                // The adopted path source already carries its validated byte
                // length. It is safe for display and load decisions, but its
                // managed-copy mtime is not the original source revision, so
                // do not use it to validate a persistent original-path cache.
                trustedGeometryStat.value = {size: sourceAtLookup.size};
                return;
            }
            // An original path is identity/display metadata, not renderer file
            // authority. Without an authoritative prevalidated fingerprint or
            // an adopted path source, let PDF.js commit ephemeral geometry;
            // never validate the persistent cache by statting the original.
            return;
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
            trustedGeometryStat,
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
            if (!documentId || !metric || pageCount < 1) {
                return;
            }
            const brandedPageNumber = requirePageNumber(pageNumber, pageCount);

            const snapshot = chassisAuthority?.openSurface.snapshot.value;
            if (chassisAuthority && snapshot?.identity) {
                commitPdfLoadedOpeningPageGeometry(chassisAuthority, {
                    expectedGeneration: snapshot.generation,
                    documentId: snapshot.identity.documentId,
                    metricSource: acceptedSource.value,
                    currentSource: src.value,
                    pageNumber: brandedPageNumber,
                    currentPage: requirePageNumber(currentPage.value, pageCount),
                    pageCount,
                    metric,
                });
            }
            const stat = trustedGeometryStat.value;
            if (stat?.modifiedAt === undefined) {
                return;
            }
            writeTrustedPdfOpenGeometry({
                documentId,
                size: stat.size,
                modifiedAt: stat.modifiedAt,
                pageNumber: brandedPageNumber,
                pageCount,
                width: metric.width,
                height: metric.height,
                rotation: metric.rotation ?? 0,
                savedAt: Date.now(),
            });
        },
        { flush: 'post' },
    );

};
