import {EventEmitter} from 'node:events';
import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
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
    readonly close = vi.fn();
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

        expect(lines.close).toHaveBeenCalledOnce();
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
