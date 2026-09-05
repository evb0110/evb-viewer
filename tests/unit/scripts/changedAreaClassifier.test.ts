import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import {removeTemporaryDirectorySync} from '@tests/helpers/removeTemporaryDirectory';
import { spawnSync } from 'node:child_process';
import {
    describe,
    expect,
    it,
} from 'vitest';

const classifierPath = resolve(process.cwd(), 'scripts/ci/classify-changed-areas.mjs');

interface IChangedAreaClassification { matched: boolean }

interface IChangedAreaDefinition {
    output: string;
    owner: string;
    paths: string[];
}

interface IChangedAreaClassifierModule { classifyChangedFiles: (files: string[] | null) => Record<string, IChangedAreaClassification> }

interface IReleasePolicyModule {
    getCiChangedAreaPolicy: () => Record<string, IChangedAreaDefinition>;
    getNativePdfSaveDependencyPaths: () => string[];
}

function runGit(cwd: string, args: string[]) {
    const result = spawnSync('git', [
        '-c',
        'commit.gpgSign=false',
        ...args,
    ], {
        cwd,
        encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
}

function createTempRepository() {
    const root = mkdtempSync(join(tmpdir(), 'evb-changed-areas-git-'));
    runGit(root, [
        'init',
        '--quiet',
    ]);
    runGit(root, [
        'config',
        'user.email',
        'classifier@example.test',
    ]);
    runGit(root, [
        'config',
        'user.name',
        'Changed Area Classifier',
    ]);
    return root;
}

function commitAll(root: string, message: string) {
    runGit(root, [
        'add',
        '--all',
    ]);
    runGit(root, [
        'commit',
        '--quiet',
        '-m',
        message,
    ]);
    return runGit(root, [
        'rev-parse',
        'HEAD',
    ]);
}

function runClassifierForRange(root: string, base: string, head: string, includeWorktree = false) {
    const arguments_ = [
        classifierPath,
        `--base=${base}`,
        `--head=${head}`,
    ];
    if (includeWorktree) {
        arguments_.push('--include-worktree');
    }
    const result = spawnSync(process.execPath, arguments_, {
        cwd: root,
        encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as {
        files: string[];
        result: Record<string, IChangedAreaClassification>;
    };
}

const { classifyChangedFiles } = await import(
    pathToFileURL(classifierPath).href
) as IChangedAreaClassifierModule;
const {
    getCiChangedAreaPolicy,
    getNativePdfSaveDependencyPaths,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/release/policy.mjs')).href
) as IReleasePolicyModule;

describe('changed-area classifier', () => {
    it('classifies release-critical hooks, workflows, resources, and landing sources', () => {
        for (const file of [
            '.github/workflows/build.yml',
            'native/pdf-search/Cargo.toml',
            'resources/tesseract/tessdata/eng.traineddata',
            'scripts/afterPack.cjs',
            'scripts/afterSign.cjs',
            'scripts/build-minimal-ffmpeg-for-unpaper.sh',
            'scripts/cargo-artifacts.mjs',
            'scripts/checkSearchNativeParity.ts',
            'scripts/ci/classify-changed-areas.mjs',
            'scripts/generate-djvu-fidelity-corpus.mjs',
            'scripts/nativeResourceManifest.ts',
            'scripts/fixtures/ocr-quality-corpus.json',
            'scripts/ocrQualityMetrics.mjs',
            'scripts/test-ocr-native-smoke.mjs',
            'scripts/test-ocr-quality-corpus.mjs',
            'scripts/verify-packaged-startup.sh',
        ]) {
            expect(classifyChangedFiles([file]).native_or_build?.matched, file).toBe(true);
        }
        expect(classifyChangedFiles(['landing/app/pages/index.vue']).landing?.matched).toBe(true);
        expect(classifyChangedFiles(['packages/release-selection/index.ts']).landing?.matched).toBe(true);
        expect(classifyChangedFiles(['scripts/ci/classify-changed-areas.mjs']).landing?.matched).toBe(true);
        expect(classifyChangedFiles(['app/modules/pdf-viewer/PdfViewer.vue']).electron_smoke?.matched).toBe(true);
        expect(classifyChangedFiles(['scripts/electron-run/electronLaunch.ts']).electron_smoke?.matched).toBe(true);
        expect(classifyChangedFiles(['app/platform/browser/browserDocumentIdb.ts']).browser_integration?.matched).toBe(true);
        for (const file of [
            '.github/workflows/build-target.yml',
            'electron-builder.yml',
            'package.json',
            'pnpm-lock.yaml',
            'scripts/release/verifyPackagedCorePdfSmoke.ts',
            'tests/e2e/electron/helpers/packagedCorePdfJourney.ts',
        ]) {
            expect(classifyChangedFiles([file]).packaged_smoke?.matched, file).toBe(true);
        }
        expect(classifyChangedFiles(['app/app.vue'])).toMatchObject({
            landing: { matched: false },
            native_or_build: { matched: false },
            packaged_smoke: { matched: false },
        });
    });

    it('routes native PDF save sources to the required Electron save and reopen lane', () => {
        expect(getNativePdfSaveDependencyPaths()).toEqual(expect.arrayContaining([
            'app/modules/workspace-shell/composables/document-session/createDocumentPersistence.ts',
            'app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts',
            'packages/contracts/documentsPersistenceSchemas.ts',
            'packages/contracts/electronApiDocuments.ts',
            'packages/pdf-core/nativePdfMutationPolicy.ts',
            'app/modules/pdf-viewer/runtime/save/**',
            'native/evb-native-support/**',
        ]));
        expect(classifyChangedFiles(['native/pdf-page-ops/src/incremental.rs'])).toMatchObject({electron_save_reopen: {
            area: 'nativePdfSave',
            matched: true,
            owner: 'pr_electron_native_save_reopen',
        }});
        expect(classifyChangedFiles(['electron/features/documents/main/documentFileWriteHandlers.ts']))
            .toMatchObject({electron_save_reopen: {matched: true}});
        expect(classifyChangedFiles(['native/pdf-search/src/main.rs']))
            .toMatchObject({electron_save_reopen: {matched: false}});
        expect(classifyChangedFiles(['tests/integration/native/nativePdfSave.test.ts']))
            .toMatchObject({native_or_build: {matched: true}});
        expect(classifyChangedFiles(['packages/contracts/electronApiDocuments.ts']))
            .toMatchObject({electron_save_reopen: {matched: true}});
        expect(classifyChangedFiles(['app/modules/pdf-viewer/runtime/save/pdfDocumentPersistence.ts']))
            .toMatchObject({electron_save_reopen: {matched: true}});
        for (const file of [
            'app/modules/workspace-shell/composables/document-session/createDocumentPersistence.ts',
            'app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts',
            'packages/contracts/documentsPersistenceSchemas.ts',
            'packages/pdf-core/nativePdfMutationPolicy.ts',
            'native/evb-native-support/src/lib.rs',
        ]) {
            expect(classifyChangedFiles([file]), file).toMatchObject({
                electron_save_reopen: {matched: true},
                electron_smoke: {matched: true},
                native_or_build: {matched: true},
            });
        }
    });

    it('runs browser journeys for their production graph without claiming unrelated platforms', () => {
        for (const file of [
            'app/app.vue',
            'app/modules/pdf-viewer/engine/pdf-page-scale/pdfPageScale.ts',
            'drizzle/schema.ts',
            'nuxt.config.ts',
            'packages/pdf-core/index.ts',
            'public/pdfjs/pdf.worker.min.mjs',
            'scan-cleanup-adapters/createScanCleanupRenderers.ts',
            'scan-cleanup-core/detection.ts',
            'server/api/releases.get.ts',
            'tests/fixtures/electron/generated-text.pdf',
            'tests/helpers/pdfAnnotationCommentsListHarness.ts',
            'tests/setup.ts',
            'tsconfig.workspace-paths.json',
        ]) {
            expect(classifyChangedFiles([file]).browser_integration?.matched, file).toBe(true);
        }

        for (const file of [
            'docs/releasing.md',
            'electron/main.ts',
            'landing/app/pages/index.vue',
            'native/pdf-search/src/main.rs',
        ]) {
            expect(classifyChangedFiles([file]).browser_integration?.matched, file).toBe(false);
        }
        expect(classifyChangedFiles(null).browser_integration?.matched).toBe(true);
    });

    it('owns scan-cleanup export dependencies and fails closed when the diff is unknown', () => {
        for (const file of [
            'app/modules/scan-cleanup/geometry/placement.ts',
            'native/pdf-image-combine/src/lib.rs',
            'native/scan-cleanup/src/mrc.rs',
            'packages/contracts/scan-cleanup/domain.ts',
            'public/wasm/evb-pdf-image-combine.wasm',
            'scan-cleanup-adapters/createScanCleanupRenderers.ts',
            'scan-cleanup-core/detection.ts',
            'scripts/ci-install-dependencies.mjs',
            'scripts/ci/apt-install.sh',
            'scripts/ci/scan-cleanup-oracles.sh',
            'scripts/diagnostics/scan-cleanup-preview-harness.mjs',
            'scripts/diagnostics/stroke-weight-oracle/stroke-weight-oracle.mjs',
            'scripts/flattenLayeredManifestPage.ts',
            'scripts/scan-cleanup-convert.ts',
            'scripts/scanCleanupCliAdapters.ts',
            'tests/fixtures/electron/test-scanned.pdf',
            'tsconfig.json',
        ]) {
            expect(classifyChangedFiles([file]).scan_cleanup_export?.matched, file).toBe(true);
        }

        for (const file of [
            'docs/releasing.md',
            'electron/updater.ts',
            'landing/app/pages/index.vue',
            'native/pdf-search/src/main.rs',
        ]) {
            expect(classifyChangedFiles([file]).scan_cleanup_export?.matched, file).toBe(false);
        }
        expect(classifyChangedFiles(null).scan_cleanup_export?.matched).toBe(true);
    });

    it('keeps workflow outputs and job owners aligned with the canonical policy', () => {
        const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
        const changedAreasStart = workflow.indexOf('  pr_changed_areas:');
        const browserIntegrationStart = workflow.indexOf('  pr_browser_integration:');
        if (changedAreasStart === -1) {
            throw new Error('CI workflow is missing the pr_changed_areas job.');
        }
        if (browserIntegrationStart === -1) {
            throw new Error('CI workflow is missing the pr_browser_integration job.');
        }
        if (browserIntegrationStart <= changedAreasStart) {
            throw new Error('pr_browser_integration must follow pr_changed_areas in the CI workflow.');
        }
        const changedAreaJob = workflow.slice(
            changedAreasStart,
            browserIntegrationStart,
        );

        for (const definition of Object.values(getCiChangedAreaPolicy())) {
            expect(changedAreaJob).toContain(`${definition.output}: \${{ steps.classify.outputs.${definition.output} }}`);
            expect(workflow).toContain(`  ${definition.owner}:`);
            for (const pattern of definition.paths) {
                if (pattern === 'scripts/ci/classify-changed-areas.mjs') {
                    continue;
                }
                expect(changedAreaJob).not.toContain(pattern);
            }
        }
    });

    it('writes executable GitHub outputs from the canonical policy', () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'evb-changed-areas-'));
        const outputPath = join(tempDir, 'github-output');
        try {
            const result = spawnSync(process.execPath, [
                classifierPath,
                '--file=scripts/afterPack.cjs',
                '--file=landing/app/pages/index.vue',
            ], {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    GITHUB_OUTPUT: outputPath,
                },
            });

            expect(result.status, result.stderr).toBe(0);
            expect(readFileSync(outputPath, 'utf8').trim().split('\n').sort()).toEqual([
                'browser_integration=false',
                'electron_save_reopen=false',
                'electron_smoke=false',
                'landing=true',
                'native_or_build=true',
                'packaged_smoke=true',
                'scan_cleanup_export=false',
            ]);
        } finally {
            removeTemporaryDirectorySync(tempDir);
        }
    });

    it('classifies deletion of a landing source from an executable git diff', () => {
        const root = createTempRepository();
        try {
            const landingPage = join(root, 'landing/app/pages/removed.vue');
            mkdirSync(resolve(landingPage, '..'), {recursive: true});
            writeFileSync(landingPage, '<template />\n', 'utf8');
            const base = commitAll(root, 'add landing page');
            rmSync(landingPage);
            const head = commitAll(root, 'delete landing page');

            const classification = runClassifierForRange(root, base, head);

            expect(classification.files).toContain('landing/app/pages/removed.vue');
            expect(classification.result.landing?.matched).toBe(true);
        } finally {
            removeTemporaryDirectorySync(root);
        }
    });

    it('classifies a rename out of a relevant area as delete plus add', () => {
        const root = createTempRepository();
        try {
            const source = join(root, 'landing/app/pages/moved.vue');
            const destination = join(root, 'notes/moved.vue');
            mkdirSync(resolve(source, '..'), {recursive: true});
            writeFileSync(source, '<template />\n', 'utf8');
            const base = commitAll(root, 'add landing page');
            mkdirSync(resolve(destination, '..'), {recursive: true});
            runGit(root, [
                'mv',
                'landing/app/pages/moved.vue',
                'notes/moved.vue',
            ]);
            const head = commitAll(root, 'move landing page out');

            const classification = runClassifierForRange(root, base, head);

            expect(classification.files).toEqual(expect.arrayContaining([
                'landing/app/pages/moved.vue',
                'notes/moved.vue',
            ]));
            expect(classification.result.landing?.matched).toBe(true);
        } finally {
            removeTemporaryDirectorySync(root);
        }
    });

    it('includes staged, unstaged, and untracked paths for agent-run gates', () => {
        const root = createTempRepository();
        try {
            const trackedPath = join(root, 'app/modules/scan-cleanup/tracked.ts');
            mkdirSync(resolve(trackedPath, '..'), {recursive: true});
            writeFileSync(trackedPath, 'export const tracked = 1;\n', 'utf8');
            const base = commitAll(root, 'add tracked scan-cleanup source');

            writeFileSync(trackedPath, 'export const tracked = 2;\n', 'utf8');
            const stagedPath = join(root, 'native/scan-cleanup/staged.rs');
            mkdirSync(resolve(stagedPath, '..'), {recursive: true});
            writeFileSync(stagedPath, 'pub const STAGED: bool = true;\n', 'utf8');
            runGit(root, [
                'add',
                'native/scan-cleanup/staged.rs',
            ]);
            const stagedThenDeletedPath = join(root, 'app/modules/scan-cleanup/staged-then-deleted.ts');
            writeFileSync(stagedThenDeletedPath, 'export const stagedThenDeleted = true;\n', 'utf8');
            runGit(root, [
                'add',
                'app/modules/scan-cleanup/staged-then-deleted.ts',
            ]);
            unlinkSync(stagedThenDeletedPath);
            const untrackedPath = join(root, 'scan-cleanup-core/untracked.ts');
            mkdirSync(resolve(untrackedPath, '..'), {recursive: true});
            writeFileSync(untrackedPath, 'export const untracked = true;\n', 'utf8');

            const classification = runClassifierForRange(root, base, base, true);

            expect(classification.files).toEqual(expect.arrayContaining([
                'app/modules/scan-cleanup/tracked.ts',
                'app/modules/scan-cleanup/staged-then-deleted.ts',
                'native/scan-cleanup/staged.rs',
                'scan-cleanup-core/untracked.ts',
            ]));
            expect(classification.result.scan_cleanup_export?.matched).toBe(true);
            expect(classification.result.native_or_build?.matched).toBe(true);
        } finally {
            removeTemporaryDirectorySync(root);
        }
    });

    it.skipIf(process.platform === 'win32')('includes tracked file type changes for agent-run gates', () => {
        const root = createTempRepository();
        try {
            const trackedPath = join(root, 'app/modules/scan-cleanup/type-change.ts');
            mkdirSync(resolve(trackedPath, '..'), {recursive: true});
            writeFileSync(trackedPath, 'export const value = true;\n', 'utf8');
            const base = commitAll(root, 'add tracked scan-cleanup source');

            unlinkSync(trackedPath);
            symlinkSync('replacement.ts', trackedPath);

            const classification = runClassifierForRange(root, base, base, true);

            expect(classification.files).toContain('app/modules/scan-cleanup/type-change.ts');
            expect(classification.result.scan_cleanup_export?.matched).toBe(true);
        } finally {
            removeTemporaryDirectorySync(root);
        }
    });
});
