import type { IDocumentPageMetrics } from '@app/modules/document-viewer/public';
import {
    createRafCoalescedCallback,
    type IRafCoalescedCallbackEnvironment,
} from '@app/utils/createRafCoalescedCallback';
import {
    mergeDocumentPageMetrics,
    type TDocumentPageMetricsCollection,
} from '@app/modules/workspace-shell/viewers/loadPrioritizedDocumentPageMetrics';

interface ICreateDocumentPageMetricPublicationOptions {
    readMetrics: () => TDocumentPageMetricsCollection;
    commitMetrics: (metrics: TDocumentPageMetricsCollection) => void;
    onPublished: () => void;
}

/** Frame-batches exact metric discovery so large documents do not rebuild all geometry per page. */
export function createDocumentPageMetricPublication(
    options: ICreateDocumentPageMetricPublicationOptions,
    environment?: IRafCoalescedCallbackEnvironment,
) {
    const pendingMetrics = new Map<number, IDocumentPageMetrics>();

    function flush() {
        if (pendingMetrics.size === 0) {
            return;
        }
        const nextMetrics = mergeDocumentPageMetrics(options.readMetrics(), pendingMetrics);
        pendingMetrics.clear();
        options.commitMetrics(nextMetrics);
        options.onPublished();
    }

    const schedule = createRafCoalescedCallback(flush, environment);
    function clear() {
        pendingMetrics.clear();
        schedule.cancel();
    }

    return {
        clear,
        enqueue(pageNumber: number, metric: IDocumentPageMetrics) {
            pendingMetrics.set(pageNumber, metric);
            schedule.schedule();
        },
        flush,
    };
}
