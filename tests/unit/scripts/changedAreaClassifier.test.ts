import {
    chmodSync,
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
    delimiter,
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
const pushDiffBasePath = resolve(process.cwd(), 'scripts/ci/push-diff-base.sh');
const lanesModulePath = resolve(process.cwd(), 'scripts/electron-e2e-lanes.mjs');

interface IChangedAreaSelection {
    lanes: string[];
    selected: string[];
    verifiedTree: boolean;
}

interface IChangedAreaClassifierModule {
    ALL_GATED_JOBS: readonly string[];
    classifyChangedFiles: (
        files: string[] | null,
        options?: {
            event?: string;
            verifiedTree?: boolean;
        },
    ) => IChangedAreaSelection;
}

interface IElectronLanesModule {
    listRequiredElectronE2ELanes: () => Array<{
        directory: string;
        name: string;
    }>;
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

function runClassifierForRange(
    root: string,
    base: string,
    head: string,
    options: {
        event?: string;
        includeWorktree?: boolean;
    } = {},
) {
    const arguments_ = [
        classifierPath,
        `--base=${base}`,
        `--head=${head}`,
    ];
    if (options.event) {
        arguments_.push(`--event=${options.event}`);
    }
    if (options.includeWorktree) {
        arguments_.push('--include-worktree');
    }
    const result = spawnSync(process.execPath, arguments_, {
        cwd: root,
        encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as {
        files: string[] | null;
        lanes: string[];
        selected: string[];
        verifiedTree: boolean;
    };
}

function runPushDiffBase(
    root: string,
    before: string,
    head: string,
    extraEnv: Record<string, string> = {},
) {
    const bash = process.platform === 'win32'
        ? resolve(runGit(root, ['--exec-path']), '../../../bin/bash.exe')
        : 'bash';
    const result = spawnSync(bash, [
        pushDiffBasePath,
        before,
        head,
    ], {
        cwd: root,
        encoding: 'utf8',
        env: {
            ...process.env,
            ...extraEnv,
        },
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
}

const {
    ALL_GATED_JOBS,
    classifyChangedFiles,
} = await import(pathToFileURL(classifierPath).href) as IChangedAreaClassifierModule;
const { listRequiredElectronE2ELanes } = await import(
    pathToFileURL(lanesModulePath).href
) as IElectronLanesModule;
const ALL_LANES = listRequiredElectronE2ELanes().map(lane => lane.name).sort();

describe('changed-area classifier', () => {
    it('keeps docs, markdown, hooks, and non-ci workflows to lint, unit, and build_wasm', () => {
        for (const file of [
            'README.md',
            'AGENTS.md',
            'docs/contributing/ci.md',
            'native/pdf-page-ops/README.md',
            '.husky/pre-push',
            '.github/workflows/release.yml',
            '.github/workflows/ci-nightly.yml',
            '.github/workflows/dependency-audit.yml',
        ]) {
            const selection = classifyChangedFiles([file], {event: 'pull_request'});
            expect(selection.selected, file).toEqual([
                'publication_policy',
                'lint',
                'unit',
                'build_wasm',
            ]);
            expect(selection.lanes, file).toEqual([]);
        }
    });

    it('selects landing and browser_integration for landing and shared landing package changes', () => {
        const selection = classifyChangedFiles(['landing/app/pages/index.vue'], {event: 'pull_request'});
        expect(selection.selected).toEqual([
            'publication_policy',
            'lint',
            'unit',
            'build_wasm',
            'browser_integration',
            'landing',
        ]);
        expect(selection.lanes).toEqual([]);

        for (const file of [
            'packages/i18n-core/index.ts',
            'packages/release-selection/index.ts',
        ]) {
            const sharedSelection = classifyChangedFiles([file], {event: 'pull_request'});
            expect(sharedSelection.selected, file).toContain('landing');
            expect(sharedSelection.selected, file).toContain('electron_e2e');
        }
    });

    it('selects the product suite and all Electron lanes for product paths', () => {
        for (const file of [
            'app/app.vue',
            'electron/main.ts',
            'packages/pdf-core/index.ts',
            'server/api/releases.get.ts',
            'public/pdfjs/pdf.worker.min.mjs',
            'vendor/pdfjs/pdf.mjs',
            'resources/tesseract/tessdata/eng.traineddata',
            'build/icons/icon.png',
            'types/global.d.ts',
            'nuxt.config.ts',
            'electron-builder.yml',
            'tests/fixtures/electron/generated-text.pdf',
            'tests/helpers/pdfAnnotationCommentsListHarness.ts',
            'tests/setup.ts',
            'tests/setupApp.ts',
        ]) {
            const selection = classifyChangedFiles([file], {event: 'pull_request'});
            expect(selection.selected, file).toEqual([
                'publication_policy',
                'lint',
                'unit',
                'build_wasm',
                'strict_build',
                'native_pdf_integration',
                'windows_atomic_pdf_replacement',
                'browser_integration',
                'electron_e2e',
            ]);
            expect(selection.lanes, file).toEqual(ALL_LANES);
        }
    });

    it('selects rust, product jobs, and scan_cleanup_oracles for native, contract, and embedded-font paths', () => {
        for (const file of [
            'native/pdf-page-ops/src/incremental.rs',
            'native/pdf-search/src/lib.rs',
            '.cargo/config.toml',
            'rust-toolchain.toml',
            'public/fonts/annotation/DejaVuSans.ttf',
            'public/pdf/standard_fonts/LiberationSans-Regular.ttf',
            'tests/fixtures/electron/interop/hebrew-punctuation-reference.pdf',
        ]) {
            const selection = classifyChangedFiles([file], {event: 'pull_request'});
            expect(selection.selected, file).toEqual([
                'publication_policy',
                'lint',
                'unit',
                'build_wasm',
                'rust',
                'strict_build',
                'native_pdf_integration',
                'windows_atomic_pdf_replacement',
                'browser_integration',
                'scan_cleanup_oracles',
                'electron_e2e',
            ]);
            expect(selection.lanes, file).toEqual(ALL_LANES);
        }

        const contractsSelection = classifyChangedFiles(['packages/contracts/electronApiDocuments.ts'], {event: 'pull_request'});
        expect(contractsSelection.selected).toContain('rust');
        expect(contractsSelection.selected).toContain('landing');
        expect(contractsSelection.selected).toContain('scan_cleanup_oracles');
        expect(contractsSelection.lanes).toEqual(ALL_LANES);
    });

    it('adds scan_cleanup_oracles additively and includes strict_build and build_wasm dependencies', () => {
        for (const file of [
            'app/modules/scan-cleanup/geometry/placement.ts',
            'packages/scan-cleanup/core/detection.ts',
            'electron/features/scan-cleanup/handler.ts',
            'tests/fixtures/electron/test-scanned.pdf',
            'tests/fixtures/release/scan-cleanup-four-page-grayscale.pdf',
        ]) {
            const selection = classifyChangedFiles([file], {event: 'pull_request'});
            expect(selection.selected, file).toContain('scan_cleanup_oracles');
            expect(selection.selected, file).toContain('strict_build');
            expect(selection.selected, file).toContain('electron_e2e');
            expect(selection.selected, file).not.toContain('rust');
            expect(selection.lanes, file).toEqual(ALL_LANES);
        }

        for (const file of [
            'scripts/scan-cleanup-convert.ts',
            'scripts/scanCleanupCliAdapters.ts',
            'scripts/diagnostics/stroke-weight-oracle/stroke_weight_oracle.py',
            'tests/unit/electron/scanCleanupPipeline.test.ts',
            'tests/unit/scripts/scanCleanupStagedWindowEndToEnd.test.ts',
            'tests/unit/scripts/scanCleanupDiagnosticsManifestRoots.test.ts',
        ]) {
            const selection = classifyChangedFiles([file], {event: 'pull_request'});
            expect(selection.selected, file).toEqual([
                'publication_policy',
                'lint',
                'unit',
                'build_wasm',
                'strict_build',
                'scan_cleanup_oracles',
            ]);
            expect(selection.lanes, file).toEqual([]);
        }
    });

    it('scopes test-only changes to their specific lane or integration job', () => {
        const singleLane = classifyChangedFiles(
            ['tests/e2e/electron/save/savePipeline.e2e.test.ts'],
            {event: 'pull_request'},
        );
        expect(singleLane.selected).toEqual([
            'publication_policy',
            'lint',
            'unit',
            'build_wasm',
            'strict_build',
            'electron_e2e',
        ]);
        expect(singleLane.lanes).toEqual(['e2e-save']);

        const twoLanes = classifyChangedFiles([
            'tests/e2e/electron/save/savePipeline.e2e.test.ts',
            'tests/e2e/electron/annotations/annotationLifecycle.e2e.test.ts',
        ], {event: 'pull_request'});
        expect(twoLanes.lanes).toEqual([
            'e2e-annotations',
            'e2e-save',
        ]);

        for (const file of [
            'tests/unit/scripts/publicationPolicy.test.ts',
            'tests/e2e/electron/nightly/large-pdf/largePdfAnnotationSave.e2e.test.ts',
        ]) {
            const selection = classifyChangedFiles([file], {event: 'pull_request'});
            expect(selection.selected, file).toEqual([
                'publication_policy',
                'lint',
                'unit',
                'build_wasm',
            ]);
            expect(selection.lanes, file).toEqual([]);
        }

        const browserTests = classifyChangedFiles(
            ['tests/integration/browser/documentLifecycle.test.ts'],
            {event: 'pull_request'},
        );
        expect(browserTests.selected).toEqual([
            'publication_policy',
            'lint',
            'unit',
            'build_wasm',
            'browser_integration',
        ]);
        expect(browserTests.lanes).toEqual([]);

        const nativeTests = classifyChangedFiles(
            ['tests/integration/native/nativePdfSave.test.ts'],
            {event: 'pull_request'},
        );
        expect(nativeTests.selected).toEqual([
            'publication_policy',
            'lint',
            'unit',
            'build_wasm',
            'strict_build',
            'native_pdf_integration',
            'windows_atomic_pdf_replacement',
        ]);
        expect(nativeTests.lanes).toEqual([]);
    });

    it('fails open to every gated job and all lanes for unmatched files or null diffs', () => {
        for (const file of [
            '.github/workflows/ci.yml',
            '.github/actions/setup-ci-env/action.yml',
            'scripts/afterPack.cjs',
            'scripts/ci/classify-changed-areas.mjs',
            'package.json',
            'pnpm-lock.yaml',
            'vitest.config.ts',
            'tsconfig.json',
            'tests/e2e/electron/helpers/session.ts',
            'tests/e2e/electron/globalSetup.ts',
        ]) {
            const selection = classifyChangedFiles([file], {event: 'pull_request'});
            expect(selection.selected, file).toEqual([
                'publication_policy',
                ...ALL_GATED_JOBS,
            ]);
            expect(selection.lanes, file).toEqual(ALL_LANES);
        }

        const nullDiff = classifyChangedFiles(null, {event: 'push'});
        expect(nullDiff.selected).toEqual([
            'publication_policy',
            ...ALL_GATED_JOBS,
        ]);
        expect(nullDiff.lanes).toEqual(ALL_LANES);
    });

    it('handles workflow_dispatch and verified-tree push runs inside the classifier', () => {
        const dispatch = classifyChangedFiles(['README.md'], {event: 'workflow_dispatch'});
        expect(dispatch.selected).toEqual([...ALL_GATED_JOBS]);
        expect(dispatch.selected).not.toContain('publication_policy');
        expect(dispatch.lanes).toEqual(ALL_LANES);
        expect(dispatch.verifiedTree).toBe(false);

        const verified = classifyChangedFiles([], {
            event: 'push',
            verifiedTree: true,
        });
        expect(verified.selected).toEqual([
            'publication_policy',
            'build_wasm',
            'strict_build',
            'electron_e2e',
        ]);
        expect(verified.lanes).toEqual(['e2e-smoke']);
        expect(verified.verifiedTree).toBe(true);
    });

    it('writes selected and lanes JSON outputs to GITHUB_OUTPUT', () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'evb-changed-areas-'));
        const outputPath = join(tempDir, 'github-output');
        try {
            const result = spawnSync(process.execPath, [
                classifierPath,
                '--event=pull_request',
                '--file=landing/app/pages/index.vue',
            ], {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    GITHUB_OUTPUT: outputPath,
                },
            });

            expect(result.status, result.stderr).toBe(0);
            const lines = readFileSync(outputPath, 'utf8').trim().split('\n');
            expect(lines).toEqual([
                'selected=["publication_policy","lint","unit","build_wasm","browser_integration","landing"]',
                'lanes=[]',
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

            const classification = runClassifierForRange(root, base, head, {event: 'pull_request'});

            expect(classification.files).toContain('landing/app/pages/removed.vue');
            expect(classification.selected).toContain('landing');
            expect(classification.selected).toContain('browser_integration');
        } finally {
            removeTemporaryDirectorySync(root);
        }
    });

    it('classifies a rename out of a relevant area as delete plus add', () => {
        const root = createTempRepository();
        try {
            const source = join(root, 'landing/app/pages/moved.vue');
            const destination = join(root, 'docs/moved.md');
            mkdirSync(resolve(source, '..'), {recursive: true});
            writeFileSync(source, '<template />\n', 'utf8');
            const base = commitAll(root, 'add landing page');
            mkdirSync(resolve(destination, '..'), {recursive: true});
            runGit(root, [
                'mv',
                'landing/app/pages/moved.vue',
                'docs/moved.md',
            ]);
            const head = commitAll(root, 'move landing page out');

            const classification = runClassifierForRange(root, base, head, {event: 'pull_request'});

            expect(classification.files).toEqual(expect.arrayContaining([
                'landing/app/pages/moved.vue',
                'docs/moved.md',
            ]));
            expect(classification.selected).toContain('landing');
        } finally {
            removeTemporaryDirectorySync(root);
        }
    });

    it('detects verified-tree push when base equals head without --include-worktree', () => {
        const root = createTempRepository();
        try {
            const source = join(root, 'app/app.vue');
            mkdirSync(resolve(source, '..'), {recursive: true});
            writeFileSync(source, '<template />\n', 'utf8');
            const head = commitAll(root, 'verified merge');

            const classification = runClassifierForRange(root, head, head, {event: 'push'});

            expect(classification.verifiedTree).toBe(true);
            expect(classification.selected).toEqual([
                'publication_policy',
                'build_wasm',
                'strict_build',
                'electron_e2e',
            ]);
            expect(classification.lanes).toEqual(['e2e-smoke']);
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
            const untrackedPath = join(root, 'packages/scan-cleanup/core/untracked.ts');
            mkdirSync(resolve(untrackedPath, '..'), {recursive: true});
            writeFileSync(untrackedPath, 'export const untracked = true;\n', 'utf8');

            const classification = runClassifierForRange(root, base, base, {includeWorktree: true});

            expect(classification.files).toEqual(expect.arrayContaining([
                'app/modules/scan-cleanup/tracked.ts',
                'app/modules/scan-cleanup/staged-then-deleted.ts',
                'native/scan-cleanup/staged.rs',
                'packages/scan-cleanup/core/untracked.ts',
            ]));
            expect(classification.selected).toContain('scan_cleanup_oracles');
            expect(classification.selected).toContain('rust');
            expect(classification.verifiedTree).toBe(false);
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

            const classification = runClassifierForRange(root, base, base, {includeWorktree: true});

            expect(classification.files).toContain('app/modules/scan-cleanup/type-change.ts');
            expect(classification.selected).toContain('scan_cleanup_oracles');
        } finally {
            removeTemporaryDirectorySync(root);
        }
    });

    describe('push-diff-base.sh', () => {
        it('returns unavailable-push-base for new refs even when HEAD has a parent', () => {
            const root = createTempRepository();
            try {
                const source = join(root, 'app/app.vue');
                mkdirSync(resolve(source, '..'), {recursive: true});
                writeFileSync(source, '<template>1</template>\n', 'utf8');
                const first = commitAll(root, 'first root commit');
                writeFileSync(source, '<template>2</template>\n', 'utf8');
                const second = commitAll(root, 'second commit');

                for (const [
                    before,
                    head,
                ] of [
                    [
                        '0000000000000000000000000000000000000000',
                        first,
                    ],
                    [
                        '0000000000000000000000000000000000000000',
                        second,
                    ],
                    [
                        '',
                        second,
                    ],
                ]) {
                    const base = runPushDiffBase(root, before ?? '', head ?? '');
                    expect(base).toBe('unavailable-push-base');
                    expect(runClassifierForRange(root, base, head ?? '', {event: 'push'}).files).toBeNull();
                }
            } finally {
                removeTemporaryDirectorySync(root);
            }
        });

        it.skipIf(process.platform === 'win32')('intersects push runs in one query, ignores in-flight before, and proves merged PR trees', () => {
            const root = createTempRepository();
            const fakeBin = mkdtempSync(join(tmpdir(), 'evb-fake-gh-'));
            const ghLog = join(fakeBin, 'gh-calls.log');
            try {
                const filePath = join(root, 'app/app.vue');
                mkdirSync(resolve(filePath, '..'), {recursive: true});
                writeFileSync(filePath, '<template>v1</template>\n', 'utf8');
                const provedOld = commitAll(root, 'proved old');

                writeFileSync(filePath, '<template>v2</template>\n', 'utf8');
                const inFlightBefore = commitAll(root, 'in-flight before');

                runGit(root, [
                    'checkout',
                    '-q',
                    '-b',
                    'feature',
                ]);
                writeFileSync(filePath, '<template>v3</template>\n', 'utf8');
                const prHead = commitAll(root, 'pr head');

                runGit(root, [
                    'checkout',
                    '-q',
                    '-',
                ]);
                runGit(root, [
                    'merge',
                    '--quiet',
                    '--no-ff',
                    'feature',
                    '-m',
                    'merge feature',
                ]);
                const mergeHead = runGit(root, [
                    'rev-parse',
                    'HEAD',
                ]);

                const fakeGh = join(fakeBin, 'gh');
                writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${ghLog}"
exec "${process.execPath}" --input-type=module -e '
  const args = process.argv.slice(1);
  const query = args.join(" ");
  const jqIndex = args.indexOf("--jq");
  const jqFilter = jqIndex === -1 ? "" : (args[jqIndex + 1] ?? "");
  if (query.includes("event=push")) {
    const runs = JSON.parse(process.env.FAKE_PUSH_RUNS_JSON ?? "{\\"workflow_runs\\":[]}").workflow_runs;
    for (const run of runs) {
      if (run.status === "completed" && run.conclusion === "success") {
        console.log(run.head_sha);
      }
    }
  } else if (query.includes("head_sha=${prHead}")) {
    if (!jqFilter.includes("env.GITHUB_REF_NAME")) {
      process.exit(2);
    }
    const refName = process.env.GITHUB_REF_NAME ?? "";
    const runs = JSON.parse(process.env.FAKE_PR_RUNS_JSON ?? "{\\"workflow_runs\\":[]}").workflow_runs;
    const count = runs.filter(run =>
      run.status === "completed"
      && run.conclusion === "success"
      && (
        run.event === "push"
        || (
          run.event === "pull_request"
          && Array.isArray(run.pull_requests)
          && run.pull_requests.some(pr => pr.base?.ref === refName)
        )
      ),
    ).length;
    console.log(String(count));
  } else {
    process.exit(1);
  }
' -- "$@"
`, 'utf8');
                chmodSync(fakeGh, 0o755);

                const baseEnv = {
                    GITHUB_REF_NAME: 'main',
                    GITHUB_REPOSITORY: 'evb0110/evb-viewer',
                    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
                };

                const pushRuns = (runs: Array<{
                    conclusion: string | null;
                    head_sha: string;
                    status: string;
                }>) => JSON.stringify({workflow_runs: runs});

                const prRuns = (runs: Array<{
                    conclusion: string | null;
                    event: string;
                    pull_requests?: Array<{base: {ref: string}}>;
                    status: string;
                }>) => JSON.stringify({workflow_runs: runs});

                const provedBeforePushRuns = pushRuns([
                    {
                        conclusion: 'success',
                        head_sha: inFlightBefore,
                        status: 'completed',
                    },
                    {
                        conclusion: 'success',
                        head_sha: provedOld,
                        status: 'completed',
                    },
                ]);

                const passingMainPrRuns = prRuns([{
                    conclusion: 'success',
                    event: 'pull_request',
                    pull_requests: [{base: {ref: 'main'}}],
                    status: 'completed',
                }]);

                // Case 1: `inFlightBefore` is in_progress (not completed success);
                // walks back to `provedOld` in ONE query and does NOT prove the merge tree.
                writeFileSync(ghLog, '', 'utf8');
                const baseWhenInFlight = runPushDiffBase(root, inFlightBefore, mergeHead, {
                    ...baseEnv,
                    FAKE_PR_RUNS_JSON: passingMainPrRuns,
                    FAKE_PUSH_RUNS_JSON: pushRuns([
                        {
                            conclusion: null,
                            head_sha: inFlightBefore,
                            status: 'in_progress',
                        },
                        {
                            conclusion: 'success',
                            head_sha: provedOld,
                            status: 'completed',
                        },
                    ]),
                });
                expect(baseWhenInFlight).toBe(provedOld);
                expect(readFileSync(ghLog, 'utf8').trim().split('\n')).toHaveLength(1);

                // Case 2: `inFlightBefore` IS proved and PR head passed against `main` with identical tree ->
                // returns `mergeHead` (verified tree) using 2 queries total (1 push + 1 pr head).
                writeFileSync(ghLog, '', 'utf8');
                const baseWhenProved = runPushDiffBase(root, inFlightBefore, mergeHead, {
                    ...baseEnv,
                    FAKE_PR_RUNS_JSON: passingMainPrRuns,
                    FAKE_PUSH_RUNS_JSON: provedBeforePushRuns,
                });
                expect(baseWhenProved).toBe(mergeHead);
                expect(readFileSync(ghLog, 'utf8').trim().split('\n')).toHaveLength(2);

                // Case 3: `inFlightBefore` IS proved, but PR head only passed against a DIFFERENT target branch ->
                // falls back to `inFlightBefore`, NOT `mergeHead`.
                const baseWhenPrTargetedOtherBranch = runPushDiffBase(root, inFlightBefore, mergeHead, {
                    ...baseEnv,
                    FAKE_PR_RUNS_JSON: prRuns([{
                        conclusion: 'success',
                        event: 'pull_request',
                        pull_requests: [{base: {ref: 'other-branch'}}],
                        status: 'completed',
                    }]),
                    FAKE_PUSH_RUNS_JSON: provedBeforePushRuns,
                });
                expect(baseWhenPrTargetedOtherBranch).toBe(inFlightBefore);

                // Case 4: `inFlightBefore` IS proved but PR head has no passing run ->
                // falls back to `inFlightBefore`, NOT `mergeHead`.
                const baseWhenPrUnproved = runPushDiffBase(root, inFlightBefore, mergeHead, {
                    ...baseEnv,
                    FAKE_PR_RUNS_JSON: prRuns([]),
                    FAKE_PUSH_RUNS_JSON: provedBeforePushRuns,
                });
                expect(baseWhenPrUnproved).toBe(inFlightBefore);

                // Case 5: `inFlightBefore` IS proved and PR head passed, but the merge commit
                // modified the tree (evil merge) -> falls back to `inFlightBefore`.
                writeFileSync(filePath, '<template>evil-merge</template>\n', 'utf8');
                runGit(root, [
                    'add',
                    '--all',
                ]);
                runGit(root, [
                    'commit',
                    '--quiet',
                    '--amend',
                    '--no-edit',
                ]);
                const evilMergeHead = runGit(root, [
                    'rev-parse',
                    'HEAD',
                ]);
                const baseWhenTreeDiffers = runPushDiffBase(root, inFlightBefore, evilMergeHead, {
                    ...baseEnv,
                    FAKE_PR_RUNS_JSON: passingMainPrRuns,
                    FAKE_PUSH_RUNS_JSON: provedBeforePushRuns,
                });
                expect(baseWhenTreeDiffers).toBe(inFlightBefore);

                // Case 6: force-push where `before` is not an ancestor of `head` ->
                // returns `unavailable-push-base` instead of accepting a non-ancestor SHA.
                runGit(root, [
                    'checkout',
                    '-q',
                    '--orphan',
                    'rewritten',
                ]);
                writeFileSync(filePath, '<template>rewritten</template>\n', 'utf8');
                const rewrittenHead = commitAll(root, 'rewritten history');
                const baseOnForcePush = runPushDiffBase(root, inFlightBefore, rewrittenHead, {
                    ...baseEnv,
                    FAKE_PR_RUNS_JSON: passingMainPrRuns,
                    FAKE_PUSH_RUNS_JSON: provedBeforePushRuns,
                });
                expect(baseOnForcePush).toBe('unavailable-push-base');
            } finally {
                removeTemporaryDirectorySync(fakeBin);
                removeTemporaryDirectorySync(root);
            }
        });
    });
});
