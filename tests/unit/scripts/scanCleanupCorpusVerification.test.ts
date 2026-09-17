import {createHash} from 'node:crypto';
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    utimes,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';

interface ICargoArtifactFreshnessModule {
    assertStagedCargoArtifactFresh: (options: {
        binaryPath: string;
        buildCommand: string;
        sourcePaths: string[];
    }) => Promise<{
        binaryMtimeMs: number;
        newestSource: {
            mtimeMs: number;
            path: string;
        };
    }>;
    collectCargoSourceInputs: (metadata: unknown, rootManifestPath: string) => string[];
}

interface ICorpusVerifyModule {
    compareModeDistribution: (
        outputModes: string[],
        expectedDistribution: Record<string, number>,
    ) => {
        actual: Record<string, number>;
        expected: Record<string, number>;
        passed: boolean;
    };
    parsePdfImages: (output: string) => Array<{
        bitsPerComponent: number;
        encoding: string;
        number: number;
        page: number;
        type: string;
    }>;
    parseQpdfPageContentCounts: (output: string) => Array<{
        contentStreamCount: number;
        pageNumber: number;
    }>;
    parseConnectedComponents: (output: string) => Array<{
        area: number;
        gray: number;
        height: number;
        left: number;
        top: number;
        width: number;
    }>;
    reconcileScannerBoundaryExceptions: (
        artifacts: Array<{
            area: number;
            dpi: number;
            height: number;
            left: number;
            pdfPage: number;
            top: number;
            width: number;
        }>,
        exceptions: Array<{
            bboxMm: {
                height: number;
                left: number;
                top: number;
                width: number;
            };
            page: number;
            reason: string;
        }>,
    ) => {
        matched: unknown[];
        stale: unknown[];
        unexpected: unknown[];
    };
    resolveFixtureExpectations: (
        fixture: Record<string, unknown>,
        canonicalExpected?: Record<string, unknown>,
    ) => Record<string, unknown>;
    resolveFixtureOptions: (
        fixture: Record<string, unknown>,
    ) => Record<string, unknown>;
    resolveFixturePages: (fixture: Record<string, unknown>) => number[];
    inspectFixtureSource: (fixture: Record<string, unknown>) => Promise<{
        actualSha256: string | null;
        admissionStatus: 'admitted' | 'rejected' | 'skipped';
        error: string | null;
        expectedSha256: string | null;
        fixturePath: string;
        reason: string;
    }>;
    scannerBoundaryComponents: (
        components: Array<{
            area: number;
            gray: number;
            height: number;
            left: number;
            top: number;
            width: number;
        }>,
        width: number,
        height: number,
        dpi: number,
    ) => unknown[];
}

interface IModeMatrixFixture {
    id: string;
    options: {
        binarization: string;
        cropContent: boolean;
    };
}

interface IModeMatrixConfig {fixtures: IModeMatrixFixture[];}

const {
    assertStagedCargoArtifactFresh,
    collectCargoSourceInputs,
} = await import(
    pathToFileURL(path.join(process.cwd(), 'scripts/cargo-artifacts.mjs')).href
) as ICargoArtifactFreshnessModule;
const {
    compareModeDistribution,
    parseConnectedComponents,
    parsePdfImages,
    parseQpdfPageContentCounts,
    reconcileScannerBoundaryExceptions,
    resolveFixtureExpectations,
    resolveFixtureOptions,
    resolveFixturePages,
    inspectFixtureSource,
    scannerBoundaryComponents,
} = await import(
    pathToFileURL(path.join(process.cwd(), 'scripts/diagnostics/scan-cleanup-corpus-verify.mjs')).href
) as ICorpusVerifyModule;
const modeMatrix = JSON.parse(await readFile(
    path.join(process.cwd(), 'scripts/diagnostics/rome-mode-matrix-corpus-config.json'),
    'utf8',
)) as IModeMatrixConfig;

const tempRoots: string[] = [];

afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map(tempRoot => rm(tempRoot, {
        force: true,
        recursive: true,
    })));
});

async function createFreshnessFixture() {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-scan-cleanup-freshness-'));
    tempRoots.push(tempRoot);
    const binaryPath = path.join(tempRoot, '.tmp/scan-cleanup/bin/evb-scan-cleanup');
    const sourcePath = path.join(tempRoot, 'native/scan-cleanup/src/main.rs');
    await mkdir(path.dirname(binaryPath), {recursive: true});
    await mkdir(path.dirname(sourcePath), {recursive: true});
    await writeFile(binaryPath, 'binary');
    await writeFile(sourcePath, 'fn main() {}');
    return {
        binaryPath,
        sourcePath,
        tempRoot,
    };
}

