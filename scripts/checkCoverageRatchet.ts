import {
    isFiniteNumber,
    isRecord,
    isStringArray,
} from '@contracts/runtimeGuards';
import {
    readFile,
    readdir,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const COVERAGE_METRICS = [
    'statements',
    'branches',
    'functions',
    'lines',
] as const;
const BASELINE_PATH = 'coverage-baseline.json';
const SUMMARY_PATH = 'coverage/coverage-summary.json';
const DEFAULT_TOLERANCE = 0.5;

type TCoverageMetric = typeof COVERAGE_METRICS[number];

interface IMetricSummary {
    covered: number;
    pct: number;
    total: number;
}

interface IFileCoverage {
    filePath: string;
    metrics: Record<TCoverageMetric, IMetricSummary>;
}

interface ICoverageSnapshot {
    files: IFileCoverage[];
    metrics: Record<TCoverageMetric, IMetricSummary>;
}

interface ICoverageAreaBaseline {
    fileCount: number;
    include: string[];
    metrics: Record<TCoverageMetric, number>;
}

interface ICoverageFileBaseline {lines: number;}

interface ICoverageGroupBaseline {
    files: string[];
    lines: number;
}

interface ICoverageBaseline {
    areas: Record<string, ICoverageAreaBaseline>;
    files: Record<string, ICoverageFileBaseline>;
    groups: Record<string, ICoverageGroupBaseline>;
    metrics: Record<TCoverageMetric, number>;
    tolerancePercentagePoints: number;
    version: 3;
}

export const DEFAULT_COVERAGE_AREAS = {
    'app-core': {include: ['app/']},
    'electron-core': {include: ['electron/']},
    'electron-djvu-feature': {include: ['electron/features/djvu/']},
    // OCR production code now lives under the feature-owned path while the
    // worker entrypoints that still use the legacy path remain covered here.
    'electron-ocr': {include: [
        'electron/ocr/',
        'electron/features/ocr/',
    ]},
    'pdf-viewer': {include: ['app/modules/pdf-viewer/']},
    'release-scripts': {include: ['scripts/release/']},
    'scan-cleanup-adapters': {include: ['packages/scan-cleanup/adapters/']},
    'scan-cleanup-core': {include: ['packages/scan-cleanup/core/']},
    'scripts-core': {include: ['scripts/']},
    'workspace-shell': {include: ['app/modules/workspace-shell/']},
} satisfies Record<string, {include: string[]}>;

export const LOAD_BEARING_COVERAGE_FILES = [
    'app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession.ts',
    'app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator.ts',
    'app/modules/workspace-shell/viewers/documentPageSourceFeaturePackState.ts',
    'electron/features/agent/workspaceBridge.ts',
    'electron/features/documents/main/nativePdfMutationSaveHandlers.ts',
    'electron/features/documents/main/nativePdfPreview.ts',
    // The former monolith was split into lifecycle owners. Keep the renderer
    // owner as the load-bearing representative instead of tracking a deleted
    // path that can never appear in a coverage report.
    'electron/features/scan-cleanup/scanCleanupPreviewRenderer.ts',
] as const;

// The former createScanCleanupPreviewService.ts entry was split into several
// owners. Keep the protected implementation as one explicit weighted group,
// while retaining each existing load-bearing file floor independently.
export const LOAD_BEARING_COVERAGE_GROUPS = {'scan-cleanup-preview-successors': {
    files: [
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
    ],
    lines: 88.77,
}} as const;

export const LOAD_BEARING_COVERAGE_GROUP_FILES = [...new Set(Object.values(LOAD_BEARING_COVERAGE_GROUPS).flatMap(group => group.files))] as readonly string[];

function assertNumber(value: unknown, label: string) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`${label} must be a finite number.`);
    }
    return value;
}

