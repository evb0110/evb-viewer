#!/usr/bin/env node
import { getCliErrorMessage } from './lib/cli-error.mjs';
import {
    execFileSync,
    spawn,
} from 'node:child_process';
import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {
    constants as fsConstants,
    createWriteStream,
    existsSync,
    lstatSync,
    readFileSync,
    readdirSync,
    readlinkSync,
} from 'node:fs';
import {
    mkdir,
    open,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    unlink,
    writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { collectPrePushWork } from './check-commit-attribution.mjs';
import { getValidationImpactPolicy } from './release/policy.mjs';
import { matchesChangedAreaPattern } from './ci/classify-changed-areas.mjs';
import { withNodeHeap } from './typecheckNodeEnv.mjs';
import {createAllGatesValidationStages} from './all-gates-validation-plan.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unitProjects = [
    'unit-core',
    'unit-app',
    'unit-electron',
    'unit-scripts',
    'unit-policy',
    'unit-static-architecture',
];
const allTs7Projects = [
    'electron/tsconfig.json',
    'tests/tsconfig.json',
    'tsconfig.scripts.json',
    'tsconfig.scripts-js.json',
    'server/tsconfig.json',
];
// ESLint holds one TypeScript program per tsconfig in the flat config, and the
// tests program alone types 1300+ files, so the peak lives above 6 GB.
const eslintNodeHeapMb = 8192;
const heavyGateDefaultWaitMs = 30 * 60_000;
const heavyGateWaitReportIntervalMs = 10_000;
const processTerminationGraceMs = 1_500;
const validationCacheSchemaVersion = 1;
const validationCacheRootOnlyDirectories = new Set([
    '.devkit',
    '.tmp',
    'coverage',
    'dist-electron',
    'nuxt-output',
    'release',
]);
const validationCacheDirectoryNames = new Set([
    '.git',
    '.nuxt',
    '.output',
    'node_modules',
    'target',
]);
const validationInputHashCache = new Map();
/** @type {Record<string, string[]>} */
const validationStageInputPaths = {
    build: [
        'app',
        'build',
        'electron',
        'native',
        'packages',
        'public',
        'resources',
        'packages/scan-cleanup/adapters',
        'packages/scan-cleanup/core',
        'server',
        'electron-builder.yml',
        'nuxt.config.ts',
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'scripts',
        'tsconfig*.json',
    ],
    lint: [
        'app',
        'electron',
        'landing',
        'packages',
        'packages/scan-cleanup/adapters',
        'packages/scan-cleanup/core',
        'scripts',
        'server',
        'tests',
        '.github',
        'eslint.config.mjs',
        'eslint.shared.mjs',
        'eslint-plugin-custom.mjs',
        'landing/eslint.config.mjs',
        'nuxt.config.ts',
        'stylelint.config.mjs',
        'package.json',
        'pnpm-lock.yaml',
        'tsconfig*.json',
        'vitest.config.ts',
        'vitest.shared.config.ts',
    ],
    native: [
        'native',
        'resources',
        'scripts/checkSearchNativeParity.ts',
        'scripts/check-native-tools-source-matrix.sh',
        'native/Cargo.toml',
        'native/Cargo.lock',
        'rust-toolchain.toml',
        'package.json',
        'pnpm-lock.yaml',
    ],
    'static-platform': [
        'app',
        'electron',
        'packages',
        'scripts/reportPlatformManifestConsumers.ts',
        'package.json',
        'pnpm-lock.yaml',
        'tsconfig*.json',
    ],
    typecheck: [
        'app',
        'electron',
        'packages',
        'scripts',
        'server',
        'tests',
        'types',
        'nuxt.config.ts',
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'tsconfig*.json',
    ],
    'web-deploy': [
        '.vercelignore',
        'app',
        'nuxt.config.ts',
        'package.json',
        'patches',
        'public',
        'packages/scan-cleanup/adapters',
        'packages/scan-cleanup/core',
        'scripts/check-web-deploy-source.mjs',
        'scripts/deployVercelPrivate.mjs',
        'server',
        'vercel.json',
    ],
};
const validationToolPackages = [
    'electron-builder',
    'eslint',
    'esbuild',
    'nuxt',
    'stylelint',
    'typescript',
    'tsx',
    'vitest',
    'vue-tsc',
];
const validationEnvironmentKeys = new Set([
    'CI',
    'EVB_ELECTRON_SOURCEMAP',
    'EVB_NATIVE_TARGET_ARCH',
    'EVB_NATIVE_TARGET_PLATFORM',
    'EVB_STRICT_BUILD_SKIP_WASM_CHECK',
    'NODE_ENV',
    'RUSTFLAGS',
    'TARGET_ARCH',
    'npm_config_arch',
]);
const toolVersionCache = new Map();
const lintableSourcePattern = /\.(?:[cm]?[jt]sx?|vue)$/u;
const ordinaryUnitTestPattern = /^tests\/unit\/.+\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const lintableWorkflowPattern = /^\.github\/.*\.(?:ya?ml)$/u;
const sharedUnitTestDependencyPatterns = [
    /^tests\/fixtures\//u,
    /^tests\/helpers\//u,
    /^tests\/setup\.ts$/u,
];
const appUnitTestDependencyPattern = /^tests\/setupApp\.ts$/u;
const validationTiers = new Set([
    'iteration',
    'acceptance',
    'integration',
    'nightly',
]);
const lintableStylePattern = /\.(?:css|scss|vue)$/u;

/** @param {IValidationClassification} classification @returns {boolean} */
function isToolingOnlyClassification(classification) {
    return classification.impacts.tooling === true && ![
        'app',
        'build',
        'electron',
        'landing',
        'native',
        'packages',
        'policy',
        'server',
        'tests',
    ].some(impact => classification.impacts[impact]);
}

/** @typedef {'iteration' | 'acceptance' | 'integration' | 'nightly' | 'lint' | 'lint-all' | 'lint-changed' | 'heavy'} TValidationTier */
/** @typedef {{args: string[], command: string, id: string, additionalInputPaths?: string[], cachePath?: string, cacheable?: boolean, dependsOn?: string[], env?: NodeJS.ProcessEnv, heavyWeight?: number, inputFingerprint?: string, inputPaths?: string[], inputScope?: string, parallelPhase?: string, priority?: number, tools?: string[], weight?: number}} IValidationStage */
/** @typedef {{additionalInputPaths?: string[], args?: string[], cachePath?: string, cacheable?: boolean, dependsOn?: string[], env?: NodeJS.ProcessEnv, heavyWeight?: number, inputFingerprint?: string, inputPaths?: string[], inputScope?: string, parallelPhase?: string, priority?: number, tools?: string[], weight?: number}} IValidationStageOptions */
/** @typedef {{base?: string | undefined, classification?: IValidationClassification, files: string[], known: boolean, reason?: string | undefined}} IValidationChanges */
/** @typedef {{full: boolean, impacts: Record<string, boolean>, unmatchedFiles: string[]}} IValidationClassification */
/** @typedef {{paths: string[]}} IValidationImpactDefinition */
/** @typedef {{additionalInputPaths?: string[], extraValues?: unknown[], inputPaths?: string[], inputScope?: string | undefined, root?: string, tools?: string[]}} IValidationFingerprintOptions */
/** @typedef {{cacheHit: boolean, cacheReason: string, cacheState: string, inputFingerprint: string}} IValidationCacheDecision */
/** @typedef {{cache: string, cacheHit: boolean, cacheReason: string, dependsOn: string[], endedAt: string, gateCapacity?: number, gateWaitMs?: number, id: string, inputFingerprint: string, loadAverage: number[], skipped: boolean, status: 'passed' | 'failed' | 'interrupted', wallMs: number, weight: number}} IValidationStageResult */
/** @typedef {{error: unknown, id: string}} IValidationStageFailure */
/** @typedef {{dependency: string, id: string}} IValidationStageSkip */
/** @typedef {{capacity: number, coordinated: boolean, release: (options?: {ownedGroupIds?: number[] | undefined, ownedPids?: number[] | undefined, retain?: boolean | undefined}) => Promise<void>, waitedMs: number}} IHeavyGateHandle */
/** @typedef {{acquired: boolean, capacity: number, holders: {id: string, ownedGroupIds?: number[], ownedPids?: number[], pid: number, projectRoot?: string, weight: number}[], usedWeight: number}} IHeavyGateAdmission */
/** @typedef {{error: null, ok: true, stageDefinition: IValidationStage} | {error: unknown, ok: false, stageDefinition: IValidationStage}} IValidationStageOutcome */
/** @typedef {{failures: IValidationStageFailure[], skipped: IValidationStageSkip[]}} IValidationStagePoolResult */
/** @typedef {{code?: string, message?: string}} INodeError */
/** @typedef {{interrupted?: boolean | undefined, retainCapacity?: boolean | undefined, ownedGroupIds?: number[] | undefined, ownedPids?: number[] | undefined, failures?: IValidationStageFailure[] | undefined, skipped?: IValidationStageSkip[] | undefined}} IValidationErrorState */
/** @typedef {{capacity?: number | undefined, signal?: AbortSignal | undefined}} IValidationStagePoolOptions */
/** @typedef {{signal?: AbortSignal | undefined}} IValidationSignalOptions */
/** @typedef {{changes?: IValidationChanges | undefined, noCache?: boolean | undefined, signal?: AbortSignal | undefined, tier?: TValidationTier | undefined}} IValidationStagesOptions */
/** @typedef {{capacity?: number | undefined, env?: NodeJS.ProcessEnv | undefined, failOpenOnTimeout?: boolean | undefined, id?: string | undefined, root?: string | undefined, signal?: AbortSignal | undefined, waitMs?: number | undefined, weight?: number | undefined}} IHeavyGateOptions */
/** @typedef {{owned: boolean, ownedGroupIds?: number[] | undefined, ownedPids?: number[] | undefined}} IProcessStopResult */

/** @param {unknown} value @returns {value is INodeError} */
function isNodeError(value) {
    return typeof value === 'object' && value !== null;
}

/** @param {unknown} value @returns {value is IValidationErrorState} */
function isValidationErrorState(value) {
    return typeof value === 'object' && value !== null;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}

/** @param {string | undefined} value @returns {value is TValidationTier} */
function isValidationTier(value) {
    return value !== undefined && validationTiers.has(value);
}

