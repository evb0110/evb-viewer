import type * as TChildProcess from 'node:child_process';
import {
    EventEmitter, on,
} from 'node:events';
import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {
    delimiter,
    isAbsolute,
    join,
} from 'node:path';
import {PassThrough} from 'node:stream';
import {decode as decodePng} from 'fast-png';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    createInterface: vi.fn(),
    spawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({spawn: mocks.spawn}));
vi.mock('node:readline', () => ({createInterface: mocks.createInterface}));

class MockCliSidecarProcess extends EventEmitter {
    readonly stdout = new PassThrough();

    readonly stderr = new PassThrough();

    readonly pid = 42_424;

    exitCode: number | null = null;

    signalCode: NodeJS.Signals | null = null;

    readonly kill = vi.fn();
}

class MockLineReader extends EventEmitter {
    readonly close = vi.fn(() => this.emit('close'));

    async *[Symbol.asyncIterator]() {
        for await (const [line] of on(this, 'line', {close: ['close']})) yield String(line);
    }
}

describe('CLI scan cleanup sidecar protocol failures', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each([
        [
            'malformed NDJSON',
            '{',
            undefined,
        ],
        [
            'schema-invalid NDJSON',
            JSON.stringify({
                version: 3,
                type: 'progress',
                progress: {},
            }),
            undefined,
        ],
        [
            'progress callback failure',
            JSON.stringify({
                version: 3,
                type: 'progress',
                progress: {
                    stage: 'page-complete',
                    completedPages: 1,
                    totalPages: 1,
                    pageNumber: requirePageNumber(1),
                    classification: 'single-uncut-page',
                    confidence: 0.9,
                },
            }),
            new Error('CLI progress consumer failed'),
        ],
    ] as const)('closes stdout and terminates the process group on %s', async (
        _label,
        line,
        progressError,
    ) => {
        const child = new MockCliSidecarProcess();
        const lines = new MockLineReader();
        const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
        mocks.spawn.mockReturnValue(child);
        mocks.createInterface.mockReturnValue(lines);
        const {runCliScanCleanupSidecar} = await import('@scripts/scanCleanupCliAdapters');
        const run = runCliScanCleanupSidecar(
            '/native/evb-scan-cleanup',
            '/scratch/manifest.json',
            new AbortController().signal,
            vi.fn(),
            () => {
                if (progressError !== undefined) throw progressError;
            },
        );

        lines.emit('line', line);

        await vi.waitFor(() => expect(lines.close).toHaveBeenCalledOnce());
        // Windows has no POSIX process groups; the adapter terminates the child itself there.
        if (process.platform === 'win32') expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        else expect(processKill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
        child.exitCode = 1;
        child.emit('exit', null, 'SIGTERM');
        if (progressError === undefined) {
            await expect(run).rejects.toBeInstanceOf(Error);
        } else {
            await expect(run).rejects.toBe(progressError);
        }
    });
});

