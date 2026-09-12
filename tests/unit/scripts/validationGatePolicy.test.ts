import {
    mkdir,
    mkdtemp,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import {
    execFileSync,
    spawn,
    spawnSync,
} from 'node:child_process';
import {
    existsSync,
    readFileSync,
} from 'node:fs';
import os, { tmpdir } from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    collectDescendantPidsUnix,
    isProcessAlive,
} from '@scripts/electron-run/electronRunProcessTree';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ESLint } from 'eslint';

interface IValidationChanges {
    files: string[];
    known: boolean;
    reason: string;
}

interface IValidationGateModule {
    acquireHeavyGate: (options: {
        capacity?: number;
        env?: NodeJS.ProcessEnv;
        failOpenOnTimeout?: boolean;
        id: string;
        root: string;
        waitMs?: number;
        weight?: number;
    }) => Promise<{
        capacity: number;
        coordinated: boolean;
        release: () => Promise<void>;
        waitedMs: number;
    }>;
    classifyValidationImpacts: (files: string[]) => {
        full: boolean;
        impacts: Record<string, boolean>;
        unmatchedFiles: string[];
    };
    getLintCachePaths: (options: {
        arch?: string;
        nodeVersion?: string;
        platform?: string;
        root: string;
    }) => {
        eslint: string;
        fingerprint: string;
        stylelint: string;
    };
    getValidationStageCacheDecision: (stage: {
        cacheable?: boolean;
        id: string;
        inputFingerprint?: string;
    }, options: {
            lastPassingFingerprints?: Map<string, string>;
            noCache?: boolean;
        }) => {
        cacheHit: boolean;
        cacheReason: string;
        cacheState: string;
        inputFingerprint: string;
    };
    getValidationBuildMarkerPath: (root?: string) => string;
    getValidationInputFingerprint: (options: {
        inputPaths: string[];
        root: string;
    }) => string;
    isValidationBuildFresh: (options: {
        buildScriptName: string;
        outputPaths: string[];
        root: string;
    }) => boolean;
    getValidationPlan: (options: {
        allGates?: boolean;
        cold?: boolean;
        changes: IValidationChanges;
        classification?: {
            full: boolean;
            impacts: Record<string, boolean>;
            unmatchedFiles: string[];
        };
        tier: 'iteration' | 'acceptance' | 'integration' | 'nightly';
    }) => Array<{
        args: string[];
        command: string;
        env?: Record<string, string>;
        heavyWeight: number;
        id: string;
        cacheable?: boolean;
        dependsOn?: string[];
        parallelPhase?: number;
        weight?: number;
    }>;
    pruneRetentionEntries: (options: {
        keep: number;
        minimumAgeMs: number;
        root: string;
    }) => Promise<string[]>;
    runStagePool: <T extends {
        dependsOn?: string[];
        id: string;
        weight?: number
    }>(
        stages: T[],
        runStage: (
            stage: T,
            context: {signal?: AbortSignal},
        ) => Promise<void>,
        options?: {
            capacity?: number;
            signal?: AbortSignal;
        },
    ) => Promise<void>;
    writeValidationBuildMarker: (options: {
        buildScriptName: string;
        outputPaths: string[];
        root: string;
    }) => Promise<string | null>;
}

const validationGates = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/validation-gates.mjs')).href
) as IValidationGateModule;
const ignoredRootEslintConfigFiles = [
    'eslint.config.mjs',
    'eslint.shared.mjs',
    'nuxt.config.ts',
    'stylelint.config.mjs',
];

function runChangedLint(files: string[]) {
    const result = spawnSync(process.execPath, [
        'scripts/validation-gates.mjs',
        'lint',
        '--changed',
        '--no-cache',
        ...files.map(file => `--file=${file}`),
    ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: process.env,
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });
    return {
        output: `${result.stdout}${result.stderr}`,
        status: result.status,
    };
}

async function forceKillAndWait(child: ReturnType<typeof spawn>) {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    await new Promise<void>((resolve) => {
        const onExit = () => resolve();
        child.once('exit', onExit);
        if (!child.kill('SIGKILL')) {
            child.off('exit', onExit);
            resolve();
        }
    });
}

function readPosixProcessState(pid: number) {
    if (process.platform === 'linux') {
        const procStat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
        return procStat.slice(procStat.lastIndexOf(')') + 1).trimStart().charAt(0);
    }
    return execFileSync('ps', [
        '-p',
        String(pid),
        '-o',
        'stat=',
    ], {encoding: 'utf8'}).trim().charAt(0);
}

async function spawnUnreapedZombie() {
    const parent = spawn('python3', [
        '-c',
        'import os,time\npid=os.fork()\nif pid == 0: os._exit(0)\nprint(pid, flush=True)\ntime.sleep(30)',
    ], {stdio: [
        'ignore',
        'pipe',
        'ignore',
    ]});
    try {
        const zombiePid = await new Promise<number>((resolve, reject) => {
            parent.stdout?.once('data', chunk => resolve(Number(String(chunk).trim())));
            parent.once('error', reject);
            parent.once('exit', (code, signal) => reject(new Error(
                `zombie parent exited before reporting its child (code ${String(code)}, signal ${String(signal)})`,
            )));
        });
        expect(zombiePid).toBeGreaterThan(0);
        await vi.waitFor(() => {
            expect(readPosixProcessState(zombiePid)).toBe('Z');
        });
        return {
            parent,
            zombiePid,
        };
    } catch (error) {
        await forceKillAndWait(parent);
        throw error;
    }
}

