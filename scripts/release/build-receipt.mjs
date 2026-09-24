import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    lstatSync,
    mkdirSync,
    readFileSync,
    readlinkSync,
    readdirSync,
    renameSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { getRequestedNativeRustTarget } from '../native-rust-targets.mjs';

const RECEIPT_SCHEMA_VERSION = 1;
export const RELEASE_BUILD_RECEIPT_ENV_VAR = 'EVB_RELEASE_BUILD_RECEIPT';
/** @typedef {{schemaVersion: number, platformArch: string, stagingRoots: string[]}} IBuildManifest */
/** @typedef {(command: string, args: string[], options?: object) => string} TCommandRunner */
/** @typedef {{env?: NodeJS.ProcessEnv | undefined, inputFiles?: string[] | undefined, outputPaths?: string[] | undefined, projectRoot?: string | undefined, runCommand?: TCommandRunner | undefined}} IComputeReleaseBuildStateOptions */

/** @param {NodeJS.ProcessEnv} env @param {string} projectRoot */
function getBuildOutputs(env, projectRoot) {
    const {platformArch} = getRequestedNativeRustTarget(env);
    const nativeManifest = `.tmp/native-build-manifest/${platformArch}.json`;
    const manifest = /** @type {IBuildManifest} */ (JSON.parse(readFileSync(path.resolve(projectRoot, nativeManifest), 'utf8')));
    if (
        manifest?.schemaVersion !== 1
        || manifest.platformArch !== platformArch
        || !Array.isArray(manifest.stagingRoots)
        || manifest.stagingRoots.length === 0
        || manifest.stagingRoots.some(root => (
            typeof root !== 'string'
            || !root.startsWith('.tmp/')
            || path.isAbsolute(root)
            || root.split('/').includes('..')
        ))
    ) {
        throw new Error(`Invalid native build manifest: ${nativeManifest}`);
    }
    return [
        'dist-electron',
        'nuxt-output',
        '.tmp/generated-electron-builder-resources.yml',
        nativeManifest,
        ...manifest.stagingRoots,
    ];
}
const BUILD_ENVIRONMENT_KEYS = [
    'NODE_ENV',
    'RUSTFLAGS',
    'TARGET_ARCH',
    'npm_config_arch',
    'EVB_NATIVE_TARGET_ARCH',
    'EVB_NATIVE_TARGET_PLATFORM',
    'EVB_RELEASE_TARGET_ARCH',
    'EVB_RELEASE_TARGET_PLATFORM',
    'EVB_RELEASE_TARGET_DIST',
    'EVB_ELECTRON_SOURCEMAP',
];
const BUILD_ENVIRONMENT_PREFIXES = [
    'NUXT_',
    'VITE_',
];
const SENSITIVE_BUILD_ENVIRONMENT_KEY = /(?:AUTH|CREDENTIAL|DATABASE|DSN|ENDPOINT|KEY|PASSWORD|PRIVATE|SECRET|TOKEN)/iu;

/** @param {string} projectRoot @param {string} filePath */
function normalizedRelativePath(projectRoot, filePath) {
    return path.relative(projectRoot, filePath).split(path.sep).join('/');
}

/** @param {import('node:crypto').Hash} hash @param {string} projectRoot @param {string} filePath */
function addPath(hash, projectRoot, filePath) {
    const relativePath = normalizedRelativePath(projectRoot, filePath);
    let metadata;
    try {
        metadata = lstatSync(filePath);
    } catch (error) {
        const isMissing = error
            && typeof error === 'object'
            && 'code' in error
            && error.code === 'ENOENT';
        if (isMissing) {
            hash.update(`missing\0${relativePath}\0`);
            return;
        }
        throw error;
    }
    hash.update(`${relativePath}\0${metadata.mode & 0o777}\0`);
    if (metadata.isDirectory()) {
        const entries = readdirSync(filePath)
            .sort((left, right) => left.localeCompare(right, 'en'));
        for (const entry of entries) {
            addPath(hash, projectRoot, path.join(filePath, entry));
        }
        return;
    }
    if (metadata.isSymbolicLink()) {
        hash.update(`symlink\0${readlinkSync(filePath)}\0`);
        return;
    }
    if (!metadata.isFile()) {
        throw new Error(`Unsupported release build input type: ${filePath}`);
    }
    hash.update(readFileSync(filePath));
    hash.update('\0');
}