describe('CLI scan cleanup acceptance evidence', () => {
    it('retains the final reconciled detector verdict fields', async () => {
        const {compactScanCleanupDetectionVerdicts} = await import('@scripts/scanCleanupCliAdapters');
        const splitDiagnostics = {
            analysisDpi: 150,
            deskewAngleDegrees: 0,
            deskewConfidence: 1,
            cutterSlope: 0,
            leftDeskewAngleDegrees: 0,
            rightDeskewAngleDegrees: 0,
            leftDeskewConfidence: 1,
            rightDeskewConfidence: 1,
            whitespaceX: 1075,
            foldX: 1142,
            decisionX: 1198,
            whitespaceScore: 0.98,
            bilateralScore: 1,
            leftPageScore: 1,
            rightPageScore: 1,
            leftContentScore: 1,
            rightContentScore: 1,
            leftSurfaceScore: 1,
            rightSurfaceScore: 1,
            leftInkPixels: 31_717,
            rightInkPixels: 20_784,
            outerMarginScore: 1,
            leftOuterMarginScore: 1,
            rightOuterMarginScore: 1,
            gutterScore: 1,
            agreementScore: 1,
            foldScore: 0.086,
            gutterDarknessScore: 0,
            softGutterScore: 0,
            softGutterCoverage: 0,
            softGutterContinuity: 0,
            softGutterMeanDepression: 0,
            sparseGutterScore: 1,
            sparseGutterCoverage: 1,
            sparseGutterContinuity: 1,
            sparseGutterMeanDepression: 24.64,
            aspectRatio: 1.4,
            aspectSpreadScore: 1,
            aspectSingleScore: 0,
            independentSpreadCues: 3,
            offcutBoundaryScore: 0,
            offcutEmptyScore: 0,
            offcutPopulatedScore: 0,
            offcutWidthScore: 0,
            offcutNoTextRowsScore: 0,
            alternativeProduct: 0,
            evidenceProduct: 0.699,
            whitespaceGatePassed: true,
            centralPositionGatePassed: true,
            bilateralGatePassed: true,
            outerMarginGatePassed: true,
            gutterGatePassed: true,
            independentGutterGatePassed: true,
            aspectSupportGatePassed: true,
            evidenceAgreementGatePassed: true,
            outerMarginRecovery: false,
            outerMarginWeakEdge: null,
            sparseSpreadRecovered: true,
            abstained: false,
            foldBand: {
                status: 'measured' as const,
                leftXPx: 1188,
                rightXPx: 1215,
            },
        };
        const results = compactScanCleanupDetectionVerdicts([{
            pageNumber: requirePageNumber(1),
            classification: 'two-page-spread',
            confidence: 0.71,
            cutterXPx: 1203,
            tier1Verdict: 'single-uncut-page',
            reconciled: true,
            clusterAgreement: 0.94,
            documentPrior: {
                dominantLayout: 'two-page-spread',
                cutterRatioMedian: 0.544,
                clusterDims: {
                    widthPx: 2200,
                    heightPx: 1573,
                },
                agreementStrength: 0.94,
            },
            splitDiagnostics,
        }]);
        expect(results).toEqual([{
            pageNumber: requirePageNumber(1),
            classification: 'two-page-spread',
            confidence: 0.71,
            cutterXPx: 1203,
            tier1Verdict: 'single-uncut-page',
            reconciled: true,
            clusterAgreement: 0.94,
            documentPrior: {
                dominantLayout: 'two-page-spread',
                cutterRatioMedian: 0.544,
                clusterDims: {
                    widthPx: 2200,
                    heightPx: 1573,
                },
                agreementStrength: 0.94,
            },
            splitDiagnostics,
        }]);
    });

    it('extracts only raw bilevel planes from compact page specs', async () => {
        const {compactScanCleanupBilevelMaskPath} = await import('@scripts/scanCleanupCliAdapters');
        expect(compactScanCleanupBilevelMaskPath('image-bilevel\t72\t144\t/tmp/page.pbm')).toBe('/tmp/page.pbm');
        expect(compactScanCleanupBilevelMaskPath('layered-jpeg\t72\t144\t85\t/tmp/bg.ppm\t/tmp/mask.pbm')).toBe('/tmp/mask.pbm');
        expect(compactScanCleanupBilevelMaskPath('image-jpeg\t72\t144\t85\t/tmp/page.ppm')).toBeUndefined();
    });

    it('snapshots only requested PBMs and maps them to final pages', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'scan-cleanup-evidence-test-'));
        try {
            const first = join(directory, 'first.pbm');
            const second = join(directory, 'second.pbm');
            const manifest = join(directory, 'combine.json');
            const evidenceDirectory = join(directory, 'evidence');
            await Promise.all([
                writeFile(first, Buffer.from('P4\n8 1\n\x80', 'binary')),
                writeFile(second, Buffer.from('P4\n8 1\n\x40', 'binary')),
                writeFile(manifest, JSON.stringify({pages: [
                    `image-bilevel\t72\t144\t${first}`,
                    `image-bilevel\t72\t144\t${second}`,
                ]})),
            ]);
            const {
                buildCliRawMaskEvidenceManifest,
                snapshotCliDiagnosticMasks,
            } = await import('@scripts/scanCleanupCliAdapters');
            const evidence = await snapshotCliDiagnosticMasks(manifest, [2], evidenceDirectory);
            expect(evidence).toEqual([{
                outputOrdinal: 2,
                relativePath: 'raw-masks/output-0002.pbm',
            }]);
            expect(await readFile(join(evidenceDirectory, evidence[0]!.relativePath), 'binary')).toBe('P4\n8 1\n\x40');
            expect(buildCliRawMaskEvidenceManifest('/output.pdf', evidence, [{
                outputOrdinal: 2,
                outputPageNumber: 7,
                sourcePageNumber: 4,
                half: 'right',
            }])).toEqual({
                schemaVersion: 1,
                outputPdf: '/output.pdf',
                pages: [{
                    outputPage: 7,
                    sourcePage: 4,
                    half: 'right',
                    rawMaskPath: 'raw-masks/output-0002.pbm',
                }],
            });
        } finally {
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    });
});

/** Two pixels on a white page; the mask gives the left pixel ink and the right pixel paper. */
const HARD_MASK_INK_THEN_PAPER = Buffer.concat([
    Buffer.from('P4\n2 1\n', 'ascii'),
    Buffer.from([0x80]),
]);
/** Opacity samples: the left pixel is opaque (255) and the right pixel is clear. */
const SOFT_ALPHA_OPAQUE_THEN_CLEAR = Buffer.concat([
    Buffer.from('P5\n2 1\n255\n', 'ascii'),
    Buffer.from([
        255,
        0,
    ]),
]);