/** @param {string} filePath */
function normalizePath(filePath) {
    return filePath.split(path.sep).join('/').replace(/^\.\//u, '');
}
/** @param {string[]} values @returns {string[]} */
function unique(values) {
    return [...new Set(values)];
}
/** @param {unknown} value @param {number} fallback */
function parsePositiveInteger(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
/** @param {unknown} value @returns {number | undefined} */
function parsePositiveIntegerOrUndefined(value) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
/** @returns {number} */
export function getDefaultGateCapacity() {
    return typeof os.availableParallelism === 'function'
        ? os.availableParallelism()
        : Math.max(os.cpus().length, 1);
}
/** @param {number | undefined} capacity @param {NodeJS.ProcessEnv} env @returns {number | undefined} */
function resolveConfiguredHeavyGateCapacity(capacity, env) {
    const configuredCapacity = capacity === undefined
        ? env.EVB_GATE_CAPACITY
        : capacity;
    return parsePositiveIntegerOrUndefined(configuredCapacity);
}
/** @param {string[]} argv @param {string} name @returns {string | undefined} */
function readArg(argv, name) {
    const prefix = `--${name}=`;
    return argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length);
}
/** @param {string[]} argv @param {string} name @returns {string[]} */
function readArgs(argv, name) {
    const prefix = `--${name}=`;
    return argv
        .filter(argument => argument.startsWith(prefix))
        .map(argument => argument.slice(prefix.length))
        .filter(Boolean);
}
/** @param {string} command @param {string[]} args @param {import('node:child_process').SpawnOptions} [options] @returns {Promise<{error: Error | null, status: number | null, stderr: string, stdout: string}>} */
function runCapture(command, args, options = {}) {
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            cwd: projectRoot,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
            ...options,
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', chunk => {
            stdout += chunk;
        });
        child.stderr?.on('data', chunk => {
            stderr += chunk;
        });
        child.on('error', error => resolve({
            error,
            status: null,
            stderr,
            stdout,
        }));
        child.on('close', status => resolve({
            error: null,
            status,
            stderr,
            stdout,
        }));
    });
}
/** @param {string[]} args @returns {Promise<string | null>} */
async function gitOutput(args) {
    const result = await runCapture('git', args);
    if (result.error || result.status !== 0) {
        return null;
    }
    return result.stdout.trim();
}
/** @param {string | null | undefined} output @returns {string[]} */
function splitNullOutput(output) {
    return output?.split('\0').filter(Boolean).map(normalizePath) ?? [];
}
/** @param {{base?: string | undefined, explicitFiles?: string[] | undefined}} options @returns {Promise<IValidationChanges>} */
export async function collectValidationChanges({
    base,
    explicitFiles = [],
} = {}) {
    if (explicitFiles.length > 0) {
        return {
            files: unique(explicitFiles.map(normalizePath)),
            known: true,
            reason: 'explicit-files',
        };
    }
    const resolvedBase = base
        ?? process.env.EVB_GATE_BASE
        ?? await gitOutput([
            'merge-base',
            'HEAD',
            'origin/main',
        ]);
    const workingOutputs = await Promise.all([
        gitOutput([
            'diff',
            '--name-only',
            '--no-renames',
            '--diff-filter=ACDMR',
            '-z',
        ]),
        gitOutput([
            'diff',
            '--cached',
            '--name-only',
            '--no-renames',
            '--diff-filter=ACDMR',
            '-z',
        ]),
        gitOutput([
            'ls-files',
            '--others',
            '--exclude-standard',
            '-z',
        ]),
    ]);
    if (!resolvedBase || workingOutputs.some(output => output === null)) {
        return {
            files: [],
            known: false,
            reason: 'git-change-detection-failed',
        };
    }
    const committedOutput = await gitOutput([
        'diff',
        '--name-only',
        '--no-renames',
        '--diff-filter=ACDMR',
        '-z',
        `${resolvedBase}...HEAD`,
    ]);
    if (committedOutput === null) {
        return {
            files: [],
            known: false,
            reason: 'git-base-diff-failed',
        };
    }
    return {
        base: resolvedBase,
        files: unique([
            ...splitNullOutput(committedOutput),
            ...workingOutputs.flatMap(splitNullOutput),
        ]).sort(),
        known: true,
        reason: 'git',
    };
}
/** @param {string[]} files @param {Record<string, IValidationImpactDefinition>} [policy] @returns {IValidationClassification} */
export function classifyValidationImpacts(
    files,
    policy = getValidationImpactPolicy(),
) {
    const normalizedFiles = unique(files.map(normalizePath).filter(Boolean));
    const impacts = Object.fromEntries(Object.entries(policy).map(([
        impact,
        definition,
    ]) => [
        impact,
        normalizedFiles.some(file => definition.paths.some(pattern => (
            matchesChangedAreaPattern(file, pattern)
        ))),
    ]));
    const unmatchedFiles = normalizedFiles.filter(file => !Object.values(policy).some(definition => (
        definition.paths.some(pattern => matchesChangedAreaPattern(file, pattern))
    )));
    return {
        full: unmatchedFiles.length > 0,
        impacts,
        unmatchedFiles,
    };
}
/** @param {string[]} files @param {IValidationClassification} classification */
function selectedTypecheckProjects(files, classification) {
    if (classification.full || classification.impacts.policy) {
        return {
            nuxt: true,
            projects: [...allTs7Projects],
            workspacePackages: true,
        };
    }
    if (isToolingOnlyClassification(classification)) {
        return {
            nuxt: false,
            projects: [],
            workspacePackages: false,
        };
    }
    const projects = [];
    if (classification.impacts.electron) {
        projects.push('electron/tsconfig.json');
    }
    if (classification.impacts.tests) {
        projects.push('tests/tsconfig.json');
    }
    if (classification.impacts.scripts || classification.impacts.build || classification.impacts.native) {
        projects.push('tsconfig.scripts.json', 'tsconfig.scripts-js.json');
    }
    if (classification.impacts.server) {
        projects.push('server/tsconfig.json');
    }
    if (classification.impacts.packages) {
        projects.push(...allTs7Projects);
    }

    return {
        nuxt: classification.impacts.app || classification.impacts.packages,
        projects: unique(projects),
        workspacePackages: classification.impacts.packages,
    };
}
/** @param {string[]} files @param {IValidationClassification} classification @returns {string[]} */
function selectedUnitProjects(files, classification) {
    if (classification.full || classification.impacts.policy) {
        return [...unitProjects];
    }
    if (files.some(file => sharedUnitTestDependencyPatterns.some(pattern => pattern.test(file)))) {
        return [...unitProjects];
    }
    const projects = [];
    if (classification.impacts.tooling) {
        projects.push('unit-scripts', 'unit-policy');
    }
    if (files.some(file => appUnitTestDependencyPattern.test(file))) {
        projects.push('unit-app', 'unit-landing');
    }
    if (classification.impacts.app) {
        projects.push('unit-app', 'unit-static-architecture');
    }
    if (classification.impacts.electron) {
        projects.push('unit-electron');
    }
    if (classification.impacts.packages || classification.impacts.server) {
        projects.push('unit-core');
    }
    if (classification.impacts.packages) {
        projects.push(...unitProjects);
    }
    if (classification.impacts.scripts || classification.impacts.build || classification.impacts.native) {
        projects.push('unit-scripts');
        if (!isToolingOnlyClassification(classification)) {
            projects.push('unit-static-architecture');
        }
    }
    for (const file of files) {
        if (file.startsWith('tests/e2e/electron/quarantine/')) {
            projects.push('unit-static-architecture');
        } else if (file.startsWith('tests/unit/app/')) {
            projects.push('unit-app', 'unit-static-architecture');
        } else if (file.startsWith('tests/unit/architecture/')) {
            projects.push('unit-static-architecture');
        } else if (file.startsWith('tests/unit/electron/') || file.startsWith('tests/unit/e2e/')) {
            projects.push('unit-electron');
        } else if (file.startsWith('tests/unit/landing/')) {
            projects.push('unit-landing');
        } else if (file.startsWith('tests/unit/scripts/')) {
            projects.push('unit-scripts', 'unit-policy');
        } else if (file.startsWith('tests/unit/')) {
            projects.push('unit-core');
        }
    }
    return unique(projects);
}
/** @param {string[]} files @returns {string[]} */
function getOrdinaryUnitTestFiles(files) {
    if (files.length === 0 || files.some(file => (
        !ordinaryUnitTestPattern.test(file)
        || !existsSync(path.join(projectRoot, file))
    ))) {
        return [];
    }
    return files;
}
/** @param {string[]} files @returns {boolean} */
function hasLintableChangedFile(files) {
    return files.some(file => lintableSourcePattern.test(file)
        || lintableWorkflowPattern.test(file)
        || (lintableStylePattern.test(file)
            && (file.startsWith('app/') || file.startsWith('landing/app/'))));
}
/** @param {string} id @param {string} command @param {string[]} args @param {IValidationStageOptions} options @returns {IValidationStage} */
function stage(id, command, args, options = {}) {
    return {
        args,
        command,
        dependsOn: [],
        heavyWeight: 0,
        weight: 1,
        ...options,
        id,
    };
}
/** @param {string} id @param {string} scriptName @param {IValidationStageOptions} options @returns {IValidationStage} */
function pnpmRunStage(id, scriptName, options = {}) {
    return stage(id, 'pnpm', [
        'run',
        scriptName,
    ], options);
}
/** @param {string} id @param {string} scriptName @param {string[]} args @param {IValidationStageOptions} options @returns {IValidationStage} */
function nodeStage(id, scriptName, args = [], options = {}) {
    return stage(id, 'node', [
        scriptName,
        ...args,
    ], options);
}
/** @param {string} id @param {string[]} projects @param {string[]} extraArgs @param {IValidationStageOptions} options @returns {IValidationStage} */
function vitestStage(id, projects, extraArgs = [], options = {}) {
    return stage(id, 'pnpm', [
        'exec',
        'vitest',
        'run',
        ...projects.flatMap(project => [
            '--project',
            project,
        ]),
        ...extraArgs,
    ], options);
}
/** @param {string} id @param {string[]} projects @param {string[]} files @param {IValidationStageOptions} options @returns {IValidationStage} */
function vitestRelatedStage(id, projects, files, options = {}) {
    return stage(id, 'pnpm', [
        'exec',
        'vitest',
        'related',
        '--run',
        ...files,
        ...projects.flatMap(project => [
            '--project',
            project,
        ]),
        '--passWithNoTests',
    ], options);
}
/** @param {TValidationTier} tier @param {string[]} files @param {IValidationClassification} classification @returns {IValidationStage[]} */
function affectedPlan(tier, files, classification) {
    const stages = [];
    const typecheck = selectedTypecheckProjects(files, classification);
    const selectedUnits = selectedUnitProjects(files, classification);
    const ordinaryUnitTestFiles = getOrdinaryUnitTestFiles(files);
    if (hasLintableChangedFile(files)) {
        stages.push(nodeStage('lint.affected', 'scripts/validation-gates.mjs', [
            'lint',
            '--changed',
            ...files.map(file => `--file=${file}`),
        ], {
            additionalInputPaths: files,
            cacheable: true,
            inputScope: 'lint',
            weight: 2,
        }));
    }
    if (typecheck.nuxt) {
        stages.push(nodeStage('typecheck.nuxt', 'scripts/run-nuxt-typecheck.mjs', [], {
            additionalInputPaths: files,
            cacheable: true,
            inputScope: 'typecheck',
        }));
    }
    if (typecheck.projects.length > 0 || typecheck.workspacePackages) {
        stages.push(stage('typecheck.ts7', 'node', [
            typecheck.workspacePackages
                ? 'scripts/run-workspace-package-typecheck.mjs'
                : 'scripts/run-ts7-typecheck.mjs',
            ...typecheck.projects.flatMap(project => [
                '-p',
                project,
            ]),
        ], {
            additionalInputPaths: files,
            cacheable: true,
            inputScope: 'typecheck',
        }));
    }
    if (tier === 'iteration') {
        const relatedFiles = files.filter(file => /\.(?:[cm]?[jt]sx?|vue)$/u.test(file));
        if (relatedFiles.length > 0 && selectedUnits.length > 0) {
            stages.push(vitestRelatedStage(
                'test.unit.related',
                selectedUnits,
                relatedFiles,
                {
                    heavyWeight: 4,
                    weight: 4,
                },
            ));
        }
        if (classification.impacts.native) {
            stages.push(
                pnpmRunStage('native.lint', 'lint:rust', {
                    cacheable: true,
                    heavyWeight: 2,
                    inputScope: 'native',
                    weight: 2,
                }),
                pnpmRunStage('native.test', 'test:rust', {
                    heavyWeight: 4,
                    weight: 4,
                }),
            );
        }
        return stages;
    }

    if (selectedUnits.length > 0) {
        stages.push(vitestStage('test.unit.affected-projects', selectedUnits, ordinaryUnitTestFiles, {
            heavyWeight: 4,
            weight: 4,
        }));
    }
    if (classification.impacts.webDeploy) {
        stages.push(nodeStage('static.web-deploy-source', 'scripts/check-web-deploy-source.mjs', ['--allow-dirty'], {
            cacheable: true,
            inputScope: 'web-deploy',
        }));
    }
    if (classification.impacts.landing) {
        stages.push(stage('landing.typecheck', 'pnpm', [
            '--dir',
            'landing',
            'run',
            'typecheck',
        ], {
            additionalInputPaths: files,
            cacheable: true,
            inputScope: 'typecheck',
        }));
    }
    if (classification.impacts.native) {
        stages.push(
            pnpmRunStage('native.lint', 'lint:rust', {
                cacheable: true,
                heavyWeight: 2,
                inputScope: 'native',
                weight: 2,
            }),
            pnpmRunStage('native.test', 'test:rust', {
                heavyWeight: 4,
                weight: 4,
            }),
            pnpmRunStage('native.resource-matrix', 'check:resources:matrix', {
                cacheable: true,
                dependsOn: ['build.strict'],
                env: {EVB_BUILD_ARTIFACTS_PREPARED: '1'},
                inputScope: 'native',
            }),
        );
    }
    if (classification.impacts.native || classification.impacts.build) {
        stages.push(pnpmRunStage('build.strict', 'build:strict', {
            heavyWeight: 2,
            inputScope: 'build',
            weight: 2,
        }));
    }
    if (classification.impacts.app || classification.impacts.electron) {
        if (tier === 'integration') {
            const hasStrictBuild = stages.some(item => item.id === 'build.strict');
            stages.push(hasStrictBuild
                ? stage('electron.regression', 'bash', [
                    'scripts/test-electron-e2e-headless.sh',
                    '--no-build',
                    'e2e-regression',
                ], {
                    dependsOn: ['build.strict'],
                    heavyWeight: 2,
                    inputScope: 'build',
                    weight: 2,
                })
                : pnpmRunStage(
                    'electron.regression',
                    'test:e2e:electron:headless',
                    {
                        heavyWeight: 2,
                        inputScope: 'build',
                        weight: 2,
                    },
                ));
        } else {
            const hasStrictBuild = stages.some(item => item.id === 'build.strict');
            stages.push(hasStrictBuild
                ? stage('electron.blocking-smoke', 'bash', [
                    'scripts/test-electron-e2e-headless.sh',
                    '--no-build',
                    'e2e-blocking-smoke',
                ], {
                    dependsOn: ['build.strict'],
                    env: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
                    heavyWeight: 3,
                    inputScope: 'build',
                    weight: 3,
                })
                : pnpmRunStage(
                    'electron.blocking-smoke',
                    'test:e2e:electron:blocking-smoke:headless',
                    {
                        heavyWeight: 3,
                        inputScope: 'build',
                        weight: 3,
                    },
                ));
        }
    }
    return stages;
}
/** @param {{allGates?: boolean, cold?: boolean, changes: IValidationChanges, classification?: IValidationClassification, tier: TValidationTier}} options @returns {IValidationStage[]} */
export function getValidationPlan({
    allGates = false,
    cold = false,
    changes,
    classification = classifyValidationImpacts(changes.files),
    tier,
}) {
    if (!validationTiers.has(tier)) {
        throw new Error(`Unknown validation tier "${tier}".`);
    }
    const mustRunFull = allGates
        || !changes.known
        || classification.full
        || classification.impacts.policy;

    if (tier === 'iteration' && changes.known && changes.files.length === 0) {
        return [];
    }
    if ((tier === 'iteration' || tier === 'acceptance' || tier === 'integration') && !mustRunFull) {
        return affectedPlan(tier, changes.files, classification);
    }
    if (tier === 'iteration') {
        return [
            pnpmRunStage('lint.full', cold ? 'lint:clean' : 'lint', {
                cacheable: true,
                heavyWeight: 2,
                inputScope: 'lint',
                weight: 2,
            }),
            pnpmRunStage('typecheck.full', cold ? 'typecheck:clean' : 'typecheck', {
                cacheable: true,
                heavyWeight: 1,
                inputScope: 'typecheck',
            }),
            pnpmRunStage('test.unit.full', 'test:unit', {
                heavyWeight: 4,
                weight: 4,
            }),
        ];
    }

    if (allGates && tier === 'acceptance') {
        return createAllGatesValidationStages({cold});
    }

    const fullStages = [
        pnpmRunStage('lint.full', cold || tier !== 'acceptance' ? 'lint:clean' : 'lint', {
            cacheable: true,
            heavyWeight: 2,
            inputScope: 'lint',
            weight: 2,
        }),
        pnpmRunStage('typecheck.full', cold || tier !== 'acceptance' ? 'typecheck:clean' : 'typecheck', {
            cacheable: true,
            heavyWeight: 1,
            inputScope: 'typecheck',
        }),
        ...(tier === 'nightly'
            ? []
            : [pnpmRunStage('test.unit.full', 'test:unit', {
                heavyWeight: 4,
                weight: 4,
            })]),
        pnpmRunStage('build.strict', 'build:strict', {
            heavyWeight: 2,
            inputScope: 'build',
            weight: 2,
        }),
    ];
    if (tier === 'acceptance' || tier === 'integration') {
        if (tier === 'acceptance') {
            fullStages.push(pnpmRunStage(
                'electron.bundle-integrity',
                'test:electron-bundle-static-integrity:no-build',
                {
                    dependsOn: ['build.strict'],
                    inputScope: 'build',
                },
            ));
            fullStages.push(stage('electron.blocking-smoke', 'bash', [
                'scripts/test-electron-e2e-headless.sh',
                '--no-build',
                'e2e-blocking-smoke',
            ], {
                dependsOn: [
                    'build.strict',
                    'electron.bundle-integrity',
                ],
                env: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
                heavyWeight: 3,
                inputScope: 'build',
                weight: 3,
            }));
        }
        if (
            tier === 'integration'
            && (
                !changes.known
                || classification.full
                || classification.impacts.policy
                || classification.impacts.app
                || classification.impacts.electron
            )
        ) {
            fullStages.push(stage('electron.regression', 'bash', [
                'scripts/test-electron-e2e-headless.sh',
                '--no-build',
                'e2e-regression',
            ], {
                dependsOn: ['build.strict'],
                heavyWeight: 2,
                inputScope: 'build',
                weight: 2,
            }));
        }
        return fullStages;
    }

    return [
        ...fullStages,
        pnpmRunStage('static.platform-report', 'check:static:reports', {
            cacheable: true,
            inputScope: 'static-platform',
        }),
        pnpmRunStage('static.web-deploy-source', 'check:static:assets', {
            args: [
                'run',
                'check:static:assets',
                '--allow-dirty',
            ],
            cacheable: true,
            inputScope: 'web-deploy',
        }),
        pnpmRunStage('test.coverage', 'test:coverage', {
            heavyWeight: 4,
            weight: 4,
        }),
        pnpmRunStage('native.test', 'test:rust', {
            heavyWeight: 4,
            weight: 4,
        }),
        pnpmRunStage('native.resource-matrix', 'check:resources:matrix', {
            cacheable: true,
            dependsOn: ['build.strict'],
            env: {EVB_BUILD_ARTIFACTS_PREPARED: '1'},
            inputScope: 'native',
        }),
        pnpmRunStage(
            'electron.quarantine',
            'test:e2e:electron:quarantine:headless',
            {
                heavyWeight: 3,
                inputScope: 'build',
                weight: 3,
            },
        ),
    ];
}

