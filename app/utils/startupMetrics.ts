export type TStartupMetric = 'evb:shell-interactive' | 'evb:document-open-started' | 'evb:first-page-painted';

const marked = new Set<TStartupMetric>();

export function markStartupMetricOnce(metric: TStartupMetric) {
    if (marked.has(metric) || typeof performance === 'undefined') {
        return false;
    }
    marked.add(metric);
    performance.mark(metric);
    return true;
}

export function resetStartupMetricsForTests() {
    marked.clear();
}
