import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
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

    it('reports temporal stability skipped without independently observed frames', async () => {
        const result = await measurePreviewPresentationStability({
            observations: undefined,
            compareMargins: () => ({maximum: 0}),
            measureMargins: () => ({}),
        });
        expect(result).toMatchObject({
            status: 'skipped',
            reason: expect.stringContaining('independently observed'),
        });
        expect(result).not.toHaveProperty('provisionalCandidates');
    });

    it('rejects changed independently sampled pixels and accepts separate identical captures', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'scan-cleanup-presentation-probe-'));
        try {
            const canvas = createCanvas(24, 16);
            const context = canvas.getContext('2d');
            context.fillStyle = '#fff';
            context.fillRect(0, 0, 24, 16);
            context.fillStyle = '#000';
            context.fillRect(3, 2, 9, 8);
            const captures = await Promise.all([
                0,
                1,
                2,
                3,
            ].map(async index => {
                const metricsPath = join(directory, `capture-${index}.png`);
                await writeFile(metricsPath, canvas.toBuffer('image/png'));
                return {
                    atMs: index,
                    phase: index < 2 ? 'provisional' : 'settled',
                    leaves: [{
                        half: 'left',
                        metricsPath,
                    }],
                };
            }));
            const changed = await createForcedPostSettleMovementProbeLeaves(captures[3]!.leaves, join(directory, 'changed'));
            const compareMargins = () => ({maximum: 1});
            const measureMargins = () => ({});
            const green = await measurePreviewPresentationStability({
                observations: captures,
                compareMargins,
                measureMargins,
            });
            expect(green).toMatchObject({
                status: 'pass',
                violations: [],
            });
            const red = await measurePreviewPresentationStability({
                observations: [
                    ...captures.slice(0, 3),
                    {
                        ...captures[3],
                        leaves: changed,
                    },
                ],
                compareMargins,
                measureMargins,
            });
            expect(red.status).toBe('fail');
            expect(red.violations).toContain('presentation-post-settle-movement');
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
