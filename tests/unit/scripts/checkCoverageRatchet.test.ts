import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    mkdir,
    mkdtemp,
    readFile,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createTemporaryDirectoryRegistry} from '@tests/helpers/createTemporaryDirectoryRegistry';
import {
    compareCoverageToBaseline,
    createCoverageBaseline,
    DEFAULT_COVERAGE_AREAS,
    LOAD_BEARING_COVERAGE_FILES,
    LOAD_BEARING_COVERAGE_GROUPS,
    parseCoverageSummary,
    runCoverageRatchet,
} from '@scripts/checkCoverageRatchet';

const temporaryDirectories = createTemporaryDirectoryRegistry();

afterEach(() => temporaryDirectories.cleanup());

function metricSummary(pct: number) {
    return Object.fromEntries([
        'statements',
        'branches',
        'functions',
        'lines',
    ].map(metric => [
        metric,
        {
            covered: pct,
            pct,
            skipped: 0,
            total: 100,
        },
    ]));
}

const SCAN_CLEANUP_PREVIEW_SUCCESSOR_FILES = [
    'electron/features/scan-cleanup/createScanCleanupRasterBatchRenderer.ts',
    'electron/features/scan-cleanup/createScanCleanupService.ts',
    'electron/features/scan-cleanup/resolveScanCleanupRasterPageSizeStore.ts',
    'electron/features/scan-cleanup/scanCleanupDetectionLifecycle.ts',
    'electron/features/scan-cleanup/scanCleanupPreviewCompositionDefaults.ts',
    'electron/features/scan-cleanup/scanCleanupPreviewLifecycle.ts',
    'electron/features/scan-cleanup/scanCleanupPreviewPolicy.ts',
    'electron/features/scan-cleanup/scanCleanupPreviewRenderer.ts',
    'electron/features/scan-cleanup/scanCleanupPreviewRenderingOwner.ts',
    'electron/features/scan-cleanup/scanCleanupPreviewRenderingPipeline.ts',
    'electron/features/scan-cleanup/scanCleanupPreviewShared.ts',
    'electron/features/scan-cleanup/scanCleanupPreviewSupport.ts',
    'electron/features/scan-cleanup/scanCleanupRasterMeasurement.ts',
    'electron/features/scan-cleanup/scanCleanupRasterRetention.ts',
    'electron/features/scan-cleanup/scanCleanupRasterRetentionIo.ts',
] as const;

function summary(totalPct: number, filePct = totalPct, projectRoot = '/repo') {
    return JSON.stringify({
        total: metricSummary(totalPct),
        ...Object.fromEntries(LOAD_BEARING_COVERAGE_FILES.map(filePath => [
            `${projectRoot}/${filePath}`,
            metricSummary(filePct),
        ])),
        ...Object.fromEntries(SCAN_CLEANUP_PREVIEW_SUCCESSOR_FILES.map(filePath => [
            `${projectRoot}/${filePath}`,
            metricSummary(filePct),
        ])),
        [`${projectRoot}/app/runtime.ts`]: metricSummary(filePct),
        [`${projectRoot}/electron/main.ts`]: metricSummary(filePct),
        [`${projectRoot}/electron/features/djvu/open.ts`]: metricSummary(filePct),
        [`${projectRoot}/electron/ocr/recognize.ts`]: metricSummary(filePct),
        [`${projectRoot}/app/modules/pdf-viewer/viewer.ts`]: metricSummary(filePct),
        [`${projectRoot}/app/modules/workspace-shell/workspace.ts`]: metricSummary(filePct),
        [`${projectRoot}/packages/scan-cleanup/adapters/renderers.ts`]: metricSummary(filePct),
        [`${projectRoot}/packages/scan-cleanup/core/detection.ts`]: metricSummary(filePct),
        [`${projectRoot}/scripts/release/build.ts`]: metricSummary(filePct),
    });
}

