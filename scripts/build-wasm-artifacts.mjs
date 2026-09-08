import { getCliErrorMessage } from './lib/cli-error.mjs';
import { spawnSync } from 'node:child_process';
import {
    mkdir,
    readFile,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WASM_ARTIFACTS } from './wasm-artifacts.mjs';
import { getWasmArtifactFingerprint } from './wasm-fingerprint.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutputDir = path.join(projectRoot, 'public', 'wasm');
const usage = 'Usage: node scripts/build-wasm-artifacts.mjs [--output-dir=<directory>]';

export function parseWasmArtifactsRequest(argv = process.argv.slice(2)) {
    const outputArguments = argv.filter(argument => argument.startsWith('--output-dir='));
    const unsupported = argv.filter(argument => argument !== '--' && !argument.startsWith('--output-dir='));
    if (unsupported.length > 0 || outputArguments.length > 1) throw new Error(usage);
    return {outputDir: outputArguments[0]
        ? path.resolve(projectRoot, outputArguments[0].slice('--output-dir='.length))
        : defaultOutputDir};
}

/** @param {{outputDir?: string, run?: (...args: any[]) => {status: number | null}}} options */
export function buildWasmArtifacts({
    outputDir = defaultOutputDir,
    run = spawnSync,
} = {}) {
    for (const artifact of WASM_ARTIFACTS) {
        const result = run(process.execPath, [
            path.join(projectRoot, 'scripts', 'build-wasm-tool.mjs'),
            artifact.crateName,
            `--output-dir=${outputDir}`,
        ], {
            cwd: projectRoot,
            env: process.env,
            stdio: 'inherit',
        });
        if (result.status !== 0) throw new Error(`WASM build failed for ${artifact.crateName}`);
    }
}

export async function writeWasmArtifactManifest(outputDir) {
    const entries = [];
    for (const artifact of WASM_ARTIFACTS) {
        const fileName = path.basename(artifact.publicRelativePath);
        const bytes = await readFile(path.join(outputDir, fileName));
        const fingerprint = getWasmArtifactFingerprint(bytes);
        if (!fingerprint) throw new Error(`WASM artifact has no source fingerprint: ${artifact.builtFileName}`);
        entries.push({
            byteLength: bytes.byteLength,
            fileName,
            fingerprint,
        });
    }
    await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify({
        artifacts: entries,
        schemaVersion: 1,
    }, null, 2)}\n`);
    return entries;
}

async function main() {
    const {outputDir} = parseWasmArtifactsRequest();
    await mkdir(outputDir, {recursive: true});
    buildWasmArtifacts({outputDir});
    if (outputDir === defaultOutputDir) {
        console.log(`Built ${WASM_ARTIFACTS.length} fresh WASM artifacts.`);
        return;
    }
    console.log(`Built ${(await writeWasmArtifactManifest(outputDir)).length} fresh WASM artifacts.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(getCliErrorMessage(error)); process.exitCode = 1; });
}
