import { getCliErrorMessage } from './lib/cli-error.mjs';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWasmToolBuilder } from './build-wasm-tool.mjs';
import { computeNativeBuildId } from './native-build-id.mjs';
import { WASM_ARTIFACTS } from './wasm-artifacts.mjs';

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

/**
 * A web deploy uploads the local browser WASM. Its remote build has no native/
 * sources to check, so the local build identities must be current first.
 * @param {string} root
 */
export function assertWasmArtifactsCurrent(root) {
    const stale = findWasmArtifactsToBuild(root);
    if (stale.length > 0) {
        throw new Error(
            `Browser WASM is missing or built from other native sources: ${stale.map(({artifact}) => artifact.publicRelativePath).join(', ')}. `
            + 'Run node scripts/ensure-wasm-artifacts.mjs before deploying.',
        );
    }
}

/**
 * Builds the browser WASM files that are missing or were built from other
 * native sources. A web deploy uploads prebuilt files without native/, so there
 * they only have to exist.
 */
export async function ensureWasmArtifacts() {
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
