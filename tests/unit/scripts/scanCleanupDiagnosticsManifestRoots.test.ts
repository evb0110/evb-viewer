import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    isAbsolute,
    join,
    relative,
    resolve,
} from 'node:path';
import type {IScanCleanupOptions} from '@contracts/electronApiScanCleanup';
import {buildRunnableNativeScanCleanupManifest} from '@evb/scan-cleanup/core/policy/buildNativeScanCleanupManifest';
import {ScanCleanupContractError} from '@evb/scan-cleanup/core/errors';
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
// sidecar, so they are part of the runnable inventory: the directory a
// manifest is constrained to and the root the native launch is told about must
// be the same value. Both scripts take that pairing from one shared scope, so
// the scope itself is what these tests exercise.
const diagnosticsScripts = [
    'scripts/diagnostics/scan-cleanup-corpus-verify.mjs',
    'scripts/diagnostics/scan-cleanup-preview-harness.mjs',
];

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

    it.each(diagnosticsScripts)('%s takes its manifest root only from the shared scope', async path => {
        const source = await readFile(resolve(path), 'utf8');

        expect(source).toContain('createScanCleanupDiagnosticsManifestScope');
        // Geometry-only construction skips path containment entirely, so it has
        // no place in a script that hands its manifest to the native binary.
        expect(source).not.toContain('buildGeometryOnlyNativeScanCleanupManifest');
        // A local root literal is how the two sides drift apart; the scope owns
        // both the builder input and the native flag.
        expect(source).not.toContain('allowedPathRoot:');
        expect(source).not.toContain('--allowed-path-root');
    });
});
