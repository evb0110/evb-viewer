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
const buildIdsPath = path.join(projectRoot, '.tmp', 'wasm-build-ids.json');

/** @returns {Record<string, string>} */
function readRecordedBuildIds() {
    try {
        return JSON.parse(readFileSync(buildIdsPath, 'utf8'));
    } catch {
        return {};
    }
}

/**
 * Builds the browser WASM files that are missing or were built from other
 * native sources. A web deploy uploads prebuilt files without native/, so there
 * they only have to exist.
 */
export async function ensureWasmArtifacts() {
    const missing = WASM_ARTIFACTS.filter(artifact => !existsSync(path.join(projectRoot, artifact.publicRelativePath)));
    if (!existsSync(path.join(projectRoot, 'native', 'Cargo.toml'))) {
        if (missing.length > 0) {
            throw new Error(`Missing ${missing.map(artifact => artifact.publicRelativePath).join(', ')} and no native/ sources to build them from.`);
        }
        return;
    }
    const recorded = readRecordedBuildIds();
    const stale = WASM_ARTIFACTS
        .map(artifact => ({
            artifact,
            buildId: computeNativeBuildId(projectRoot, artifact.crateName),
        }))
        .filter(({
            artifact, buildId,
        }) => missing.includes(artifact) || recorded[artifact.crateName] !== buildId);
    for (const {
        artifact, buildId,
    } of stale) {
        await runWasmToolBuilder([artifact.crateName]);
        recorded[artifact.crateName] = buildId;
        mkdirSync(path.dirname(buildIdsPath), {recursive: true});
        writeFileSync(buildIdsPath, `${JSON.stringify(recorded, null, 2)}\n`);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await ensureWasmArtifacts().catch((error) => {
        console.error(getCliErrorMessage(error));
        process.exitCode = 1;
    });
}
