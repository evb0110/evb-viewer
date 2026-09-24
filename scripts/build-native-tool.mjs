import { getCliErrorMessage } from './lib/cli-error.mjs';
import { spawnSync } from 'node:child_process';
import {
    access,
    chmod,
    mkdir,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import {
    copyCargoArtifactVerified,
    collectCargoSourceInputs,
    computeCargoInputFingerprint,
    getCargoArtifactPath,
    parseCargoTargetDirectory,
    readValidCargoBuildReceipt,
    writeCargoBuildReceipt,
} from './cargo-artifacts.mjs';
import { computeNativeBuildId } from './native-build-id.mjs';
import { getRequestedNativeRustTarget } from './native-rust-targets.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usage = `Usage: node scripts/build-native-tool.mjs <tool...>|--all [--dry-run]

Builds one or more generated native tools from the canonical native resource manifest.
Use --dry-run to resolve and print the build plan without invoking Cargo.`;

export function createNativeToolBuildPlan({
    projectRoot: root,
    staticLinuxCrt = false,
    target,
    tool,
}) {
    const manifestPath = `native/${tool.crateName}/Cargo.toml`;
    const binaryName = `${tool.binaryName}${target.binaryExtension}`;
    return {
        binaryName,
        cargoArgs: [
            staticLinuxCrt ? 'rustc' : 'build',
            '--manifest-path',
            manifestPath,
            '--release',
            '--locked',
            ...target.cargoTargetArgs,
            ...(staticLinuxCrt
                ? [
                    '--bin',
                    tool.binaryName,
                    '--',
                    '-C',
                    'target-feature=+crt-static',
                ]
                : []),
        ],
        destinationPath: path.join(root, '.tmp', tool.stagingName, target.platformArch, 'bin', binaryName),
        manifestPath,
        platform: target.platform,
        platformArch: target.platformArch,
        rustTarget: target.isHostTarget ? undefined : target.rustTarget,
    };
}

export function parseNativeToolBuildRequest(argv) {
    if (argv.includes('--help') || argv.includes('-h')) {
        return {
            dryRun: false,
            help: true,
            toolIds: [],
        };
    }
    const dryRun = argv.includes('--dry-run');
    const all = argv.includes('--all');
    const unsupportedOptions = argv.filter(argument => (
        argument.startsWith('-')
        && ![
            '--all',
            '--dry-run',
        ].includes(argument)
    ));
    const toolIds = argv.filter(argument => !argument.startsWith('-'));
    if (unsupportedOptions.length > 0 || (all && toolIds.length > 0) || (!all && toolIds.length === 0)) {
        throw new Error(usage);
    }
    return {
        all,
        dryRun,
        help: false,
        toolIds: [...new Set(toolIds)],
    };
}

async function resolveTools(request) {
    const {
        GENERATED_NATIVE_TOOL_RESOURCES,
        getGeneratedNativeToolResource,
    } = await tsImport(
        './nativeResourceManifest.ts',
        import.meta.url,
    );
    return request.all
        ? [...GENERATED_NATIVE_TOOL_RESOURCES]
        : request.toolIds.map(toolId => getGeneratedNativeToolResource(toolId));
}

function commandVersion(command) {
    const result = spawnSync(command, ['--version'], {
        cwd: projectRoot,
        encoding: 'utf8',
    });
    if (result.status !== 0) {
        throw new Error(`${command} --version failed with status ${result.status ?? 'unknown'}`);
    }
    return String(result.stdout).trim();
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv;
 *   runCommand?: (
 *     command: string,
 *     args: string[],
 *     options: {encoding: BufferEncoding},
 *   ) => {status: number | null; stdout: string};
 * }} [options]
 */
export function getCargoBuildEnvironment({
    env = process.env,
    runCommand = spawnSync,
} = {}) {
    if (env.RUSTC_WRAPPER) {
        return {
            env,
            sccache: `configured (${env.RUSTC_WRAPPER})`,
        };
    }
    if (env.EVB_RUST_SCCACHE !== '1') {
        return {
            env,
            sccache: 'disabled',
        };
    }
    const result = runCommand('sccache', ['--version'], {encoding: 'utf8'});
    if (result.status === 0) {
        return {
            env: {
                ...env,
                RUSTC_WRAPPER: 'sccache',
            },
            sccache: String(result.stdout).trim(),
        };
    }
    return {
        env,
        sccache: 'unavailable',
    };
}

export function getCargoFingerprintEnvironment(env) {
    const exactKeys = new Set([
        'AR',
        'CC',
        'CFLAGS',
        'CXX',
        'CXXFLAGS',
        'LDFLAGS',
        'MACOSX_DEPLOYMENT_TARGET',
        'PKG_CONFIG_PATH',
        'SDKROOT',
    ]);
    const prefixes = [
        'AR_',
        'CARGO_',
        'CC_',
        'CFLAGS_',
        'CXX_',
        'CXXFLAGS_',
        'LDFLAGS_',
        'OPENSSL_',
        'PKG_CONFIG_',
        'RUST',
    ];
    return Object.fromEntries(Object.entries(env)
        .filter(([key]) => exactKeys.has(key) || prefixes.some(prefix => key.startsWith(prefix)))
        .sort(([left], [right]) => left.localeCompare(right, 'en')));
}

function getReceiptPath(plan) {
    return path.join(path.dirname(plan.destinationPath), '..', 'build-receipt.json');
}

async function writeNativeBuildManifest(plans, target) {
    const manifestPath = path.join(
        projectRoot,
        '.tmp',
        'native-build-manifest',
        `${target.platformArch}.json`,
    );
    const manifest = {
        platformArch: target.platformArch,
        schemaVersion: 1,
        stagingRoots: plans.map(plan => (
            path.relative(projectRoot, path.dirname(path.dirname(plan.destinationPath)))
                .split(path.sep)
                .join('/')
        )),
        tools: plans.map(plan => ({
            binaryPath: path.relative(projectRoot, plan.destinationPath).split(path.sep).join('/'),
            inputFingerprint: plan.input.fingerprint,
            toolId: plan.tool.familyId,
        })),
    };
    await mkdir(path.dirname(manifestPath), {recursive: true});
    const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(temporaryPath, manifestPath);
}

export async function runNativeToolBuilder(argv = process.argv.slice(2)) {
    const request = parseNativeToolBuildRequest(argv);
    if (request.help) {
        console.log(usage);
        return;
    }

    const tools = await resolveTools(request);
    const target = getRequestedNativeRustTarget();
    const staticLinuxCrt = target.platform === 'linux'
        && process.env.EVB_NATIVE_TARGET_PLATFORM !== undefined;
    const plans = tools.map(tool => ({
        ...createNativeToolBuildPlan({
            projectRoot,
            staticLinuxCrt,
            target,
            tool,
        }),
        cargoTargetArgs: target.cargoTargetArgs,
        tool,
    }));
    if (request.dryRun) {
        console.log(JSON.stringify({
            cargoCommands: plans.map(plan => plan.cargoArgs),
            plans,
        }, null, 2));
        return;
    }

    const cargoEnvironment = getCargoBuildEnvironment();
    const metadataArgs = [
        'metadata',
        '--manifest-path',
        'native/Cargo.toml',
        '--format-version',
        '1',
        '--no-deps',
    ];
    const metadataResult = spawnSync('cargo', metadataArgs, {
        cwd: projectRoot,
        encoding: 'utf8',
        env: cargoEnvironment.env,
    });
    if (metadataResult.status !== 0) {
        throw new Error(`cargo ${metadataArgs.join(' ')} failed with status ${metadataResult.status ?? 'unknown'}`);
    }
    const metadata = JSON.parse(metadataResult.stdout);
    const cargoTargetDirectory = parseCargoTargetDirectory(metadataResult.stdout);
    const toolchain = {
        cargo: commandVersion('cargo'),
        rustc: commandVersion('rustc'),
        target: target.rustTarget ?? `${process.platform}-${process.arch}`,
    };
    const preparedPlans = await Promise.all(plans.map(async (plan) => {
        const sourcePaths = collectCargoSourceInputs(
            metadata,
            path.join(projectRoot, plan.manifestPath),
        );
        for (const relativePath of [
            '.cargo/config',
            '.cargo/config.toml',
            'rust-toolchain.toml',
        ]) {
            const inputPath = path.join(projectRoot, relativePath);
            try {
                await access(inputPath);
                sourcePaths.push(inputPath);
            } catch {
                // Optional Cargo configuration files are absent in most worktrees.
            }
        }
        const cargoHome = cargoEnvironment.env.CARGO_HOME
            ? path.resolve(cargoEnvironment.env.CARGO_HOME)
            : path.join(os.homedir(), '.cargo');
        for (const cargoConfigName of [
            'config',
            'config.toml',
        ]) {
            const inputPath = path.join(cargoHome, cargoConfigName);
            try {
                await access(inputPath);
                sourcePaths.push(inputPath);
            } catch {
                // A user-level Cargo config is optional, but affects builds when present.
            }
        }
        const environment = getCargoFingerprintEnvironment(cargoEnvironment.env);
        const input = await computeCargoInputFingerprint({
            cargoArgs: plan.cargoArgs,
            environment,
            projectRoot,
            sourcePaths,
            toolchain,
        });
        const receiptPath = getReceiptPath(plan);
        const receipt = await readValidCargoBuildReceipt({
            binaryPath: plan.destinationPath,
            fingerprint: input.fingerprint,
            receiptPath,
        });
        return {
            ...plan,
            input,
            receipt,
            receiptPath,
        };
    }));
    const missingPlans = preparedPlans.filter(plan => !plan.receipt);
    for (const plan of preparedPlans.filter(candidate => candidate.receipt)) {
        console.log(`Reusing fingerprinted ${plan.binaryName} (${plan.input.fingerprint.slice(0, 12)}).`);
    }
    if (missingPlans.length === 0) {
        if (request.all) {
            await writeNativeBuildManifest(preparedPlans, target);
        }
        return;
    }

    console.log(
        `Building ${missingPlans.length} native tool(s) with shared metadata preparation; sccache ${cargoEnvironment.sccache}.`,
    );
    for (const plan of missingPlans) {
        const result = spawnSync('cargo', plan.cargoArgs, {
            cwd: projectRoot,
            env: {
                ...cargoEnvironment.env,
                EVB_NATIVE_BUILD_ID: computeNativeBuildId(projectRoot, plan.tool.crateName),
            },
            stdio: 'inherit',
        });
        if (result.status !== 0) {
            throw new Error(
                `cargo ${plan.cargoArgs.join(' ')} failed with status ${result.status ?? 'unknown'}`,
            );
        }
    }

    for (const plan of missingPlans) {
        const sourcePath = getCargoArtifactPath({
            fileName: plan.binaryName,
            rustTarget: plan.rustTarget,
            targetDirectory: cargoTargetDirectory,
        });
        const stageDir = path.dirname(plan.destinationPath);
        await rm(stageDir, {
            recursive: true,
            force: true,
        });
        await mkdir(stageDir, {recursive: true});
        const stagedArtifact = await copyCargoArtifactVerified(sourcePath, plan.destinationPath);
        if (plan.platform !== 'win32') {
            await chmod(plan.destinationPath, 0o755);
        }
        await writeCargoBuildReceipt({
            artifact: stagedArtifact,
            binaryPath: plan.destinationPath,
            fileCount: plan.input.fileCount,
            fingerprint: plan.input.fingerprint,
            receiptPath: plan.receiptPath,
            toolchain,
        });
        console.log(
            `Staged ${plan.binaryName} for ${plan.platformArch}: `
            + `${path.relative(projectRoot, plan.destinationPath)} (${stagedArtifact.sha256})`,
        );
    }
    if (request.all) {
        await writeNativeBuildManifest(preparedPlans, target);
    }
}

const isDirectRun = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
    await runNativeToolBuilder().catch((error) => {
        console.error(getCliErrorMessage(error));
        process.exitCode = 1;
    });
}