async function createSourceFixture(contents = 'source') {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-scan-cleanup-source-'));
    tempRoots.push(tempRoot);
    const sourcePath = path.join(tempRoot, 'source.pdf');
    await writeFile(sourcePath, contents);
    return {
        sourcePath,
        tempRoot,
    };
}

describe('scan-cleanup corpus native freshness', () => {
    it('accepts a staged binary newer than every source input', async () => {
        const fixture = await createFreshnessFixture();
        const sourceTime = new Date('2026-07-24T01:00:00.000Z');
        const binaryTime = new Date('2026-07-24T01:00:02.000Z');
        await utimes(fixture.sourcePath, sourceTime, sourceTime);
        await utimes(fixture.binaryPath, binaryTime, binaryTime);

        await expect(assertStagedCargoArtifactFresh({
            binaryPath: fixture.binaryPath,
            buildCommand: 'pnpm run build:scan-cleanup',
            sourcePaths: [path.join(fixture.tempRoot, 'native/scan-cleanup')],
        })).resolves.toMatchObject({newestSource: {path: fixture.sourcePath}});
    });

    it('rejects stale staged bytes with the source and actionable restage command', async () => {
        const fixture = await createFreshnessFixture();
        const binaryTime = new Date('2026-07-24T01:00:00.000Z');
        const sourceTime = new Date('2026-07-24T01:00:02.000Z');
        await utimes(fixture.binaryPath, binaryTime, binaryTime);
        await utimes(fixture.sourcePath, sourceTime, sourceTime);

        await expect(assertStagedCargoArtifactFresh({
            binaryPath: fixture.binaryPath,
            buildCommand: 'pnpm run build:scan-cleanup',
            sourcePaths: [path.join(fixture.tempRoot, 'native/scan-cleanup')],
        })).rejects.toThrow([
            `Stale staged release binary: ${fixture.binaryPath}`,
            `Newer native source: ${fixture.sourcePath}`,
            'Run pnpm run build:scan-cleanup to rebuild and restage it.',
        ].join('\n'));
    });

    it('includes transitive local Cargo dependencies but not unrelated workspace crates', () => {
        const workspaceRoot = '/repo/native';
        const packageRecord = (name: string, dependencies: unknown[] = []) => ({
            dependencies,
            manifest_path: `${workspaceRoot}/${name}/Cargo.toml`,
        });
        const metadata = {
            packages: [
                packageRecord('scan-cleanup', [{path: `${workspaceRoot}/scan-primitives`}]),
                packageRecord('scan-primitives', [{path: `${workspaceRoot}/evb-native-support`}]),
                packageRecord('evb-native-support'),
                packageRecord('pdf-search'),
            ],
            workspace_root: workspaceRoot,
        };

        const inputs = collectCargoSourceInputs(
            metadata,
            `${workspaceRoot}/scan-cleanup/Cargo.toml`,
        );
        expect(inputs).toEqual(expect.arrayContaining([
            `${workspaceRoot}/Cargo.lock`,
            `${workspaceRoot}/Cargo.toml`,
            `${workspaceRoot}/scan-cleanup/src`,
            `${workspaceRoot}/scan-primitives/src`,
            `${workspaceRoot}/evb-native-support/src`,
        ]));
        expect(inputs).not.toContain(`${workspaceRoot}/pdf-search/src`);
    });
});

