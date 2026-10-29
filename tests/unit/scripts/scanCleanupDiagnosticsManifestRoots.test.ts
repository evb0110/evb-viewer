import {spawnSync} from 'node:child_process';
import {
    PDFDocument, rgb,
} from 'pdf-lib';
import {
    readFile, readdir,
    mkdir,
    mkdtemp,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    isAbsolute,
    join,
    relative,
} from 'node:path';
import type {IScanCleanupOptions} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {buildRunnableNativeScanCleanupManifest} from '@evb/scan-cleanup/core/policy/buildNativeScanCleanupManifest';
import {ScanCleanupContractError} from '@evb/scan-cleanup/core/errors';
import * as corpusVerifier from '@scripts/diagnostics/scan-cleanup-corpus-verify.mjs';
import {createScanCleanupDiagnosticsManifestScope} from '@scripts/diagnostics/scan-cleanup-diagnostics-manifest.mjs';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';

const options: IScanCleanupOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'auto',
    thickness: 0,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'top-center',
    marginsMm: {
        leftMm: 5,
        topMm: 5,
        rightMm: 5,
        bottomMm: 5,
    },
    despeckle: true,
    readingOrder: 'ltr',
    skipBlankPages: false,
    pageOverrides: {},
};

// The diagnostics harnesses build product manifests and launch the real
// sidecar: the directory a manifest is constrained to and the root the native
// launch is told about must be the same value, so both take that pairing from
// one shared scope, which is what these tests exercise.
describe('scan cleanup diagnostics manifest scope', () => {
    let temporaryDirectory = '';
    let scopedRoot = '';
    let otherRoot = '';

    const manifestInput = (inputPath: string, outputDirectory: string) => ({
        operation: 'render' as const,
        renderMode: 'preview' as const,
        canvasScope: 'page' as const,
        qualityPath: 'raster' as const,
        options,
        pages: [{
            inputPath,
            pageNumber: 1,
            dpi: 300,
            pageMetadataPath: join(outputDirectory, 'page-1.json'),
            outputs: [{
                outputPath: join(outputDirectory, 'page-1.png'),
                metadataPath: join(outputDirectory, 'page-1-output.json'),
            }],
        }],
    });

    beforeAll(async () => {
        temporaryDirectory = await mkdtemp(join(tmpdir(), 'scan-cleanup-diagnostics-scope-'));
        scopedRoot = join(temporaryDirectory, 'scoped');
        otherRoot = join(temporaryDirectory, 'other');
        await mkdir(scopedRoot);
        await mkdir(otherRoot);
        await writeFile(join(scopedRoot, 'input.png'), 'input');
        await writeFile(join(otherRoot, 'input.png'), 'outside input');
        await symlink(join(otherRoot, 'input.png'), join(scopedRoot, 'escape-link.png'));
    });

    afterAll(async () => {
        if (temporaryDirectory === '') {
            return;
        }
        await rm(temporaryDirectory, {
            recursive: true,
            force: true,
        });
    });

    it('constrains every manifest it builds to the root its sidecar argv names', () => {
        const scope = createScanCleanupDiagnosticsManifestScope(
            scopedRoot,
            buildRunnableNativeScanCleanupManifest,
        );
        const manifestPath = join(scopedRoot, 'manifest.json');

        expect(() => scope.buildManifest(manifestInput(join(scopedRoot, 'input.png'), scopedRoot)))
            .not.toThrow();
        expect(scope.sidecarArgv(manifestPath)).toEqual([
            '--manifest',
            manifestPath,
            '--allowed-path-root',
            scopedRoot,
        ]);

        // The argv root is the same value the manifest was judged against: a
        // path this root rejects cannot reach a launch that claims this root.
        const argvRoot = scope.sidecarArgv(manifestPath).at(-1);
        expect(argvRoot).toBe(scope.allowedPathRoot);
        expect(() => scope.buildManifest(manifestInput(join(otherRoot, 'input.png'), scopedRoot)))
            .toThrow(ScanCleanupContractError);
        expect(() => scope.buildManifest(manifestInput(join(scopedRoot, 'escape-link.png'), scopedRoot)))
            .toThrow(ScanCleanupContractError);
        expect(() => scope.buildManifest(manifestInput(join(scopedRoot, 'input.png'), otherRoot)))
            .toThrow(ScanCleanupContractError);
    });

    it('keeps two scopes independent so one harness root cannot serve another', () => {
        const scope = createScanCleanupDiagnosticsManifestScope(
            scopedRoot,
            buildRunnableNativeScanCleanupManifest,
        );
        const otherScope = createScanCleanupDiagnosticsManifestScope(
            otherRoot,
            buildRunnableNativeScanCleanupManifest,
        );

        expect(otherScope.sidecarArgv(join(otherRoot, 'manifest.json')).at(-1)).toBe(otherRoot);
        expect(() => otherScope.buildManifest(manifestInput(join(otherRoot, 'input.png'), otherRoot)))
            .not.toThrow();
        expect(() => scope.buildManifest(manifestInput(join(otherRoot, 'input.png'), otherRoot)))
            .toThrow(ScanCleanupContractError);
    });

    it('resolves a relative root once so the builder and the launch name one directory', () => {
        const relativeRoot = relative(process.cwd(), scopedRoot);
        expect(isAbsolute(relativeRoot)).toBe(false);
        const scope = createScanCleanupDiagnosticsManifestScope(
            relativeRoot,
            buildRunnableNativeScanCleanupManifest,
        );
        const manifestPath = join(scopedRoot, 'manifest.json');

        // One absolute value the scope owns: containment and the native flag
        // cannot read the same relative spelling from different directories.
        expect(scope.allowedPathRoot).toBe(scopedRoot);
        expect(scope.sidecarArgv(manifestPath).at(-1)).toBe(scope.allowedPathRoot);
        expect(() => scope.buildManifest(manifestInput(join(scopedRoot, 'input.png'), scopedRoot)))
            .not.toThrow();
        expect(() => scope.buildManifest(manifestInput(join(otherRoot, 'input.png'), otherRoot)))
            .toThrow(ScanCleanupContractError);
    });

    it('rejects a caller that tries to supply its own root or an unusable scope', () => {
        const scope = createScanCleanupDiagnosticsManifestScope(
            scopedRoot,
            buildRunnableNativeScanCleanupManifest,
        );

        expect(() => scope.buildManifest({
            ...manifestInput(join(scopedRoot, 'input.png'), scopedRoot),
            allowedPathRoot: otherRoot,
        })).toThrow(/must not carry its own allowed path root/u);
        expect(() => scope.sidecarArgv('')).toThrow(/requires a manifest path/u);
        expect(() => createScanCleanupDiagnosticsManifestScope('', buildRunnableNativeScanCleanupManifest))
            .toThrow(/requires an allowed path root/u);
        expect(() => createScanCleanupDiagnosticsManifestScope(scopedRoot, undefined))
            .toThrow(/requires the runnable manifest builder/u);
    });
});


