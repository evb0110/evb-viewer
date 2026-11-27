import {getCliErrorMessage} from './lib/cli-error.mjs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildWasmArtifact, createWasmToolBuildPlan} from './build-wasm-tool.mjs';
import {
    copyCargoArtifactVerified,
    discardCargoBuildFromOtherWrapperFlags,
    getCargoArtifactPath,
    resolveCargoTargetDirectory,
} from './cargo-artifacts.mjs';
import {getCargoBuildEnvironment, getCargoConfigurationInputs, getCargoFingerprintEnvironment} from './lib/build-environment.mjs';
import {countWasmBulkMemory, lowerWasmBulkMemory} from './lib/lower-wasm-bulk-memory.mjs';
import {computeNativeBuildId} from './native-build-id.mjs';
import {PREBUILT_WASM_FILES, WASM_ARTIFACTS} from './wasm-artifacts.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Keyed by artifact id: the build identity each public/wasm file was built from.
// An artifact's id is its crate name unless the crate has several artifacts.
const buildIdsPathFor = (root) => path.join(root, '.tmp', 'wasm-build-ids.json');

/**
 * Everything a browser WASM build is made from: its native sources, and the
 * Cargo arguments, effective Rust flags, Cargo and toolchain configuration
 * files and compiler environment. A toolchain pin or flag change makes the
 * build stale as surely as a source change. CI keys its WASM cache on it too.
 * @param {string} root
 * @param {import('./wasm-artifacts.mjs').IWasmArtifact} artifact
 * @param {NodeJS.ProcessEnv} [env]
 */
export function computeWasmBuildIdentity(root, artifact, env = process.env) {
    const plan = createWasmToolBuildPlan({
        artifact,
        env,
        projectRoot: root,
    });
    const hash = createHash('sha256').update(
        JSON.stringify({
            buildId: computeNativeBuildId(root, artifact.crateName),
            cargoArgs: plan.cargoArgs,
            environment: getCargoFingerprintEnvironment(env),
            rustflags: plan.rustflags,
        }),
    );
    for (const input of [
        ...getCargoConfigurationInputs({
            env,
            projectRoot: root,
        }),
        path.join(root, 'native', 'rust-toolchain.toml'),
        path.join(root, 'scripts', 'lib', 'cargo-rustc-wrapper.mjs'),
        path.join(root, 'scripts', 'lib', 'cargo-rustc-wrapper.rs'),
        path.join(root, 'scripts', 'lib', 'cargo-rustc-launcher.mjs'),
        ...(artifact.lowerBulkMemory ? [path.join(root, 'scripts', 'lib', 'lower-wasm-bulk-memory.mjs')] : []),
    ]) {
        if (!existsSync(input)) {
            continue;
        }
        hash.update(`${path.relative(root, input)}\0`)
            .update(readFileSync(input))
            .update('\0');
    }
    return hash.digest('hex');
}

/** @param {string} root @returns {Record<string, string>} */
function readRecordedBuildIds(root) {
    try {
        return JSON.parse(readFileSync(buildIdsPathFor(root), 'utf8'));
    } catch {
        return {};
    }
}

/**
 * The browser WASM files that are missing or were built from other inputs,
 * with the build identity each one must carry. Without native/ sources there
 * is no identity to compare, so only presence counts and the build ID is null.
 * @param {string} [root]
 * @returns {Array<{artifact: import('./wasm-artifacts.mjs').IWasmArtifact, buildId: string | null}>}
 */
export function findWasmArtifactsToBuild(root = projectRoot) {
    const isPresent = (artifact) => existsSync(path.join(root, artifact.publicRelativePath));
    if (!existsSync(path.join(root, 'native', 'Cargo.toml'))) {
        return WASM_ARTIFACTS.filter((artifact) => !isPresent(artifact)).map((artifact) => ({
            artifact,
            buildId: null,
        }));
    }
    const recorded = readRecordedBuildIds(root);
    return WASM_ARTIFACTS.map((artifact) => ({
        artifact,
        buildId: computeWasmBuildIdentity(root, artifact),
    })).filter(({artifact, buildId}) => !isPresent(artifact) || recorded[artifact.id] !== buildId);
}

