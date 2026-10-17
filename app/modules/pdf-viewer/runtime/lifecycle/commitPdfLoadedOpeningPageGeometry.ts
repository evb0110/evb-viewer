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
    if (!input.pageMetrics[input.pageNumber - 1]) {
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
        pageMetrics: readonly IPdfPageMetric[];
    },
) {
    const metric = input.pageMetrics[input.pageNumber - 1];
    if (diagnosePdfLoadedOpeningPageGeometry(chassisAuthority, input) !== 'ready' || !metric) {
        return false;
    }
    // A partial table cannot place a Fit Width skeleton at the eventual scale.
    if (input.pageMetrics.length !== input.pageCount || !Array.from(input.pageMetrics).every(Boolean)) {
        return false;
    }
    const pages = input.pageMetrics.map((metric) => {
        const rotated = metric.rotation === 90 || metric.rotation === 270;
        const userUnit = metric.userUnit ?? 1;
        return {
            widthPoints: (rotated ? metric.height : metric.width) / userUnit,
            heightPoints: (rotated ? metric.width : metric.height) / userUnit,
            rotation: metric.rotation ?? 0,
            userUnit,
        };
    });
    return chassisAuthority.openSurface.commitOpeningPageGeometry(input.expectedGeneration, {
        documentId: input.documentId,
        pageNumber: input.pageNumber,
        pageCount: input.pageCount,
        width: metric.width,
        height: metric.height,
        rotation: metric.rotation ?? 0,
        widestPageWidth: input.pageMetrics.reduce((width, metric) => Math.max(width, metric.width), 0),
        tallestPageHeight: input.pageMetrics.reduce((height, metric) => Math.max(height, metric.height), 0),
        pages,
    });
}
