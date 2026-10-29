import {createHash} from 'node:crypto';
import {
    mkdir,
    readFile,
    writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {
    createCanvas,
    loadImage,
} from '@napi-rs/canvas';

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

export async function composePreviewTransition(beforePath, afterPath, outputPath) {
    const [
        before,
        after,
    ] = await Promise.all([
        loadImage(beforePath),
        loadImage(afterPath),
    ]);
    const labelHeight = 52;
    const gap = 32;
    const width = before.width + after.width + gap;
    const height = Math.max(before.height, after.height) + labelHeight;
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#d0d0d0';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#202020';
    context.font = 'bold 24px sans-serif';
    context.fillText('Provisional', 12, 34);
    context.fillText('Settled candidate', before.width + gap + 12, 34);
    context.drawImage(before, 0, labelHeight);
    context.drawImage(after, before.width + gap, labelHeight);
    await writeFile(outputPath, canvas.toBuffer('image/png'));
}

export async function compareDisplayedPreviewLeaves(beforeLeaves, afterLeaves, measureMargins, compareMargins) {
    const halves = [...new Set([
        ...beforeLeaves.map(leaf => leaf.half),
        ...afterLeaves.map(leaf => leaf.half),
    ])];
    return Promise.all(halves.map(async half => {
        const beforeLeaf = beforeLeaves.find(leaf => leaf.half === half);
        const afterLeaf = afterLeaves.find(leaf => leaf.half === half);
        if (!beforeLeaf || !afterLeaf) {
            return {
                half,
                missingAfter: !afterLeaf,
                missingBefore: !beforeLeaf,
                rasterIdentical: false,
                inkMarginShift: null,
            };
        }
        const [
            beforeBytes,
            afterBytes,
        ] = await Promise.all([
            readFile(beforeLeaf.metricsPath),
            readFile(afterLeaf.metricsPath),
        ]);
        const rasterIdentical = sha256(beforeBytes) === sha256(afterBytes);
        return {
            half,
            rasterIdentical,
            inkMarginShift: rasterIdentical ? {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
                maximum: 0,
            } : compareMargins(
                await measureMargins(beforeLeaf.metricsPath),
                await measureMargins(afterLeaf.metricsPath),
            ),
        };
    }));
}

function comparisonMoved(comparison) {
    return comparison.missingBefore === true
        || comparison.missingAfter === true
        || comparison.rasterIdentical !== true
        || (comparison.inkMarginShift?.maximum ?? Number.POSITIVE_INFINITY) !== 0;
}

function comparisonHasMovement(comparison) {
    return comparison.missingBefore !== true
        && comparison.missingAfter !== true
        && (
            comparison.rasterIdentical !== true
            || (comparison.inkMarginShift?.maximum ?? 0) !== 0
        );
}

export async function createForcedPostSettleMovementProbeLeaves(leaves, outputDirectory) {
    await mkdir(outputDirectory, {recursive: true});
    return Promise.all(leaves.map(async leaf => {
        const image = await loadImage(leaf.metricsPath);
        const marginDeltaPx = 3;
        const canvas = createCanvas(image.width + marginDeltaPx, image.height);
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        // Mirror every source pixel and add a fixed left margin. Neither part
        // depends on the provisional render, so a green probe is meaningful.
        context.translate(canvas.width, 0);
        context.scale(-1, 1);
        context.drawImage(image, 0, 0);
        const metricsPath = join(outputDirectory, `${leaf.half}-raster-flip-margin-delta.png`);
        await writeFile(metricsPath, canvas.toBuffer('image/png'));
        return {
            ...leaf,
            metricsPath,
        };
    }));
}

// Only independently captured frames can establish temporal stability. Native
// candidate files and a simulation of the commit policy are not observations.
export async function measurePreviewPresentationStability({
    observations,
    compareMargins,
    measureMargins,
}) {
    const skipped = {
        status: 'skipped',
        reason: 'Temporal stability requires independently observed provisional and settled frames at the renderer presentation boundary.',
        violations: [],
    };
    if (!Array.isArray(observations)) return skipped;
    const phases = [
        'provisional',
        'settled',
    ];
    const comparisons = [];
    for (const phase of phases) {
        const samples = observations.filter(sample => sample.phase === phase);
        if (samples.length < 2) return skipped;
        for (let index = 1; index < samples.length; index++) {
            const before = samples[index - 1];
            const after = samples[index];
            if (!Number.isFinite(before.atMs) || !(after.atMs > before.atMs)
                || before.leaves.length === 0 || after.leaves.length === 0
                || before.leaves.some(leaf => after.leaves.some(next => next.metricsPath === leaf.metricsPath))) return skipped;
            comparisons.push({
                phase,
                fromMs: before.atMs,
                toMs: after.atMs,
                leaves: await compareDisplayedPreviewLeaves(before.leaves, after.leaves, measureMargins, compareMargins),
            });
        }
    }
    const violations = phases.flatMap(phase => comparisons.some(comparison =>
        comparison.phase === phase && comparison.leaves.some(comparisonMoved))
        ? [phase === 'settled' ? 'presentation-post-settle-movement' : 'presentation-provisional-movement'] : []);
    return {
        status: violations.length === 0 ? 'pass' : 'fail',
        comparisons,
        violations,
    };
}

export function createPreviewPresentationStabilityReport({
    firstProvisionalCommit,
    firstProvisionalComparisons,
    forcedPostSettleMovementComparisons,
    postSettleCommit,
    postSettleComparisons,
    settleCommitComparisons,
    settleCommit,
    settledLoadingCommit,
    previewHalves = /** @type {string[]} */ ([]),
    provisionalHalves = /** @type {string[]} */ ([]),
    secondProvisionalCommit,
    secondProvisionalComparisons,
}) {
    const violations = [];
    if (
        firstProvisionalCommit.action !== 'coalesce'
        || secondProvisionalCommit.action !== 'coalesce'
    ) {
        violations.push('presentation-provisional-commit');
    }
    if (settleCommit.action !== 'commit') {
        violations.push('presentation-settle-rejected');
    }
    if (settledLoadingCommit.action !== 'reject') {
        violations.push('presentation-settle-loading-commit');
    }
    if (postSettleCommit.action !== 'reject') {
        violations.push('presentation-post-settle-commit');
    }
    if ([
        ...firstProvisionalComparisons,
        ...secondProvisionalComparisons,
    ].some(comparisonMoved)) {
        violations.push('presentation-provisional-movement');
    }
    if (postSettleComparisons.some(comparisonMoved)) {
        violations.push('presentation-post-settle-movement');
    }
    const expectedHalves = new Set([
        ...provisionalHalves,
        ...previewHalves,
    ]);
    const leafSetMissingHalf = expectedHalves.size > 0 && [
        provisionalHalves,
        previewHalves,
    ].some(halves => expectedHalves.size !== new Set(halves).size);
    if (leafSetMissingHalf || [
        ...firstProvisionalComparisons,
        ...secondProvisionalComparisons,
        ...settleCommitComparisons,
        ...postSettleComparisons,
        ...forcedPostSettleMovementComparisons,
    ].some(comparison => comparison.missingBefore === true || comparison.missingAfter === true)) {
        violations.push('presentation-missing-half');
    }
    const forcedProbeRed = forcedPostSettleMovementComparisons.some(comparisonHasMovement);
    if (!forcedProbeRed) {
        violations.push('presentation-forced-probe-not-red');
    }
    return {
        provisionalCandidates: [
            {
                action: firstProvisionalCommit.action,
                leaves: firstProvisionalComparisons,
            },
            {
                action: secondProvisionalCommit.action,
                leaves: secondProvisionalComparisons,
            },
        ],
        phaseEdgeSettle: {
            action: settleCommit.action,
            leaves: settleCommitComparisons,
        },
        settledLoadingCandidate: {action: settledLoadingCommit.action},
        postSettle: {
            action: postSettleCommit.action,
            leaves: postSettleComparisons,
        },
        forcedPostSettleMovementProbe: {
            leaves: forcedPostSettleMovementComparisons,
            status: forcedProbeRed ? 'red' : 'green',
            violations: forcedProbeRed
                ? ['presentation-post-settle-movement']
                : ['presentation-forced-probe-not-red'],
        },
        violations,
    };
}