/** @param {string} projectRoot @param {string[]} paths @param {{requireExisting?: boolean}} [options] */
function fingerprintPaths(projectRoot, paths, {requireExisting = false} = {}) {
    const hash = createHash('sha256');
    for (const filePath of paths
        .map(file => path.resolve(projectRoot, file))
        .sort((left, right) => left.localeCompare(right, 'en'))) {
        if (requireExisting) {
            lstatSync(filePath);
        }
        addPath(hash, projectRoot, filePath);
    }
    return hash.digest('hex');
}

/** @param {string} command @param {string[]} args @param {object} [options] */
function defaultRun(command, args, options = {}) {
    return String(execFileSync(command, args, {
        cwd: process.cwd(),
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
        ...options,
    })).trim();
}

/** @param {{projectRoot?: string, runCommand?: TCommandRunner}} [options] */
export function getReleaseBuildInputFiles({
    projectRoot = process.cwd(),
    runCommand = defaultRun,
} = {}) {
    const output = runCommand('git', [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
    ], {cwd: projectRoot});
    return output.split('\0').filter(Boolean);
}

/** @param {NodeJS.ProcessEnv} env */
function buildEnvironment(env) {
    return Object.fromEntries(Object.entries(env)
        .filter(([key]) => (
            BUILD_ENVIRONMENT_KEYS.includes(key)
            || BUILD_ENVIRONMENT_PREFIXES.some(prefix => key.startsWith(prefix))
        ) && !SENSITIVE_BUILD_ENVIRONMENT_KEY.test(key))
        .sort(([left], [right]) => left.localeCompare(right, 'en')));
}

/** @param {TCommandRunner} runCommand */
function toolchain(runCommand) {
    return {
        cargo: runCommand('cargo', ['--version']),
        node: process.version,
        pnpm: runCommand('pnpm', ['--version']),
        rustc: runCommand('rustc', ['--version']),
    };
}

/** @param {IComputeReleaseBuildStateOptions} [options] */
export function computeReleaseBuildState({
    env = process.env,
    inputFiles,
    outputPaths,
    projectRoot = process.cwd(),
    runCommand = defaultRun,
} = {}) {
    const inputs = inputFiles ?? getReleaseBuildInputFiles({
        projectRoot,
        runCommand,
    });
    const contract = {
        environment: buildEnvironment(env),
        platform: process.platform,
        architecture: process.arch,
        toolchain: toolchain(runCommand),
    };
    const contractHash = createHash('sha256')
        .update(JSON.stringify(contract))
        .digest('hex');
    return {
        contract,
        inputFingerprint: createHash('sha256')
            .update(contractHash)
            .update(fingerprintPaths(projectRoot, inputs))
            .digest('hex'),
        outputFingerprint: fingerprintPaths(
            projectRoot,
            outputPaths ?? getBuildOutputs(env, projectRoot),
            {requireExisting: true},
        ),
    };
}

/** @param {string} receiptPath @param {IComputeReleaseBuildStateOptions} [options] */
export function writeReleaseBuildReceipt(receiptPath, options = {}) {
    const receipt = {
        ...computeReleaseBuildState(options),
        schemaVersion: RECEIPT_SCHEMA_VERSION,
    };
    mkdirSync(path.dirname(receiptPath), {recursive: true});
    const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`);
    renameSync(temporaryPath, receiptPath);
    return receipt;
}

/** @param {string} receiptPath @param {IComputeReleaseBuildStateOptions} [options] */
export function validateReleaseBuildReceipt(receiptPath, options = {}) {
    try {
        const receipt = /** @type {{schemaVersion?: number, inputFingerprint?: string, outputFingerprint?: string}} */ (JSON.parse(readFileSync(receiptPath, 'utf8')));
        if (receipt?.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
            return {
                reason: 'schema-mismatch',
                valid: false,
            };
        }
        const current = computeReleaseBuildState(options);
        if (receipt.inputFingerprint !== current.inputFingerprint) {
            return {
                reason: 'inputs-changed',
                valid: false,
            };
        }
        if (receipt.outputFingerprint !== current.outputFingerprint) {
            return {
                reason: 'outputs-changed',
                valid: false,
            };
        }
        return {
            receipt,
            valid: true,
        };
    } catch (error) {
        const isMissing = error
            && typeof error === 'object'
            && 'code' in error
            && error.code === 'ENOENT';
        return {
            reason: isMissing ? 'missing' : 'unreadable-or-incomplete',
            valid: false,
        };
    }
}
