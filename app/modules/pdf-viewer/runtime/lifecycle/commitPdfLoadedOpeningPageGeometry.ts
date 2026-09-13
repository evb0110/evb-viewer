import type { TPageNumber } from '@contracts/pageNumbers';

import type {
    IPdfPageMetric,
    TPdfSource,
} from '@app/types/pdfUi';
import type { IDocumentViewerRuntime } from '@app/modules/document-viewer/public';
import { pdfSourcesMatch } from '@app/modules/pdf-viewer/runtime/pdfSourcesMatch';

function diagnosePdfLoadedOpeningPageGeometry(
    chassisAuthority: IDocumentViewerRuntime,
    input: Parameters<typeof commitPdfLoadedOpeningPageGeometry>[1],
) {
    const snapshot = chassisAuthority.openSurface.snapshot.value;
    if (snapshot.generation !== input.expectedGeneration) {
        return 'generation-mismatch';
    }
    if (snapshot.identity?.documentId !== input.documentId) {
        return 'document-mismatch';
    }
    if (snapshot.phase !== 'pending') {
        return 'surface-not-pending';
    }
    if (snapshot.openingPageGeometry !== null) {
        return 'already-committed';
    }
    if (input.pageNumber !== input.currentPage) {
        return 'page-mismatch';
    }
    if (input.pageCount < input.pageNumber) {
        return 'page-count-invalid';
    }
    if (!input.metric) {
        return 'metric-missing';
    }
    if (!pdfSourcesMatch(input.metricSource, input.currentSource)) {
        const describe = (source: TPdfSource | null) => {
            if (source === null) {
                return 'null';
            }
            if (source instanceof Blob) {
                return `blob:${String(source.size)}`;
            }
            return `path:${source.path}:${String(source.size)}`;
        };
        return `source-mismatch:${describe(input.metricSource)}!=${describe(input.currentSource)}`;
    }
    return 'ready';
}

export function commitPdfLoadedOpeningPageGeometry(
    chassisAuthority: IDocumentViewerRuntime,
    input: {
        expectedGeneration: number;
        documentId: string;
        metricSource: TPdfSource | null;
        currentSource: TPdfSource | null;
        pageNumber: TPageNumber;
        currentPage: number;
        pageCount: number;
        metric: IPdfPageMetric | undefined;
    },
) {
    const metric = input.metric;
    if (diagnosePdfLoadedOpeningPageGeometry(chassisAuthority, input) !== 'ready' || !metric) {
        return false;
    }
    return chassisAuthority.openSurface.commitOpeningPageGeometry(input.expectedGeneration, {
        documentId: input.documentId,
        pageNumber: input.pageNumber,
        pageCount: input.pageCount,
        width: metric.width,
        height: metric.height,
        rotation: metric.rotation ?? 0,
    });
}
