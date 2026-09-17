import {
    describe,
    expect,
    it,
} from 'vitest';
import {resolveScanCleanupEffectiveOutputMode} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE} from '@contracts/scan-cleanup/scanCleanupPageOverrides';

const automaticOptions = {
    preserveOriginalQuality: false,
    outputMode: 'auto' as const,
};

describe('scan-cleanup effective output mode', () => {
    it('keeps unresolved Auto unknown instead of guessing B&W', () => {
        expect(resolveScanCleanupEffectiveOutputMode({
            options: automaticOptions,
            pageOverride: DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE,
        })).toBeUndefined();
    });

    it('uses one precedence order for preview, detail, labels, and final rendering', () => {
        expect(resolveScanCleanupEffectiveOutputMode({
            options: automaticOptions,
            pageOverride: DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE,
            detectedOutputMode: 'color',
            renderedOutputMode: 'bw',
        })).toBe('color');
        expect(resolveScanCleanupEffectiveOutputMode({
            options: automaticOptions,
            pageOverride: {
                ...DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE,
                outputModeOverride: 'grayscale',
            },
            detectedOutputMode: 'color',
        })).toBe('grayscale');
        expect(resolveScanCleanupEffectiveOutputMode({
            options: {
                preserveOriginalQuality: true,
                outputMode: 'bw',
            },
            pageOverride: {
                ...DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE,
                outputModeOverride: 'mixed',
            },
        })).toBe('color');
    });
});
