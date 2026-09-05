import {isRecord} from '@contracts/runtimeGuards';
import {execFileSync} from 'node:child_process';
import {
    readdir,
    readFile,
} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {LOAD_BEARING_COVERAGE_FILES} from '@scripts/checkCoverageRatchet';

const DEFAULT_SUMMARY_PATH = 'coverage/coverage-summary.json';
const COVERAGE_BASE_SHA_ENV = 'EVB_COVERAGE_BASE_SHA';
const COVERAGE_HEAD_SHA_ENV = 'EVB_COVERAGE_HEAD_SHA';
const WORKTREE_HEAD = 'WORKTREE';

export interface ILineCoverageSummary {
    covered: number;
    total: number;
}

export interface IZeroExecutionCoverageResult {
    changedTargetFileCount: number;
    missingFiles: string[];
    passed: boolean;
    targetFileCount: number;
    zeroExecutionFiles: string[];
}

const PRODUCTION_COVERAGE_ROOTS = [
    'app/',
    'electron/',
    'packages/',
    'scan-cleanup-adapters/',
    'scan-cleanup-core/',
    'scripts/',
    'server/',
] as const;

// These integration entrypoints are exercised by the real browser, Electron,
// packaged-app, or OCR quality gates rather than by the unit projects that
// produce coverage/coverage-summary.json. Keep this list exact: a new source
// file is required to execute in unit coverage unless it is deliberately
// assigned to a stronger non-unit gate here.
export const NON_UNIT_COVERAGE_ENTRYPOINTS = [
    'app/app.vue',
    'app/modules/pdf-viewer/components/PdfViewer.vue',
    'app/modules/pdf-viewer/components/annotations/PdfAnnotationNoteWindow.vue',
    'app/modules/pdf-viewer/components/PdfAnnotationEditorLayer.vue',
    // Worker entrypoints execute in browser/Electron worker bundles and are
    // covered by the corresponding save, image, or page-ops acceptance lanes.
    'app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations.worker.ts',
    'app/platform/browser-api/browserPageOps.worker.ts',
    'app/platform/browser-api/browserPdfCombine.worker.ts',
    'app/modules/pdf-viewer/components/PdfAnnotationToolbar.vue',
    'app/modules/pdf-viewer/components/PdfAnnotationSelectionHandles.vue',
    'app/modules/pdf-viewer/components/PdfNoteAnnotation.vue',
    'app/modules/pdf-viewer/components/PdfShapeAnnotation.vue',
    'app/modules/pdf-viewer/components/PdfStampAnnotation.vue',
    'app/modules/pdf-viewer/components/PdfTextBoxAnnotation.vue',
    'app/modules/pdf-viewer/components/PdfTextMarkupAnnotation.vue',
    'app/modules/pdf-viewer/components/PdfViewerPage.vue',
    'app/modules/pdf-viewer/components/PdfViewerPortalLayers.vue',
    'app/modules/pdf-viewer/components/PdfViewerViewport.vue',
    'app/modules/pdf-viewer/runtime/rendering/createHiddenAnnotationLayerController.ts',
    // These workspace dialogs are driven by the Electron save/open flows.
    'app/modules/workspace-shell/components/DocumentPasswordDialog.vue',
    'app/modules/workspace-shell/components/UnencryptedSaveDialog.vue',
    'app/modules/workspace-shell/components/AppShellRoot.vue',
    'app/modules/workspace-shell/composables/useAppShellResilience.ts',
    'app/modules/workspace-shell/useWorkspaceOrchestration.ts',
    'app/pages/electron.vue',
    'electron/main.ts',
    'electron/preload.ts',
    'electron/ocr/worker/runProductionOcrQualityCase.ts',
    // This standalone builder creates a checked-in Electron lifecycle fixture.
    'scripts/generate-freetext-lifecycle-fixture.mjs',
    'scripts/release/verifyPackagedCorePdfSmoke.ts',
    'scripts/release/verifyPackagedScanCleanup.ts',
    'scripts/test-ocr-quality-corpus.mjs',
] as const;

