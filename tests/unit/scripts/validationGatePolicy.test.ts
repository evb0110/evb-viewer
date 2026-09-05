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
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
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
        coordinated: boolean;
        release: () => Promise<void>;
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
        runStage: (stage: T) => Promise<void>,
        options?: {capacity?: number},
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
        // Keep the deliberately invalid fixture dot-prefixed. ESLint excludes
        // dotfiles from directory globs used by the full gate, while an
        // explicit --file still exercises the changed-file path below.
        const invalidPath = `tests/unit/scripts/.validation-gate-policy-invalid-${process.pid}.ts`;
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
    }, 30_000);

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
            'fallow.dead-code',
            'build.strict',
            'electron.blocking-smoke',
        ]));

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

        expect(related?.args).toContain('unit-app');
        expect(related?.args).toContain('unit-static-architecture');
        expect(related?.args).not.toContain('unit-core');
        expect(related?.args).not.toContain('unit-electron');
        expect(related?.args).not.toContain('unit-scripts');
        expect(related?.args).not.toContain('unit-policy');
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

    it('routes exact-fixture and quarantine admission policy through blocking policy tests', () => {
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
        const policyStage = plan.find(stage => stage.id === 'test.unit.full');

        expect(classification.impacts.policy).toBe(true);
        expect(policyStage?.args).toContain('test:unit');
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
            'typecheck.coverage',
            'test.coverage',
            'fallow.dupes',
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
        expect(plan.find(stage => stage.id === 'test.unit.affected-projects')?.args)
            .toContain('unit-static-architecture');
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
            'test.coverage',
            'typecheck.coverage',
            'fallow.dead-code',
            'fallow.dupes',
            'static.platform-report',
            'static.web-deploy-source',
            'native.lint',
            'native.test',
            'native.resource-matrix',
            'build.strict',
            'electron.bundle-integrity',
            'electron.blocking-smoke',
        ]);
        expect(scripts).toContain('lint');
        expect(scripts).toContain('typecheck');
        expect(scripts).toContain('test:coverage');
        expect(scripts).toContain('fallow');
        expect(scripts).toContain('fallow:dupes');
        expect(scripts).not.toContain('lint:clean');
        expect(scripts).not.toContain('typecheck:clean');
        expect(scripts).not.toContain('fallow:all');
        expect(scripts).not.toContain('test:unit');
        expect(plan.find(stage => stage.id === 'electron.blocking-smoke')?.args)
            .toContain('--no-build');
        expect(plan.find(stage => stage.id === 'electron.blocking-smoke')?.env)
            .toMatchObject({EVB_PDF_PAGE_OPS_ENABLE: '1'});
        expect(plan.find(stage => stage.id === 'native.test')?.dependsOn)
            .toEqual(['build.prepare']);
        expect(plan.find(stage => stage.id === 'native.resource-matrix')?.dependsOn)
            .toEqual(['build.strict']);
        expect(plan.find(stage => stage.id === 'build.strict')?.dependsOn)
            .toEqual(['build.prepare']);
        expect(plan.find(stage => stage.id === 'electron.bundle-integrity')?.dependsOn)
            .toEqual(['build.strict']);
        expect(plan.find(stage => stage.id === 'electron.blocking-smoke')?.dependsOn)
            .toEqual([
                'build.strict',
                'electron.bundle-integrity',
            ]);
        expect(plan.filter(stage => stage.cacheable).map(stage => stage.id)).toEqual(expect.arrayContaining([
            'lint.full',
            'typecheck.full',
            'typecheck.coverage',
            'fallow.dead-code',
            'fallow.dupes',
            'static.platform-report',
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
            expect(saturated.coordinated).toBe(false);
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
            await expect(validationGates.isValidationBuildFresh({
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