function parseMetrics(value: unknown, label: string) {
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object.`);
    }
    return Object.fromEntries(COVERAGE_METRICS.map((metric) => {
        const rawMetric = value[metric];
        if (!isRecord(rawMetric)) {
            throw new TypeError(`${label}.${metric} must be an object.`);
        }
        return [
            metric,
            {
                covered: assertNumber(rawMetric.covered, `${label}.${metric}.covered`),
                pct: assertNumber(rawMetric.pct, `${label}.${metric}.pct`),
                total: assertNumber(rawMetric.total, `${label}.${metric}.total`),
            },
        ];
    })) as Record<TCoverageMetric, IMetricSummary>;
}

function normalizePath(filePath: string, projectRoot: string) {
    const normalized = filePath.replaceAll('\\', '/');
    const root = projectRoot.replaceAll('\\', '/').replace(/\/$/u, '');
    return path.isAbsolute(filePath) && normalized.startsWith(`${root}/`)
        ? normalized.slice(root.length + 1)
        : normalized.replace(/^\.\//u, '');
}

async function collectCoverageSourceFiles(projectRoot: string) {
    const roots = [...new Set(Object.values(DEFAULT_COVERAGE_AREAS)
        .flatMap(area => area.include)
        .flatMap((prefix) => {
            const [root] = prefix.split('/');
            return root ? [root] : [];
        }))];

    async function collect(directory: string): Promise<string[]> {
        const entries = await readdir(path.join(projectRoot, directory), {withFileTypes: true});
        const files = await Promise.all(entries.map(async (entry) => {
            const relativePath = path.posix.join(directory, entry.name);
            if (entry.isDirectory()) {
                return entry.name === '.nuxt' ? [] : collect(relativePath);
            }
            const isCoverageSource = relativePath.startsWith('scripts/')
                ? /\.(?:cjs|mjs|ts)$/u.test(entry.name)
                : entry.name.endsWith('.ts') || (
                    relativePath.startsWith('app/') && entry.name.endsWith('.vue')
                );
            return entry.isFile()
                && isCoverageSource
                && !entry.name.endsWith('.d.ts')
                ? [relativePath]
                : [];
        }));
        return files.flat();
    }

    return (await Promise.all(roots.map(root => collect(root)))).flat();
}

export function parseCoverageSummary(source: string, projectRoot = process.cwd()): ICoverageSnapshot {
    const parsed = JSON.parse(source) as unknown;
    if (!isRecord(parsed)) {
        throw new TypeError('Coverage summary must be an object.');
    }
    return {
        files: Object.entries(parsed)
            .filter(([filePath]) => filePath !== 'total')
            .map(([
                filePath,
                metrics,
            ]) => ({
                filePath: normalizePath(filePath, projectRoot),
                metrics: parseMetrics(metrics, `Coverage summary ${filePath}`),
            })),
        metrics: parseMetrics(parsed.total, 'Coverage summary total'),
    };
}

function aggregateArea(snapshot: ICoverageSnapshot, prefixes: readonly string[]) {
    const files = snapshot.files.filter(file => prefixes.some(prefix => file.filePath.startsWith(prefix)));
    const metrics = Object.fromEntries(COVERAGE_METRICS.map((metric) => {
        const covered = files.reduce((total, file) => total + file.metrics[metric].covered, 0);
        const total = files.reduce((sum, file) => sum + file.metrics[metric].total, 0);
        return [
            metric,
            {
                covered,
                pct: total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2)),
                total,
            },
        ];
    })) as Record<TCoverageMetric, IMetricSummary>;
    return {
        fileCount: files.length,
        metrics,
    };
}

function aggregateFiles(snapshot: ICoverageSnapshot, filePaths: readonly string[]) {
    const expectedPaths = new Set(filePaths);
    const files = snapshot.files.filter(file => expectedPaths.has(file.filePath));
    const metrics = Object.fromEntries(COVERAGE_METRICS.map((metric) => {
        const covered = files.reduce((total, file) => total + file.metrics[metric].covered, 0);
        const total = files.reduce((sum, file) => sum + file.metrics[metric].total, 0);
        return [
            metric,
            {
                covered,
                pct: total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2)),
                total,
            },
        ];
    })) as Record<TCoverageMetric, IMetricSummary>;
    return {
        fileCount: files.length,
        metrics,
    };
}

function metricPercentages(metrics: Record<TCoverageMetric, IMetricSummary>) {
    return Object.fromEntries(COVERAGE_METRICS.map(metric => [
        metric,
        metrics[metric].pct,
    ])) as Record<TCoverageMetric, number>;
}

export function createCoverageBaseline(
    snapshot: ICoverageSnapshot,
    tolerance = DEFAULT_TOLERANCE,
    onDiskSourceFiles?: readonly string[],
): ICoverageBaseline {
    if (tolerance !== DEFAULT_TOLERANCE) {
        throw new RangeError(`Coverage baseline tolerance must remain ${DEFAULT_TOLERANCE} percentage points.`);
    }
    const filesByPath = new Map(snapshot.files.map(file => [
        file.filePath,
        file,
    ]));
    return {
        areas: Object.fromEntries(Object.entries(DEFAULT_COVERAGE_AREAS).map(([
            name,
            area,
        ]) => {
            const aggregate = aggregateArea(snapshot, area.include);
            return [
                name,
                {
                    fileCount: aggregate.fileCount,
                    include: area.include,
                    metrics: metricPercentages(aggregate.metrics),
                },
            ];
        })),
        files: Object.fromEntries(LOAD_BEARING_COVERAGE_FILES.map((filePath) => {
            const file = filesByPath.get(filePath);
            if (!file) {
                throw new TypeError(`Load-bearing file ${filePath} is missing from the coverage report.`);
            }
            return [
                filePath,
                {lines: file.metrics.lines.pct},
            ];
        })),
        groups: Object.fromEntries(Object.entries(LOAD_BEARING_COVERAGE_GROUPS).map(([
            name,
            group,
        ]) => {
            if (onDiskSourceFiles !== undefined) {
                const missingSourceFiles = group.files.filter(filePath => !onDiskSourceFiles.includes(filePath));
                if (missingSourceFiles.length > 0) {
                    throw new TypeError(
                        `Load-bearing coverage group ${name} is missing source members on disk: ${missingSourceFiles.join(', ')}`,
                    );
                }
            }
            for (const filePath of group.files) {
                if (!filesByPath.has(filePath)) {
                    throw new TypeError(`Load-bearing coverage group ${name} is missing ${filePath} from the coverage report.`);
                }
            }
            return [
                name,
                {
                    files: [...group.files],
                    lines: group.lines,
                },
            ];
        })),
        metrics: metricPercentages(snapshot.metrics),
        tolerancePercentagePoints: tolerance,
        version: 3,
    };
}

export function compareCoverageToBaseline(
    snapshot: ICoverageSnapshot,
    baseline: ICoverageBaseline,
    onDiskSourceFiles?: readonly string[],
) {
    const failures: string[] = [];
    const comparisons: string[] = [];
    const compare = (
        label: string,
        current: Record<TCoverageMetric, IMetricSummary>,
        expected: Record<TCoverageMetric, number>,
    ) => {
        for (const metric of COVERAGE_METRICS) {
            const delta = Number((current[metric].pct - expected[metric]).toFixed(2));
            comparisons.push(`${label} ${metric}: ${current[metric].pct.toFixed(2)}% (${delta >= 0 ? '+' : ''}${delta.toFixed(2)} pp)`);
            if (delta < -baseline.tolerancePercentagePoints) {
                failures.push(`${label} ${metric} regressed by ${Math.abs(delta).toFixed(2)} percentage points`);
            }
        }
    };

    compare('total', snapshot.metrics, baseline.metrics);
    for (const [
        name,
        area,
    ] of Object.entries(baseline.areas)) {
        const aggregate = aggregateArea(snapshot, area.include);
        if (aggregate.fileCount === 0) {
            failures.push(`${name} is missing from the coverage report`);
        } else {
            compare(name, aggregate.metrics, area.metrics);
        }
        if (aggregate.fileCount < area.fileCount) {
            const onDiskFileCount = onDiskSourceFiles?.filter(filePath => (
                area.include.some(prefix => filePath.startsWith(prefix))
            )).length;
            if (onDiskFileCount === undefined || aggregate.fileCount !== onDiskFileCount) {
                failures.push(
                    `${name} coverage file count shrank from ${area.fileCount} to ${aggregate.fileCount}`
                    + (onDiskFileCount === undefined ? '' : ` while ${onDiskFileCount} source files remain on disk`),
                );
            } else {
                comparisons.push(
                    `${name} file count: ${aggregate.fileCount} (${area.fileCount - aggregate.fileCount} source files removed on disk)`,
                );
            }
        }
    }
    const filesByPath = new Map(snapshot.files.map(file => [
        file.filePath,
        file,
    ]));
    for (const [
        filePath,
        expected,
    ] of Object.entries(baseline.files)) {
        const file = filesByPath.get(filePath);
        if (!file) {
            failures.push(`${filePath} is missing from the coverage report`);
            continue;
        }
        const lines = file.metrics.lines;
        const delta = Number((lines.pct - expected.lines).toFixed(2));
        comparisons.push(`${filePath} lines: ${lines.pct.toFixed(2)}% (${delta >= 0 ? '+' : ''}${delta.toFixed(2)} pp)`);
        if (lines.total > 0 && lines.covered === 0) {
            failures.push(`${filePath} has zero executed lines`);
        } else if (delta < -baseline.tolerancePercentagePoints) {
            failures.push(`${filePath} lines regressed by ${Math.abs(delta).toFixed(2)} percentage points`);
        }
    }
    for (const [
        name,
        expected,
    ] of Object.entries(baseline.groups)) {
        const missingReportFiles = expected.files.filter(filePath => !filesByPath.has(filePath));
        if (missingReportFiles.length > 0) {
            failures.push(
                `${name} is missing coverage members: ${missingReportFiles.join(', ')}`,
            );
            continue;
        }
        const missingSourceFiles = onDiskSourceFiles === undefined
            ? []
            : expected.files.filter(filePath => !onDiskSourceFiles.includes(filePath));
        if (missingSourceFiles.length > 0) {
            failures.push(
                `${name} is missing source members on disk: ${missingSourceFiles.join(', ')}`,
            );
            continue;
        }
        const aggregate = aggregateFiles(snapshot, expected.files);
        const lines = aggregate.metrics.lines;
        const rawPercentage = lines.total === 0 ? 100 : lines.covered / lines.total * 100;
        const delta = Number((rawPercentage - expected.lines).toFixed(2));
        comparisons.push(
            `${name} lines: ${rawPercentage.toFixed(4)}% (${delta >= 0 ? '+' : ''}${delta.toFixed(2)} pp; baseline ${expected.lines.toFixed(2)}%; tolerance ${baseline.tolerancePercentagePoints.toFixed(2)} pp)`,
        );
        // Apply the inherited rounded-delta tolerance to the successor group,
        // just as the former monolith and every other load-bearing entry did.
        if (delta < -baseline.tolerancePercentagePoints) {
            failures.push(
                `${name} lines regressed by ${Math.abs(delta).toFixed(2)} percentage points`,
            );
        }
    }
    return {
        comparisons,
        failures,
        passed: failures.length === 0,
    };
}

function isBaselineMetrics(value: unknown): value is Record<TCoverageMetric, number> {
    return isRecord(value) && COVERAGE_METRICS.every(metric => isFiniteNumber(value[metric]));
}

function isCoverageAreaBaseline(value: unknown): value is ICoverageAreaBaseline {
    return isRecord(value)
        && isFiniteNumber(value.fileCount)
        && isStringArray(value.include)
        && isBaselineMetrics(value.metrics);
}

function isCoverageFileBaseline(value: unknown): value is ICoverageFileBaseline {
    return isRecord(value) && isFiniteNumber(value.lines);
}

function isCoverageGroupBaseline(value: unknown): value is ICoverageGroupBaseline {
    return isRecord(value)
        && isStringArray(value.files)
        && isFiniteNumber(value.lines);
}

function hasExpectedCoverageGroups(value: unknown) {
    if (!isRecord(value)) {
        return false;
    }
    const expectedGroups = Object.entries(LOAD_BEARING_COVERAGE_GROUPS);
    return Object.keys(value).length === expectedGroups.length
        && expectedGroups.every(([
            name,
            expected,
        ]) => {
            const actual = value[name];
            return isCoverageGroupBaseline(actual)
                && actual.lines === expected.lines
                && actual.files.length === expected.files.length
                && actual.files.every((filePath, index) => filePath === expected.files[index]);
        });
}

function isCoverageBaseline(value: unknown): value is ICoverageBaseline {
    return isRecord(value)
        && value.version === 3
        && value.tolerancePercentagePoints === DEFAULT_TOLERANCE
        && isBaselineMetrics(value.metrics)
        && isRecord(value.areas)
        && Object.values(value.areas).every(isCoverageAreaBaseline)
        && isRecord(value.files)
        && Object.values(value.files).every(isCoverageFileBaseline)
        && hasExpectedCoverageGroups(value.groups);
}

function parseBaseline(source: string): ICoverageBaseline {
    const parsed: unknown = JSON.parse(source);
    if (!isCoverageBaseline(parsed)) {
        throw new TypeError('Coverage baseline is invalid or unsupported.');
    }
    return parsed;
}

export async function runCoverageRatchet(args = process.argv.slice(2), projectRoot = process.cwd()) {
    const snapshot = parseCoverageSummary(
        await readFile(path.join(projectRoot, SUMMARY_PATH), 'utf8'),
        projectRoot,
    );
    const baselinePath = path.join(projectRoot, BASELINE_PATH);
    if (args.includes('--update-baseline')) {
        const onDiskSourceFiles = await collectCoverageSourceFiles(projectRoot);
        await writeFile(
            baselinePath,
            `${JSON.stringify(createCoverageBaseline(snapshot, DEFAULT_TOLERANCE, onDiskSourceFiles), null, 2)}\n`,
            'utf8',
        );
        return {
            message: 'Coverage baseline updated.',
            passed: true,
        };
    }

    const result = compareCoverageToBaseline(
        snapshot,
        parseBaseline(await readFile(baselinePath, 'utf8')),
        await collectCoverageSourceFiles(projectRoot),
    );
    return {
        message: [
            result.passed ? 'Coverage ratchet passed.' : 'Coverage ratchet failed.',
            ...result.failures.map(failure => `  ERROR: ${failure}`),
            ...result.comparisons.map(comparison => `  ${comparison}`),
        ].join('\n'),
        passed: result.passed,
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const result = await runCoverageRatchet();
    console.log(result.message);
    if (!result.passed) {
        process.exitCode = 1;
    }
}