export function isProductionCoverageSource(filePath: string) {
    const normalized = filePath.replaceAll('\\', '/').replace(/^\.\//u, '');
    if (!PRODUCTION_COVERAGE_ROOTS.some(root => normalized.startsWith(root))) {
        return false;
    }
    if (normalized.endsWith('.d.ts')) {
        return false;
    }
    if (normalized.startsWith('app/')) {
        return /\.(?:ts|vue)$/u.test(normalized);
    }
    if (normalized.startsWith('scripts/')) {
        return /\.(?:cjs|mjs|ts)$/u.test(normalized);
    }
    return normalized.endsWith('.ts');
}

export function selectChangedProductionCoverageTargets(changedFiles: readonly string[]) {
    const nonUnitCoverageEntrypoints = new Set<string>(NON_UNIT_COVERAGE_ENTRYPOINTS);
    return [...new Set(changedFiles
        .map(filePath => filePath.replaceAll('\\', '/').replace(/^\.\//u, ''))
        .filter(filePath => (
            isProductionCoverageSource(filePath)
            && !nonUnitCoverageEntrypoints.has(filePath)
        )))]
        .sort((left, right) => left.localeCompare(right));
}

function assertCommitSha(value: string, label: string) {
    if (!/^[a-f\d]{40,64}$/iu.test(value)) {
        throw new Error(`${label} must be a full Git commit SHA.`);
    }
    return value;
}

export function collectChangedProductionCoverageTargets({
    baseSha = process.env[COVERAGE_BASE_SHA_ENV],
    headSha = process.env[COVERAGE_HEAD_SHA_ENV],
    projectRoot = process.cwd(),
}: {
    baseSha?: string;
    headSha?: string;
    projectRoot?: string;
} = {}) {
    if (baseSha === undefined && headSha === undefined) {
        return [];
    }
    if (baseSha === undefined || headSha === undefined) {
        throw new Error(`${COVERAGE_BASE_SHA_ENV} and ${COVERAGE_HEAD_SHA_ENV} must be set together.`);
    }

    const gitLines = (args: string[]) => execFileSync('git', args, {
        cwd: projectRoot,
        encoding: 'utf8',
    }).split('\0').filter(Boolean);
    if (headSha === WORKTREE_HEAD) {
        const base = assertCommitSha(baseSha, COVERAGE_BASE_SHA_ENV);
        return selectChangedProductionCoverageTargets([
            ...gitLines([
                'diff',
                '--no-renames',
                '--name-only',
                '--diff-filter=ACMR',
                '-z',
                base,
            ]),
            ...gitLines([
                'ls-files',
                '--others',
                '--exclude-standard',
                '-z',
            ]),
        ]);
    }

    const head = assertCommitSha(headSha, COVERAGE_HEAD_SHA_ENV);
    const requestedBase = assertCommitSha(baseSha, COVERAGE_BASE_SHA_ENV);
    const base = /^0+$/u.test(requestedBase)
        ? execFileSync('git', [
            'rev-parse',
            '--verify',
            `${head}^`,
        ], {
            cwd: projectRoot,
            encoding: 'utf8',
        }).trim()
        : requestedBase;
    return selectChangedProductionCoverageTargets(gitLines([
        'diff',
        '--no-renames',
        '--name-only',
        '--diff-filter=ACMR',
        '-z',
        `${base}...${head}`,
    ]));
}

function assertFiniteNumber(value: unknown, label: string) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${label} must be a finite number.`);
    }
    return value;
}

function normalizeCoveragePath(filePath: string, projectRoot: string) {
    const normalizedPath = filePath.replaceAll('\\', '/');
    const normalizedRoot = projectRoot.replaceAll('\\', '/').replace(/\/$/u, '');
    return path.isAbsolute(filePath) && normalizedPath.startsWith(`${normalizedRoot}/`)
        ? normalizedPath.slice(normalizedRoot.length + 1)
        : normalizedPath.replace(/^\.\//u, '');
}

export function parseLineCoverageSummary(source: string, projectRoot = process.cwd()) {
    const parsed = JSON.parse(source) as unknown;
    if (!isRecord(parsed)) {
        throw new Error('Coverage summary must be a JSON object.');
    }

    const files = new Map<string, ILineCoverageSummary>();
    for (const [
        filePath,
        rawMetrics,
    ] of Object.entries(parsed)) {
        if (filePath === 'total') {
            continue;
        }
        if (!isRecord(rawMetrics) || !isRecord(rawMetrics.lines)) {
            throw new Error(`Coverage summary ${filePath}.lines must be an object.`);
        }
        files.set(normalizeCoveragePath(filePath, projectRoot), {
            covered: assertFiniteNumber(rawMetrics.lines.covered, `Coverage summary ${filePath}.lines.covered`),
            total: assertFiniteNumber(rawMetrics.lines.total, `Coverage summary ${filePath}.lines.total`),
        });
    }
    return files;
}

export function isZeroExecutionTripwireTarget(filePath: string) {
    const normalized = filePath.replaceAll('\\', '/');
    if (!normalized.endsWith('.ts') || normalized.endsWith('.d.ts')) {
        return false;
    }
    if (normalized.startsWith('electron/platform-ipc/') || normalized.startsWith('packages/contracts/')) {
        return true;
    }
    if ((LOAD_BEARING_COVERAGE_FILES as readonly string[]).includes(normalized)) {
        return true;
    }
    if (normalized.startsWith('scan-cleanup-core/') || normalized.startsWith('scan-cleanup-adapters/')) {
        return true;
    }

    const basename = path.posix.basename(normalized);
    return basename.endsWith('.worker.ts')
        || basename.endsWith('Worker.ts')
        || basename === 'worker.ts'
        || normalized === 'electron/ocr/worker/main.ts';
}

async function collectProductionTypeScriptFiles(root: string, relativeDirectory: string): Promise<string[]> {
    const directory = path.join(root, relativeDirectory);
    const entries = await readdir(directory, {withFileTypes: true});
    const files: string[] = [];

    for (const entry of entries) {
        const relativePath = path.posix.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) {
            files.push(...await collectProductionTypeScriptFiles(root, relativePath));
        } else if (
            entry.isFile()
            && isZeroExecutionTripwireTarget(relativePath)
            && !(NON_UNIT_COVERAGE_ENTRYPOINTS as readonly string[]).includes(relativePath)
        ) {
            files.push(relativePath);
        }
    }
    return files;
}

export async function collectZeroExecutionTripwireTargets(projectRoot = process.cwd()) {
    const roots = [
        'app',
        'electron',
        'packages',
        'scan-cleanup-adapters',
        'scan-cleanup-core',
    ];
    const files = (await Promise.all(roots.map(root => collectProductionTypeScriptFiles(projectRoot, root)))).flat();
    return files.sort((left, right) => left.localeCompare(right));
}

export function checkZeroExecutionCoverage(
    targetFiles: readonly string[],
    coverageFiles: ReadonlyMap<string, ILineCoverageSummary>,
    changedTargetFileCount = 0,
): IZeroExecutionCoverageResult {
    const missingFiles: string[] = [];
    const zeroExecutionFiles: string[] = [];

    for (const filePath of targetFiles) {
        const coverage = coverageFiles.get(filePath);
        if (coverage === undefined) {
            missingFiles.push(filePath);
        } else if (coverage.total > 0 && coverage.covered === 0) {
            zeroExecutionFiles.push(filePath);
        }
    }

    return {
        changedTargetFileCount,
        missingFiles,
        passed: missingFiles.length === 0 && zeroExecutionFiles.length === 0,
        targetFileCount: targetFiles.length,
        zeroExecutionFiles,
    };
}

export function formatZeroExecutionCoverageResult(result: IZeroExecutionCoverageResult) {
    const changedTargetDescription = result.changedTargetFileCount > 0
        ? `, including ${result.changedTargetFileCount} changed production files`
        : '';
    const lines = [result.passed
        ? `Zero-execution coverage tripwire passed for ${result.targetFileCount} production files${changedTargetDescription}.`
        : `Zero-execution coverage tripwire failed for ${result.targetFileCount} production files${changedTargetDescription}.`];

    if (result.missingFiles.length > 0) {
        lines.push('Files missing from the coverage report (check coverage.include):');
        lines.push(...result.missingFiles.map(file => (
            `  ${file}: add it to coverage.include or classify it as a NON_UNIT_COVERAGE_ENTRYPOINTS entry.`
        )));
    }
    if (result.zeroExecutionFiles.length > 0) {
        lines.push('Production files with zero executed lines:');
        lines.push(...result.zeroExecutionFiles.map(file => (
            `  ${file}: add a unit test that imports and executes this file.`
        )));
    }
    return lines.join('\n');
}

export async function runZeroExecutionCoverage(options: {
    changedFiles?: readonly string[];
    projectRoot?: string;
    summaryPath?: string;
} = {}) {
    const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
    const summaryPath = path.resolve(projectRoot, options.summaryPath ?? DEFAULT_SUMMARY_PATH);
    const [
        summary,
        baselineTargetFiles,
    ] = await Promise.all([
        readFile(summaryPath, 'utf8'),
        collectZeroExecutionTripwireTargets(projectRoot),
    ]);
    const changedTargetFiles = options.changedFiles === undefined
        ? collectChangedProductionCoverageTargets({projectRoot})
        : selectChangedProductionCoverageTargets(options.changedFiles);
    const targetFiles = [...new Set([
        ...baselineTargetFiles,
        ...changedTargetFiles,
    ])].sort((left, right) => left.localeCompare(right));
    const result = checkZeroExecutionCoverage(
        targetFiles,
        parseLineCoverageSummary(summary, projectRoot),
        changedTargetFiles.length,
    );
    console.log(formatZeroExecutionCoverageResult(result));
    if (!result.passed) {
        process.exitCode = 1;
    }
    return result;
}

const isEntryPoint = process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntryPoint) {
    await runZeroExecutionCoverage();
}
