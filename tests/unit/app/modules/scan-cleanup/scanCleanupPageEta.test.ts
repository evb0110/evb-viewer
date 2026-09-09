import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    ref,
} from 'vue';
import {
    createScanCleanupPageEtaEstimator,
    useScanCleanupPageEta,
} from '@app/modules/scan-cleanup/composables/useScanCleanupPageEta';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (
        key: string,
        parameters?: Record<string, string | number>,
    ) => Object.entries(parameters ?? {}).reduce(
        (value, [
            parameter,
            replacement,
        ]) => `${value} ${parameter}=${String(replacement)}`,
        key,
    )}),
}));

describe('scan cleanup page ETA estimator', () => {
    it('keeps the ETA pending until three page durations are available', () => {
        const estimator = createScanCleanupPageEtaEstimator();
        estimator.reset(0, 0);

        expect(estimator.record({
            completedAtMs: 1_000,
            completedUnits: 1,
            totalUnits: 10,
        })).toBeNull();
        expect(estimator.record({
            completedAtMs: 2_000,
            completedUnits: 2,
            totalUnits: 10,
        })).toBeNull();
    });

    it('estimates remaining work from a steady per-page rate', () => {
        const estimator = createScanCleanupPageEtaEstimator();
        estimator.reset(0, 0);

        estimator.record({
            completedAtMs: 1_000,
            completedUnits: 1,
            totalUnits: 10,
        });
        estimator.record({
            completedAtMs: 2_000,
            completedUnits: 2,
            totalUnits: 10,
        });

        expect(estimator.record({
            completedAtMs: 3_000,
            completedUnits: 3,
            totalUnits: 10,
        })).toBe(7_000);
    });

    it('reads through batched completions instead of timing gaps inside a batch', () => {
        const estimator = createScanCleanupPageEtaEstimator();
        estimator.reset(0, 0);

        // Eight pages analyzed four at a time: each batch takes two seconds and
        // then reports its four pages a millisecond apart. Real throughput is
        // half a second per page, but three of every four adjacent gaps are ~1ms.
        let latest: number | null = null;
        for (let batch = 1; batch <= 2; batch += 1) {
            for (let pageInBatch = 0; pageInBatch < 4; pageInBatch += 1) {
                latest = estimator.record({
                    completedAtMs: batch * 2_000 + pageInBatch,
                    completedUnits: (batch - 1) * 4 + pageInBatch + 1,
                    totalUnits: 20,
                });
            }
        }

        // Twelve pages remain at the measured half second each. An estimator
        // that believed the intra-batch gaps would promise about a hundredth
        // of that.
        expect(latest).toBe(6_005);
    });

    it('does not collapse the estimate when a burst lands after a steady stretch', () => {
        const estimator = createScanCleanupPageEtaEstimator();
        estimator.reset(0, 0);
        for (let completedUnits = 1; completedUnits <= 5; completedUnits += 1) {
            estimator.record({
                completedAtMs: completedUnits * 1_000,
                completedUnits,
                totalUnits: 10,
            });
        }

        estimator.record({
            completedAtMs: 5_100,
            completedUnits: 6,
            totalUnits: 10,
        });
        estimator.record({
            completedAtMs: 5_200,
            completedUnits: 7,
            totalUnits: 10,
        });

        // Eight pages in 5.3 seconds is 662ms each, so two pages left is about
        // 1.3 seconds. The burst pulls the average down without erasing the
        // five seconds of evidence that came before it.
        expect(estimator.record({
            completedAtMs: 5_300,
            completedUnits: 8,
            totalUnits: 10,
        })).toBe(1_325);
    });

    it('restarts measurement when the counter moves backward', () => {
        const estimator = createScanCleanupPageEtaEstimator();
        estimator.reset(0, 0);
        for (let completedUnits = 1; completedUnits <= 4; completedUnits += 1) {
            estimator.record({
                completedAtMs: completedUnits * 1_000,
                completedUnits,
                totalUnits: 10,
            });
        }

        expect(estimator.record({
            completedAtMs: 5_000,
            completedUnits: 2,
            totalUnits: 10,
        })).toBeNull();
        expect(estimator.record({
            completedAtMs: 6_000,
            completedUnits: 3,
            totalUnits: 10,
        })).toBeNull();
        // Measured only since the restart: three pages in three seconds.
        expect(estimator.record({
            completedAtMs: 8_000,
            completedUnits: 5,
            totalUnits: 10,
        })).toBe(5_000);
    });
});

describe('scan cleanup page ETA caption', () => {
    function createCaption() {
        const progress = ref({
            completedAtMs: 0,
            completedUnits: 0,
            phaseKey: 'analysis',
            runKey: 'job-1',
            totalUnits: 10,
        });
        const {
            progressEtaText,
            progressEtaWidestText,
        } = useScanCleanupPageEta(
            computed(() => progress.value),
            computed(() => 'scanCleanup.detectAll.reconciling'),
        );
        return {
            progress,
            progressEtaText,
            progressEtaWidestText,
        };
    }

    it('reports the phase as finishing once the counter reaches its total', () => {
        const {
            progress,
            progressEtaText,
        } = createCaption();

        for (let completedUnits = 1; completedUnits <= 9; completedUnits += 1) {
            progress.value = {
                ...progress.value,
                completedAtMs: completedUnits * 1_000,
                completedUnits,
            };
        }
        expect(progressEtaText.value).toBe('scanCleanup.etaSeconds seconds=1');

        progress.value = {
            ...progress.value,
            completedAtMs: 10_000,
            completedUnits: 10,
        };

        expect(progressEtaText.value).toBe('scanCleanup.detectAll.reconciling');
    });

    it('never falls back to the pending sentence after the counter completes', () => {
        const {
            progress,
            progressEtaText,
        } = createCaption();

        progress.value = {
            ...progress.value,
            completedAtMs: 1_000,
            completedUnits: 10,
        };

        expect(progressEtaText.value).toBe('scanCleanup.detectAll.reconciling');
    });

    it('reserves width for the finishing caption', () => {
        const {progressEtaWidestText} = createCaption();

        expect([
            'scanCleanup.etaPending',
            'scanCleanup.detectAll.reconciling',
            'scanCleanup.etaMinutes minutes=999',
            'scanCleanup.etaSeconds seconds=999',
        ]).toContain(progressEtaWidestText.value);
        expect(progressEtaWidestText.value.length).toBeGreaterThanOrEqual(
            'scanCleanup.detectAll.reconciling'.length,
        );
    });
});