async function createLintConfigRoot() {
    const root = await mkdtemp(join(tmpdir(), 'evb-validation-cache-'));
    await Promise.all([
        writeFile(join(root, 'eslint.config.mjs'), 'export default [];\n'),
        writeFile(join(root, 'eslint-plugin-custom.mjs'), 'export default {};\n'),
        writeFile(join(root, 'stylelint.config.mjs'), 'export default {};\n'),
        writeFile(join(root, 'package.json'), '{}\n'),
        writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n'),
    ]);
    return root;
}

describe('validation gate policy', () => {
    it.sequential('skips root config files ignored by ESLint while still checking lintable changed files', async () => {
        // Keep the deliberately invalid fixture outside the directories scanned
        // by the full gate. The explicit --file still exercises changed-file
        // linting without racing the full lint stage.
        const invalidPath = `.validation-gate-policy-invalid-${process.pid}.ts`;
        await rm(invalidPath, {force: true});
        await writeFile(invalidPath, 'const invalidSyntax = ;\n');
        try {
            const ignoredConfigsOnly = runChangedLint(ignoredRootEslintConfigFiles);
            const withLintableError = runChangedLint([
                ...ignoredRootEslintConfigFiles,
                invalidPath,
            ]);

            expect(ignoredConfigsOnly, ignoredConfigsOnly.output).toMatchObject({status: 0});
            expect(withLintableError.status).not.toBe(0);
            expect(withLintableError.output).toContain(invalidPath);
        } finally {
            await rm(invalidPath, {force: true});
        }
    }, 60_000);

    it('keeps root and landing config ignore policies distinct', async () => {
        const rootEslint = new ESLint({cwd: process.cwd()});
        const landingEslint = new ESLint({cwd: join(process.cwd(), 'landing')});

        await expect(Promise.all(ignoredRootEslintConfigFiles.map(
            file => rootEslint.isPathIgnored(file),
        ))).resolves.toEqual(ignoredRootEslintConfigFiles.map(() => true));
        await expect(Promise.all([
            'drizzle.config.ts',
            'nuxt.config.ts',
        ].map(file => landingEslint.isPathIgnored(file)))).resolves.toEqual([
            false,
            false,
        ]);
    }, 30_000);

    it('fails closed for unmatched paths and unknown change detection', () => {
        const classification = validationGates.classifyValidationImpacts(['unowned/new-input.xyz']);
        expect(classification).toMatchObject({
            full: true,
            unmatchedFiles: ['unowned/new-input.xyz'],
        });

        const plan = validationGates.getValidationPlan({
            changes: {
                files: [],
                known: false,
                reason: 'missing-base',
            },
            tier: 'acceptance',
        });
        const stageIds = plan.map(stage => stage.id);
        expect(stageIds).toEqual(expect.arrayContaining([
            'lint.full',
            'typecheck.full',
            'test.unit.full',
            'build.strict',
            'electron.blocking-smoke',
        ]));
        const smoke = plan.find(stage => stage.id === 'electron.blocking-smoke');
        expect(smoke?.command).toBe('bash');
        expect(smoke?.args).toEqual([
            'scripts/test-electron-e2e-headless.sh',
            '--no-build',
            'e2e-blocking-smoke',
        ]);
        expect(smoke?.env).toMatchObject({EVB_PDF_PAGE_OPS_ENABLE: '1'});
        expect(stageIds).not.toContain('test.coverage');
        expect(stageIds).not.toContain('typecheck.coverage');

        const iterationStageIds = validationGates.getValidationPlan({
            changes: {
                files: [],
                known: false,
                reason: 'missing-base',
            },
            tier: 'iteration',
        }).map(stage => stage.id);
        expect(iterationStageIds).toEqual([
            'lint.full',
            'typecheck.full',
            'test.unit.full',
        ]);
        expect(iterationStageIds).not.toContain('build.strict');
    });

    it('maps non-import policy edges to every unit project', () => {
        const changes = {
            files: ['package.json'],
            known: true,
            reason: 'explicit-files',
        };
        const classification = validationGates.classifyValidationImpacts(changes.files);
        const plan = validationGates.getValidationPlan({
            changes,
            classification,
            tier: 'acceptance',
        });
        const unitStage = plan.find(stage => stage.id === 'test.unit.full');

        expect(classification.impacts.policy).toBe(true);
        expect(unitStage?.args.join(' ')).toContain('test:unit');
    });

    it('keeps tooling-only changes on lint and script policy tests', () => {
        for (const file of [
            '.github/workflows/ci.yml',
            '.husky/pre-commit',
            '.fallowrc.json',
            'eslint.config.mjs',
            'stylelint.config.mjs',
            'scripts/ci/classify-changed-areas.mjs',
        ]) {
            const classification = validationGates.classifyValidationImpacts([file]);
            const plan = validationGates.getValidationPlan({
                changes: {
                    files: [file],
                    known: true,
                    reason: 'explicit-files',
                },
                classification,
                tier: 'acceptance',
            });
            const stageIds = plan.map(stage => stage.id);
            const unitStage = plan.find(stage => stage.id === 'test.unit.affected-projects');

            expect(classification.impacts.tooling, file).toBe(true);
            expect(classification.impacts.policy, file).toBe(false);
            expect(unitStage?.args, file).toEqual(expect.arrayContaining([
                '--project',
                'unit-scripts',
                'unit-policy',
            ]));
            expect(stageIds, file).not.toContain('typecheck.nuxt');
            expect(stageIds, file).not.toContain('typecheck.ts7');
            expect(stageIds, file).not.toContain('build.strict');
            expect(stageIds, file).not.toContain('electron.blocking-smoke');
        }
    });

    it('keeps package and TypeScript configuration changes on full acceptance', () => {
        for (const file of [
            'package.json',
            'tsconfig.json',
        ]) {
            const classification = validationGates.classifyValidationImpacts([file]);
            const plan = validationGates.getValidationPlan({
                changes: {
                    files: [file],
                    known: true,
                    reason: 'explicit-files',
                },
                classification,
                tier: 'acceptance',
            });
            const stageIds = plan.map(stage => stage.id);

            expect(classification.impacts.policy, file).toBe(true);
            expect(stageIds, file).toEqual(expect.arrayContaining([
                'typecheck.full',
                'build.strict',
                'electron.blocking-smoke',
            ]));
        }
    });

    it('targets one Vitest project for a related app iteration instead of paying all project startups', () => {
        const changes = {
            files: ['app/composables/useExample.ts'],
            known: true,
            reason: 'explicit-files',
        };
        const plan = validationGates.getValidationPlan({
            changes,
            tier: 'iteration',
        });
        const related = plan.find(stage => stage.id === 'test.unit.related');

        expect(related?.args).toContain('--run');
        expect(related?.args).toContain('unit-app');
        expect(related?.args).toContain('unit-static-architecture');
        expect(related?.args).not.toContain('unit-core');
        expect(related?.args).not.toContain('unit-electron');
        expect(related?.args).not.toContain('unit-scripts');
        expect(related?.args).not.toContain('unit-policy');
    });

    it('does no work for documentation-only changes without lintable files', () => {
        const changes = {
            files: ['docs/contributing/releasing.md'],
            known: true,
            reason: 'explicit-files',
        };
        const classification = validationGates.classifyValidationImpacts(changes.files);

        expect(validationGates.getValidationPlan({
            changes,
            classification,
            tier: 'iteration',
        })).toEqual([]);
        expect(validationGates.getValidationPlan({
            changes,
            classification,
            tier: 'acceptance',
        })).toEqual([]);
        expect(validationGates.getValidationPlan({
            changes,
            classification,
            tier: 'integration',
        })).toEqual([]);
    });

    it('does no work for a verified clean tree while keeping explicit all-gates available', () => {
        const changes = {
            files: [],
            known: true,
            reason: 'git',
        };
        const classification = validationGates.classifyValidationImpacts(changes.files);

        expect(validationGates.getValidationPlan({
            changes,
            classification,
            tier: 'acceptance',
        })).toEqual([]);
        expect(validationGates.getValidationPlan({
            allGates: true,
            changes,
            classification,
            tier: 'acceptance',
        }).map(stage => stage.id)).toContain('build.prepare');
    });

    it('keeps ordinary script-test acceptance on changed lint, types, and tests', () => {
        const changes = {
            files: ['tests/unit/scripts/depGraph.test.ts'],
            known: true,
            reason: 'explicit-files',
        };
        const classification = validationGates.classifyValidationImpacts(changes.files);
        const plan = validationGates.getValidationPlan({
            changes,
            classification,
            tier: 'acceptance',
        });
        const stageIds = plan.map(stage => stage.id);

        expect(stageIds).toEqual([
            'lint.affected',
            'typecheck.ts7',
            'test.unit.affected-projects',
        ]);
        expect(plan.find(stage => stage.id === 'test.unit.affected-projects')?.args)
            .toContain('tests/unit/scripts/depGraph.test.ts');
        expect(stageIds).not.toContain('build.strict');
        expect(stageIds).not.toContain('electron.blocking-smoke');
    });

    it('targets the landing unit project for an ordinary landing test', () => {
        const file = 'tests/unit/landing/analytics.test.ts';
        const plan = validationGates.getValidationPlan({
            changes: {
                files: [file],
                known: true,
                reason: 'explicit-files',
            },
            tier: 'acceptance',
        });
        const unitStage = plan.find(stage => stage.id === 'test.unit.affected-projects');

        expect(unitStage?.args).toContain('unit-landing');
        expect(unitStage?.args).not.toContain('unit-core');
        expect(unitStage?.args).toContain(file);
    });

    it('keeps shared unit setup on every consumer project', () => {
        const plan = validationGates.getValidationPlan({
            changes: {
                files: ['tests/setup.ts'],
                known: true,
                reason: 'explicit-files',
            },
            tier: 'acceptance',
        });
        const unitStage = plan.find(stage => stage.id === 'test.unit.affected-projects');

        expect(unitStage?.args).toEqual(expect.arrayContaining([
            'unit-core',
            'unit-app',
            'unit-electron',
            'unit-scripts',
            'unit-policy',
            'unit-static-architecture',
        ]));
        expect(unitStage?.args).not.toContain('tests/setup.ts');
    });

    it('keeps app-only unit setup on app and landing projects', () => {
        const plan = validationGates.getValidationPlan({
            changes: {
                files: ['tests/setupApp.ts'],
                known: true,
                reason: 'explicit-files',
            },
            tier: 'acceptance',
        });
        const unitStage = plan.find(stage => stage.id === 'test.unit.affected-projects');

        expect(unitStage?.args).toEqual(expect.arrayContaining([
            'unit-app',
            'unit-landing',
        ]));
        expect(unitStage?.args).not.toContain('unit-core');
        expect(unitStage?.args).not.toContain('unit-electron');
        expect(unitStage?.args).not.toContain('unit-scripts');
        expect(unitStage?.args).not.toContain('unit-policy');
        expect(unitStage?.args).not.toContain('unit-static-architecture');
    });

    it('keeps project selection when an ordinary unit test is deleted', () => {
        const deletedFile = 'tests/unit/scripts/deletedValidationGate.test.ts';
        const plan = validationGates.getValidationPlan({
            changes: {
                files: [deletedFile],
                known: true,
                reason: 'explicit-files',
            },
            tier: 'acceptance',
        });
        const unitStage = plan.find(stage => stage.id === 'test.unit.affected-projects');

        expect(unitStage?.args).toEqual(expect.arrayContaining([
            'unit-scripts',
            'unit-policy',
        ]));
        expect(unitStage?.args).not.toContain(deletedFile);
    });

    it('runs ordinary unit files directly during bounded integration', () => {
        const file = 'tests/unit/scripts/depGraph.test.ts';
        const plan = validationGates.getValidationPlan({
            changes: {
                files: [file],
                known: true,
                reason: 'explicit-files',
            },
            tier: 'integration',
        });
        const stageIds = plan.map(stage => stage.id);

        expect(stageIds).toEqual([
            'lint.affected',
            'typecheck.ts7',
            'test.unit.affected-projects',
        ]);
        expect(plan.find(stage => stage.id === 'test.unit.affected-projects')?.args)
            .toContain(file);
        expect(stageIds).not.toContain('electron.regression');
        expect(stageIds).not.toContain('test.unit.full');
    });

    it('adds the Electron regression lane only for affected app integration', () => {
        const plan = validationGates.getValidationPlan({
            changes: {
                files: ['app/composables/useExample.ts'],
                known: true,
                reason: 'explicit-files',
            },
            tier: 'integration',
        });
        const stageIds = plan.map(stage => stage.id);

        expect(stageIds).toContain('electron.regression');
        expect(stageIds).not.toContain('electron.blocking-smoke');
        expect(stageIds).not.toContain('lint.full');
        expect(stageIds).not.toContain('typecheck.full');
        expect(stageIds).not.toContain('test.unit.full');
        expect(stageIds).not.toContain('build.strict');
        expect(plan.find(stage => stage.id === 'electron.regression')?.args)
            .toEqual([
                'run',
                'test:e2e:electron:headless',
            ]);
    });

    it('reuses a strict build for affected Electron integration', () => {
        const plan = validationGates.getValidationPlan({
            changes: {
                files: [
                    'app/composables/useExample.ts',
                    'scripts/build-electron.mjs',
                ],
                known: true,
                reason: 'explicit-files',
            },
            tier: 'integration',
        });
        const regression = plan.find(stage => stage.id === 'electron.regression');

        expect(regression?.command).toBe('bash');
        expect(regression?.args).toEqual([
            'scripts/test-electron-e2e-headless.sh',
            '--no-build',
            'e2e-regression',
        ]);
        expect(regression?.dependsOn).toEqual(['build.strict']);
    });

    it('reuses a strict build for affected Electron acceptance smoke', () => {
        const plan = validationGates.getValidationPlan({
            changes: {
                files: [
                    'app/composables/useExample.ts',
                    'scripts/build-electron.mjs',
                ],
                known: true,
                reason: 'explicit-files',
            },
            tier: 'acceptance',
        });
        const smoke = plan.find(stage => stage.id === 'electron.blocking-smoke');

        expect(smoke?.command).toBe('bash');
        expect(smoke?.args).toEqual([
            'scripts/test-electron-e2e-headless.sh',
            '--no-build',
            'e2e-blocking-smoke',
        ]);
        expect(smoke?.env).toMatchObject({EVB_PDF_PAGE_OPS_ENABLE: '1'});
        expect(smoke?.dependsOn).toEqual(['build.strict']);
    });

    it('reuses the strict build in broad integration fallback', () => {
        const plan = validationGates.getValidationPlan({
            changes: {
                files: [],
                known: false,
                reason: 'missing-base',
            },
            tier: 'integration',
        });
        const regression = plan.find(stage => stage.id === 'electron.regression');

        expect(regression?.command).toBe('bash');
        expect(regression?.args).toEqual([
            'scripts/test-electron-e2e-headless.sh',
            '--no-build',
            'e2e-regression',
        ]);
        expect(regression?.dependsOn).toEqual(['build.strict']);
    });

    it('targets the static architecture lane when quarantine metadata changes', () => {
        const plan = validationGates.getValidationPlan({
            changes: {
                files: ['tests/e2e/electron/quarantine/graduation-policy.json'],
                known: true,
                reason: 'explicit-files',
            },
            tier: 'acceptance',
        });
        const related = plan.find(stage => stage.id === 'test.unit.affected-projects');

        expect(related?.args).toContain('unit-static-architecture');
        expect(related?.args).not.toContain('unit-app');
        expect(related?.args).toContain('unit-electron');
    });

    it('routes CI helper admission through script and policy tests', () => {
        const files = [
            'scripts/ci/stageExactPdfFixture.ts',
            'scripts/ci/runElectronQuarantine.ts',
        ];
        const classification = validationGates.classifyValidationImpacts(files);
        const plan = validationGates.getValidationPlan({
            changes: {
                files,
                known: true,
                reason: 'explicit-files',
            },
            classification,
            tier: 'acceptance',
        });
        const unitStage = plan.find(stage => stage.id === 'test.unit.affected-projects');
        const stageIds = plan.map(stage => stage.id);

        expect(classification.impacts.tooling).toBe(true);
        expect(classification.impacts.policy).toBe(false);
        expect(unitStage?.args).toEqual(expect.arrayContaining([
            '--project',
            'unit-scripts',
            'unit-policy',
        ]));
        expect(stageIds).not.toContain('build.strict');
        expect(stageIds).not.toContain('electron.blocking-smoke');
    });

    it('keeps informational and exhaustive reports in the nightly tier', () => {
        const plan = validationGates.getValidationPlan({
            changes: {
                files: [],
                known: false,
                reason: 'nightly-full',
            },
            tier: 'nightly',
        });
        const stageIds = plan.map(stage => stage.id);

        expect(stageIds).toEqual(expect.arrayContaining([
            'static.platform-report',
            'static.web-deploy-source',
            'test.coverage',
            'native.resource-matrix',
            'electron.quarantine',
        ]));
        expect(stageIds).not.toContain('test.unit.full');
    });

    it('includes Rust formatting and Clippy in affected native acceptance', () => {
        const plan = validationGates.getValidationPlan({
            changes: {
                files: ['native/pdf-search/src/main.rs'],
                known: true,
                reason: 'explicit-files',
            },
            tier: 'acceptance',
        });

        expect(plan.map(stage => stage.id)).toEqual(expect.arrayContaining([
            'native.lint',
            'native.test',
            'native.resource-matrix',
            'build.strict',
        ]));
        expect(plan.find(stage => stage.id === 'native.resource-matrix')?.dependsOn)
            .toEqual(['build.strict']);
        expect(plan.find(stage => stage.id === 'native.resource-matrix')?.env)
            .toMatchObject({EVB_BUILD_ARTIFACTS_PREPARED: '1'});
        expect(plan.find(stage => stage.id === 'test.unit.affected-projects')?.args)
            .toContain('unit-static-architecture');
    });

    it('includes Rust formatting and tests in affected native iteration', () => {
        const plan = validationGates.getValidationPlan({
            changes: {
                files: ['native/pdf-page-ops/src/lib.rs'],
                known: true,
                reason: 'explicit-files',
            },
            tier: 'iteration',
        });
        const stageIds = plan.map(stage => stage.id);

        expect(stageIds).toEqual([
            'typecheck.ts7',
            'native.lint',
            'native.test',
        ]);
        expect(stageIds).not.toContain('build.strict');
        expect(stageIds).not.toContain('native.resource-matrix');
        expect(plan.find(stage => stage.id === 'typecheck.ts7')?.args)
            .toContain('tsconfig.scripts.json');
        expect(plan.find(stage => stage.id === 'typecheck.ts7')?.args)
            .toContain('tsconfig.scripts-js.json');
    });

    it('consolidates the full local gate sequence without duplicate unit or build work', () => {
        const plan = validationGates.getValidationPlan({
            allGates: true,
            changes: {
                files: ['package.json'],
                known: true,
                reason: 'explicit-files',
            },
            tier: 'acceptance',
        });
        const stageIds = plan.map(stage => stage.id);
        const scripts = plan.flatMap(stage => (
            stage.command === 'pnpm' && stage.args[0] === 'run'
                ? [stage.args[1]]
                : []
        ));

        expect(stageIds).toEqual([
            'build.prepare',
            'lint.full',
            'typecheck.full',
            'test.unit.full',
            'static.web-deploy-source',
            'native.lint',
            'native.test',
        ]);
        expect(stageIds).not.toContain('build.strict');
        expect(stageIds).not.toContain('electron.blocking-smoke');
        expect(scripts).toContain('lint');
        expect(scripts).toContain('typecheck');
        expect(scripts).toContain('test:unit');
        expect(scripts).not.toContain('test:coverage');
        expect(scripts).not.toContain('fallow');
        expect(scripts).not.toContain('fallow:dupes');
        expect(stageIds).not.toContain('typecheck.coverage');
        expect(scripts).not.toContain('lint:clean');
        expect(scripts).not.toContain('typecheck:clean');
        expect(scripts).not.toContain('fallow:all');
        expect(plan.find(stage => stage.id === 'native.test')?.dependsOn)
            .toEqual(['build.prepare']);
        expect(plan.every(stage => (stage.dependsOn ?? []).every(id => stageIds.includes(id)))).toBe(true);
        expect(plan.filter(stage => stage.cacheable).map(stage => stage.id)).toEqual(expect.arrayContaining([
            'lint.full',
            'typecheck.full',
            'static.web-deploy-source',
            'native.lint',
        ]));
        const coldPlan = validationGates.getValidationPlan({
            allGates: true,
            changes: {
                files: [],
                known: true,
                reason: 'explicit-files',
            },
            tier: 'acceptance',
            cold: true,
        });
        expect(coldPlan.find(stage => stage.id === 'lint.full')?.args).toContain('lint:clean');
        expect(coldPlan.find(stage => stage.id === 'typecheck.full')?.args).toContain('typecheck:clean');
    });

    it('keys lint caches by configuration, toolchain, platform, and architecture content', async () => {
        const root = await createLintConfigRoot();
        try {
            const first = validationGates.getLintCachePaths({
                arch: 'arm64',
                nodeVersion: 'v24.11.1',
                platform: 'darwin',
                root,
            });
            await writeFile(join(root, 'eslint.config.mjs'), 'export default [{ rules: {} }];\n');
            const configChanged = validationGates.getLintCachePaths({
                arch: 'arm64',
                nodeVersion: 'v24.11.1',
                platform: 'darwin',
                root,
            });
            const toolchainChanged = validationGates.getLintCachePaths({
                arch: 'arm64',
                nodeVersion: 'v24.12.0',
                platform: 'darwin',
                root,
            });

            expect(first.eslint).toContain(join('.devkit', 'cache', 'eslint'));
            expect(first.fingerprint).not.toBe(configChanged.fingerprint);
            expect(configChanged.fingerprint).not.toBe(toolchainChanged.fingerprint);
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('coordinates weighted work, reclaims capacity on release, and degrades open', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-heavy-gate-'));
        const stderrChunks: string[] = [];
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
            stderrChunks.push(String(chunk));
            return true;
        });
        try {
            const first = await validationGates.acquireHeavyGate({
                capacity: 2,
                env: {},
                id: 'first',
                root,
                waitMs: 25,
                weight: 2,
            });
            const saturated = await validationGates.acquireHeavyGate({
                capacity: 2,
                env: {},
                failOpenOnTimeout: true,
                id: 'saturated',
                root,
                waitMs: 25,
                weight: 1,
            });
            expect(first.coordinated).toBe(true);
            expect(first.capacity).toBe(2);
            expect(saturated.coordinated).toBe(false);
            expect(saturated.waitedMs).toBeGreaterThan(0);
            await expect(validationGates.acquireHeavyGate({
                capacity: 2,
                env: {},
                id: 'fail-closed-timeout',
                root,
                waitMs: 25,
                weight: 1,
            })).rejects.toThrow('Timed out waiting');

            await first.release();
            const afterRelease = await validationGates.acquireHeavyGate({
                capacity: 2,
                env: {},
                id: 'after-release',
                root,
                waitMs: 25,
                weight: 1,
            });
            expect(afterRelease.coordinated).toBe(true);
            expect(afterRelease.capacity).toBe(2);
            await afterRelease.release();

            const unusableRoot = join(root, 'not-a-directory');
            await writeFile(unusableRoot, 'occupied');
            const degraded = await validationGates.acquireHeavyGate({
                env: {},
                id: 'degraded',
                root: unusableRoot,
                waitMs: 25,
            });
            expect(degraded.coordinated).toBe(false);
        } finally {
            stderr.mockRestore();
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
        expect(stderrChunks.join('')).toContain(
            '[gate] BLOCKED waiting for heavy-gate: id=saturated, needs=1, used=2/2, holders=first(pid=',
        );
    });

    it('re-evaluates the default capacity when admission starts and honors the environment override', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-heavy-gate-dynamic-'));
        const availableParallelism = vi.spyOn(os, 'availableParallelism')
            .mockReturnValueOnce(1)
            .mockReturnValue(2);
        const stderrChunks: string[] = [];
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
            stderrChunks.push(String(chunk));
            return true;
        });
        let blockingGate: Awaited<ReturnType<typeof validationGates.acquireHeavyGate>> | undefined;
        let overriddenPromise: ReturnType<typeof validationGates.acquireHeavyGate> | undefined;
        try {
            const dynamic = await validationGates.acquireHeavyGate({
                env: {},
                id: 'dynamic',
                root,
                waitMs: 50,
                weight: 2,
            });
            expect(dynamic.capacity).toBe(2);
            expect(dynamic.waitedMs).toBe(0);
            await dynamic.release();

            blockingGate = await validationGates.acquireHeavyGate({
                capacity: 2,
                env: {},
                id: 'blocking',
                root,
                waitMs: 1000,
                weight: 2,
            });
            const overrideEnv: NodeJS.ProcessEnv = {EVB_GATE_CAPACITY: '2'};
            overriddenPromise = validationGates.acquireHeavyGate({
                env: overrideEnv,
                id: 'overridden',
                root,
                waitMs: 15_000,
                weight: 1,
            });
            await vi.waitFor(() => {
                expect(stderrChunks.join('')).toContain(
                    '[gate] BLOCKED waiting for heavy-gate: id=overridden, needs=1, used=2/2',
                );
            });
            overrideEnv.EVB_GATE_CAPACITY = '1';
            await blockingGate.release();
            blockingGate = undefined;
            const overridden = await overriddenPromise;
            expect(overridden.capacity).toBe(2);
            await overridden.release();
            overriddenPromise = undefined;
        } finally {
            if (blockingGate) {
                await blockingGate.release();
            }
            if (overriddenPromise) {
                await overriddenPromise.then(
                    async (gate) => {
                        await gate.release();
                    },
                    () => undefined,
                );
            }
            stderr.mockRestore();
            availableParallelism.mockRestore();
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('runs ready stages by dependency and weight instead of phase barriers', async () => {
        const events: string[] = [];
        let activeWeight = 0;
        let maxActiveWeight = 0;
        await validationGates.runStagePool([
            {
                id: 'root-a',
                weight: 2,
            },
            {
                id: 'root-b',
                weight: 1,
            },
            {
                dependsOn: ['root-a'],
                id: 'child',
                weight: 2,
            },
        ], async stage => {
            activeWeight += stage.weight ?? 1;
            maxActiveWeight = Math.max(maxActiveWeight, activeWeight);
            events.push(`start:${stage.id}`);
            await new Promise(resolve => setTimeout(resolve, 5));
            events.push(`end:${stage.id}`);
            activeWeight -= stage.weight ?? 1;
        }, {capacity: 2});

        expect(maxActiveWeight).toBeLessThanOrEqual(2);
        expect(events.indexOf('start:child')).toBeGreaterThan(events.indexOf('end:root-a'));
    });

    it('keeps running independent stages after a failure and skips only the dependents', async () => {
        const started: string[] = [];
        const pool = validationGates.runStagePool([
            {
                id: 'broken',
                weight: 1,
            },
            {
                dependsOn: ['broken'],
                id: 'child',
                weight: 1,
            },
            {
                dependsOn: ['child'],
                id: 'grandchild',
                weight: 1,
            },
            {
                id: 'independent',
                weight: 1,
            },
        ], async (stage) => {
            started.push(stage.id);
            await new Promise(resolve => setTimeout(resolve, 5));
            if (stage.id === 'broken') {
                throw new Error('broken exited 1');
            }
        }, {capacity: 1});

        await expect(pool).rejects.toMatchObject({
            failures: [{id: 'broken'}],
            name: 'ValidationStagePoolError',
            skipped: [
                {
                    dependency: 'broken',
                    id: 'child',
                },
                {
                    dependency: 'child',
                    id: 'grandchild',
                },
            ],
        });
        await expect(pool).rejects.toThrow(/broken exited 1[\s\S]*skipped \(dependency failed\): child <- broken, grandchild <- child/u);
        expect(started).toEqual([
            'broken',
            'independent',
        ]);
    });

    it('stops launching pending stages after cancellation and settles running stages first', async () => {
        const controller = new AbortController();
        const events: string[] = [];
        await expect(validationGates.runStagePool([
            {
                id: 'first',
                weight: 1,
            },
            {
                id: 'pending',
                weight: 1,
            },
        ], async (stage, {signal}) => {
            events.push(`start:${stage.id}`);
            if (stage.id === 'first') {
                signal?.addEventListener('abort', () => events.push('abort:first'), {once: true});
                controller.abort();
            }
        }, {
            capacity: 1,
            signal: controller.signal,
        })).rejects.toMatchObject({name: 'ValidationInterruptedError'});
        expect(events).toEqual([
            'start:first',
            'abort:first',
        ]);
    });

    it.runIf(process.platform !== 'win32')('interrupts a real stage tree and records an interrupted run', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-validation-cancellation-'));
        const readyPath = join(root, 'ready');
        const evidenceDir = join(root, 'evidence');
        const fixtureCode = 'const fs=require(\'node:fs\');const {spawn}=require(\'node:child_process\');const child=spawn(process.execPath,[\'-e\',\'setInterval(()=>{},1000)\'],{detached:true,stdio:\'ignore\'});child.unref();fs.writeFileSync(process.env.READY,process.pid+\':\'+child.pid);setInterval(()=>{},1000);';
        const runner = spawn(process.execPath, [
            'scripts/validation-gates.mjs',
            'heavy',
            '--no-cache',
            '--id=validation-cancellation-fixture',
            '--weight=1',
            '--',
            process.execPath,
            '-e',
            fixtureCode,
        ], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                EVB_GATE_EVIDENCE_DIR: evidenceDir,
                EVB_GATE_SEMAPHORE_DIR: join(root, 'semaphore'),
                READY: readyPath,
            },
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
        });
        let output = '';
        runner.stdout?.on('data', chunk => { output += String(chunk); });
        runner.stderr?.on('data', chunk => { output += String(chunk); });
        let fixturePid: number | undefined;
        let descendantPid: number | undefined;
        try {
            await vi.waitFor(() => {
                expect(existsSync(readyPath)).toBe(true);
                [
                    fixturePid,
                    descendantPid,
                ] = readFileSync(readyPath, 'utf8')
                    .trim()
                    .split(':')
                    .map(Number);
                expect(fixturePid).toBeGreaterThan(0);
                expect(descendantPid).toBeGreaterThan(0);
            }, {timeout: 5000});
            expect(collectDescendantPidsUnix(runner.pid ?? 0)).toEqual(
                expect.arrayContaining([
                    fixturePid!,
                    descendantPid!,
                ]),
            );
            runner.kill('SIGTERM');
            runner.kill('SIGINT');
            await new Promise<void>(resolve => runner.once('close', () => resolve()));
            expect(output).toContain('Validation interrupted');
            expect(isProcessAlive(fixturePid!)).toBe(false);
            expect(isProcessAlive(descendantPid!)).toBe(false);
            const afterCancellation = await validationGates.acquireHeavyGate({
                capacity: 1,
                env: {},
                id: 'after-cancellation',
                root: join(root, 'semaphore'),
                waitMs: 25,
                weight: 1,
            });
            expect(afterCancellation.coordinated).toBe(true);
            await afterCancellation.release();
            const evidenceFiles = await readdir(evidenceDir);
            const evidenceFile = evidenceFiles.find(file => file.endsWith('.ndjson'));
            expect(evidenceFile).toBeDefined();
            const evidence = readFileSync(join(evidenceDir, evidenceFile!), 'utf8');
            expect(evidence).toContain('"status":"interrupted"');
            expect(evidence).toContain('"event":"run-end"');
        } finally {
            if (fixturePid && isProcessAlive(fixturePid)) {
                try {
                    process.kill(fixturePid, 'SIGKILL');
                } catch {
                    // The fixture may have exited during cleanup.
                }
            }
            if (descendantPid && isProcessAlive(descendantPid)) {
                try {
                    process.kill(descendantPid, 'SIGKILL');
                } catch {
                    // The fixture may have exited during cleanup.
                }
            }
            await forceKillAndWait(runner);
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('skips a deterministic stage only for an exact passing fingerprint', () => {
        const stage = {
            cacheable: true,
            id: 'typecheck.full',
            inputFingerprint: 'fingerprint-a',
        };

        expect(validationGates.getValidationStageCacheDecision(stage, {lastPassingFingerprints: new Map([[
            'typecheck.full',
            'fingerprint-a',
        ]])})).toMatchObject({
            cacheHit: true,
            cacheReason: 'last-passing-input-fingerprint',
            cacheState: 'warm',
        });
        expect(validationGates.getValidationStageCacheDecision(stage, {lastPassingFingerprints: new Map([[
            'typecheck.full',
            'fingerprint-b',
        ]])})).toMatchObject({
            cacheHit: false,
            cacheState: 'cold',
        });
        expect(validationGates.getValidationStageCacheDecision(stage, {
            lastPassingFingerprints: new Map([[
                'typecheck.full',
                'fingerprint-a',
            ]]),
            noCache: true,
        })).toMatchObject({
            cacheHit: false,
            cacheReason: 'cache-disabled',
        });
    });

    it('fingerprints nested release and fixture directories but ignores build output directories', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-input-fingerprint-'));
        try {
            await mkdir(join(root, 'scripts', 'release'), {recursive: true});
            await mkdir(join(root, 'tests', 'fixtures', 'release'), {recursive: true});
            await mkdir(join(root, 'native', 'crate', 'target'), {recursive: true});
            await mkdir(join(root, 'release'), {recursive: true});
            await writeFile(join(root, 'scripts', 'release', 'cut.mjs'), 'export const a = 1;\n');
            await writeFile(join(root, 'tests', 'fixtures', 'release', 'fixture.json'), '{}\n');
            await writeFile(join(root, 'native', 'crate', 'target', 'artifact.bin'), 'a');
            await writeFile(join(root, 'release', 'artifact.dmg'), 'a');
            const inputPaths = [
                'scripts',
                'tests',
                'native',
                'release',
            ];
            const fingerprint = () => validationGates.getValidationInputFingerprint({
                inputPaths,
                root,
            });
            const initial = fingerprint();

            await writeFile(join(root, 'native', 'crate', 'target', 'artifact.bin'), 'b');
            await writeFile(join(root, 'release', 'artifact.dmg'), 'b');
            expect(fingerprint()).toBe(initial);

            await writeFile(join(root, 'scripts', 'release', 'cut.mjs'), 'export const a = 2;\n');
            const afterScriptChange = fingerprint();
            expect(afterScriptChange).not.toBe(initial);

            await writeFile(join(root, 'tests', 'fixtures', 'release', 'fixture.json'), '{"changed":true}\n');
            expect(fingerprint()).not.toBe(afterScriptChange);
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('invalidates the local strict-build marker when an input changes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-build-marker-'));
        try {
            await mkdir(join(root, 'dist'), {recursive: true});
            await writeFile(join(root, 'dist', 'bundle.js'), 'bundle\n');
            await writeFile(join(root, 'package.json'), '{}\n');
            const markerPath = await validationGates.writeValidationBuildMarker({
                buildScriptName: 'build:desktop',
                outputPaths: ['dist'],
                root,
            });

            expect(markerPath).toBe(validationGates.getValidationBuildMarkerPath(root));
            expect(validationGates.isValidationBuildFresh({
                buildScriptName: 'build:desktop',
                outputPaths: ['dist'],
                root,
            })).toBe(true);
            await writeFile(join(root, 'package.json'), '{"changed":true}\n');
            expect(validationGates.isValidationBuildFresh({
                buildScriptName: 'build:desktop',
                outputPaths: ['dist'],
                root,
            })).toBe(false);
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it.runIf(process.platform !== 'win32')('reclaims a heavy-gate slot held by an unreaped zombie', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-heavy-gate-zombie-'));
        let zombieFixture: Awaited<ReturnType<typeof spawnUnreapedZombie>> | undefined;
        try {
            zombieFixture = await spawnUnreapedZombie();
            const holdersDir = join(root, 'holders');
            await mkdir(holdersDir, {recursive: true});
            await writeFile(join(holdersDir, 'zombie.json'), JSON.stringify({
                id: 'unreaped-zombie',
                pid: zombieFixture.zombiePid,
                weight: 1,
            }));

            const gate = await validationGates.acquireHeavyGate({
                capacity: 1,
                env: {},
                id: 'after-zombie',
                root,
                waitMs: 50,
            });
            expect(gate.coordinated).toBe(true);
            await gate.release();
        } finally {
            if (zombieFixture) {
                await forceKillAndWait(zombieFixture.parent);
            }
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('bounds ignored gate evidence and fingerprint cache entries', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-gate-retention-'));
        try {
            await Promise.all(Array.from({length: 5}, (_, index) => (
                writeFile(join(root, `${index}.json`), `${index}\n`)
            )));
            const removed = await validationGates.pruneRetentionEntries({
                keep: 2,
                minimumAgeMs: 0,
                root,
            });

            expect(removed).toHaveLength(3);
            await expect(readdir(root)).resolves.toHaveLength(2);
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });
});
