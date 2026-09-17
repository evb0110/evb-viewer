import { spawnSync } from 'node:child_process';
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCliErrorMessage } from '../lib/cli-error.mjs';

// A packaged sidecar that is merely stale reports the same identity as a fresh
// one: the batch manifest stays v3 across schema-additive protocol changes,
// while the runtime `--protocol-version` advances as strict parser fields are
// added, and the crate version is not bumped per change. A same-version stale
// binary can therefore still evade version probes. This smoke runs the
// packaged binary on a synthesized spread and reads the fields back out of the
// metadata it writes.
//
// Marker: `foldClipRightPx` on the left leaf and `foldClipLeftPx` on the right.
// They are the fold-edge source-window clip the final materialization applies,
// they are serialized only by builds that carry the current render metadata
// struct, and they are omitted when zero — so asserting them positive requires
// the emitting build to have both the field and the code path that fills it.
const SPREAD_WIDTH_PX = 400;
const SPREAD_HEIGHT_PX = 120;
const PAPER_LEVEL = 240;
const INK_LEVEL = 20;

// A P6 raster is written rather than committed so the input stays reviewable
// as source: two inked leaves with a white fold tail on each side of the cut.
/** @param {string} path */
function writeSyntheticSpread(path) {
    const pixels = Buffer.alloc(SPREAD_WIDTH_PX * SPREAD_HEIGHT_PX * 3, PAPER_LEVEL);
    /** @param {number} startX @param {number} endX */
    function inkLeaf(startX, endX) {
        for (let line = 0; line < 4; line += 1) {
            const topY = 12 + line * 24;
            for (let y = topY; y < topY + 8; y += 1) {
                for (let x = startX; x < endX; x += 1) {
                    if ((x + line * 3) % 9 >= 6) {
                        continue;
                    }
                    const offset = (y * SPREAD_WIDTH_PX + x) * 3;
                    pixels[offset] = INK_LEVEL;
                    pixels[offset + 1] = INK_LEVEL;
                    pixels[offset + 2] = INK_LEVEL;
                }
            }
        }
    }
    inkLeaf(20, 156);
    inkLeaf(244, 380);
    const header = Buffer.from(`P6\n${SPREAD_WIDTH_PX} ${SPREAD_HEIGHT_PX}\n255\n`);
    writeFileSync(path, Buffer.concat([
        header,
        pixels,
    ]));
}

// Every layout decision is dictated rather than detected: the cut, both content
// boxes, and the margins are given, so the smoke measures serialization and not
// the tuning of the spread heuristics. The margins are what shrink the canvas
// below the placed leaf, which is the condition the fold-tail clip answers to.
/** @param {string} workDir @param {string} inputPath */
function buildManifest(workDir, inputPath) {
    const fullBox = {
        xNormalized: 0,
        yNormalized: 0,
        widthNormalized: 1,
        heightNormalized: 1,
        rotationDegrees: 0,
    };
    return {
        version: 3,
        operation: 'render',
        renderMode: 'final',
        canvasScope: 'document',
        documentCanvas: {
            widthPoints: 306,
            heightPoints: 396,
            widthPx: 425,
            heightPx: 550,
        },
        pages: [{
            inputPath,
            sourcePageIndex: 0,
            pageMetadataPath: join(workDir, 'page.json'),
            options: {
                dpi: 100,
                layout: 'force-two-page',
                despeckle: true,
                manualSplit: {
                    xNormalized: 0.5,
                    rotationDegrees: 0,
                },
                matchPageSize: true,
                cropContent: true,
                pageAlignment: 'top-center',
                manualContentBoxes: {
                    left: fullBox,
                    right: fullBox,
                },
                margins: {
                    leftMm: 20,
                    topMm: 5,
                    rightMm: 20,
                    bottomMm: 5,
                },
                outputMode: 'bw',
            },
            outputs: [
                {
                    outputPath: join(workDir, 'left.png'),
                    metadataPath: join(workDir, 'left.json'),
                },
                {
                    outputPath: join(workDir, 'right.png'),
                    metadataPath: join(workDir, 'right.json'),
                },
            ],
        }],
    };
}

/** @param {string} metadataPath @param {string} field */
function assertPositiveFoldClip(metadataPath, field) {
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    const value = metadata[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error(
            `Packaged evb-scan-cleanup emitted no positive ${field} for the fold-clipped spread `
            + `(got ${JSON.stringify(value)}). The packaged sidecar predates the fold-clip `
            + 'protocol fields, or no longer emits them; rebuild the packaged native tools.',
        );
    }
}

/** @returns {void} */
function main() {
    const [toolPath] = process.argv.slice(2);
    if (!toolPath) {
        throw new Error(
            'Usage: node scripts/release/assert-packaged-scan-cleanup-fold-clip.mjs <tool-path>',
        );
    }

    const workDir = mkdtempSync(join(tmpdir(), 'evb-scan-cleanup-smoke-'));
    try {
        const inputPath = join(workDir, 'spread.ppm');
        writeSyntheticSpread(inputPath);
        const manifestPath = join(workDir, 'manifest.json');
        writeFileSync(manifestPath, JSON.stringify(buildManifest(workDir, inputPath)));

        const run = spawnSync(toolPath, [
            '--manifest',
            manifestPath,
        ], {
            encoding: 'utf8',
            timeout: 120_000,
        });
        if (run.error) {
            throw new Error(`Packaged evb-scan-cleanup could not be executed: ${run.error.message}`);
        }
        if (run.status !== 0) {
            throw new Error(
                `Packaged evb-scan-cleanup exited ${run.status} on the fold-clip smoke manifest:\n`
                + `${run.stdout ?? ''}${run.stderr ?? ''}`,
            );
        }
        if (!(run.stdout ?? '').includes('"status":"success"')) {
            throw new Error(
                `Packaged evb-scan-cleanup reported no success envelope:\n${run.stdout ?? ''}`,
            );
        }

        assertPositiveFoldClip(join(workDir, 'left.json'), 'foldClipRightPx');
        assertPositiveFoldClip(join(workDir, 'right.json'), 'foldClipLeftPx');
    } finally {
        rmSync(workDir, {
            recursive: true,
            force: true,
        });
    }
}

try {
    main();
} catch (error) {
    process.stderr.write(`${getCliErrorMessage(error)}\n`);
    process.exit(1);
}
