import {
    describe,
    expect,
    it,
} from 'vitest';
import {createScanCleanupProgressEtaEstimator} from '@evb/scan-cleanup/core/createScanCleanupProgressReporter';
import type {TTranslateFn} from '@i18n-app';
import {
    formatScanCleanupEta,
    resolveScanCleanupEtaWidestText,
} from '@app/modules/scan-cleanup/runtime/formatScanCleanupProgress';

const t: TTranslateFn = (key, ...args) => {
    const parameter = args[0];
    const parameters = typeof parameter === 'object' && parameter !== null
        ? parameter
        : {};
    return Object.entries(parameters).reduce<string>(
        (value, [
            name,
            replacement,
        ]) => `${value} ${name}=${String(replacement)}`,
        String(key),
    );
};

describe('scan cleanup progress ETA', () => {
    it('uses the shared estimator for detection and conversion progress', () => {
        const estimator = createScanCleanupProgressEtaEstimator();

        expect(estimator.update('detecting', 0, 10, 0)).toBeUndefined();
        expect(estimator.update('detecting', 5, 10, 10_000)).toBe(10);
        expect(estimator.update('detecting', 6, 10, 11_000)).toBe(7);
    });

    it('resets the shared estimate when the progress stage changes', () => {
        const estimator = createScanCleanupProgressEtaEstimator();
        estimator.update('detecting', 0, 10, 0);
        estimator.update('detecting', 5, 10, 10_000);

        expect(estimator.update('rendering', 0, 10, 11_000)).toBeUndefined();
    });
});

describe('scan cleanup ETA caption', () => {
    it('formats pending, seconds, and minutes from the worker value', () => {
        expect(formatScanCleanupEta(undefined, t)).toBe('scanCleanup.etaPending');
        expect(formatScanCleanupEta(1, t)).toBe('scanCleanup.etaSeconds seconds=1');
        expect(formatScanCleanupEta(60, t)).toBe('scanCleanup.etaMinutes minutes=1');
    });

    it('uses one widest-text candidate set for both progress sessions', () => {
        const widest = resolveScanCleanupEtaWidestText(t);

        expect([
            'scanCleanup.etaPending',
            'scanCleanup.etaMinutes minutes=999',
            'scanCleanup.etaSeconds seconds=999',
            'scanCleanup.finishingPhase',
            'scanCleanup.almostDone',
            'scanCleanup.detectAll.reconciling',
        ]).toContain(widest);
        expect(widest.length).toBeGreaterThanOrEqual('scanCleanup.detectAll.reconciling'.length);
    });
});
