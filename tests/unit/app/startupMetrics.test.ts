import {beforeEach, describe, expect, it, vi} from 'vitest';
import {markStartupMetricOnce, resetStartupMetricsForTests} from '@app/utils/startupMetrics';

describe('startup metrics', () => {
    beforeEach(() => resetStartupMetricsForTests());

    it('records each milestone exactly once', () => {
        const mark = vi.spyOn(performance, 'mark');
        expect(markStartupMetricOnce('evb:shell-interactive')).toBe(true);
        expect(markStartupMetricOnce('evb:shell-interactive')).toBe(false);
        expect(mark).toHaveBeenCalledOnce();
        mark.mockRestore();
    });
});