function compensateElectronArea(snapshot: ReturnType<typeof parseCoverageSummary>) {
    for (const filePath of [
        'electron/main.ts',
        'electron/features/djvu/open.ts',
        'electron/ocr/recognize.ts',
    ]) {
        const file = snapshot.files.find(candidate => candidate.filePath === filePath)!;
        file.metrics.lines = {
            covered: 100,
            pct: 100,
            total: 100,
        };
    }
}

function isolateElectronAreaGate(baseline: ReturnType<typeof createCoverageBaseline>) {
    // These synthetic cases exercise only successor-group arithmetic. Keep the
    // unrelated electron-core area comparator neutral while perturbing one group member.
    const electronCore = baseline.areas['electron-core'];
    if (electronCore === undefined) {
        throw new Error('Synthetic baseline is missing the electron-core area.');
    }
    electronCore.metrics.lines = 0;
}

async function createTemporaryProject() {
    const projectRoot = temporaryDirectories.register(
        await mkdtemp(path.join(tmpdir(), 'evb-coverage-ratchet-')),
    );
    await Promise.all([
        'app/.nuxt',
        'coverage',
        'electron',
        'electron/features/scan-cleanup',
        'packages/scan-cleanup/adapters',
        'packages/scan-cleanup/core',
        'scripts/release',
    ].map(directory => mkdir(path.join(projectRoot, directory), {recursive: true})));
    await Promise.all(SCAN_CLEANUP_PREVIEW_SUCCESSOR_FILES.map(filePath => writeFile(
        path.join(projectRoot, filePath),
        'export const successor = true;\n',
        'utf8',
    )));
    return projectRoot;
}

