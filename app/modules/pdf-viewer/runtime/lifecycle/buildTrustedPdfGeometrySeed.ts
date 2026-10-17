import type { TPageNumber } from '@contracts/pageNumbers';
import type { IDocumentOpenSurfaceSnapshot } from '@app/modules/document-viewer/public';

import type { IPdfPageMetric } from '@app/types/pdfUi';

export function buildTrustedPdfGeometrySeed(input: {
    pageNumber: TPageNumber;
    pageCount: number;
    width?: number;
    height?: number;
    rotation?: number;
    pages?: NonNullable<IDocumentOpenSurfaceSnapshot['openingPageGeometry']>['pages'];
}) {
    if (
        !Number.isSafeInteger(input.pageNumber) || input.pageNumber < 1
        || !Number.isSafeInteger(input.pageCount) || input.pageCount < input.pageNumber
        || !input.pages || input.pages.length !== input.pageCount
    ) {
        return null;
    }
    const pageMetrics: IPdfPageMetric[] = [];
    for (const [
        index,
        page,
    ] of input.pages.entries()) {
        if ('pageNumber' in page && page.pageNumber !== index + 1 || ![
            0,
            90,
            180,
            270,
        ].includes(page.rotation)) return null;
        const rotated = page.rotation === 90 || page.rotation === 270;
        const metric = {
            width: (rotated ? page.heightPoints : page.widthPoints) * page.userUnit,
            height: (rotated ? page.widthPoints : page.heightPoints) * page.userUnit,
            rotation: page.rotation,
            userUnit: page.userUnit,
        };
        if (!Number.isFinite(metric.width) || metric.width <= 0 || !Number.isFinite(metric.height) || metric.height <= 0) {
            return null;
        }
        pageMetrics.push(metric);
    }
    return {
        numPages: input.pageCount,
        basePageWidth: pageMetrics.reduce((width, page) => Math.max(width, page.width), 0),
        basePageHeight: pageMetrics.reduce((height, page) => Math.max(height, page.height), 0),
        pageMetrics,
    };
}
