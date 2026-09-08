import { getCliErrorMessage } from './lib/cli-error.mjs';
import {
    copyFile,
    mkdir,
    readFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WASM_ARTIFACTS } from './wasm-artifacts.mjs';
import {
    computeWasmSourceFingerprint,
    getWasmArtifactFingerprint,
} from './wasm-fingerprint.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function stageWasmArtifacts(inputDir, outputDir = path.join(projectRoot, 'public', 'wasm')) {
    const manifest = JSON.parse(await readFile(path.join(inputDir, 'manifest.json'), 'utf8'));
    if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.artifacts)) throw new Error('WASM artifact manifest is invalid');
    const manifestByName = new Map(manifest.artifacts.map(entry => [
        entry.fileName,
        entry,
    ]));
    const expectedNames = new Set(WASM_ARTIFACTS.map(artifact => path.basename(artifact.publicRelativePath)));
    if (manifest.artifacts.length !== expectedNames.size || manifest.artifacts.some(entry => !expectedNames.has(entry.fileName))) {
        throw new Error('WASM artifact manifest does not contain exactly the expected artifacts');
    }
    const validatedArtifacts = [];
    for (const artifact of WASM_ARTIFACTS) {
        const fileName = path.basename(artifact.publicRelativePath);
        const sourcePath = path.join(inputDir, fileName);
        const bytes = await readFile(sourcePath);
        const actualFingerprint = getWasmArtifactFingerprint(bytes);
        const expectedFingerprint = await computeWasmSourceFingerprint(artifact, {
            projectRoot,
            rustflags: artifact.rustflags.join(' '),
        });
        const entry = manifestByName.get(fileName);
        if (!entry || entry.byteLength !== bytes.byteLength || entry.fingerprint !== actualFingerprint) throw new Error(`WASM artifact manifest does not match ${fileName}`);
        if (actualFingerprint !== expectedFingerprint) throw new Error(`WASM artifact ${fileName} was built from different sources`);
        validatedArtifacts.push({
            fileName,
            sourcePath,
        });
    }
    await mkdir(outputDir, {recursive: true});
    for (const {
        fileName,
        sourcePath,
    } of validatedArtifacts) {
        await copyFile(sourcePath, path.join(outputDir, fileName));
    }
}

async function main() {
    if (!process.argv[2] || process.argv.length > 3) throw new Error('Usage: node scripts/stage-wasm-artifacts.mjs <artifact-directory>');
    await stageWasmArtifacts(path.resolve(projectRoot, process.argv[2]));
    console.log('Staged source-verified WASM artifacts into public/wasm.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(getCliErrorMessage(error)); process.exitCode = 1; });
}