/** @param {string[]} commits @returns {string[]} */
function collectPushedCommitFiles(commits) {
    const output = execFileSync('git', [
        'diff-tree',
        '--stdin',
        '-r',
        '-z',
        '--name-only',
        '--no-renames',
        '--root',
        '--diff-merges=first-parent',
        '--diff-filter=ACDMRT',
    ], {
        cwd: projectRoot,
        encoding: 'utf8',
        input: `${commits.join('\n')}\n`,
    });
    const requestedCommits = new Set(commits);
    let currentCommit;
    const files = [];
    for (const token of output.split('\0')) {
        if (requestedCommits.has(token)) {
            currentCommit = token;
        } else if (currentCommit && token.length > 0) {
            files.push(normalizePath(token));
        }
    }
    return unique(files).sort();
}

/** @param {string[]} filePaths @param {unknown[]} [extraValues] @param {string} [root] @returns {string} */
function hashFiles(filePaths, extraValues = [], root = projectRoot) {
    const hash = createHash('sha256');
    for (const value of extraValues) {
        hash.update(String(value));
        hash.update('\0');
    }
    for (const filePath of filePaths) {
        hash.update(filePath);
        hash.update('\0');
        try {
            hash.update(readFileSync(path.join(root, filePath)));
        } catch (error) {
            hash.update(`missing:${isNodeError(error) ? error.code ?? 'unknown' : 'unknown'}`);
        }
        hash.update('\0');
    }
    return hash.digest('hex');
}
/** @param {string} pattern @returns {RegExp} */
function pathPatternToRegExp(pattern) {
    return new RegExp(`^${pattern
        .split('*')
        .map(part => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
        .join('.*')}$`, 'u');
}
/** @param {string} inputPath @param {string} root @returns {string[]} */
function expandValidationInputPath(inputPath, root) {
    const normalizedInputPath = normalizePath(inputPath);
    if (!normalizedInputPath.includes('*')) {
        return [normalizedInputPath];
    }
    const directory = path.posix.dirname(normalizedInputPath);
    const basename = path.posix.basename(normalizedInputPath);
    const directoryPath = path.join(root, directory === '.' ? '' : directory);
    try {
        return readdirSync(directoryPath)
            .filter(entry => pathPatternToRegExp(basename).test(entry))
            .map(entry => path.posix.join(directory === '.' ? '' : directory, entry));
    } catch {
        return [];
    }
}
/** @param {string[]} inputPaths @param {string} root @returns {{files: string[], missing: string[]}} */
function collectValidationInputFiles(inputPaths, root) {
    const files = new Set();
    const missing = new Set();
    /** @param {string} relativePath */
    const visit = (relativePath) => {
        const absolutePath = path.join(root, relativePath);
        let metadata;
        try {
            metadata = lstatSync(absolutePath);
        } catch {
            missing.add(relativePath);
            return;
        }
        if (metadata.isDirectory()) {
            const normalizedDirectory = normalizePath(relativePath);
            if (
                validationCacheRootOnlyDirectories.has(normalizedDirectory)
                || validationCacheDirectoryNames.has(path.posix.basename(normalizedDirectory))
            ) {
                return;
            }
            let entries;
            try {
                entries = readdirSync(absolutePath).sort((left, right) => left.localeCompare(right, 'en'));
            } catch {
                missing.add(relativePath);
                return;
            }
            for (const entry of entries) {
                visit(path.posix.join(relativePath, entry));
            }
            return;
        }
        files.add(normalizePath(relativePath));
    };
    for (const inputPath of inputPaths) {
        const expandedPaths = expandValidationInputPath(inputPath, root);
        if (expandedPaths.length === 0) {
            missing.add(normalizePath(inputPath));
            continue;
        }
        for (const expandedPath of expandedPaths) {
            visit(expandedPath);
        }
    }
    return {
        files: [...files].sort(),
        missing: [...missing].sort(),
    };
}
/** @param {string} absolutePath @param {import('node:fs').Stats} metadata @returns {string} */
function validationFileDigest(absolutePath, metadata) {
    const cached = validationInputHashCache.get(absolutePath);
    if (cached && cached.size === metadata.size && cached.mtimeMs === metadata.mtimeMs) {
        return cached.digest;
    }
    const digest = createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
    validationInputHashCache.set(absolutePath, {
        digest,
        mtimeMs: metadata.mtimeMs,
        size: metadata.size,
    });
    return digest;
}
/** @param {string[]} inputPaths @param {string} root @returns {string} */
function hashValidationInputs(inputPaths, root) {
    const {
        files,
        missing,
    } = collectValidationInputFiles(inputPaths, root);
    const hash = createHash('sha256');
    for (const relativePath of files) {
        hash.update(relativePath);
        hash.update('\0');
        const absolutePath = path.join(root, relativePath);
        const metadata = lstatSync(absolutePath);
        if (metadata.isSymbolicLink()) {
            hash.update(`symlink:${readlinkSync(absolutePath)}`);
        } else {
            hash.update(validationFileDigest(absolutePath, metadata));
        }
        hash.update('\0');
    }
    for (const relativePath of missing) {
        hash.update(`missing:${relativePath}\0`);
    }
    return hash.digest('hex');
}
/** @param {string} packageName @param {string} root @returns {string} */
function readPackageVersion(packageName, root) {
    const cacheKey = `${root}\0package:${packageName}`;
    if (toolVersionCache.has(cacheKey)) {
        return toolVersionCache.get(cacheKey);
    }
    let version = 'unavailable';
    try {
        const packageJson = JSON.parse(readFileSync(
            path.join(root, 'node_modules', packageName, 'package.json'),
            'utf8',
        ));
        version = typeof packageJson.version === 'string' ? packageJson.version : 'unknown';
    } catch {
        // A missing optional tool still belongs in the key so a later install cannot reuse stale evidence.
    }
    toolVersionCache.set(cacheKey, version);
    return version;
}
/** @param {string} command @param {string[]} args @param {string} root @returns {string} */
function readCommandVersion(command, args, root) {
    const cacheKey = `${root}\0command:${command} ${args.join(' ')}`;
    if (toolVersionCache.has(cacheKey)) {
        return toolVersionCache.get(cacheKey);
    }
    let version = 'unavailable';
    try {
        version = execFileSync(command, args, {
            cwd: root,
            encoding: 'utf8',
            stdio: [
                'ignore',
                'pipe',
                'ignore',
            ],
        }).trim();
    } catch {
        // Keep the unavailable marker in the fingerprint. A newly available tool invalidates the old key.
    }
    toolVersionCache.set(cacheKey, version);
    return version;
}
/** @param {string[]} tools @param {string} root @returns {Record<string, string>} */
function validationToolVersions(tools, root) {
    /** @type {Record<string, string>} */
    const versions = {node: process.version};
    const requestedTools = new Set(tools);
    if (requestedTools.has('pnpm')) {
        versions.pnpm = readCommandVersion('pnpm', ['--version'], root);
    }
    for (const packageName of validationToolPackages) {
        if (requestedTools.has(packageName)) {
            versions[packageName] = readPackageVersion(packageName, root);
        }
    }
    if (requestedTools.has('cargo')) {
        versions.cargo = readCommandVersion('cargo', ['--version'], root);
    }
    if (requestedTools.has('rustc')) {
        versions.rustc = readCommandVersion('rustc', ['--version'], root);
    }
    return versions;
}
/** @returns {Record<string, string | undefined>} */
function validationEnvironmentValues() {
    return Object.fromEntries(Object.entries(process.env)
        .filter(([key]) => validationEnvironmentKeys.has(key)
            || key.startsWith('CARGO_')
            || key.startsWith('NUXT_')
            || key.startsWith('VITE_'))
        .sort(([left], [right]) => left.localeCompare(right, 'en')));
}
/** @param {IValidationStage} stageDefinition @returns {string[]} */
function inferValidationTools(stageDefinition) {
    if (stageDefinition.tools) {
        return stageDefinition.tools;
    }
    if (stageDefinition.inputScope === 'native') {
        return [
            'pnpm',
            'cargo',
            'rustc',
            'tsx',
        ];
    }
    if (stageDefinition.inputScope === 'typecheck') {
        return [
            'pnpm',
            'typescript',
            'vue-tsc',
            'nuxt',
        ];
    }
    if (stageDefinition.inputScope === 'lint') {
        return [
            'pnpm',
            'eslint',
            'stylelint',
        ];
    }
    if (stageDefinition.inputScope === 'build') {
        return [
            'cargo',
            'electron-builder',
            'esbuild',
            'pnpm',
            'nuxt',
            'rustc',
            'tsx',
        ];
    }
    if (stageDefinition.inputScope === 'static-platform') {
        return [
            'pnpm',
            'tsx',
        ];
    }
    return ['pnpm'];
}
/** @param {IValidationFingerprintOptions} options @returns {string} */
export function getValidationInputFingerprint({
    additionalInputPaths = [],
    extraValues = [],
    inputPaths = [],
    inputScope,
    root = projectRoot,
    tools = [],
} = {}) {
    const paths = unique([
        ...(inputScope ? validationStageInputPaths[inputScope] ?? [] : []),
        ...inputPaths,
        ...additionalInputPaths,
    ]);
    const inputHash = hashValidationInputs(paths, root);
    const hash = createHash('sha256');
    hash.update(inputHash);
    hash.update('\0');
    hash.update(JSON.stringify({
        environment: validationEnvironmentValues(),
        extraValues,
        tools: validationToolVersions(tools, root),
    }));
    return hash.digest('hex');
}
const validationBuildOutputPaths = [
    'dist-electron',
    'nuxt-output',
    '.tmp/native-build-manifest',
];
/** @param {string} root @param {string[]} outputPaths @returns {string} */
function collectValidationOutputState(root, outputPaths) {
    /** @type {string[]} */
    const entries = [];
    /** @param {string} relativePath */
    const visit = relativePath => {
        const absolutePath = path.join(root, relativePath);
        let metadata;
        try {
            metadata = lstatSync(absolutePath);
        } catch {
            entries.push(`missing:${relativePath}`);
            return;
        }
        entries.push([
            normalizePath(relativePath),
            metadata.isDirectory() ? 'directory' : (metadata.isSymbolicLink() ? 'symlink' : 'file'),
            metadata.mode,
            metadata.size,
            metadata.mtimeMs,
        ].join(':'));
        if (metadata.isSymbolicLink()) {
            entries.push(`link:${relativePath}:${readlinkSync(absolutePath)}`);
            return;
        }
        if (!metadata.isDirectory()) {
            return;
        }
        for (const entry of readdirSync(absolutePath).sort((left, right) => left.localeCompare(right, 'en'))) {
            visit(path.posix.join(relativePath, entry));
        }
    };
    for (const outputPath of outputPaths) {
        visit(normalizePath(outputPath));
    }
    return entries.sort().join('\n');
}
/** @param {string} [root] @returns {string} */
export function getValidationBuildMarkerPath(root = projectRoot) {
    return path.join(root, '.devkit', 'cache', 'build', 'strict.json');
}
/** @param {string} buildScriptName @param {string} root @returns {string} */
function getValidationBuildInputFingerprint(buildScriptName, root) {
    return getValidationInputFingerprint({
        extraValues: [
            'strict-build',
            buildScriptName,
        ],
        inputScope: 'build',
        root,
        tools: [
            'pnpm',
            'nuxt',
        ],
    });
}
/** @param {{buildScriptName?: string, outputPaths?: string[], root?: string}} options @returns {Promise<string | null>} */
export async function writeValidationBuildMarker({
    buildScriptName = '',
    outputPaths = validationBuildOutputPaths,
    root = projectRoot,
} = {}) {
    const outputState = collectValidationOutputState(root, outputPaths);
    if (outputState.includes('missing:')) {
        return null;
    }
    const markerPath = getValidationBuildMarkerPath(root);
    const temporaryPath = `${markerPath}.${process.pid}.tmp`;
    await mkdir(path.dirname(markerPath), {recursive: true});
    await writeFile(temporaryPath, `${JSON.stringify({
        buildScriptName,
        inputFingerprint: getValidationBuildInputFingerprint(buildScriptName, root),
        outputState,
        schemaVersion: validationCacheSchemaVersion,
        writtenAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await rename(temporaryPath, markerPath);
    return markerPath;
}
/** @param {{buildScriptName?: string, outputPaths?: string[], root?: string}} options @returns {boolean} */
export function isValidationBuildFresh({
    buildScriptName = '',
    outputPaths = validationBuildOutputPaths,
    root = projectRoot,
} = {}) {
    let marker;
    try {
        marker = JSON.parse(readFileSync(getValidationBuildMarkerPath(root), 'utf8'));
    } catch {
        return false;
    }
    if (
        marker?.schemaVersion !== validationCacheSchemaVersion
        || marker.buildScriptName !== buildScriptName
        || marker.inputFingerprint !== getValidationBuildInputFingerprint(buildScriptName, root)
    ) {
        return false;
    }
    const outputState = collectValidationOutputState(root, outputPaths);
    return !outputState.includes('missing:') && outputState === marker.outputState;
}
/** @param {{arch?: NodeJS.Architecture, nodeVersion?: string, platform?: NodeJS.Platform, root?: string}} options */
export function getLintCachePaths({
    arch = process.arch,
    nodeVersion = process.version,
    platform = process.platform,
    root = projectRoot,
} = {}) {
    const ignoredDirectories = new Set([
        '.devkit',
        '.git',
        '.nuxt',
        '.tmp',
        'dist-electron',
        'native',
        'node_modules',
        'nuxt-output',
        'release',
    ]);
    /** @type {string[]} */
    const tsconfigFiles = [];
    /** @param {string} directory */
    function visit(directory) {
        for (const entry of readdirSync(path.join(root, directory), {withFileTypes: true})) {
            const relativePath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!ignoredDirectories.has(entry.name)) {
                    visit(relativePath);
                }
                continue;
            }
            if (/^tsconfig.*\.json$/u.test(entry.name)) {
                tsconfigFiles.push(normalizePath(relativePath));
            }
        }
    }
    visit('');
    const fingerprint = hashFiles([
        'eslint.config.mjs',
        'eslint-plugin-custom.mjs',
        'landing/eslint.config.mjs',
        'stylelint.config.mjs',
        'package.json',
        'pnpm-lock.yaml',
        ...tsconfigFiles.sort(),
    ], [
        nodeVersion,
        platform,
        arch,
        `eslint=${readPackageVersion('eslint', root)}`,
        `stylelint=${readPackageVersion('stylelint', root)}`,
        `pnpm=${readCommandVersion('pnpm', ['--version'], root)}`,
    ], root).slice(0, 20);
    const cacheRoot = path.join(root, '.devkit', 'cache', 'eslint', fingerprint);
    return {
        cacheRoot,
        eslint: path.join(cacheRoot, 'eslint.cache'),
        fingerprint,
        landingEslint: path.join(cacheRoot, 'landing-eslint.cache'),
        stylelint: path.join(cacheRoot, 'stylelint.cache'),
    };
}
/** @param {string[]} files @returns {Promise<{eslint: string[], landing: string[], stylelint: string[]}>} */
async function lintTargets(files) {
    const existingFiles = files.filter(file => existsSync(path.join(projectRoot, file)));
    const eslintCandidates = existingFiles.filter(file => !file.startsWith('landing/') && (
        lintableSourcePattern.test(file)
    ));
    const { ESLint } = await import('eslint');
    const rootEslint = new ESLint({cwd: projectRoot});
    const ignored = await Promise.all(eslintCandidates.map(file => rootEslint.isPathIgnored(file)));
    const eslint = eslintCandidates.filter((_, index) => !ignored[index]);
    const landing = existingFiles.filter(file => file.startsWith('landing/') && (
        lintableSourcePattern.test(file)
    ));
    const stylelint = existingFiles.filter(file => /\.(?:vue|scss|css)$/u.test(file) && (
        file.startsWith('app/') || file.startsWith('landing/app/')
    ));
    return {
        eslint: unique(eslint),
        landing: unique(landing),
        stylelint: unique(stylelint),
    };
}
/** @param {{keep?: number, minimumAgeMs?: number, nowMs?: number, root?: string}} options @returns {Promise<string[]>} */
export async function pruneRetentionEntries({
    keep = 100,
    minimumAgeMs = 10 * 60_000,
    nowMs = Date.now(),
    root = projectRoot,
} = {}) {
    let entries;
    try {
        entries = await readdir(root, {withFileTypes: true});
    } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
    const candidates = await Promise.all(entries.map(async entry => ({
        entry,
        metadata: await stat(path.join(root, entry.name)),
    })));
    candidates.sort((left, right) => right.metadata.mtimeMs - left.metadata.mtimeMs);
    const removed = [];
    for (const {
        entry,
        metadata,
    } of candidates.slice(keep)) {
        if (minimumAgeMs > 0 && nowMs - metadata.mtimeMs < minimumAgeMs) {
            continue;
        }
        await rm(path.join(root, entry.name), {
            force: true,
            recursive: entry.isDirectory(),
        });
        removed.push(entry.name);
    }
    return removed;
}
/** @param {string[]} argv @param {IValidationSignalOptions} [options] */
async function runLint(argv, {signal} = {}) {
    const changed = argv.includes('--changed');
    const fix = argv.includes('--fix');
    const all = argv.includes('--all');
    const noCache = argv.includes('--no-cache') || process.env.EVB_GATE_NO_CACHE === '1';
    const explicitFiles = readArgs(argv, 'file');
    const changes = changed
        ? await collectValidationChanges({
            base: readArg(argv, 'base'),
            explicitFiles,
        })
        : {
            files: [],
            known: true,
        };
    const full = !changed || !changes.known;
    const targets = full
        ? {
            eslint: [
                'app',
                'electron',
                'packages',
                'packages/scan-cleanup/adapters',
                'packages/scan-cleanup/core',
                'scripts',
                'server',
                'tests',
                'eslint-plugin-custom.mjs',
                'vitest.config.ts',
                'vitest.shared.config.ts',
            ],
            landing: all ? ['landing'] : [],
            stylelint: [all ? '{app,landing/app}/**/*.{vue,scss,css}' : 'app/**/*.{vue,scss,css}'],
        }
        : await lintTargets(changes.files);
    const cachePaths = getLintCachePaths();
    if (!noCache) {
        await mkdir(cachePaths.cacheRoot, {recursive: true});
        await pruneRetentionEntries({
            keep: 3,
            minimumAgeMs: 60 * 60_000,
            root: path.dirname(cachePaths.cacheRoot),
        });
    }
    const eslintCacheWarm = !noCache && existsSync(cachePaths.eslint);
    const relevantFiles = full ? [] : changes.files;
    const commands = [];
    if (targets.eslint.length > 0) {
        commands.push(stage('lint.eslint', 'pnpm', [
            'exec',
            'eslint',
            ...targets.eslint,
            ...(fix ? ['--fix'] : ['--report-unused-disable-directives']),
            '--max-warnings=0',
            ...(!noCache ? [
                '--cache',
                '--cache-strategy=content',
                `--cache-location=${cachePaths.eslint}`,
            ] : []),
            ...(!changed && !eslintCacheWarm
                ? [`--concurrency=${parsePositiveInteger(process.env.EVB_ESLINT_WORKERS, 1)}`]
                : []),
        ], {
            ...(!noCache ? {cachePath: cachePaths.eslint} : {}),
            additionalInputPaths: relevantFiles,
            cacheable: true,
            env: withNodeHeap(process.env, eslintNodeHeapMb),
            heavyWeight: full ? (eslintCacheWarm ? 1 : 2) : 0,
            inputScope: 'lint',
            weight: full ? (eslintCacheWarm ? 1 : 2) : 1,
        }));
    }
    if (targets.landing.length > 0) {
        commands.push(
            stage('lint.landing-naming', 'pnpm', [
                'exec',
                'eslint',
                ...targets.landing,
                '--no-ignore',
                ...(fix ? ['--fix'] : ['--report-unused-disable-directives']),
                '--max-warnings=0',
            ], {
                additionalInputPaths: relevantFiles,
                cacheable: true,
                env: {EVB_ESLINT_NAMING_ONLY: '1'},
                inputScope: 'lint',
            }),
            stage('lint.landing', 'pnpm', [
                '--dir',
                'landing',
                'exec',
                'eslint',
                '.',
                ...(fix ? ['--fix'] : []),
                '--max-warnings=0',
                ...(!noCache ? [
                    '--cache',
                    '--cache-strategy=content',
                    `--cache-location=${cachePaths.landingEslint}`,
                ] : []),
            ], {
                ...(!noCache ? {cachePath: cachePaths.landingEslint} : {}),
                additionalInputPaths: relevantFiles,
                cacheable: true,
                env: withNodeHeap(process.env, 6144),
                inputScope: 'lint',
            }),
        );
    }
    if (targets.stylelint.length > 0) {
        commands.push(stage('lint.stylelint', 'pnpm', [
            'exec',
            'stylelint',
            ...targets.stylelint,
            ...(fix ? ['--fix'] : []),
            ...(!noCache ? [
                '--cache',
                `--cache-location=${cachePaths.stylelint}`,
            ] : []),
        ], {
            ...(!noCache ? {cachePath: cachePaths.stylelint} : {}),
            additionalInputPaths: relevantFiles,
            cacheable: true,
            inputScope: 'lint',
        }));
    }
    if (full || relevantFiles.some(file => file.startsWith('.github/'))) {
        commands.push(nodeStage('lint.github-actions', '--import', [
            'tsx',
            'scripts/checkGithubActionsSyntax.ts',
        ], {
            additionalInputPaths: relevantFiles,
            cacheable: true,
            inputScope: 'lint',
        }));
    }
    if (full || relevantFiles.some(file => file.startsWith('app/') || file.startsWith('landing/app/'))) {
        const target = all || relevantFiles.some(file => file.startsWith('landing/'))
            ? 'all'
            : 'app';
        commands.push(
            nodeStage('lint.style-assets', '--import', [
                'tsx',
                'scripts/checkStyleAssetConventions.ts',
                `--target=${target}`,
            ], {
                additionalInputPaths: relevantFiles,
                cacheable: true,
                inputScope: 'lint',
            }),
            nodeStage('lint.locales', '--import', [
                'tsx',
                'scripts/checkLocales.ts',
                `--target=${target}`,
            ], {
                additionalInputPaths: relevantFiles,
                cacheable: true,
                inputScope: 'lint',
            }),
            nodeStage('lint.icons', '--import', [
                'tsx',
                'scripts/checkIconBundle.ts',
                `--target=${target}`,
            ], {
                additionalInputPaths: relevantFiles,
                cacheable: true,
                inputScope: 'lint',
            }),
        );
    }
    if (
        full
        || relevantFiles.some(file => /^(?:app|electron|landing|packages|scripts|server)\//u.test(file))
    ) {
        commands.push(nodeStage('lint.architecture', 'scripts/architecture/boundary-check.mjs', ['--scope=all'], {
            additionalInputPaths: relevantFiles,
            cacheable: true,
            inputScope: 'lint',
        }));
    }
    await runStages(commands, {
        changes,
        noCache,
        signal,
        tier: all ? 'lint-all' : (changed ? 'lint-changed' : 'lint'),
    });
}

/** @param {NodeJS.ProcessEnv} [env] @returns {string} */
function heavyGateRoot(env = process.env) {
    if (env.EVB_GATE_SEMAPHORE_DIR) {
        return path.resolve(env.EVB_GATE_SEMAPHORE_DIR);
    }
    const base = process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Caches')
        : (env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'));
    return path.join(base, 'evb-viewer', 'heavy-gates');
}
/** @param {unknown} pid @returns {boolean} */
function isPidAlive(pid) {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) {
        return false;
    }
    try {
        process.kill(pid, 0);
    } catch (error) {
        return isNodeError(error) && error.code === 'EPERM';
    }
    if (process.platform === 'win32') {
        return true;
    }
    let state = '';
    try {
        if (process.platform === 'linux') {
            const procStat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
            state = procStat.slice(procStat.lastIndexOf(')') + 1).trimStart().charAt(0);
        } else {
            state = execFileSync('ps', [
                '-p',
                String(pid),
                '-o',
                'stat=',
            ], {
                encoding: 'utf8',
                stdio: [
                    'ignore',
                    'pipe',
                    'ignore',
                ],
            }).trim().charAt(0);
        }
    } catch {
        // The process may exit between kill(0) and the state read. Probe again
        // before treating an unavailable state as a live holder.
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            return isNodeError(error) && error.code === 'EPERM';
        }
    }
    return state !== 'Z' && state !== 'X';
}
/** @param {string} filePath @returns {Promise<Record<string, unknown> | null>} */
async function readJson(filePath) {
    try {
        const value = JSON.parse(await readFile(filePath, 'utf8'));
        return isRecord(value) ? value : null;
    } catch {
        return null;
    }
}
/** @param {string} root @param {number} nowMs @returns {Promise<(() => Promise<void>) | null>} */
async function acquireMutationLock(root, nowMs) {
    const lockPath = path.join(root, 'mutation.lock');
    try {
        const handle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
        await handle.writeFile(JSON.stringify({
            createdAtMs: nowMs,
            pid: process.pid,
        }));
        await handle.close();
        return async () => {
            await unlink(lockPath).catch(() => undefined);
        };
    } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') {
            throw error;
        }
    }

    const owner = await readJson(lockPath);
    let lockAgeMs = Number.POSITIVE_INFINITY;
    try {
        lockAgeMs = nowMs - (await stat(lockPath)).mtimeMs;
    } catch {
        return null;
    }
    if (
        (owner && !isPidAlive(owner.pid))
        || (owner && nowMs - Number(owner.createdAtMs ?? 0) > 60_000)
        || (!owner && lockAgeMs > 60_000)
    ) {
        await unlink(lockPath).catch(() => undefined);
    }
    return null;
}
/** @param {string} root @param {() => Promise<unknown>} callback @returns {Promise<unknown | null>} */
async function withMutationLock(root, callback) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const release = await acquireMutationLock(root, Date.now());
        if (release) {
            try {
                return await callback();
            } finally {
                await release();
            }
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    return null;
}

/** @param {unknown} value @returns {string} */
function formatHeavyGateLabel(value) {
    const label = String(value ?? 'unknown').replaceAll(/\s+/gu, ' ').trim();
    return label || 'unknown';
}
/** @param {IHeavyGateAdmission['holders']} holders @returns {string} */
function formatHeavyGateHolders(holders) {
    if (holders.length === 0) {
        return 'none';
    }
    return holders.map(holder => {
        const holderRoot = typeof holder.projectRoot === 'string'
            ? `, root=${formatHeavyGateLabel(holder.projectRoot)}`
            : '';
        return `${formatHeavyGateLabel(holder.id)}(pid=${String(holder.pid)}, weight=${String(holder.weight)}${holderRoot})`;
    }).join(', ');
}
/** @param {IHeavyGateAdmission | null} admission @param {number} requestedWeight @param {number} fallbackCapacity @returns {string} */
function describeHeavyGateAdmission(admission, requestedWeight, fallbackCapacity) {
    if (!admission) {
        return `needs=${String(requestedWeight)}, used=unknown/${String(fallbackCapacity)}, holders=mutation.lock busy`;
    }
    const admittedWeight = Math.min(requestedWeight, admission.capacity);
    const needs = requestedWeight > admission.capacity
        ? `${String(requestedWeight)} (capped to ${String(admittedWeight)})`
        : String(requestedWeight);
    return `needs=${needs}, used=${String(admission.usedWeight)}/${String(admission.capacity)}, holders=${formatHeavyGateHolders(admission.holders)}`;
}
/** @param {IHeavyGateAdmission | null} admission @returns {string} */
function heavyGateAdmissionState(admission) {
    if (!admission) {
        return 'mutation.lock busy';
    }
    return [
        admission.capacity,
        admission.usedWeight,
        ...admission.holders.map(holder => [
            holder.id,
            holder.pid,
            holder.projectRoot,
            holder.weight,
        ]),
    ].join('|');
}

/** @param {IHeavyGateOptions} options @returns {Promise<IHeavyGateHandle>} */
export async function acquireHeavyGate({
    env = process.env,
    capacity,
    failOpenOnTimeout = false,
    id = 'heavy',
    root = heavyGateRoot(env),
    signal,
    waitMs = parsePositiveInteger(env.EVB_GATE_WAIT_MS, heavyGateDefaultWaitMs),
    weight = 1,
} = {}) {
    const configuredCapacity = resolveConfiguredHeavyGateCapacity(capacity, env);
    const resolveCurrentCapacity = () => configuredCapacity ?? getDefaultGateCapacity();
    const initialCapacity = resolveCurrentCapacity();
    if (env.EVB_HEAVY_GATE_HELD === '1' || weight < 1) {
        return {
            capacity: initialCapacity,
            coordinated: true,
            release: async () => undefined,
            waitedMs: 0,
        };
    }
    const requestedWeight = Number.isFinite(weight) ? Math.max(1, Math.floor(weight)) : 1;
    const holdersDir = path.join(root, 'holders');
    try {
        await mkdir(holdersDir, {
            mode: 0o700,
            recursive: true,
        });
    } catch (error) {
        process.stderr.write(`[gate] Heavy-gate coordination unavailable (${isNodeError(error) ? error.message ?? String(error) : String(error)}); continuing uncoordinated.\n`);
        return {
            capacity: initialCapacity,
            coordinated: false,
            release: async () => undefined,
            waitedMs: 0,
        };
    }

    const holderName = `${process.pid}-${randomUUID()}.json`;
    const holderPath = path.join(holdersDir, holderName);
    const waitStartedAtMs = Date.now();
    const deadline = waitStartedAtMs + waitMs;
    let blockedSinceMs;
    let lastObservedCapacity = initialCapacity;
    /** @type {IHeavyGateAdmission | null} */
    let lastAdmission = null;
    let lastReportedState = '';
    let lastReportedAtMs = 0;
    while (Date.now() <= deadline) {
        if (signal?.aborted) {
            throw new ValidationInterruptedError();
        }
        /** @type {IHeavyGateAdmission | null} */
        const admission = /** @type {IHeavyGateAdmission | null} */ (await withMutationLock(root, async () => {
            const currentCapacity = resolveCurrentCapacity();
            const holderNames = (await readdir(holdersDir)).filter(name => name.endsWith('.json'));
            /** @type {IHeavyGateAdmission['holders']} */
            const holders = [];
            let usedWeight = 0;
            for (const name of holderNames) {
                const candidatePath = path.join(holdersDir, name);
                const holder = await readJson(candidatePath);
                const holderPid = typeof holder?.pid === 'number' ? holder.pid : 0;
                const ownedPids = Array.isArray(holder?.ownedPids)
                    ? holder.ownedPids.filter(pid => typeof pid === 'number' && isPidAlive(pid))
                    : [];
                const ownedGroupIds = Array.isArray(holder?.ownedGroupIds)
                    ? holder.ownedGroupIds.filter(pid => typeof pid === 'number' && isProcessGroupAlive(pid))
                    : [];
                if (!holder || (!isPidAlive(holderPid) && ownedPids.length === 0 && ownedGroupIds.length === 0)) {
                    await unlink(candidatePath).catch(() => undefined);
                    continue;
                }
                const holderWeight = parsePositiveInteger(holder.weight, 1);
                usedWeight += holderWeight;
                holders.push({
                    id: typeof holder.id === 'string' ? holder.id : 'unknown',
                    pid: holderPid,
                    weight: holderWeight,
                    ...(ownedGroupIds.length > 0 ? {ownedGroupIds} : {}),
                    ...(ownedPids.length > 0 ? {ownedPids} : {}),
                    ...(typeof holder.projectRoot === 'string'
                        ? {projectRoot: holder.projectRoot}
                        : {}),
                });
            }
            const boundedWeight = Math.min(requestedWeight, currentCapacity);
            if (usedWeight + boundedWeight > currentCapacity) {
                return {
                    acquired: false,
                    capacity: currentCapacity,
                    holders,
                    usedWeight,
                };
            }
            await writeFile(holderPath, JSON.stringify({
                acquiredAt: new Date().toISOString(),
                id,
                pid: process.pid,
                projectRoot,
                weight: boundedWeight,
            }), {
                encoding: 'utf8',
                flag: 'wx',
                mode: 0o600,
            });
            return {
                acquired: true,
                capacity: currentCapacity,
                holders,
                usedWeight,
            };
        }));
        if (admission?.acquired) {
            const heldWeight = Math.min(requestedWeight, admission.capacity);
            const waitedMs = blockedSinceMs === undefined
                ? 0
                : Math.max(0, Date.now() - blockedSinceMs);
            if (waitedMs > 0) {
                const admittedAdmission = {
                    ...admission,
                    usedWeight: admission.usedWeight + Math.min(requestedWeight, admission.capacity),
                };
                process.stderr.write(
                    `[gate] ADMITTED heavy-gate: id=${formatHeavyGateLabel(id)}, waited=${String(waitedMs)}ms, ${describeHeavyGateAdmission(admittedAdmission, requestedWeight, admission.capacity)}, semaphore=${formatHeavyGateLabel(root)}\n`,
                );
            }
            return {
                capacity: admission.capacity,
                coordinated: true,
                release: async ({
                    ownedGroupIds = [],
                    ownedPids = [],
                    retain = false,
                } = {}) => {
                    if (retain || ownedPids.some(pid => isPidAlive(pid)) || ownedGroupIds.some(pid => isProcessGroupAlive(pid))) {
                        const retainedHolderPath = `${holderPath}.retained-${randomUUID()}`;
                        await writeFile(retainedHolderPath, JSON.stringify({
                            acquiredAt: new Date().toISOString(),
                            id,
                            ownedGroupIds,
                            ownedPids,
                            pid: process.pid,
                            projectRoot,
                            retained: true,
                            weight: heldWeight,
                        }), 'utf8');
                        try {
                            await rename(retainedHolderPath, holderPath);
                        } catch (error) {
                            await unlink(retainedHolderPath).catch(() => undefined);
                            throw error;
                        }
                        return;
                    }
                    await unlink(holderPath).catch(() => undefined);
                },
                waitedMs,
            };
        }
        const nowMs = Date.now();
        blockedSinceMs ??= waitStartedAtMs;
        lastAdmission = admission;
        lastObservedCapacity = admission?.capacity ?? resolveCurrentCapacity();
        const state = heavyGateAdmissionState(admission);
        if (
            state !== lastReportedState
            || nowMs - lastReportedAtMs >= heavyGateWaitReportIntervalMs
        ) {
            process.stderr.write(
                `[gate] BLOCKED waiting for heavy-gate: id=${formatHeavyGateLabel(id)}, ${describeHeavyGateAdmission(admission, requestedWeight, lastObservedCapacity)}, waited=${String(nowMs - blockedSinceMs)}ms, semaphore=${formatHeavyGateLabel(root)}\n`,
            );
            lastReportedState = state;
            lastReportedAtMs = nowMs;
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
            break;
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(250, remainingMs)));
    }

    const waitedMs = blockedSinceMs === undefined
        ? 0
        : Math.max(0, Date.now() - blockedSinceMs);
    const timeoutDetails = describeHeavyGateAdmission(lastAdmission, requestedWeight, lastObservedCapacity);
    const timeoutMessage = `[gate] Timed out waiting ${String(waitedMs)}ms for heavy-gate capacity for ${formatHeavyGateLabel(id)}; ${timeoutDetails}; semaphore=${formatHeavyGateLabel(root)}.`;
    if (failOpenOnTimeout) {
        process.stderr.write(`${timeoutMessage} Continuing uncoordinated.\n`);
        return {
            capacity: lastObservedCapacity,
            coordinated: false,
            release: async () => undefined,
            waitedMs,
        };
    }
    throw new Error(timeoutMessage);
}

/** @returns {Promise<void>} */
async function reportRepoSessions() {
    const worktreeOutput = await gitOutput([
        'worktree',
        'list',
        '--porcelain',
    ]);
    if (!worktreeOutput) {
        return;
    }
    const roots = worktreeOutput
        .split(/\r?\n/u)
        .filter(line => line.startsWith('worktree '))
        .map(line => line.slice('worktree '.length));
    const sessions = [];
    for (const root of roots) {
        const sessionRoot = path.join(root, '.devkit', 'sessions');
        try {
            const entries = await readdir(sessionRoot, {withFileTypes: true});
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    sessions.push({
                        name: entry.name,
                        root,
                    });
                }
            }
        } catch {
            // Worktrees without session state are normal.
        }
    }
    if (sessions.length > 0) {
        const defaultCount = sessions.filter(session => session.name === 'default').length;
        const isolatedCount = sessions.filter(session => session.name.startsWith('e2e-')).length;
        process.stdout.write(
            `[gate] Repo session inventory: ${sessions.length} directories across ${roots.length} worktrees `
            + `(${defaultCount} default, ${isolatedCount} isolated e2e). Report only; no cross-worktree cleanup performed.\n`,
        );
    }
}

/** @param {number} pid @returns {number | null} */
function getProcessGroupId(pid) {
    if (process.platform === 'win32') {
        return pid;
    }
    try {
        const output = execFileSync('ps', [
            '-p',
            String(pid),
            '-o',
            'pgid=',
        ], {
            encoding: 'utf8',
            stdio: [
                'ignore',
                'pipe',
                'ignore',
            ],
        }).trim();
        const groupId = Number(output);
        return Number.isInteger(groupId) && groupId > 0 ? groupId : null;
    } catch {
        return null;
    }
}

/** @param {number} pid @returns {boolean} */
function isProcessGroupAlive(pid) {
    if (process.platform === 'win32') {
        return isPidAlive(pid);
    }
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        return isNodeError(error) && error.code === 'EPERM';
    }
}

/** @param {number} rootPid @returns {number[]} */
function collectDescendantPidsUnix(rootPid) {
    if (process.platform === 'win32' || !Number.isInteger(rootPid) || rootPid < 1) {
        return [];
    }
    try {
        const output = execFileSync('ps', [
            '-eo',
            'pid=,ppid=',
        ], {
            encoding: 'utf8',
            stdio: [
                'ignore',
                'pipe',
                'ignore',
            ],
        });
        /** @type {Map<number, number[]>} */
        const childrenByParent = new Map();
        for (const line of output.split('\n')) {
            const [
                pidText,
                ppidText,
            ] = line.trim().split(/\s+/u);
            const pid = Number(pidText);
            const ppid = Number(ppidText);
            if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid < 1 || ppid < 1) {
                continue;
            }
            const children = childrenByParent.get(ppid) ?? [];
            children.push(pid);
            childrenByParent.set(ppid, children);
        }
        /** @type {number[]} */
        const descendants = [];
        /** @type {number[]} */
        const pending = [rootPid];
        while (pending.length > 0) {
            const parentPid = pending.pop();
            if (parentPid === undefined) {
                break;
            }
            for (const childPid of childrenByParent.get(parentPid) ?? []) {
                descendants.push(childPid);
                pending.push(childPid);
            }
        }
        return descendants;
    } catch {
        return [];
    }
}

/** @param {number[]} pids @returns {Set<number>} */
function getLiveProcessGroups(pids) {
    const groupIds = new Set();
    for (const pid of pids) {
        const groupId = getProcessGroupId(pid);
        if (groupId !== null && isProcessGroupAlive(groupId)) {
            groupIds.add(groupId);
        }
    }
    return groupIds;
}

/** @param {Set<number>} groupIds @param {number[]} pids @param {number} timeoutMs @returns {Promise<boolean>} */
async function waitForOwnedProcessesExit(groupIds, pids, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const hasSurvivor = () => [...groupIds].some(groupId => isProcessGroupAlive(groupId)) || pids.some(isPidAlive);
    while (hasSurvivor() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    return !hasSurvivor();
}

/** @param {import('node:child_process').ChildProcess} child @param {NodeJS.Signals} signal @returns {Promise<IProcessStopResult>} */
async function stopSpawnedProcess(child, signal) {
    const pid = child.pid;
    if (!pid || !isPidAlive(pid)) {
        if (typeof pid === 'number' && isProcessGroupAlive(pid)) {
            return {
                owned: false,
                ownedGroupIds: [pid],
                ownedPids: [pid],
            };
        }
        return {
            owned: true,
            ownedGroupIds: [],
            ownedPids: [],
        };
    }
    let groupId = getProcessGroupId(pid);
    const identityDeadline = Date.now() + processTerminationGraceMs;
    while (groupId === null && isPidAlive(pid) && Date.now() < identityDeadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
        groupId = getProcessGroupId(pid);
    }
    const owned = groupId === pid;
    if (!owned) {
        return {
            owned: false,
            ownedGroupIds: [pid],
            ownedPids: [pid],
        };
    }
    const descendantPids = collectDescendantPidsUnix(pid);
    const ownedGroupIds = getLiveProcessGroups([
        pid,
        ...descendantPids,
    ]);
    if (process.platform === 'win32') {
        child.kill(signal);
    } else {
        for (const ownedGroupId of ownedGroupIds) {
            try {
                process.kill(-ownedGroupId, signal);
            } catch {
                // A captured group may exit between discovery and signalling.
            }
        }
    }
    if (await waitForOwnedProcessesExit(ownedGroupIds, descendantPids, processTerminationGraceMs)) {
        return {
            owned: true,
            ownedPids: [],
        };
    }
    if (process.platform === 'win32') {
        try {
            execFileSync('taskkill', [
                '/PID',
                String(pid),
                '/T',
                '/F',
            ], {stdio: 'ignore'});
        } catch {
            // The child may have exited between the identity check and taskkill.
        }
    } else {
        for (const ownedGroupId of ownedGroupIds) {
            if (isProcessGroupAlive(ownedGroupId)) {
                try {
                    process.kill(-ownedGroupId, 'SIGKILL');
                } catch {
                    // The group may exit between the liveness check and SIGKILL.
                }
            }
        }
    }
    if (await waitForOwnedProcessesExit(ownedGroupIds, descendantPids, processTerminationGraceMs)) {
        return {
            owned: true,
            ownedPids: [],
        };
    }
    const remainingGroupIds = [...ownedGroupIds].filter(isProcessGroupAlive);
    const remainingPids = descendantPids.filter(isPidAlive);
    return {
        owned: false,
        ownedGroupIds: remainingGroupIds,
        ownedPids: remainingPids,
    };
}

class ValidationInterruptedError extends Error {
    constructor(message = 'Validation interrupted') {
        super(message);
        this.name = 'ValidationInterruptedError';
        this.interrupted = true;
    }
}

/** @param {string} command @param {string[]} args @param {NodeJS.ProcessEnv} env @param {IValidationSignalOptions} [options] @returns {Promise<void>} */
async function spawnInherited(command, args, env, {signal} = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: projectRoot,
            detached: process.platform !== 'win32',
            env,
            stdio: 'inherit',
        });
        let stopping = false;
        let settled = false;
        const onAbort = () => {
            if (stopping || settled) {
                return;
            }
            stopping = true;
            void stopSpawnedProcess(child, 'SIGTERM').then(result => {
                if (!result.owned) {
                    /** @type {IValidationErrorState} */
                    const error = new ValidationInterruptedError(
                        'Validation interrupted; stage ownership could not be proven',
                    );
                    error.retainCapacity = true;
                    error.ownedGroupIds = result.ownedGroupIds;
                    error.ownedPids = result.ownedPids;
                    reject(error);
                    return;
                }
                reject(new ValidationInterruptedError());
            }).catch(error => reject(error));
        };
        signal?.addEventListener('abort', onAbort, {once: true});
        if (signal?.aborted) {
            onAbort();
        }
        child.on('error', error => {
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            reject(error);
        });
        child.on('close', (status, exitSignal) => {
            if (stopping) {
                return;
            }
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            if (status === 0) {
                resolve();
                return;
            }
            reject(new Error(
                exitSignal
                    ? `${command} ${args.join(' ')} exited after signal ${exitSignal}`
                    : `${command} ${args.join(' ')} failed with status ${status ?? 1}`,
            ));
        });
    });
}

/** @param {string} evidenceDir @returns {Promise<Map<string, string>>} */
async function readLastPassingStageFingerprints(evidenceDir) {
    let entries;
    try {
        entries = await readdir(evidenceDir, {withFileTypes: true});
    } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
            return new Map();
        }
        throw error;
    }
    const evidenceFiles = /** @type {{filePath: string, modifiedAtMs: number}[]} */ ((await Promise.all(entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.ndjson'))
        .map(async entry => {
            const filePath = path.join(evidenceDir, entry.name);
            try {
                return {
                    filePath,
                    modifiedAtMs: (await stat(filePath)).mtimeMs,
                };
            } catch {
                return null;
            }
        }))).filter(Boolean));
    evidenceFiles.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
    /** @type {Map<string, string>} */
    const fingerprints = new Map();
    for (const {filePath} of evidenceFiles) {
        /** @type {Record<string, unknown>[]} */
        const stageResults = [];
        let runPassed = false;
        try {
            const lines = (await readFile(filePath, 'utf8')).split(/\r?\n/u);
            for (const line of lines) {
                if (!line.trim()) {
                    continue;
                }
                let event;
                try {
                    const parsed = JSON.parse(line);
                    if (!isRecord(parsed)) {
                        continue;
                    }
                    event = parsed;
                } catch {
                    continue;
                }
                if (event.event === 'run-end') {
                    runPassed = event.status === 'passed';
                } else if (event.event === 'stage-end' && event.status === 'passed') {
                    stageResults.push(event);
                }
            }
        } catch {
            continue;
        }
        if (!runPassed) {
            continue;
        }
        for (const result of stageResults) {
            if (
                typeof result.id === 'string'
                && typeof result.inputFingerprint === 'string'
                && !fingerprints.has(result.id)
            ) {
                fingerprints.set(result.id, result.inputFingerprint);
            }
        }
    }
    return fingerprints;
}

/** @param {IValidationStage} stageDefinition @param {IValidationChanges | undefined} changes @returns {string} */
function stageInputFingerprint(stageDefinition, changes) {
    if (stageDefinition.inputFingerprint) {
        return stageDefinition.inputFingerprint;
    }
    return getValidationInputFingerprint({
        additionalInputPaths: stageDefinition.additionalInputPaths ?? [],
        extraValues: [
            validationCacheSchemaVersion,
            stageDefinition.id,
            stageDefinition.command,
            ...stageDefinition.args,
            JSON.stringify(stageDefinition.dependsOn ?? []),
            JSON.stringify(stageDefinition.env ?? {}),
            process.platform,
            process.arch,
            process.version,
        ],
        inputPaths: stageDefinition.inputPaths ?? (
            stageDefinition.inputScope ? [] : (changes?.files ?? [])
        ),
        inputScope: stageDefinition.inputScope,
        tools: inferValidationTools(stageDefinition),
    });
}
/** @param {IValidationStage} stageDefinition @param {{changes?: IValidationChanges, lastPassingFingerprints?: Map<string, string>, noCache?: boolean}} options @returns {IValidationCacheDecision} */
export function getValidationStageCacheDecision(stageDefinition, {
    changes,
    lastPassingFingerprints = new Map(),
    noCache = false,
} = {}) {
    const inputFingerprint = stageDefinition.inputFingerprint
        ?? stageInputFingerprint(stageDefinition, changes);
    const cacheHit = !noCache
        && stageDefinition.cacheable === true
        && lastPassingFingerprints.get(stageDefinition.id) === inputFingerprint;
    const cacheState = stageDefinition.cacheable === true
        ? (cacheHit ? 'warm' : 'cold')
        : (stageDefinition.cachePath
            ? (existsSync(stageDefinition.cachePath) ? 'warm' : 'cold')
            : 'not-applicable');
    return {
        cacheHit,
        cacheReason: cacheHit
            ? 'last-passing-input-fingerprint'
            : (noCache ? 'cache-disabled' : (stageDefinition.cacheable ? 'input-fingerprint-miss' : 'not-cacheable')),
        cacheState,
        inputFingerprint,
    };
}

/** @param {IValidationStage} stageDefinition @param {number} capacity @returns {number} */
function stageResourceWeight(stageDefinition, capacity) {
    const heavyWeight = stageDefinition.heavyWeight ?? 0;
    const requestedWeight = stageDefinition.weight;
    const requested = typeof requestedWeight === 'number' && Number.isFinite(requestedWeight)
        ? requestedWeight
        : (heavyWeight > 0 ? heavyWeight : 1);
    return Math.max(1, Math.min(Math.floor(requested), capacity));
}

/** @param {IValidationStage[]} stages @param {(stage: IValidationStage, context: IValidationSignalOptions) => Promise<void>} runStage @param {IValidationStagePoolOptions} options @returns {Promise<IValidationStagePoolResult>} */
export async function runStagePool(stages, runStage, {
    capacity = getDefaultGateCapacity(),
    signal,
} = {}) {
    const effectiveCapacity = Math.max(1, Math.floor(capacity));
    /** @type {Map<string, IValidationStage>} */
    const stageById = new Map();
    stages.forEach((stageDefinition, index) => {
        if (!stageDefinition.id || stageById.has(stageDefinition.id)) {
            throw new Error(`Validation stages must have unique ids; duplicate "${stageDefinition.id}" at index ${index}.`);
        }
        stageById.set(stageDefinition.id, stageDefinition);
    });
    for (const stageDefinition of stages) {
        for (const dependency of stageDefinition.dependsOn ?? []) {
            if (!stageById.has(dependency)) {
                throw new Error(`Validation stage "${stageDefinition.id}" depends on unknown stage "${dependency}".`);
            }
            if (dependency === stageDefinition.id) {
                throw new Error(`Validation stage "${stageDefinition.id}" cannot depend on itself.`);
            }
        }
    }

    const pending = new Set(stages.map(stageDefinition => stageDefinition.id));
    const completed = new Set();
    /** @type {Map<string, {promise: Promise<IValidationStageOutcome>, stageDefinition: IValidationStage, weight: number}>} */
    const running = new Map();
    /** @type {IValidationStageFailure[]} */
    const failures = [];
    /** @type {IValidationStageSkip[]} */
    const skipped = [];
    let usedCapacity = 0;
    // A failed stage takes its transitive dependents out of the plan; every
    // independent stage still runs so one pass reports every failure.
    /** @param {string} failedId */
    const skipDependents = (failedId) => {
        for (const stageDefinition of stages) {
            if (pending.has(stageDefinition.id) && (stageDefinition.dependsOn ?? []).includes(failedId)) {
                pending.delete(stageDefinition.id);
                skipped.push({
                    dependency: failedId,
                    id: stageDefinition.id,
                });
                skipDependents(stageDefinition.id);
            }
        }
    };
    const stageIndex = new Map(stages.map((stageDefinition, index) => [
        stageDefinition.id,
        index,
    ]));

    /** @returns {IValidationStage[]} */
    const sortedReadyStages = () => stages
        .filter(stageDefinition => (
            pending.has(stageDefinition.id)
            && (stageDefinition.dependsOn ?? []).every(dependency => completed.has(dependency))
        ))
        .sort((left, right) => (
            Number(right.priority ?? 0) - Number(left.priority ?? 0)
            || stageResourceWeight(right, effectiveCapacity) - stageResourceWeight(left, effectiveCapacity)
            || (stageIndex.get(left.id) ?? 0) - (stageIndex.get(right.id) ?? 0)
        ));

    /** @param {IValidationStage} stageDefinition */
    const launch = (stageDefinition) => {
        const weight = stageResourceWeight(stageDefinition, effectiveCapacity);
        pending.delete(stageDefinition.id);
        usedCapacity += weight;
        const promise = Promise.resolve()
            .then(() => runStage(stageDefinition, {signal}))
            .then(
                () => ({
                    error: null,
                    ok: true,
                    stageDefinition,
                }),
                error => ({
                    error,
                    ok: false,
                    stageDefinition,
                }),
            );
        running.set(stageDefinition.id, {
            promise,
            stageDefinition,
            weight,
        });
    };

    while (pending.size > 0 || running.size > 0) {
        let launched = true;
        while (launched && !signal?.aborted) {
            launched = false;
            const availableCapacity = effectiveCapacity - usedCapacity;
            const candidate = sortedReadyStages().find(stageDefinition => (
                stageResourceWeight(stageDefinition, effectiveCapacity) <= availableCapacity
            ));
            if (candidate) {
                launch(candidate);
                launched = true;
            }
        }

        if (running.size === 0) {
            if (pending.size === 0) {
                break;
            }
            if (signal?.aborted) {
                break;
            }
            throw new Error('Validation stage dependency graph contains a cycle or an unsatisfied dependency.');
        }

        const outcome = await Promise.race([...running.values()].map(entry => entry.promise));
        running.delete(outcome.stageDefinition.id);
        usedCapacity -= stageResourceWeight(outcome.stageDefinition, effectiveCapacity);
        if (outcome.ok) {
            completed.add(outcome.stageDefinition.id);
            continue;
        }
        failures.push({
            error: outcome.error,
            id: outcome.stageDefinition.id,
        });
        skipDependents(outcome.stageDefinition.id);
    }

    if (signal?.aborted) {
        /** @type {IValidationErrorState} */
        const interrupted = new ValidationInterruptedError();
        interrupted.failures = failures;
        interrupted.skipped = skipped;
        throw interrupted;
    }

    if (failures.length > 0) {
        throw new ValidationStagePoolError(failures, skipped);
    }
    return {
        failures,
        skipped,
    };
}

export class ValidationStagePoolError extends Error {
    /** @param {IValidationStageFailure[]} failures @param {IValidationStageSkip[]} skipped */
    constructor(failures, skipped) {
        const lines = failures.map(failure => `  ${failure.id}: ${getCliErrorMessage(failure.error)}`);
        if (skipped.length > 0) {
            lines.push(`  skipped (dependency failed): ${skipped.map(entry => `${entry.id} <- ${entry.dependency}`).join(', ')}`);
        }
        super(`${failures.length} validation stage${failures.length === 1 ? '' : 's'} failed:\n${lines.join('\n')}`);
        this.name = 'ValidationStagePoolError';
        this.failures = failures;
        this.skipped = skipped;
    }
}

/** @param {IValidationStage[]} stages @param {string[]} [requestedIds] @returns {IValidationStage[]} */
export function selectValidationStages(stages, requestedIds = []) {
    if (requestedIds.length === 0) {
        return stages;
    }
    const byId = new Map(stages.map(stageDefinition => [
        stageDefinition.id,
        stageDefinition,
    ]));
    const selectedIds = new Set();
    /** @param {string} id */
    const include = id => {
        const stageDefinition = byId.get(id);
        if (!stageDefinition) {
            throw new Error(`Unknown validation stage "${id}". Available stages: ${[...byId.keys()].join(', ')}`);
        }
        if (selectedIds.has(id)) {
            return;
        }
        selectedIds.add(id);
        for (const dependency of stageDefinition.dependsOn ?? []) {
            include(dependency);
        }
    };
    requestedIds.forEach(include);
    return stages.filter(stageDefinition => selectedIds.has(stageDefinition.id));
}

/** @param {IValidationStage[]} stages @param {IValidationStagesOptions} options @returns {Promise<void>} */
async function runStages(stages, {
    changes = {
        files: [],
        known: true,
    },
    noCache = process.env.EVB_GATE_NO_CACHE === '1',
    signal,
    tier = 'heavy',
} = {}) {
    const runId = `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}-${randomUUID().slice(0, 8)}`;
    const evidenceDir = process.env.EVB_GATE_EVIDENCE_DIR
        ? path.resolve(process.env.EVB_GATE_EVIDENCE_DIR)
        : path.join(projectRoot, '.devkit', 'analysis', 'gates');
    const evidencePath = path.join(evidenceDir, `${runId}.ndjson`);
    await mkdir(evidenceDir, {recursive: true});
    const evidence = createWriteStream(evidencePath, {
        encoding: 'utf8',
        flags: 'a',
        mode: 0o600,
    });
    /** @type {IValidationStageResult[]} */
    const results = [];
    const runStarted = Date.now();
    evidence.write(`${JSON.stringify({
        cacheSchemaVersion: validationCacheSchemaVersion,
        changes,
        event: 'run-start',
        runId,
        startedAt: new Date(runStarted).toISOString(),
        tier,
    })}\n`);

    try {
        if (stages.some(stageDefinition => (stageDefinition.heavyWeight ?? 0) > 0)) {
            await reportRepoSessions();
        }
        const lastPassingFingerprints = noCache
            ? new Map()
            : await readLastPassingStageFingerprints(evidenceDir);
        const preparedStages = stages.map(stageDefinition => ({
            ...stageDefinition,
            dependsOn: [...(stageDefinition.dependsOn ?? [])],
            inputFingerprint: stageInputFingerprint(stageDefinition, changes),
        }));
        /** @param {IValidationStage} stageDefinition @param {IValidationSignalOptions} [options] */
        const runStage = async (stageDefinition, {signal: stageSignal} = {}) => {
            if (stageSignal?.aborted) {
                throw new ValidationInterruptedError();
            }
            const dependsOn = stageDefinition.dependsOn ?? [];
            const cacheDecision = getValidationStageCacheDecision(stageDefinition, {
                changes,
                lastPassingFingerprints,
                noCache,
            });
            const {
                cacheHit,
                cacheReason,
                cacheState,
                inputFingerprint,
            } = cacheDecision;
            if (stageSignal?.aborted) {
                throw new ValidationInterruptedError();
            }
            if (cacheHit) {
                const timestamp = new Date().toISOString();
                /** @type {IValidationStageResult} */
                const result = {
                    cache: cacheState,
                    cacheHit: true,
                    cacheReason,
                    dependsOn,
                    endedAt: timestamp,
                    gateWaitMs: 0,
                    id: stageDefinition.id,
                    inputFingerprint,
                    loadAverage: os.loadavg(),
                    skipped: true,
                    status: 'passed',
                    wallMs: 0,
                    weight: stageDefinition.weight ?? 1,
                };
                evidence.write(`${JSON.stringify({
                    cache: cacheState,
                    cacheHit: true,
                    cacheReason,
                    command: [
                        stageDefinition.command,
                        ...stageDefinition.args,
                    ],
                    dependsOn,
                    event: 'stage-start',
                    heavyGateCoordinated: true,
                    gateWaitMs: 0,
                    heavyWeight: stageDefinition.heavyWeight,
                    id: stageDefinition.id,
                    inputFingerprint,
                    parallelPhase: stageDefinition.parallelPhase ?? null,
                    skipped: true,
                    startedAt: timestamp,
                    weight: stageDefinition.weight ?? 1,
                })}\n`);
                results.push(result);
                evidence.write(`${JSON.stringify({
                    event: 'stage-end',
                    ...result,
                })}\n`);
                process.stdout.write(`[gate] Cache hit: ${stageDefinition.id}\n`);
                return;
            }
            let gate;
            try {
                gate = await acquireHeavyGate({
                    id: stageDefinition.id,
                    signal: stageSignal,
                    weight: stageDefinition.heavyWeight ?? 0,
                });
            } catch (error) {
                if (isValidationErrorState(error) && error.interrupted) {
                    const endedAt = new Date().toISOString();
                    /** @type {IValidationStageResult} */
                    const result = {
                        cache: cacheState,
                        cacheHit: false,
                        cacheReason,
                        dependsOn,
                        endedAt,
                        id: stageDefinition.id,
                        inputFingerprint,
                        loadAverage: os.loadavg(),
                        skipped: false,
                        status: 'interrupted',
                        wallMs: 0,
                        weight: stageDefinition.weight ?? 1,
                    };
                    results.push(result);
                    evidence.write(`${JSON.stringify({
                        event: 'stage-end',
                        ...result,
                    })}\n`);
                }
                throw error;
            }
            const startedAtMs = Date.now();
            evidence.write(`${JSON.stringify({
                cache: cacheState,
                cacheHit: false,
                cacheReason,
                command: [
                    stageDefinition.command,
                    ...stageDefinition.args,
                ],
                event: 'stage-start',
                heavyGateCoordinated: gate.coordinated,
                gateCapacity: gate.capacity,
                gateWaitMs: gate.waitedMs,
                heavyWeight: stageDefinition.heavyWeight ?? 0,
                id: stageDefinition.id,
                inputFingerprint,
                parallelPhase: stageDefinition.parallelPhase ?? null,
                startedAt: new Date(startedAtMs).toISOString(),
                dependsOn: stageDefinition.dependsOn,
                weight: stageDefinition.weight ?? 1,
            })}\n`);
            /** @type {'passed' | 'failed' | 'interrupted'} */
            let status = 'passed';
            /** @type {IValidationErrorState | undefined} */
            let stageError;
            try {
                await spawnInherited(
                    stageDefinition.command,
                    stageDefinition.args,
                    {
                        ...process.env,
                        ...stageDefinition.env,
                        ...(noCache ? {EVB_GATE_NO_CACHE: '1'} : {}),
                        ...((stageDefinition.heavyWeight ?? 0) > 0
                            ? {EVB_HEAVY_GATE_HELD: '1'}
                            : {}),
                    },
                    {signal: stageSignal},
                );
                if (stageSignal?.aborted) {
                    throw new ValidationInterruptedError();
                }
            } catch (error) {
                stageError = isValidationErrorState(error) ? error : undefined;
                status = stageError?.interrupted ? 'interrupted' : 'failed';
                throw error;
            } finally {
                await gate.release({
                    ownedGroupIds: stageError?.ownedGroupIds ?? [],
                    ownedPids: stageError?.ownedPids ?? [],
                    retain: Boolean(stageError?.retainCapacity),
                });
                const endedAtMs = Date.now();
                const result = {
                    cache: cacheState,
                    cacheHit: false,
                    cacheReason,
                    endedAt: new Date(endedAtMs).toISOString(),
                    dependsOn,
                    gateCapacity: gate.capacity,
                    gateWaitMs: gate.waitedMs,
                    id: stageDefinition.id,
                    inputFingerprint,
                    loadAverage: os.loadavg(),
                    skipped: false,
                    status,
                    wallMs: endedAtMs - startedAtMs,
                    weight: stageDefinition.weight ?? 1,
                };
                results.push(result);
                evidence.write(`${JSON.stringify({
                    event: 'stage-end',
                    ...result,
                })}\n`);
            }
        };
        await runStagePool(preparedStages, runStage, {
            capacity: parsePositiveInteger(process.env.EVB_GATE_CAPACITY, getDefaultGateCapacity()),
            signal,
        });
    } finally {
        const endedAtMs = Date.now();
        evidence.write(`${JSON.stringify({
            event: 'run-end',
            runId,
            slowestStages: [...results]
                .sort((left, right) => right.wallMs - left.wallMs)
                .slice(0, 5)
                .map(result => ({
                    id: result.id,
                    wallMs: result.wallMs,
                })),
            status: signal?.aborted
                ? 'interrupted'
                : (results.length === stages.length && results.every(result => result.status === 'passed')
                    ? 'passed'
                    : 'failed'),
            wallMs: endedAtMs - runStarted,
        })}\n`);
        /** @type {Promise<void>} */
        const evidenceClosed = new Promise(resolve => {
            evidence.end(() => resolve());
        });
        await evidenceClosed;
        await pruneRetentionEntries({
            keep: 100,
            minimumAgeMs: 10 * 60_000,
            root: evidenceDir,
        });
        process.stdout.write(`[gate] Evidence: ${path.relative(projectRoot, evidencePath)}\n`);
        if (results.length > 0) {
            process.stdout.write([
                '[gate] Slowest stages:',
                ...[...results]
                    .sort((left, right) => right.wallMs - left.wallMs)
                    .slice(0, 5)
                    .map(result => `  ${result.id}: ${(result.wallMs / 1000).toFixed(2)}s`),
                '',
            ].join('\n'));
        }
    }
}

/** @param {string[]} argv @returns {Promise<void>} */
async function runPrePush(argv) {
    const remoteName = argv[0];
    if (!remoteName) {
        throw new Error('Usage: validation-gates.mjs pre-push <remote> [<url>]');
    }
    const work = collectPrePushWork(readFileSync(0, 'utf8'), [
        remoteName,
        argv[1],
    ], projectRoot);
    if (work.commits.length === 0) {
        process.stdout.write('[gate] pre-push: no commits to verify\n');
        return;
    }

    const changes = {
        files: collectPushedCommitFiles(work.commits),
        known: true,
        reason: 'pre-push',
    };
    const classification = classifyValidationImpacts(changes.files);
    if (classification.unmatchedFiles.length > 0) {
        process.stderr.write(
            `[gate] Unclassified pushed paths force the full pre-push typecheck: ${classification.unmatchedFiles.join(', ')}\n`,
        );
    }
    const plan = getValidationPlan({
        changes,
        classification,
        tier: 'acceptance',
    });
    const typecheckPlan = plan.filter(stageDefinition => (
        stageDefinition.id.startsWith('typecheck.')
        || stageDefinition.id === 'landing.typecheck'
    ));
    process.stdout.write(
        `[gate] pre-push: ${String(work.commits.length)} commit(s), ${String(changes.files.length)} changed path(s); `
        + `${typecheckPlan.map(stageDefinition => stageDefinition.id).join(', ') || 'no affected typecheck'}\n`,
    );
    if (typecheckPlan.length === 0) {
        return;
    }
    await runStages(typecheckPlan, {
        changes: {
            ...changes,
            classification,
        },
        tier: 'acceptance',
    });
}

/** @param {TValidationTier} tier @param {string[]} argv @param {IValidationSignalOptions} [options] @returns {Promise<void>} */
async function runTier(tier, argv, {signal} = {}) {
    const changes = await collectValidationChanges({
        base: readArg(argv, 'base'),
        explicitFiles: readArgs(argv, 'file'),
    });
    const classification = changes.known
        ? classifyValidationImpacts(changes.files)
        : {
            full: true,
            impacts: {},
            unmatchedFiles: [],
        };
    if (classification.unmatchedFiles.length > 0) {
        process.stderr.write(
            `[gate] Unclassified paths force the full ${tier} tier: ${classification.unmatchedFiles.join(', ')}\n`,
        );
    }
    if (!changes.known) {
        process.stderr.write(`[gate] Change impact is unknown (${changes.reason}); running the full ${tier} tier.\n`);
    }
    const cold = argv.includes('--cold');
    const plan = getValidationPlan({
        allGates: process.env.EVB_VALIDATE_ALL_GATES === '1' || argv.includes('--all'),
        cold,
        changes,
        classification,
        tier,
    });
    const selectedPlan = selectValidationStages(plan, readArgs(argv, 'only'));
    process.stdout.write(`[gate] ${tier}: ${selectedPlan.map(item => item.id).join(', ') || 'no affected stages'}\n`);
    if (selectedPlan.length === 0) {
        return;
    }
    await runStages(selectedPlan, {
        changes: {
            ...changes,
            classification,
        },
        noCache: cold || argv.includes('--no-cache') || process.env.EVB_GATE_NO_CACHE === '1',
        signal,
        tier,
    });
}

/** @param {string[]} argv @param {IValidationSignalOptions} [options] @returns {Promise<void>} */
async function runHeavyCommand(argv, {signal} = {}) {
    const separatorIndex = argv.indexOf('--');
    const command = separatorIndex >= 0 ? argv[separatorIndex + 1] : undefined;
    if (typeof command !== 'string') {
        throw new Error('Usage: validation-gates.mjs heavy --id=<id> --weight=<n> -- <command> [args...]');
    }
    const args = argv.slice(separatorIndex + 2);
    await runStages([stage(
        readArg(argv, 'id') ?? 'heavy',
        command,
        args,
        {heavyWeight: parsePositiveInteger(readArg(argv, 'weight'), 1)},
    )], {
        noCache: argv.includes('--cold')
            || argv.includes('--no-cache')
            || process.env.EVB_GATE_NO_CACHE === '1',
        signal,
        tier: 'heavy',
    });
}

/** @returns {Promise<void>} */
async function main() {
    const [
        command,
        ...argv
    ] = process.argv.slice(2);
    const cancellation = new AbortController();
    const onSignal = () => cancellation.abort();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    if (command === 'lint') {
        await runLint(argv, {signal: cancellation.signal});
        return;
    }
    if (command === 'heavy') {
        await runHeavyCommand(argv, {signal: cancellation.signal});
        return;
    }
    if (command === 'pre-push') {
        await runPrePush(argv);
        return;
    }
    if (isValidationTier(command)) {
        await runTier(command, argv, {signal: cancellation.signal});
        return;
    }
    throw new Error(
        'Usage: validation-gates.mjs <iteration|acceptance|integration|nightly|lint|heavy|pre-push> [options]',
    );
}

const isDirectRun = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
    await main().catch(async (error) => {
        process.stderr.write(`${getCliErrorMessage(error)}\n`);
        process.exitCode = 1;
    });
}