const PREBUILT_WASM_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** @param {Uint8Array} bytes */
function sha256Hex(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The prebuilt browser files that are missing or differ from their pinned digest.
 * @param {string} [root]
 */
export function findPrebuiltWasmFilesToFetch(root = projectRoot) {
    return PREBUILT_WASM_FILES.filter((file) => {
        const filePath = path.join(root, file.publicRelativePath);
        return !existsSync(filePath) || sha256Hex(readFileSync(filePath)) !== file.sha256;
    });
}

/** @param {import('./wasm-artifacts.mjs').IPrebuiltWasmFile} file */
async function fetchPrebuiltWasmFile(file) {
    // One deadline covers the response headers and the whole body.
    const response = await fetch(file.url, {signal: AbortSignal.timeout(PREBUILT_WASM_DOWNLOAD_TIMEOUT_MS)});
    if (!response.ok) {
        throw new Error(`Downloading ${file.label} failed: HTTP ${response.status} from ${file.url}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== file.bytes || sha256Hex(bytes) !== file.sha256) {
        throw new Error(`${file.label} from ${file.url} does not match its pinned size and SHA-256`);
    }
    const filePath = path.join(projectRoot, file.publicRelativePath);
    mkdirSync(path.dirname(filePath), {recursive: true});
    const partialPath = `${filePath}.partial`;
    writeFileSync(partialPath, bytes);
    renameSync(partialPath, filePath);
}

/**
 * A web deploy uploads the local browser WASM. Its remote build has no native/
 * sources to check, so the local build identities must be current first.
 * @param {string} root
 */
export function assertWasmArtifactsCurrent(root) {
    const stale = [
        ...findWasmArtifactsToBuild(root).map(({artifact}) => artifact.publicRelativePath),
        ...findPrebuiltWasmFilesToFetch(root).map((file) => file.publicRelativePath),
    ];
    if (stale.length > 0) {
        throw new Error(
            `Browser WASM is missing, built from other native sources, or not the pinned download: ${stale.join(', ')}. ` +
                'Run node scripts/ensure-wasm-artifacts.mjs before deploying.',
        );
    }
}

/**
 * @param {Uint8Array} wasmBytes
 * @param {{label: string, requiredExports: string[]}} plan
 */
function assertWasmExports(wasmBytes, plan) {
    const wasmModule = new WebAssembly.Module(wasmBytes);
    const exportNames = new Set(WebAssembly.Module.exports(wasmModule).map((entry) => entry.name));
    const missingExports = plan.requiredExports.filter((name) => !exportNames.has(name));
    if (missingExports.length > 0) {
        throw new Error(`${plan.label} is missing exports: ${missingExports.join(', ')}`);
    }
}

/**
 * Stages a freshly built WASM artifact, lowering bulk memory if configured and
 * validating required exports.
 * @param {string} sourcePath
 * @param {import('./wasm-artifacts.mjs').IWasmArtifact} artifact
 */
async function stageWasmArtifact(sourcePath, artifact) {
    const destinationPath = path.join(projectRoot, artifact.publicRelativePath);
    await mkdir(path.dirname(destinationPath), {recursive: true});
    if (artifact.lowerBulkMemory) {
        const {bytes, lowered} = lowerWasmBulkMemory(await readFile(sourcePath));
        const left = countWasmBulkMemory(bytes);
        if (left.copy + left.fill > 0) {
            throw new Error(`${artifact.label} still has ${left.copy} memory.copy and ${left.fill} memory.fill after lowering`);
        }
        assertWasmExports(bytes, artifact);
        const partialPath = `${destinationPath}.${process.pid}.partial`;
        try {
            await writeFile(partialPath, bytes);
            await rename(partialPath, destinationPath);
        } finally {
            await rm(partialPath, {force: true});
        }
        console.log(`Lowered ${lowered.copy} memory.copy and ${lowered.fill} memory.fill in ${artifact.label}`);
    } else {
        await copyCargoArtifactVerified(sourcePath, destinationPath);
    }
    const wasmBytes = await readFile(destinationPath);
    assertWasmExports(wasmBytes, artifact);
    console.log(`Staged ${artifact.label}: ${path.relative(projectRoot, destinationPath)} ` + `(${wasmBytes.byteLength} bytes)`);
}

/**
 * Builds stale WASM artifacts sharing a target and rustflags in a single
 * workspace Cargo invocation so shared dependencies compile once.
 * @param {Array<{artifact: import('./wasm-artifacts.mjs').IWasmArtifact, buildId: string | null}>} group
 * @param {string} cargoTargetDirectory
 */
async function buildWasmArtifactBatch(group, cargoTargetDirectory) {
    const first = group[0].artifact;
    const {env} = getCargoBuildEnvironment({
        projectRoot,
        extraRustflags: first.rustflags,
    });
    discardCargoBuildFromOtherWrapperFlags({
        env,
        projectRoot,
        rustTarget: first.rustTarget,
        targetDirectory: cargoTargetDirectory,
    });
    const cargoArgs = [
        'build',
        '--manifest-path',
        'native/Cargo.toml',
        '--release',
        '--locked',
        '--target',
        first.rustTarget,
        '--lib',
        ...group.flatMap(({artifact}) => ['-p', artifact.packageName]),
    ];
    const result = spawnSync('cargo', cargoArgs, {
        cwd: projectRoot,
        env,
        stdio: 'inherit',
    });
    if (result.status !== 0) {
        throw new Error(`cargo ${cargoArgs.join(' ')} failed with status ${result.status ?? 'unknown'}`);
    }
    for (const {artifact} of group) {
        const sourcePath = getCargoArtifactPath({
            fileName: artifact.builtFileName,
            rustTarget: artifact.rustTarget,
            targetDirectory: cargoTargetDirectory,
        });
        await stageWasmArtifact(sourcePath, artifact);
    }
}

/**
 * Builds the browser WASM files that are missing or were built from other
 * native sources, and fetches the prebuilt ones that are missing or differ from
 * their pin. A web deploy uploads prebuilt files without native/, so there
 * they only have to exist.
 */
export async function ensureWasmArtifacts() {
    for (const file of findPrebuiltWasmFilesToFetch()) {
        await fetchPrebuiltWasmFile(file);
    }
    const stale = findWasmArtifactsToBuild();
    if (!existsSync(path.join(projectRoot, 'native', 'Cargo.toml'))) {
        if (stale.length > 0) {
            throw new Error(
                `Missing ${stale.map(({artifact}) => artifact.publicRelativePath).join(', ')} and no native/ sources to build them from.`,
            );
        }
        return;
    }
    if (stale.length === 0) {
        return;
    }

    /** @type {Map<string, typeof stale>} */
    const groups = new Map();
    for (const entry of stale) {
        const key = `${entry.artifact.rustTarget}\0${JSON.stringify(entry.artifact.rustflags)}`;
        const existing = groups.get(key);
        if (existing) {
            existing.push(entry);
        } else {
            groups.set(key, [entry]);
        }
    }

    const cargoTargetDirectory = [...groups.values()].some((group) => group.length > 1)
        ? resolveCargoTargetDirectory({
              manifestPath: 'native/Cargo.toml',
              projectRoot,
          })
        : null;

    const recorded = readRecordedBuildIds(projectRoot);
    for (const group of groups.values()) {
        if (group.length === 1) {
            await buildWasmArtifact(group[0].artifact);
        } else {
            await buildWasmArtifactBatch(group, /** @type {string} */ (cargoTargetDirectory));
        }
        for (const {artifact, buildId} of group) {
            recorded[artifact.id] = buildId;
        }
        mkdirSync(path.dirname(buildIdsPathFor(projectRoot)), {recursive: true});
        writeFileSync(buildIdsPathFor(projectRoot), `${JSON.stringify(recorded, null, 2)}\n`);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await ensureWasmArtifacts().catch((error) => {
        console.error(getCliErrorMessage(error));
        process.exitCode = 1;
    });
}
