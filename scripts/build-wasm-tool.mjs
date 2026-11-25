import { getCliErrorMessage } from './lib/cli-error.mjs';
import {
    getCargoBuildEnvironment,
    getCargoRustflags,
} from './lib/build-environment.mjs';
import { spawnSync } from 'node:child_process';
import {
    mkdir,
    readFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import {
    copyCargoArtifactVerified,
    getCargoArtifactPath,
    parseCargoToolBuildRequest,
    resolveCargoTargetDirectory,
} from './cargo-artifacts.mjs';
import { getWasmArtifactsByCrateName } from './wasm-artifacts.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usage = `Usage: node scripts/build-wasm-tool.mjs <tool> [--dry-run]

Builds the browser WASM files of a tool registered by the canonical native
resource manifest, one per registered Rust target.
Use --dry-run to resolve and print the build plans without invoking Cargo.`;

export function createWasmToolBuildPlan({
    artifact,
    env = process.env,
    outputDir = undefined,
    projectRoot: root,
}) {
    return {
        builtFileName: artifact.builtFileName,
        cargoArgs: [
            'build',
            '--manifest-path',
            artifact.manifestPath,
            '--release',
            '--locked',
            '--target',
            artifact.rustTarget,
            '--lib',
        ],
        destinationPath: outputDir
            ? path.join(outputDir, path.basename(artifact.publicRelativePath))
            : path.join(root, artifact.publicRelativePath),
        label: artifact.label,
        manifestPath: artifact.manifestPath,
        requiredExports: artifact.requiredExports,
        rustTarget: artifact.rustTarget,
        rustflags: getCargoRustflags({
            env,
            extraRustflags: artifact.rustflags,
            projectRoot: root,
        }),
    };
}

async function resolveTool(toolId) {
    const { getGeneratedNativeToolResource } = await tsImport(
        './nativeResourceManifest.ts',
        import.meta.url,
    );
    const tool = getGeneratedNativeToolResource(toolId);
    return {
        artifacts: getWasmArtifactsByCrateName(tool.crateName),
        tool,
    };
}

/**
 * Builds one browser WASM file and stages it with its required exports checked.
 * @param {import('./wasm-artifacts.mjs').IWasmArtifact} artifact
 * @param {{outputDir?: string}} [options]
 */
export async function buildWasmArtifact(artifact, {outputDir} = {}) {
    const plan = createWasmToolBuildPlan({
        artifact,
        outputDir,
        projectRoot,
    });
    const cargoTargetDirectory = resolveCargoTargetDirectory({
        manifestPath: plan.manifestPath,
        projectRoot,
    });
    const sourcePath = getCargoArtifactPath({
        fileName: plan.builtFileName,
        rustTarget: plan.rustTarget,
        targetDirectory: cargoTargetDirectory,
    });
    const result = spawnSync('cargo', plan.cargoArgs, {
        cwd: projectRoot,
        env: getCargoBuildEnvironment({
            projectRoot,
            extraRustflags: artifact.rustflags,
        }).env,
        stdio: 'inherit',
    });
    if (result.status !== 0) {
        throw new Error(`cargo ${plan.cargoArgs.join(' ')} failed with status ${result.status ?? 'unknown'}`);
    }

    await mkdir(path.dirname(plan.destinationPath), {recursive: true});
    await copyCargoArtifactVerified(sourcePath, plan.destinationPath);
    const wasmBytes = await readFile(plan.destinationPath);
    const wasmModule = new WebAssembly.Module(wasmBytes);
    const exportNames = new Set(WebAssembly.Module.exports(wasmModule).map(entry => entry.name));
    const missingExports = plan.requiredExports.filter(name => !exportNames.has(name));
    if (missingExports.length > 0) {
        throw new Error(`${plan.label} is missing exports: ${missingExports.join(', ')}`);
    }

    console.log(
        `Staged ${plan.label}: ${path.relative(projectRoot, plan.destinationPath)} `
        + `(${wasmBytes.byteLength} bytes)`,
    );
}

export async function runWasmToolBuilder(argv = process.argv.slice(2)) {
    const request = parseCargoToolBuildRequest(argv, usage);
    if (request.help) {
        console.log(usage);
        return;
    }

    const {
        artifacts,
        tool,
    } = await resolveTool(request.toolId);
    const outputDir = request.outputDir ? path.resolve(projectRoot, request.outputDir) : undefined;
    if (request.dryRun) {
        console.log(JSON.stringify({
            tool,
            plans: artifacts.map(artifact => createWasmToolBuildPlan({
                artifact,
                outputDir,
                projectRoot,
            })),
        }, null, 2));
        return;
    }
    for (const artifact of artifacts) {
        await buildWasmArtifact(artifact, {outputDir});
    }
}

const isDirectRun = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
    await runWasmToolBuilder().catch((error) => {
        console.error(getCliErrorMessage(error));
        process.exitCode = 1;
    });
}
