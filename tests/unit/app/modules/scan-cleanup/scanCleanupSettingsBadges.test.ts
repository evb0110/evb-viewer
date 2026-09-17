import {
    describe,
    expect,
    it,
} from 'vitest';
import type {IScanCleanupOptions} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {
    resetScanCleanupOptionsToDefaults,
    resolveScanCleanupNonDefaultSettings,
} from '@app/modules/scan-cleanup/runtime/scanCleanupSettingsBadges';
import {DEFAULT_SCAN_CLEANUP_PREFERENCES} from '@contracts/scan-cleanup/scanCleanupSettings';

function scanCleanupOptions(): IScanCleanupOptions {
    return {
        ...DEFAULT_SCAN_CLEANUP_PREFERENCES,
        marginsMm: {...DEFAULT_SCAN_CLEANUP_PREFERENCES.marginsMm},
        outputMode: 'auto',
        pageOverrides: {},
    };
}

describe('scan-cleanup non-default settings badges', () => {
    it('has no badges for the default resolved options', () => {
        expect(resolveScanCleanupNonDefaultSettings(scanCleanupOptions())).toEqual([]);
    });

    it('exposes changed values and document overrides as removable badge keys', () => {
        const options = scanCleanupOptions();
        options.binarization = 'wolf';
        options.pageAlignment = 'center';
        options.marginsMm.leftMm = 8;
        options.outputMode = 'grayscale';
        options.pageOverrides = {'3': {
            rotationDegrees: 90,
            layoutOverride: 'auto',
            excluded: false,
            manualSplit: null,
        }};

        expect(resolveScanCleanupNonDefaultSettings(options).map(badge => badge.key)).toEqual([
            'binarization',
            'pageAlignment',
            'marginsMm',
            'outputMode',
            'pageOverrides',
        ]);
    });

    it('resets global, document output, and page override values to defaults', () => {
        const options = scanCleanupOptions();
        options.preserveOriginalQuality = true;
        options.autoDewarp = true;
        options.autoDewarpDepth = 2;
        options.outputMode = 'color';
        options.pageOverrides = {'1': {
            rotationDegrees: 180,
            layoutOverride: 'spread',
            excluded: true,
            manualSplit: null,
        }};

        resetScanCleanupOptionsToDefaults(options);

        expect(resolveScanCleanupNonDefaultSettings(options)).toEqual([]);
    });
});
