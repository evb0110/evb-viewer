import { getCliErrorMessage } from './lib/cli-error.mjs';
import { createHash } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWasmToolBuilder } from './build-wasm-tool.mjs';
import { computeNativeBuildId } from './native-build-id.mjs';
import {
    PREBUILT_WASM_FILES,
    WASM_ARTIFACTS,
} from './wasm-artifacts.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Keyed by crate name: the native build ID each public/wasm file was built from.
const buildIdsPathFor = root => path.join(root, '.tmp', 'wasm-build-ids.json');

/** @param {string} root @returns {Record<string, string>} */
function readRecordedBuildIds(root) {
    try {
        return JSON.parse(readFileSync(buildIdsPathFor(root), 'utf8'));
    } catch {
        return {};
    }
}

/**
 * The browser WASM files that are missing or were built from other native
 * sources, with the build ID each one must carry. Without native/ sources there
 * is no identity to compare, so only presence counts and the build ID is null.
 * @param {string} [root]
 * @returns {Array<{artifact: import('./wasm-artifacts.mjs').IWasmArtifact, buildId: string | null}>}
 */
export function findWasmArtifactsToBuild(root = projectRoot) {
    const isPresent = artifact => existsSync(path.join(root, artifact.publicRelativePath));
    if (!existsSync(path.join(root, 'native', 'Cargo.toml'))) {
        return WASM_ARTIFACTS
            .filter(artifact => !isPresent(artifact))
            .map(artifact => ({
                artifact,
                buildId: null,
            }));
    }
    const recorded = readRecordedBuildIds(root);
    return WASM_ARTIFACTS
        .map(artifact => ({
            artifact,
            buildId: computeNativeBuildId(root, artifact.crateName),
        }))
        .filter(({
            artifact, buildId,
        }) => !isPresent(artifact) || recorded[artifact.crateName] !== buildId);
}

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
    const response = await fetch(file.url);
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
        ...findPrebuiltWasmFilesToFetch(root).map(file => file.publicRelativePath),
    ];
    if (stale.length > 0) {
        throw new Error(
            `Browser WASM is missing, built from other native sources, or not the pinned download: ${stale.join(', ')}. `
            + 'Run node scripts/ensure-wasm-artifacts.mjs before deploying.',
        );
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
            throw new Error(`Missing ${stale.map(({artifact}) => artifact.publicRelativePath).join(', ')} and no native/ sources to build them from.`);
        }
        return;
    }
    const recorded = readRecordedBuildIds(projectRoot);
    for (const {
        artifact, buildId,
    } of stale) {
        await runWasmToolBuilder([artifact.crateName]);
        recorded[artifact.crateName] = buildId;
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
