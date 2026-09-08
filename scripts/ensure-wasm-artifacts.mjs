import { getCliErrorMessage } from './lib/cli-error.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildWasmArtifacts,
    parseWasmArtifactsRequest,
} from './build-wasm-artifacts.mjs';
import { stageWasmArtifacts } from './stage-wasm-artifacts.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
    const configuredInputDir = process.env.EVB_WASM_ARTIFACT_DIR;
    if (configuredInputDir) {
        await stageWasmArtifacts(path.resolve(projectRoot, configuredInputDir));
        return;
    }
    const {outputDir} = parseWasmArtifactsRequest([]);
    buildWasmArtifacts({outputDir});
}

main().catch(error => { console.error(getCliErrorMessage(error)); process.exitCode = 1; });
