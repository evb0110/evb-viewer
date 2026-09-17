import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    createCanvas,
    loadImage,
} from '@napi-rs/canvas';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    compareDisplayedPreviewLeaves,
    createForcedPostSettleMovementProbeLeaves,
    createPreviewPresentationStabilityReport,
    measurePreviewPresentationStability,
} from '@scripts/diagnostics/scan-cleanup-preview-presentation.mjs';
import {
    commitScanCleanupPreviewPresentationSettle,
    resolveScanCleanupPreviewPresentationCommit,
} from '@app/modules/scan-cleanup/composables/useScanCleanupPreviewImages';

const stableComparison = {
    half: 'left',
    rasterIdentical: true,
    inkMarginShift: {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        maximum: 0,
    },
};
const forcedMovementComparison = {
    ...stableComparison,
    rasterIdentical: false,
};

function report(
    postSettleComparisons: object[],
    leafSets: {
        previewHalves?: string[],
        provisionalHalves?: string[],
    } = {},
    forcedPostSettleMovementComparisons: object[] = [forcedMovementComparison],
) {
    return createPreviewPresentationStabilityReport({
        firstProvisionalCommit: {action: 'coalesce'},
        firstProvisionalComparisons: [stableComparison],
        forcedPostSettleMovementComparisons,
        postSettleCommit: {action: 'reject'},
        postSettleComparisons,
        settleCommit: {action: 'commit'},
        settleCommitComparisons: [stableComparison],
        settledLoadingCommit: {action: 'reject'},
        ...leafSets,
        secondProvisionalCommit: {action: 'coalesce'},
        secondProvisionalComparisons: [stableComparison],
    });
}

describe('scan cleanup preview presentation evidence', () => {
    it('gates any post-settle movement', () => {
        const rasterOnly = {
            ...stableComparison,
            rasterIdentical: false,
        };
        const marginOnly = {
            ...stableComparison,
            inkMarginShift: {
                ...stableComparison.inkMarginShift,
                maximum: 0.001,
            },
        };

        expect(report([stableComparison]).violations).toEqual([]);
        expect(report([rasterOnly]).violations).toContain('presentation-post-settle-movement');
        expect(report([marginOnly]).violations).toContain('presentation-post-settle-movement');
    });

    it('drives the harness probe mutation red for movement and fails a green probe', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'scan-cleanup-presentation-probe-'));
        try {
            const metricsPath = join(directory, 'settled-left.png');
            const canvas = createCanvas(24, 16);
            const context = canvas.getContext('2d');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = '#000000';
            context.fillRect(3, 2, 9, 8);
            await writeFile(metricsPath, canvas.toBuffer('image/png'));
            const leaves = [{
                half: 'left',
                metricsPath,
            }];
            const measureMargins = async (path: string) => {
                const image = await loadImage(path);
                const measured = createCanvas(image.width, image.height);
                const measuredContext = measured.getContext('2d');
                measuredContext.drawImage(image, 0, 0);
                const pixels = measuredContext.getImageData(0, 0, image.width, image.height).data;
                let left = image.width;
                let top = image.height;
                let right = -1;
                let bottom = -1;
                for (let y = 0; y < image.height; y += 1) {
                    for (let x = 0; x < image.width; x += 1) {
                        if ((pixels[(y * image.width + x) * 4] ?? 255) > 220) continue;
                        left = Math.min(left, x);
                        top = Math.min(top, y);
                        right = Math.max(right, x);
                        bottom = Math.max(bottom, y);
                    }
                }
                return {
                    left: left / image.width,
                    top: top / image.height,
                    right: (image.width - 1 - right) / image.width,
                    bottom: (image.height - 1 - bottom) / image.height,
                };
            };
            const compareMargins = (before: Awaited<ReturnType<typeof measureMargins>>, after: Awaited<ReturnType<typeof measureMargins>>) => {
                const shifts = {
                    left: Math.abs(before.left - after.left),
                    top: Math.abs(before.top - after.top),
                    right: Math.abs(before.right - after.right),
                    bottom: Math.abs(before.bottom - after.bottom),
                };
                return {
                    ...shifts,
                    maximum: Math.max(...Object.values(shifts)),
                };
            };
            const forcedProbeLeaves = await createForcedPostSettleMovementProbeLeaves(
                leaves,
                join(directory, 'forced-probe'),
            );
            const red = await measurePreviewPresentationStability({
                commitSettle: commitScanCleanupPreviewPresentationSettle,
                compareMargins,
                forcedProbeLeaves,
                measureMargins,
                previewLeaves: leaves,
                provisionalLeaves: leaves,
                resolveCommit: resolveScanCleanupPreviewPresentationCommit,
                transitionKey: 'session:page-1:user-0',
            });
            expect(red.violations).toEqual([]);
            expect(red.forcedPostSettleMovementProbe).toMatchObject({
                status: 'red',
                violations: ['presentation-post-settle-movement'],
                leaves: [expect.objectContaining({
                    half: 'left',
                    rasterIdentical: false,
                    inkMarginShift: expect.objectContaining({maximum: expect.any(Number)}),
                })],
            });
            expect(red.forcedPostSettleMovementProbe.leaves[0].inkMarginShift.maximum).toBeGreaterThan(0);

            const green = await measurePreviewPresentationStability({
                commitSettle: commitScanCleanupPreviewPresentationSettle,
                compareMargins,
                forcedProbeLeaves: leaves,
                measureMargins,
                previewLeaves: leaves,
                provisionalLeaves: leaves,
                resolveCommit: resolveScanCleanupPreviewPresentationCommit,
                transitionKey: 'session:page-1:user-0',
            });
            expect(green.violations).toContain('presentation-forced-probe-not-red');
            expect(green.forcedPostSettleMovementProbe).toMatchObject({
                status: 'green',
                violations: ['presentation-forced-probe-not-red'],
            });
        } finally {
            await rm(directory, {
                force: true,
                recursive: true,
            });
        }
    });

    it('reports either missing comparison half instead of silently skipping it', async () => {
        const measureMargins = vi.fn();
        const compareMargins = vi.fn();
        const beforeMissing = await compareDisplayedPreviewLeaves([], [{
            half: 'right',
            metricsPath: '/unused-after.png',
        }], measureMargins, compareMargins);
        const afterMissing = await compareDisplayedPreviewLeaves([{
            half: 'left',
            metricsPath: '/unused-before.png',
        }], [], measureMargins, compareMargins);

        expect(beforeMissing).toEqual([expect.objectContaining({
            half: 'right',
            missingBefore: true,
        })]);
        expect(afterMissing).toEqual([expect.objectContaining({
            half: 'left',
            missingAfter: true,
        })]);
        expect(report(beforeMissing).violations).toEqual(expect.arrayContaining([
            'presentation-missing-half',
            'presentation-post-settle-movement',
        ]));
        expect(measureMargins).not.toHaveBeenCalled();
        expect(compareMargins).not.toHaveBeenCalled();
    });

    it('checks both provisional and settled leaf sets for a dropped half', () => {
        expect(report([stableComparison], {
            provisionalHalves: [
                'left',
                'right',
            ],
            previewHalves: ['left'],
        }).violations).toContain('presentation-missing-half');
        expect(report([stableComparison], {
            provisionalHalves: ['left'],
            previewHalves: [
                'left',
                'right',
            ],
        }).violations).toContain('presentation-missing-half');
    });
});