describe('coverage ratchet', () => {
    it('detects broad regressions beyond the configured tolerance', () => {
        const baseline = createCoverageBaseline(parseCoverageSummary(summary(70), '/repo'));
        const result = compareCoverageToBaseline(
            parseCoverageSummary(summary(69.49), '/repo'),
            baseline,
        );

        expect(result.passed).toBe(false);
        expect(result.failures).toContain('total lines regressed by 0.51 percentage points');
    });

    it('rejects malformed coverage reports at each metric boundary', () => {
        expect(() => parseCoverageSummary('null')).toThrow('Coverage summary must be an object.');
        expect(() => parseCoverageSummary('{"total":null}')).toThrow(
            'Coverage summary total must be an object.',
        );
        expect(() => parseCoverageSummary('{"total":{"statements":null}}')).toThrow(
            'Coverage summary total.statements must be an object.',
        );
        expect(() => parseCoverageSummary(JSON.stringify({total: {
            ...metricSummary(70),
            statements: {
                ...metricSummary(70).statements,
                covered: 'invalid',
            },
        }}))).toThrow('Coverage summary total.statements.covered must be a finite number.');
    });

    it('detects a per-area regression even when total coverage is stable', () => {
        const baseline = createCoverageBaseline(parseCoverageSummary(summary(70, 80), '/repo'));
        const snapshot = parseCoverageSummary(summary(70, 79), '/repo');
        const result = compareCoverageToBaseline(snapshot, baseline);

        expect(result.passed).toBe(false);
        expect(result.failures).toContain('electron-core lines regressed by 1.00 percentage points');
    });

    it('tracks major application and release areas', () => {
        expect(DEFAULT_COVERAGE_AREAS).toMatchObject({
            'app-core': {include: ['app/']},
            'electron-core': {include: ['electron/']},
            'pdf-viewer': {include: ['app/modules/pdf-viewer/']},
            'release-scripts': {include: ['scripts/release/']},
            'scan-cleanup-adapters': {include: ['packages/scan-cleanup/adapters/']},
            'scan-cleanup-core': {include: ['packages/scan-cleanup/core/']},
            'scripts-core': {include: ['scripts/']},
            'workspace-shell': {include: ['app/modules/workspace-shell/']},
        });
    });

    it('keeps the complete scan-cleanup successor group explicit and weighted', () => {
        expect(LOAD_BEARING_COVERAGE_GROUPS['scan-cleanup-preview-successors']).toEqual({
            files: [...SCAN_CLEANUP_PREVIEW_SUCCESSOR_FILES],
            lines: 88.77,
        });

        const baseline = createCoverageBaseline(parseCoverageSummary(summary(90, 90), '/repo'));
        const result = compareCoverageToBaseline(
            parseCoverageSummary(summary(90, 90), '/repo'),
            baseline,
        );

        expect(result.passed).toBe(true);
        expect(result.comparisons).toContain(
            'scan-cleanup-preview-successors lines: 90.0000% (+1.23 pp; baseline 88.77%; tolerance 0.50 pp)',
        );
    });

    it('rejects a successor missing from the coverage report or source tree', () => {
        const baselineSnapshot = parseCoverageSummary(summary(90, 90), '/repo');
        const baseline = createCoverageBaseline(baselineSnapshot);
        const missingPath = 'electron/features/scan-cleanup/scanCleanupPreviewRenderingPipeline.ts';
        const snapshot = parseCoverageSummary(summary(90, 90), '/repo');
        snapshot.files = snapshot.files.filter(file => file.filePath !== missingPath);

        const missingReport = compareCoverageToBaseline(snapshot, baseline);
        expect(missingReport.passed).toBe(false);
        expect(missingReport.failures).toContain(
            `scan-cleanup-preview-successors is missing coverage members: ${missingPath}`,
        );

        const missingSource = compareCoverageToBaseline(
            baselineSnapshot,
            baseline,
            baselineSnapshot.files
                .map(file => file.filePath)
                .filter(filePath => filePath !== missingPath),
        );
        expect(missingSource.passed).toBe(false);
        expect(missingSource.failures).toContain(
            `scan-cleanup-preview-successors is missing source members on disk: ${missingPath}`,
        );
    });

    it('rejects a non-renderer successor regression instead of selecting a passing subset', () => {
        const baseline = createCoverageBaseline(parseCoverageSummary(summary(90, 90), '/repo'));
        const snapshot = parseCoverageSummary(summary(90, 90), '/repo');
        const pipeline = snapshot.files.find(file => file.filePath.endsWith(
            'scanCleanupPreviewRenderingPipeline.ts',
        ))!;
        pipeline.metrics.lines = {
            covered: 0,
            pct: 0,
            total: 100,
        };

        const result = compareCoverageToBaseline(snapshot, baseline);

        expect(result.passed).toBe(false);
        expect(result.failures).toContain('scan-cleanup-preview-successors lines regressed by 4.77 percentage points');
        expect(result.failures).not.toContain(
            'electron/features/scan-cleanup/scanCleanupPreviewRenderer.ts lines regressed by 10.00 percentage points',
        );
    });

    it('accepts a group just below the baseline inside the inherited tolerance', () => {
        const baseline = createCoverageBaseline(parseCoverageSummary(summary(90, 90), '/repo'));
        const snapshot = parseCoverageSummary(summary(90, 90), '/repo');
        const pipeline = snapshot.files.find(file => file.filePath.endsWith(
            'scanCleanupPreviewRenderingPipeline.ts',
        ))!;
        pipeline.metrics.lines = {
            covered: 68,
            pct: 68,
            total: 100,
        };
        compensateElectronArea(snapshot);
        isolateElectronAreaGate(baseline);

        const result = compareCoverageToBaseline(snapshot, baseline);

        expect(result.passed).toBe(true);
        expect(result.comparisons).toContain(
            'scan-cleanup-preview-successors lines: 88.5333% (-0.24 pp; baseline 88.77%; tolerance 0.50 pp)',
        );
        expect(result.failures).not.toContain('scan-cleanup-preview-successors lines regressed by 0.24 percentage points');
    });

    it('accepts a group exactly at the inherited tolerance boundary', () => {
        const baseline = createCoverageBaseline(parseCoverageSummary(summary(90, 90), '/repo'));
        const snapshot = parseCoverageSummary(summary(90, 90), '/repo');
        const pipeline = snapshot.files.find(file => file.filePath.endsWith(
            'scanCleanupPreviewRenderingPipeline.ts',
        ))!;
        pipeline.metrics.lines = {
            covered: 64,
            pct: 64,
            total: 100,
        };
        compensateElectronArea(snapshot);
        isolateElectronAreaGate(baseline);

        const result = compareCoverageToBaseline(snapshot, baseline);

        expect(result.passed).toBe(true);
        expect(result.comparisons).toContain(
            'scan-cleanup-preview-successors lines: 88.2667% (-0.50 pp; baseline 88.77%; tolerance 0.50 pp)',
        );
    });

    it('rejects a group beyond the inherited tolerance boundary', () => {
        const baseline = createCoverageBaseline(parseCoverageSummary(summary(90, 90), '/repo'));
        const snapshot = parseCoverageSummary(summary(90, 90), '/repo');
        const pipeline = snapshot.files.find(file => file.filePath.endsWith(
            'scanCleanupPreviewRenderingPipeline.ts',
        ))!;
        pipeline.metrics.lines = {
            covered: 63,
            pct: 63,
            total: 100,
        };
        compensateElectronArea(snapshot);
        isolateElectronAreaGate(baseline);

        const result = compareCoverageToBaseline(snapshot, baseline);

        expect(result.passed).toBe(false);
        expect(result.comparisons).toContain(
            'scan-cleanup-preview-successors lines: 88.2000% (-0.57 pp; baseline 88.77%; tolerance 0.50 pp)',
        );
        expect(result.failures).toContain('scan-cleanup-preview-successors lines regressed by 0.57 percentage points');
    });

    it('uses weighted covered and total lines for successor aggregation', () => {
        const baseline = createCoverageBaseline(parseCoverageSummary(summary(90, 90), '/repo'));
        const snapshot = parseCoverageSummary(summary(90, 90), '/repo');
        const pipeline = snapshot.files.find(file => file.filePath.endsWith(
            'scanCleanupPreviewRenderingPipeline.ts',
        ))!;
        pipeline.metrics.lines = {
            covered: 5,
            pct: 16.67,
            total: 30,
        };
        compensateElectronArea(snapshot);
        isolateElectronAreaGate(baseline);

        const result = compareCoverageToBaseline(snapshot, baseline);

        expect(result.passed).toBe(true);
        expect(result.comparisons).toContain(
            'scan-cleanup-preview-successors lines: 88.4615% (-0.31 pp; baseline 88.77%; tolerance 0.50 pp)',
        );
    });

    it('keeps the renderer per-file floor independent from a rising successor', () => {
        const baseline = createCoverageBaseline(parseCoverageSummary(summary(90, 90), '/repo'));
        const snapshot = parseCoverageSummary(summary(90, 90), '/repo');
        const renderer = snapshot.files.find(file => file.filePath.endsWith(
            'scanCleanupPreviewRenderer.ts',
        ))!;
        renderer.metrics.lines = {
            covered: 80,
            pct: 80,
            total: 100,
        };
        const pipeline = snapshot.files.find(file => file.filePath.endsWith(
            'scanCleanupPreviewRenderingPipeline.ts',
        ))!;
        pipeline.metrics.lines = {
            covered: 100,
            pct: 100,
            total: 100,
        };

        const result = compareCoverageToBaseline(snapshot, baseline);

        expect(result.passed).toBe(false);
        expect(result.failures).toContain(
            'electron/features/scan-cleanup/scanCleanupPreviewRenderer.ts lines regressed by 10.00 percentage points',
        );
    });

    it('ratchets lifecycle-critical files and rejects zero execution', () => {
        const baseline = createCoverageBaseline(parseCoverageSummary(summary(70, 80), '/repo'));
        const snapshot = parseCoverageSummary(summary(70, 80), '/repo');
        const targetPath = LOAD_BEARING_COVERAGE_FILES[0];
        const target = snapshot.files.find(file => file.filePath === targetPath)!;
        target.metrics.lines = {
            covered: 0,
            pct: 0,
            total: 100,
        };

        const result = compareCoverageToBaseline(snapshot, baseline);

        expect(result.passed).toBe(false);
        expect(result.failures).toContain(`${targetPath} has zero executed lines`);
    });

    it('detects a load-bearing file regression hidden by stable aggregate coverage', () => {
        const baseline = createCoverageBaseline(parseCoverageSummary(summary(70, 80), '/repo'));
        const snapshot = parseCoverageSummary(summary(70, 80), '/repo');
        const targetPath = LOAD_BEARING_COVERAGE_FILES[0];
        const target = snapshot.files.find(file => file.filePath === targetPath)!;
        target.metrics.lines = {
            covered: 79.49,
            pct: 79.49,
            total: 100,
        };

        const result = compareCoverageToBaseline(snapshot, baseline);

        expect(result.passed).toBe(false);
        expect(result.failures).toContain(`${targetPath} lines regressed by 0.51 percentage points`);
    });

    it('rejects a coverage denominator shrink while source files remain on disk', () => {
        const baselineSnapshot = parseCoverageSummary(summary(70, 80), '/repo');
        const baseline = createCoverageBaseline(baselineSnapshot);
        const snapshot = parseCoverageSummary(summary(70, 80), '/repo');
        snapshot.files = snapshot.files.filter(file => file.filePath !== 'app/runtime.ts');

        const result = compareCoverageToBaseline(
            snapshot,
            baseline,
            baselineSnapshot.files.map(file => file.filePath),
        );

        expect(result.passed).toBe(false);
        expect(result.failures).toContain(
            'app-core coverage file count shrank from 6 to 5 while 6 source files remain on disk',
        );
    });

    it('allows a stored denominator to shrink only with the on-disk source set', () => {
        const baselineSnapshot = parseCoverageSummary(summary(70, 80), '/repo');
        const baseline = createCoverageBaseline(baselineSnapshot);
        const snapshot = parseCoverageSummary(summary(70, 80), '/repo');
        snapshot.files = snapshot.files.filter(file => file.filePath !== 'app/runtime.ts');

        const result = compareCoverageToBaseline(
            snapshot,
            baseline,
            snapshot.files.map(file => file.filePath),
        );

        expect(result.failures).not.toContain(
            'app-core coverage file count shrank from 6 to 5',
        );
    });

    it('checks report shrinkage against recursively discovered source files', async () => {
        const projectRoot = await createTemporaryProject();
        const sourceFiles: Array<[string, string]> = [
            [
                'app/runtime.ts',
                'export const runtime = true;',
            ],
            [
                'app/Viewer.vue',
                '<template><main /></template>',
            ],
            [
                'app/types.d.ts',
                'export declare const ignored: true;',
            ],
            [
                'app/ignored.js',
                'export const ignored = true;',
            ],
            [
                'app/.nuxt/generated.ts',
                'export const generated = true;',
            ],
            [
                'scripts/check.ts',
                'export const check = true;',
            ],
            [
                'scripts/legacy.cjs',
                'module.exports = true;',
            ],
            [
                'scripts/release/build.mjs',
                'export const build = true;',
            ],
            [
                'scripts/types.d.ts',
                'export declare const ignored: true;',
            ],
            [
                'scripts/ignored.js',
                'export const ignored = true;',
            ],
        ];
        await Promise.all(sourceFiles.map(([
            relativePath,
            contents,
        ]) => writeFile(path.join(projectRoot, relativePath), contents, 'utf8')));

        const baselineSource = summary(70, 80, projectRoot);
        const snapshot = JSON.parse(baselineSource) as Record<string, unknown>;
        Reflect.deleteProperty(snapshot, `${projectRoot}/app/runtime.ts`);
        await Promise.all([
            writeFile(
                path.join(projectRoot, 'coverage-baseline.json'),
                JSON.stringify(createCoverageBaseline(parseCoverageSummary(baselineSource, projectRoot))),
                'utf8',
            ),
            writeFile(
                path.join(projectRoot, 'coverage/coverage-summary.json'),
                JSON.stringify(snapshot),
                'utf8',
            ),
        ]);

        const result = await runCoverageRatchet([], projectRoot);

        expect(result.passed).toBe(false);
        expect(result.message).toContain(
            'app-core coverage file count shrank from 6 to 5 while 2 source files remain on disk',
        );
    });

    it('updates the stored baseline from the current report', async () => {
        const projectRoot = await createTemporaryProject();
        await writeFile(
            path.join(projectRoot, 'coverage/coverage-summary.json'),
            summary(70, 80, projectRoot),
            'utf8',
        );

        const result = await runCoverageRatchet(['--update-baseline'], projectRoot);
        const baseline = JSON.parse(await readFile(
            path.join(projectRoot, 'coverage-baseline.json'),
            'utf8',
        )) as {
            areas: Record<string, {fileCount: number}>;
            groups: Record<string, {
                files: string[];
                lines: number
            }>;
            tolerancePercentagePoints: number;
            version: number;
        };

        expect(result).toEqual({
            message: 'Coverage baseline updated.',
            passed: true,
        });
        expect(baseline.areas['scripts-core']?.fileCount).toBe(1);
        expect(baseline.version).toBe(3);
        expect(baseline.tolerancePercentagePoints).toBe(0.5);
        expect(baseline.groups['scan-cleanup-preview-successors']).toEqual({
            files: [...SCAN_CLEANUP_PREVIEW_SUCCESSOR_FILES],
            lines: 88.77,
        });
    });

    it('rejects successor group schema drift before comparing coverage', async () => {
        const projectRoot = await createTemporaryProject();
        const summarySource = summary(90, 90, projectRoot);
        const baseline = createCoverageBaseline(parseCoverageSummary(summarySource, projectRoot));
        await writeFile(
            path.join(projectRoot, 'coverage/coverage-summary.json'),
            summarySource,
            'utf8',
        );
        const mutations: Array<(value: Record<string, unknown>) => void> = [
            (value) => {
                delete value.groups;
            },
            (value) => {
                const groups = value.groups as Record<string, unknown>;
                groups.extra = groups['scan-cleanup-preview-successors'];
            },
            (value) => {
                const groups = value.groups as Record<string, unknown>;
                const group = groups['scan-cleanup-preview-successors'] as Record<string, unknown>;
                group.files = [...(group.files as string[])].reverse();
            },
            (value) => {
                const groups = value.groups as Record<string, unknown>;
                const group = groups['scan-cleanup-preview-successors'] as Record<string, unknown>;
                group.lines = 88.76;
            },
            (value) => {
                value.tolerancePercentagePoints = 0.51;
            },
        ];

        for (const mutate of mutations) {
            const malformed = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
            mutate(malformed);
            await writeFile(
                path.join(projectRoot, 'coverage-baseline.json'),
                JSON.stringify(malformed),
                'utf8',
            );
            await expect(runCoverageRatchet([], projectRoot)).rejects.toThrow(
                'Coverage baseline is invalid or unsupported.',
            );
        }
    });

    it('rejects an unsupported stored baseline before comparing files', async () => {
        const projectRoot = await createTemporaryProject();
        await Promise.all([
            writeFile(
                path.join(projectRoot, 'coverage/coverage-summary.json'),
                summary(70, 80, projectRoot),
                'utf8',
            ),
            writeFile(
                path.join(projectRoot, 'coverage-baseline.json'),
                JSON.stringify({version: 1}),
                'utf8',
            ),
        ]);

        await expect(runCoverageRatchet([], projectRoot)).rejects.toThrow(
            'Coverage baseline is invalid or unsupported.',
        );
    });
});