describe('scan-cleanup corpus local expectations', () => {
    it('keeps the required mode matrix cases while allowing corpus growth', () => {
        const expectedIds = [
            'headers2',
            'acceptance2',
        ].flatMap(corpus => [
            'auto',
            'otsu',
            'sauvola',
            'wolf',
        ].flatMap(method => [
            `${corpus}-${method}-crop`,
            `${corpus}-${method}-no-crop`,
        ]));
        const fixtureIds = modeMatrix.fixtures.map(fixture => fixture.id);
        expect(fixtureIds).toEqual(expect.arrayContaining([
            ...expectedIds,
            'linguae-scripts-auto-crop',
        ]));
        expect(new Set(fixtureIds)).toHaveLength(fixtureIds.length);
        expect(modeMatrix.fixtures.every(fixture => (
            [
                'auto',
                'otsu',
                'sauvola',
                'wolf',
            ].includes(fixture.options.binarization)
            && typeof fixture.options.cropContent === 'boolean'
        ))).toBe(true);
    });

    it('routes the two standing fixture overrides through the shared native resolver options', () => {
        expect(resolveFixtureOptions({
            id: 'rome-sauvola-no-crop',
            options: {
                binarization: 'sauvola',
                cropContent: false,
            },
        })).toMatchObject({
            binarization: 'sauvola',
            crop: false,
        });
    });

    it('rejects fixture knobs outside the standing mode matrix', () => {
        expect(() => resolveFixtureOptions({
            id: 'invalid-fixture',
            options: {outputMode: 'bw'},
        })).toThrow('Only binarization and cropContent');
    });

    it('expands an inclusive page range without a 392-entry local config', () => {
        expect(resolveFixturePages({
            id: 'rome-full',
            pageRange: {
                from: 1,
                to: 392,
            },
        })).toHaveLength(392);
        expect(resolveFixturePages({
            id: 'rome-selected',
            pages: [
                1,
                33,
                392,
            ],
        })).toEqual([
            1,
            33,
            392,
        ]);
    });

    it('merges config-local distribution and size over canonical fixture expectations', () => {
        expect(resolveFixtureExpectations({
            id: 'linguae-armenian',
            expectedModeDistribution: {bw: 8},
            expectedOutputBytes: 1_000_000,
            maxOutputToSourceRatio: 1.4,
        }, {
            expectedOutputBytes: 900_000,
            pages: {'1': {mode: 'bw'}},
        })).toEqual({
            expectedModeDistribution: {bw: 8},
            expectedOutputBytes: 1_000_000,
            maxOutputToSourceRatio: 1.4,
            pages: {'1': {mode: 'bw'}},
        });
    });

    it.each([
        {expectedModeDistribution: {}},
        {expectedModeDistribution: {sepia: 8}},
        {expectedModeDistribution: {bw: -1}},
        {expectedOutputBytes: 0},
        {maxOutputToSourceRatio: 0},
    ])('rejects invalid config-local expectation %#', expectation => {
        expect(() => resolveFixtureExpectations({
            id: 'invalid-fixture',
            ...expectation,
        })).toThrow('Invalid expected');
    });

    it('requires the exact output-mode distribution, including absent modes', () => {
        expect(compareModeDistribution([
            'bw',
            'bw',
            'grayscale',
        ], {
            bw: 2,
            grayscale: 1,
        })).toMatchObject({passed: true});
        expect(compareModeDistribution([
            'bw',
            'bw',
            'grayscale',
        ], {bw: 2})).toMatchObject({passed: false});
        expect(compareModeDistribution([
            'bw',
            'future-mode',
        ], {bw: 1})).toMatchObject({passed: false});
    });

    it('preserves global image numbers after layered pages', () => {
        const rows = parsePdfImages(`page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio
  45     2 image    2198  3354  rgb     3   8  jpeg   no       136  0   360   360  916K 4.2%
  45     3 stencil  2198  3354  -       1   1  jbig2  no       137  0   360   360 57.5K 6.4%
  46     4 image    2198  3354  gray    1   1  jbig2  no       140  0   360   360 68.0K 7.6%`);
        expect(rows.map(row => ({
            number: row.number,
            page: row.page,
            type: row.type,
        }))).toEqual([
            {
                number: 2,
                page: 45,
                type: 'image',
            },
            {
                number: 3,
                page: 45,
                type: 'stencil',
            },
            {
                number: 4,
                page: 46,
                type: 'image',
            },
        ]);
    });

    it('detects page content arrays that can disappear in limited PDF renderers', () => {
        expect(parseQpdfPageContentCounts(`page 1: 3 0 R
  content:
    23 0 R
page 2: 4 0 R
  content:
    31 0 R
    32 0 R
    33 0 R
`)).toEqual([
            {
                contentStreamCount: 1,
                pageNumber: 1,
            },
            {
                contentStreamCount: 3,
                pageNumber: 2,
            },
        ]);
    });

    it('rejects a page-spanning foreground component confined to the scanner boundary', () => {
        const components = parseConnectedComponents(`Objects (id: bounding-box centroid area mean-color):
  0: 2198x3355+0+0 1112.7,1688.8 7.22016e+06 gray(255)
  2: 355x1234+72+446 131.6,1015.7 130027 gray(0)
  3: 1750x828+80+1084 923.9,1478.2 408123 gray(0)`);
        expect(scannerBoundaryComponents(components, 2198, 3355, 360)).toEqual([expect.objectContaining({
            area: 130027,
            height: 1234,
            left: 72,
            width: 355,
        })]);
    });

    const scannerBoundaryExceptionArtifact = {
        area: 62_284,
        dpi: 720,
        height: 2_357,
        left: 444,
        pdfPage: 2,
        top: 679,
        width: 175,
    };
    const millimetersPerPixel = 25.4 / scannerBoundaryExceptionArtifact.dpi;
    const scannerBoundaryException = {
        bboxMm: {
            height: scannerBoundaryExceptionArtifact.height * millimetersPerPixel,
            left: scannerBoundaryExceptionArtifact.left * millimetersPerPixel,
            top: scannerBoundaryExceptionArtifact.top * millimetersPerPixel,
            width: scannerBoundaryExceptionArtifact.width * millimetersPerPixel,
        },
        page: scannerBoundaryExceptionArtifact.pdfPage,
        reason: 'legitimate boundary drawing',
    };

    it('matches a declared physical exception exactly once', () => {
        expect(reconcileScannerBoundaryExceptions(
            [scannerBoundaryExceptionArtifact],
            [scannerBoundaryException],
        )).toMatchObject({
            matched: [{artifact: scannerBoundaryExceptionArtifact}],
            stale: [],
            unexpected: [],
        });
    });

    it('reports a drifted physical exception as stale and unexpected', () => {
        const drifted = {
            ...scannerBoundaryExceptionArtifact,
            left: scannerBoundaryExceptionArtifact.left + 2,
        };
        expect(reconcileScannerBoundaryExceptions(
            [drifted],
            [scannerBoundaryException],
        )).toMatchObject({
            matched: [],
            stale: [expect.objectContaining({matchCount: 0})],
            unexpected: [drifted],
        });
    });

    it('does not let one exception hide another boundary artifact', () => {
        const other = {
            ...scannerBoundaryExceptionArtifact,
            area: 90_000,
            height: 1_400,
            left: 0,
            top: 300,
            width: 80,
        };
        expect(reconcileScannerBoundaryExceptions(
            [
                scannerBoundaryExceptionArtifact,
                other,
            ],
            [scannerBoundaryException],
        )).toMatchObject({
            matched: [{artifact: scannerBoundaryExceptionArtifact}],
            stale: [],
            unexpected: [other],
        });
    });
});