const layeredMaskMagick = process.env.EVB_SCAN_CLEANUP_MAGICK_PATH ?? 'magick';
const layeredMaskMagickAvailable = isAbsolute(layeredMaskMagick)
    ? existsSync(layeredMaskMagick)
    : (process.env.PATH ?? '').split(delimiter).some(directory => existsSync(join(directory, layeredMaskMagick)));

describe.skipIf(!layeredMaskMagickAvailable)('CLI layered-mask fallback polarity', () => {
    beforeEach(async () => {
        // The file mocks node:child_process for the sidecar protocol. These cases
        // spawn the real ImageMagick that the fallback runs.
        const actual = await vi.importActual<typeof TChildProcess>('node:child_process');
        mocks.spawn.mockImplementation(actual.spawn);
    });

    /**
     * Flattens a two-pixel page through the fallback and returns the red channel
     * of the left and right pixels. Ink on the left is black (0) when it is
     * composited opaque over the white background, and paper on the right is white (255).
     */
    async function flattenTwoPixelPage(
        mask: Buffer,
        manifestLine: (paths: {
            background: string;
            foreground: string;
            mask: string
        }) => string[],
    ) {
        const directory = await mkdtemp(join(tmpdir(), 'layered-mask-fallback-'));
        try {
            const background = join(directory, 'background.ppm');
            const foreground = join(directory, 'foreground.ppm');
            const maskPath = join(directory, 'mask.netpbm');
            await Promise.all([
                writeFile(background, Buffer.concat([
                    Buffer.from('P6\n2 1\n255\n', 'ascii'),
                    Buffer.alloc(6, 255),
                ])),
                writeFile(foreground, Buffer.concat([
                    Buffer.from('P6\n2 1\n255\n', 'ascii'),
                    Buffer.alloc(6, 0),
                ])),
                writeFile(maskPath, mask),
            ]);
            const {flattenLayeredManifestPage} = await import('@scripts/flattenLayeredManifestPage');
            const flattenedPath = await flattenLayeredManifestPage(
                manifestLine({
                    background,
                    foreground,
                    mask: maskPath,
                }),
                directory,
                layeredMaskMagick,
                {},
            );
            const decoded = decodePng(await readFile(flattenedPath));
            // ImageMagick writes a two-colour result as a 1-bit palette PNG; the
            // single-colour fallback is a 1-bit gray PNG, and the colored one is 8-bit.
            const sample = (index: number) => {
                if (decoded.depth !== 1) return decoded.data[index * decoded.channels]!;
                const bit = (decoded.data[index >> 3]! >> (7 - (index & 7))) & 1;
                return decoded.palette ? decoded.palette[bit]![0]! : bit * 255;
            };
            return [
                sample(0),
                sample(1),
            ];
        } finally {
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    }

    it('keeps hard stencil ink opaque in the layered-jpeg fallback', async () => {
        expect(await flattenTwoPixelPage(HARD_MASK_INK_THEN_PAPER, ({
            background, mask,
        }) => [
            'layered-jpeg',
            '72',
            '144',
            '85',
            background,
            mask,
        ])).toEqual([
            0,
            255,
        ]);
    });

    it('keeps hard stencil ink opaque over a colored layered-color-jpeg foreground', async () => {
        expect(await flattenTwoPixelPage(HARD_MASK_INK_THEN_PAPER, ({
            background, mask,
        }) => [
            'layered-color-jpeg',
            '72',
            '144',
            '85',
            background,
            mask,
            '128',
            '16',
            '16',
        ])).toEqual([
            128,
            255,
        ]);
    });

    it('keeps soft alpha opacity as written in the soft-layered-jpeg fallback', async () => {
        expect(await flattenTwoPixelPage(SOFT_ALPHA_OPAQUE_THEN_CLEAR, ({
            background, mask,
        }) => [
            'soft-layered-jpeg',
            '72',
            '144',
            '85',
            background,
            mask,
        ])).toEqual([
            0,
            255,
        ]);
    });

    it('keeps affine masks with no decode field as written in the fallback', async () => {
        expect(await flattenTwoPixelPage(SOFT_ALPHA_OPAQUE_THEN_CLEAR, ({
            background, foreground, mask,
        }) => [
            'affine-masked-layered-jpeg',
            '72',
            '144',
            '85',
            background,
            foreground,
            mask,
            '72',
            '0',
            '0',
            '144',
            '0',
            '0',
        ])).toEqual([
            0,
            255,
        ]);
    });

    it('inverts affine masks that declare an inverted decode in the fallback', async () => {
        expect(await flattenTwoPixelPage(SOFT_ALPHA_OPAQUE_THEN_CLEAR, ({
            background, foreground, mask,
        }) => [
            'affine-masked-layered-jpeg',
            '72',
            '144',
            '85',
            background,
            foreground,
            mask,
            '72',
            '0',
            '0',
            '144',
            '0',
            '0',
            'inverted',
        ])).toEqual([
            255,
            0,
        ]);
    });
});
