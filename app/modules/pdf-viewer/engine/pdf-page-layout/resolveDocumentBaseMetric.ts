import type { IPdfPageMetric } from '@app/types/pdfUi';
import {
    getPageMetricMaximum,
    type IPdfLazyIndexedCollection,
} from '@app/modules/document-viewer/public';

export function resolveDocumentBaseMetric(
    pageMetrics: IPdfPageMetric[] | IPdfLazyIndexedCollection<IPdfPageMetric>,
    dimension: 'width' | 'height',
) {
    const maxValue = getPageMetricMaximum(pageMetrics, dimension);
    return maxValue > 0 ? maxValue : null;
}