describe('scan-cleanup corpus source admission', () => {
    it('admits a pinned source and reports both checksum values', async () => {
        const fixture = await createSourceFixture();
        const expectedSha256 = createHash('sha256').update('source').digest('hex');

        await expect(inspectFixtureSource({
            id: 'nabuco-external',
            pdfPath: fixture.sourcePath,
            required: true,
            sha256: expectedSha256.toUpperCase(),
        })).resolves.toEqual({
            actualSha256: expectedSha256,
            admissionStatus: 'admitted',
            error: null,
            expectedSha256,
            fixturePath: fixture.sourcePath,
            reason: 'source checksum matches',
        });
    });

    it('rejects a checksum mismatch before a source can be converted', async () => {
        const fixture = await createSourceFixture();
        const actualSha256 = createHash('sha256').update('source').digest('hex');
        const expectedSha256 = 'a'.repeat(64);

        await expect(inspectFixtureSource({
            id: 'nabuco-external',
            pdfPath: fixture.sourcePath,
            required: true,
            sha256: expectedSha256,
        })).resolves.toMatchObject({
            actualSha256,
            admissionStatus: 'rejected',
            error: [
                `Corpus fixture SHA-256 mismatch: ${fixture.sourcePath}`,
                `Expected: ${expectedSha256}`,
                `Actual:   ${actualSha256}`,
            ].join('\n'),
            expectedSha256,
            reason: 'source checksum mismatch',
        });
    });

    it('rejects a missing required source before native freshness checks', async () => {
        const fixture = await createSourceFixture();
        await rm(fixture.sourcePath);

        await expect(inspectFixtureSource({
            id: 'nabuco-external',
            pdfPath: fixture.sourcePath,
            required: true,
            sha256: 'a'.repeat(64),
        })).resolves.toEqual({
            actualSha256: null,
            admissionStatus: 'rejected',
            error: `Required corpus fixture is absent: ${fixture.sourcePath}`,
            expectedSha256: 'a'.repeat(64),
            fixturePath: fixture.sourcePath,
            reason: 'required source is absent',
        });
    });

    it('keeps optional absent fixtures skipped and reports their expected checksum', async () => {
        const fixture = await createSourceFixture();
        await rm(fixture.sourcePath);
        const expectedSha256 = 'b'.repeat(64);

        await expect(inspectFixtureSource({
            id: 'optional-external',
            optional: true,
            pdfPath: fixture.sourcePath,
            sha256: expectedSha256,
        })).resolves.toEqual({
            actualSha256: null,
            admissionStatus: 'skipped',
            error: null,
            expectedSha256,
            fixturePath: fixture.sourcePath,
            reason: 'optional source is absent',
        });
    });

    it('rejects an invalid configured checksum', async () => {
        const fixture = await createSourceFixture();

        await expect(inspectFixtureSource({
            id: 'invalid-external',
            pdfPath: fixture.sourcePath,
            sha256: 'not-a-checksum',
        })).rejects.toThrow('Invalid SHA-256 checksum');
    });
});
