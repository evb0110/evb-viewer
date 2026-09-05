import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {execFileSync} from 'node:child_process';
import {
    mkdir,
    mkdtemp,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createTemporaryDirectoryRegistry} from '@tests/helpers/createTemporaryDirectoryRegistry';
import {
    checkZeroExecutionCoverage,
    collectChangedProductionCoverageTargets,
    collectZeroExecutionTripwireTargets,
    formatZeroExecutionCoverageResult,
    isZeroExecutionTripwireTarget,
    isProductionCoverageSource,
    NON_UNIT_COVERAGE_ENTRYPOINTS,
    parseLineCoverageSummary,
    runZeroExecutionCoverage,
    selectChangedProductionCoverageTargets,
} from '@scripts/checkZeroExecutionCoverage';

const temporaryDirectories = createTemporaryDirectoryRegistry();

afterEach(async () => {
    vi.restoreAllMocks();
    await temporaryDirectories.cleanup();
});

function fileSummary(total: number, covered: number) {
    return {lines: {
        total,
        covered,
        skipped: 0,
        pct: total === 0 ? 100 : covered / total * 100,
    }};
}

describe('zero-execution coverage tripwire', () => {
    it('targets high-risk IPC contracts and worker entrypoints', () => {
        expect(isZeroExecutionTripwireTarget('electron/platform-ipc/validatedIpcRegistrar.ts')).toBe(true);
        expect(isZeroExecutionTripwireTarget('packages/contracts/agent.ts')).toBe(true);
        expect(isZeroExecutionTripwireTarget('app/platform/browserSearch.worker.ts')).toBe(true);
        expect(isZeroExecutionTripwireTarget('electron/search/worker.ts')).toBe(true);
        expect(isZeroExecutionTripwireTarget('electron/ocr/worker/main.ts')).toBe(true);
        expect(isZeroExecutionTripwireTarget(
            'app/modules/workspace-shell/viewers/documentPageSourceFeaturePackState.ts',
        )).toBe(true);
        expect(isZeroExecutionTripwireTarget(
            'app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator.ts',
        )).toBe(true);
        expect(isZeroExecutionTripwireTarget('scan-cleanup-core/runScanCleanupConversion.ts')).toBe(true);
        expect(isZeroExecutionTripwireTarget('scan-cleanup-adapters/createScanCleanupRenderers.ts')).toBe(true);
        expect(isZeroExecutionTripwireTarget('electron/search/nativeSearch.ts')).toBe(false);
        expect(isZeroExecutionTripwireTarget('packages/contracts/types.d.ts')).toBe(false);
    });

    it('fails on missing report entries and executable files with no executed lines', () => {
        const projectRoot = '/repo';
        const coverage = parseLineCoverageSummary(JSON.stringify({
            total: fileSummary(10, 4),
            '/repo/electron/platform-ipc/a.ts': fileSummary(4, 0),
            '/repo/packages/contracts/typeOnly.ts': fileSummary(0, 0),
        }), projectRoot);
        const result = checkZeroExecutionCoverage([
            'electron/platform-ipc/a.ts',
            'packages/contracts/missing.ts',
            'packages/contracts/typeOnly.ts',
        ], coverage);

        expect(result).toEqual({
            changedTargetFileCount: 0,
            missingFiles: ['packages/contracts/missing.ts'],
            passed: false,
            targetFileCount: 3,
            zeroExecutionFiles: ['electron/platform-ipc/a.ts'],
        });
        const formatted = formatZeroExecutionCoverageResult(result);
        expect(formatted).toContain('Files missing from the coverage report');
        expect(formatted).toContain(
            'packages/contracts/missing.ts: add it to coverage.include or classify it as a NON_UNIT_COVERAGE_ENTRYPOINTS entry.',
        );
        expect(formatted).toContain('Production files with zero executed lines');
        expect(formatted).toContain(
            'electron/platform-ipc/a.ts: add a unit test that imports and executes this file.',
        );
    });

    it('rejects malformed line summaries at each input boundary', () => {
        expect(() => parseLineCoverageSummary('null')).toThrow('Coverage summary must be a JSON object.');
        expect(() => parseLineCoverageSummary('{"/repo/file.ts":null}', '/repo')).toThrow(
            'Coverage summary /repo/file.ts.lines must be an object.',
        );
        expect(() => parseLineCoverageSummary(JSON.stringify({'/repo/file.ts': {lines: {
            covered: 'invalid',
            total: 1,
        }}}), '/repo')).toThrow('Coverage summary /repo/file.ts.lines.covered must be a finite number.');
    });

    it('passes when every executable target has at least one executed line', () => {
        const coverage = new Map([
            [
                'electron/platform-ipc/a.ts',
                {
                    total: 4,
                    covered: 1,
                },
            ],
            [
                'packages/contracts/typeOnly.ts',
                {
                    total: 0,
                    covered: 0,
                },
            ],
        ]);
        const result = checkZeroExecutionCoverage([...coverage.keys()], coverage);

        expect(result.passed).toBe(true);
        expect(formatZeroExecutionCoverageResult(result)).toBe(
            'Zero-execution coverage tripwire passed for 2 production files.',
        );
    });

    it('selects every changed production source supported by the coverage report', () => {
        expect(isProductionCoverageSource('app/components/Viewer.vue')).toBe(true);
        expect(isProductionCoverageSource('app/runtime.ts')).toBe(true);
        expect(isProductionCoverageSource('electron/main.ts')).toBe(true);
        expect(isProductionCoverageSource('scripts/release/publish.mjs')).toBe(true);
        expect(isProductionCoverageSource('server/api/health.ts')).toBe(true);
        expect(isProductionCoverageSource('app/runtime.d.ts')).toBe(false);
        expect(isProductionCoverageSource('landing/app/app.vue')).toBe(false);
        expect(isProductionCoverageSource('native/src/lib.rs')).toBe(false);

        expect(selectChangedProductionCoverageTargets([
            'app/components/Viewer.vue',
            './app/components/Viewer.vue',
            'app/app.vue',
            'app/modules/workspace-shell/components/DocumentPasswordDialog.vue',
            'app/modules/workspace-shell/components/UnencryptedSaveDialog.vue',
            'electron/main.ts',
            'scripts/generate-freetext-lifecycle-fixture.mjs',
            'scripts/release/publish.mjs',
            'tests/unit/app/Viewer.test.ts',
        ])).toEqual([
            'app/components/Viewer.vue',
            'scripts/release/publish.mjs',
        ]);
        expect(NON_UNIT_COVERAGE_ENTRYPOINTS).toContain('app/app.vue');
        expect(NON_UNIT_COVERAGE_ENTRYPOINTS).toContain('app/modules/pdf-viewer/components/PdfViewer.vue');
        expect(NON_UNIT_COVERAGE_ENTRYPOINTS).toContain(
            'app/modules/pdf-viewer/components/PdfAnnotationEditorLayer.vue',
        );
        expect(NON_UNIT_COVERAGE_ENTRYPOINTS).toContain(
            'app/modules/pdf-viewer/runtime/rendering/createHiddenAnnotationLayerController.ts',
        );
        expect(NON_UNIT_COVERAGE_ENTRYPOINTS).toContain(
            'app/modules/workspace-shell/components/DocumentPasswordDialog.vue',
        );
        expect(NON_UNIT_COVERAGE_ENTRYPOINTS).toContain(
            'app/modules/workspace-shell/components/UnencryptedSaveDialog.vue',
        );
        expect(NON_UNIT_COVERAGE_ENTRYPOINTS).toContain('scripts/generate-freetext-lifecycle-fixture.mjs');
        expect(NON_UNIT_COVERAGE_ENTRYPOINTS).toContain('app/pages/electron.vue');
        expect(NON_UNIT_COVERAGE_ENTRYPOINTS).toContain('electron/preload.ts');
        expect(NON_UNIT_COVERAGE_ENTRYPOINTS).toContain(
            'app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations.worker.ts',
        );
        expect(NON_UNIT_COVERAGE_ENTRYPOINTS).toContain('app/platform/browser-api/browserPageOps.worker.ts');
        expect(NON_UNIT_COVERAGE_ENTRYPOINTS).toContain('app/platform/browser-api/browserPdfCombine.worker.ts');
    });

    it('discovers and checks targets across the widened production roots', async () => {
        const projectRoot = temporaryDirectories.register(
            await mkdtemp(path.join(tmpdir(), 'evb-zero-execution-')),
        );
        const targetFiles = [
            'app/platform/search.worker.ts',
            'electron/platform-ipc/nested/registrar.ts',
            'packages/contracts/messages.ts',
            'scan-cleanup-adapters/createRenderers.ts',
            'scan-cleanup-core/nested/runCleanup.ts',
        ];
        await Promise.all([
            ...targetFiles,
            'app/platform/ignored.js',
            'packages/contracts/types.d.ts',
        ].map(async (relativePath) => {
            await mkdir(path.dirname(path.join(projectRoot, relativePath)), {recursive: true});
            await writeFile(path.join(projectRoot, relativePath), 'export const value = true;', 'utf8');
        }));
        const summaryPath = path.join(projectRoot, 'summary.json');
        await writeFile(summaryPath, JSON.stringify({
            total: fileSummary(targetFiles.length, targetFiles.length),
            ...Object.fromEntries(targetFiles.map(filePath => [
                path.join(projectRoot, filePath),
                fileSummary(1, 1),
            ])),
        }), 'utf8');
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        expect(await collectZeroExecutionTripwireTargets(projectRoot)).toEqual(targetFiles);
        const result = await runZeroExecutionCoverage({
            changedFiles: [],
            projectRoot,
            summaryPath,
        });

        expect(result).toMatchObject({
            changedTargetFileCount: 0,
            missingFiles: [],
            passed: true,
            targetFileCount: targetFiles.length,
            zeroExecutionFiles: [],
        });
        expect(consoleLog).toHaveBeenCalledWith(
            `Zero-execution coverage tripwire passed for ${targetFiles.length} production files.`,
        );
    });

    it('adds changed Vue and TypeScript sources to the zero-execution gate', async () => {
        const projectRoot = temporaryDirectories.register(
            await mkdtemp(path.join(tmpdir(), 'evb-changed-zero-execution-')),
        );
        await Promise.all([
            'app/components',
            'electron',
            'packages',
            'scan-cleanup-adapters',
            'scan-cleanup-core',
        ].map(directory => mkdir(path.join(projectRoot, directory), {recursive: true})));
        await Promise.all([
            writeFile(
                path.join(projectRoot, 'app/components/Viewer.vue'),
                '<template><main /></template>',
                'utf8',
            ),
            writeFile(
                path.join(projectRoot, 'electron/runtime.ts'),
                'export const runtime = true;',
                'utf8',
            ),
        ]);
        const summaryPath = path.join(projectRoot, 'summary.json');
        await writeFile(summaryPath, JSON.stringify({
            total: fileSummary(2, 1),
            [path.join(projectRoot, 'app/components/Viewer.vue')]: fileSummary(1, 0),
            [path.join(projectRoot, 'electron/runtime.ts')]: fileSummary(1, 1),
        }), 'utf8');
        vi.spyOn(console, 'log').mockImplementation(() => undefined);

        const result = await runZeroExecutionCoverage({
            changedFiles: [
                'app/components/Viewer.vue',
                'electron/runtime.ts',
                'tests/unit/app/Viewer.test.ts',
            ],
            projectRoot,
            summaryPath,
        });

        expect(result).toMatchObject({
            changedTargetFileCount: 2,
            passed: false,
            targetFileCount: 2,
            zeroExecutionFiles: ['app/components/Viewer.vue'],
        });
        expect(formatZeroExecutionCoverageResult(result)).toContain(
            'including 2 changed production files',
        );
    });

    it('discovers changed production sources from an explicit Git range', async () => {
        const projectRoot = temporaryDirectories.register(
            await mkdtemp(path.join(tmpdir(), 'evb-changed-coverage-git-')),
        );
        const runGit = (...args: string[]) => {
            const result = execFileSync('git', [
                '-c',
                'commit.gpgSign=false',
                ...args,
            ], {
                cwd: projectRoot,
                encoding: 'utf8',
            });
            return result.trim();
        };
        runGit('init', '--quiet');
        runGit('config', 'user.email', 'coverage@example.test');
        runGit('config', 'user.name', 'Coverage Test');
        await mkdir(path.join(projectRoot, 'app/components'), {recursive: true});
        await writeFile(path.join(projectRoot, 'README.md'), 'base\n', 'utf8');
        runGit('add', '--all');
        runGit('commit', '--quiet', '-m', 'base');
        const baseSha = runGit('rev-parse', 'HEAD');
        await Promise.all([
            writeFile(
                path.join(projectRoot, 'app/components/Viewer.vue'),
                '<template><main /></template>\n',
                'utf8',
            ),
            writeFile(path.join(projectRoot, 'README.md'), 'head\n', 'utf8'),
        ]);
        runGit('add', '--all');
        runGit('commit', '--quiet', '-m', 'head');
        const headSha = runGit('rev-parse', 'HEAD');

        expect(collectChangedProductionCoverageTargets({
            baseSha,
            headSha,
            projectRoot,
        })).toEqual(['app/components/Viewer.vue']);

        await Promise.all([
            writeFile(path.join(projectRoot, 'app/components/Modified.ts'), 'export const modified = true;\n', 'utf8'),
            writeFile(path.join(projectRoot, 'app/components/Untracked.ts'), 'export const untracked = true;\n', 'utf8'),
        ]);
        runGit('add', 'app/components/Modified.ts');

        expect(collectChangedProductionCoverageTargets({
            baseSha,
            headSha: 'WORKTREE',
            projectRoot,
        })).toEqual([
            'app/components/Modified.ts',
            'app/components/Untracked.ts',
            'app/components/Viewer.vue',
        ]);
    });

    it('marks a failed filesystem-backed tripwire run for process failure', async () => {
        const projectRoot = temporaryDirectories.register(
            await mkdtemp(path.join(tmpdir(), 'evb-zero-execution-failure-')),
        );
        await Promise.all([
            'app/platform',
            'electron',
            'packages',
            'scan-cleanup-adapters',
            'scan-cleanup-core',
        ].map(directory => mkdir(path.join(projectRoot, directory), {recursive: true})));
        await writeFile(
            path.join(projectRoot, 'app/platform/search.worker.ts'),
            'export const value = true;',
            'utf8',
        );
        const summaryPath = path.join(projectRoot, 'summary.json');
        await writeFile(summaryPath, JSON.stringify({total: fileSummary(0, 0)}), 'utf8');
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const originalExitCode = process.exitCode;

        try {
            const result = await runZeroExecutionCoverage({
                changedFiles: [],
                projectRoot,
                summaryPath,
            });

            expect(result.passed).toBe(false);
            expect(result.missingFiles).toEqual(['app/platform/search.worker.ts']);
            expect(process.exitCode).toBe(1);
        } finally {
            process.exitCode = originalExitCode;
        }
    });
});
