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
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {
    BUILD_PRESENCE_ENVIRONMENT_KEYS,
    BUILD_SECRET_ENVIRONMENT_KEYS,
    getCargoBuildEnvironment,
    getCargoConfigurationInputs,
    getCargoFingerprintEnvironment,
    nuxtOutputDirectory,
    readBuildEnvironment,
} from '../lib/build-environment.mjs';
import { getRequestedNativeRustTarget } from '../native-rust-targets.mjs';

const RECEIPT_SCHEMA_VERSION = 1;
export const RELEASE_BUILD_RECEIPT_ENV_VAR = 'EVB_RELEASE_BUILD_RECEIPT';
/** @typedef {{schemaVersion: number, platformArch: string, stagingRoots: string[]}} IBuildManifest */
/** @typedef {(command: string, args: string[], options?: object) => string} TCommandRunner */
/** @typedef {{env?: NodeJS.ProcessEnv | undefined, inputFiles?: string[] | undefined, outputPaths?: string[] | undefined, projectRoot?: string | undefined, runCommand?: TCommandRunner | undefined}} IComputeReleaseBuildStateOptions */

/** @param {NodeJS.ProcessEnv} env @param {string} projectRoot */
function getNativeBuildOutputs(env, projectRoot) {
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
    return manifest.stagingRoots.concat(nativeManifest);
}
// Nuxt and Vite read these by prefix, for their own overrides. The named values
// the build reads come from readBuildEnvironment.
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

// Nuxt's c12 loader is async; keep the synchronous receipt API by resolving in
// a short-lived child. Reuse its interpolation and environment precedence rather
// than maintaining a second dotenv parser. No values are printed by this owner.
/** @param {NodeJS.ProcessEnv} env @param {string} projectRoot @returns {NodeJS.ProcessEnv} */
function nuxtBuildEnvironment(env, projectRoot) {
    const require = createRequire(import.meta.url);
    const c12 = require.resolve('c12', {paths: [require.resolve('nuxt/package.json')]});
    return JSON.parse(execFileSync(process.execPath, [
        '--input-type=module',
        '-e',
        `
        import {loadDotenv} from ${JSON.stringify(pathToFileURL(c12).href)};
        const env = await loadDotenv({cwd: ${JSON.stringify(projectRoot)}, env: process.env, interpolate: true});
        process.stdout.write(JSON.stringify(env));
    `,
    ], {
        env,
        encoding: 'utf8',
    }));
}

/** @param {NodeJS.ProcessEnv} env */
function buildEnvironment(env) {
    const values = {
        ...Object.fromEntries(Object.entries(env).filter(([key]) => BUILD_ENVIRONMENT_PREFIXES.some(prefix => key.startsWith(prefix)))),
        ...readBuildEnvironment(env),
    };
    /** @type {Record<string, string | boolean>} */
    const environment = {};
    for (const [
        key,
        value,
    ] of Object.entries(values).sort(([left], [right]) => left.localeCompare(right, 'en'))) {
        if (BUILD_PRESENCE_ENVIRONMENT_KEYS.includes(key)) {
            environment[`${key}_SET`] = Boolean(value);
        } else if (value !== undefined) {
            const sensitive = BUILD_SECRET_ENVIRONMENT_KEYS.includes(key) || SENSITIVE_BUILD_ENVIRONMENT_KEY.test(key);
            environment[sensitive ? `${key}_SHA256` : key] = sensitive
                ? createHash('sha256').update(value).digest('hex')
                : value;
        }
    }
    return environment;
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
    const effectiveNuxtEnv = nuxtBuildEnvironment(env, projectRoot);
    const nativeEnv = getCargoBuildEnvironment({
        env,
        projectRoot,
    }).env;
    const contract = {
        nativeConfiguration: createHash('sha256')
            .update(JSON.stringify(getCargoFingerprintEnvironment(nativeEnv)))
            .update(fingerprintPaths(projectRoot, getCargoConfigurationInputs({
                env: nativeEnv,
                projectRoot,
            })))
            .digest('hex'),
        dotenv: fingerprintPaths(projectRoot, ['.env']),
        environment: buildEnvironment(env),
        nuxtConfiguration: createHash('sha256').update(JSON.stringify(buildEnvironment(effectiveNuxtEnv))).digest('hex'),
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
            outputPaths ?? [
                'dist-electron',
                nuxtOutputDirectory(readBuildEnvironment(effectiveNuxtEnv)),
                '.tmp/generated-electron-builder-resources.yml',
                ...getNativeBuildOutputs(env, projectRoot),
            ],
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
