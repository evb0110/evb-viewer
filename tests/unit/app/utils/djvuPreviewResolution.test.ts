import {describe, expect, it} from 'vitest';
import {DJVU_PREVIEW_HEADROOM, resolveDjvuPreviewResolutionPlan} from '@app/utils/djvuPreviewResolution';

describe('resolveDjvuPreviewResolutionPlan', () => {
    it('subsamples low-DPI fit-width previews with quality headroom', () => {
        const plan = resolveDjvuPreviewResolutionPlan({
            nativeWidth: 4_960,
            neededDevicePx: 1_100,
        });

        expect(plan).toEqual({
            targetPx: Math.ceil(1_100 * DJVU_PREVIEW_HEADROOM),
            subsample: 3,
        });
        expect(4_960 / plan.subsample).toBeGreaterThanOrEqual(plan.targetPx);
    });

    it('keeps native resolution when the display genuinely needs it', () => {
        expect(
            resolveDjvuPreviewResolutionPlan({
                nativeWidth: 4_960,
                neededDevicePx: 3_400,
            }),
        ).toEqual({
            targetPx: 4_960,
            subsample: 1,
        });
    });

    it('keeps low-resolution pages at native width instead of requesting over-native pixels', () => {
        expect(
            resolveDjvuPreviewResolutionPlan({
                nativeWidth: 1_293,
                neededDevicePx: 2_484,
                maxTargetPx: 3_072,
            }),
        ).toEqual({
            targetPx: 1_293,
            subsample: 1,
        });
    });

    it('caps extreme over-native low-resolution preview requests at native width', () => {
        expect(
            resolveDjvuPreviewResolutionPlan({
                nativeWidth: 1_293,
                neededDevicePx: 5_000,
                maxTargetPx: 2_048,
            }),
        ).toEqual({
            targetPx: 1_293,
            subsample: 1,
        });
    });

    it('keeps native pixels for tiny over-native paint gaps', () => {
        expect(
            resolveDjvuPreviewResolutionPlan({
                nativeWidth: 1_293,
                neededDevicePx: 1_398,
                maxTargetPx: 3_072,
            }),
        ).toEqual({
            targetPx: 1_293,
            subsample: 1,
        });
    });

    it('caps the target width before choosing a subsample', () => {
        expect(
            resolveDjvuPreviewResolutionPlan({
                nativeWidth: 2_400,
                neededDevicePx: 2_000,
                maxTargetPx: 1_024,
            }),
        ).toEqual({
            targetPx: 1_024,
            subsample: 2,
        });
    });

    it('caps extreme subsampling for tiny previews', () => {
        expect(
            resolveDjvuPreviewResolutionPlan({
                nativeWidth: 10_000,
                neededDevicePx: 100,
                maxSubsample: 12,
            }),
        ).toEqual({
            targetPx: 150,
            subsample: 12,
        });
    });
});