describe('corpus verifier staged native paths', () => {
    it('uses the builder Windows target tag for every executable', () => {
        const paths = corpusVerifier.resolveCorpusNativeBinaryPaths('/repo', {
            platform: 'win32',
            arch: 'x64',
        });
        expect(paths).toEqual({
            scanCleanup: join('/repo', '.tmp/scan-cleanup/win32-x64/bin/evb-scan-cleanup.exe'),
            combine: join('/repo', '.tmp/pdf-image-combine/win32-x64/bin/evb-pdf-image-combine.exe'),
            pageOps: join('/repo', '.tmp/pdf-page-ops/win32-x64/bin/evb-pdf-page-ops.exe'),
        });
        expect(Object.values(paths).some(path => path.includes('/win-x64/'))).toBe(false);
    });
});


const photoPython = process.env.PYTHON ?? 'python3';
const photoPrerequisites = spawnSync(photoPython, [
    '-c',
    'import numpy, PIL; import shutil; assert shutil.which("pdftoppm")',
], {encoding: 'utf8'});
const photoSkipReason = photoPrerequisites.status === 0 ? '' : 'requires Python numpy/Pillow and pdftoppm';
if (process.env.EVB_REQUIRE_SCAN_CLEANUP_NATIVE_TESTS === '1' && photoSkipReason) {
    throw new Error(`Rendered photo metrics: ${photoSkipReason}: ${photoPrerequisites.stderr}`);
}
it.skipIf(Boolean(photoSkipReason))(`retains two photo measurements and distinct crops on one page${photoSkipReason ? ` (skipped: ${photoSkipReason})` : ''}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'rendered-photos-'));
    try {
        const pdf = await PDFDocument.create();
        const page = pdf.addPage([
            100,
            100,
        ]);
        page.drawRectangle({
            x: 10,
            y: 10,
            width: 30,
            height: 60,
            color: rgb(0.2, 0.2, 0.2),
        });
        const source = join(root, 'source.pdf');
        await writeFile(source, await pdf.save());
        const summary = join(root, 'geometry.json');
        await writeFile(summary, JSON.stringify({perPageStreamSizes: [{
            sourcePageNumber: 1,
            outputPageNumber: 1,
            renderGeometry: {
                dewarped: false,
                forwardTransform: {matrix: [
                    [
                        1,
                        0,
                        0,
                    ],
                    [
                        0,
                        1,
                        0,
                    ],
                    [
                        0,
                        0,
                        1,
                    ],
                ]},
                inputWidthPx: 100,
                inputHeightPx: 100,
                canvasWidthPx: 100,
                canvasHeightPx: 100,
                outputWidthPx: 100,
                outputHeightPx: 100,
                placementOffsetXPx: 0,
                placementOffsetYPx: 0,
            },
        }]}));
        const boxes = join(root, 'boxes.csv');
        await writeFile(boxes, 'page,bbox\n1,"10,10,40,40"\n1,"50,10,80,40"\n');
        const csv = join(root, 'metrics.csv');
        const crops = join(root, 'crops');
        const result = spawnSync(photoPython, [
            'scripts/diagnostics/scan-cleanup-rendered-metrics.py',
            'photos',
            '--source',
            source,
            '--output',
            source,
            '--output-summary',
            summary,
            '--boxes',
            boxes,
            '--csv',
            csv,
            '--crops',
            crops,
            '--render-dpi',
            '72',
            '--box-dpi',
            '72',
        ],
        {
            encoding: 'utf8',
            env: {
                ...process.env,
                PYTHONDONTWRITEBYTECODE: '1',
            },
        });
        expect(result.status, result.stderr).toBe(0);
        const rows = (await readFile(csv, 'utf8')).trim().split('\n');
        expect(rows).toHaveLength(3);
        expect(rows[1]).toContain('10,10,40,40');
        expect(rows[2]).toContain('50,10,80,40');
        const images = await readdir(crops);
        expect(images).toHaveLength(2);
        expect(await readFile(join(crops, images[0]!))).not.toEqual(await readFile(join(crops, images[1]!)));
    } finally {
        await rm(root, {
            force: true,
            recursive: true,
        });
    }
});
