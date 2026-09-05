import {
    readdir,
    readFile,
    stat,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import {
    fileURLToPath,
    pathToFileURL,
} from 'node:url';
import {
    REQUIRED_WEB_DEPLOY_ASSETS,
    REQUIRED_WEB_OUTPUT_CONTRACTS,
    REQUIRED_WEB_WASM_ASSETS,
} from './web-deploy-asset-manifest.mjs';
import {scanPublicArtifactDirectory} from './check-build-artifacts-hygiene.mjs';

const defaultProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN_INITIAL_RENDERER_DEPENDENCIES = [
    'pdf-lib',
    'utif',
    'pako',
    '@sentry/',
];
const NODE_SERVER_BOOT_TIMINGS = Object.freeze({
    default: Object.freeze({
        healthDeadlineMs: 8_000,
        listeningDeadlineMs: 8_000,
        shutdownTimeoutMs: 2_000,
    }),
    win32: Object.freeze({
        healthDeadlineMs: 30_000,
        listeningDeadlineMs: 30_000,
        shutdownTimeoutMs: 5_000,
    }),
});
const NODE_SERVER_OUTPUT_LIMIT = 64 * 1024;
export {
    REQUIRED_WEB_DEPLOY_ASSETS,
    REQUIRED_WEB_OUTPUT_CONTRACTS,
    REQUIRED_WEB_WASM_ASSETS,
};

const WEB_OUTPUT_FORBIDDEN_PATTERNS = [
    /(?:^|\/)vendor\/(?:pdfjs-dist|pdf\.js|pdfjs-source)(?:\/|$)/u,
    /(?:^|\/)pdfjs-dist(?:-codex-preview)?(?:\/|$)/u,
    /\.(?:tgz|tar\.gz|patch|orig|rej|bak)$/iu,
    /(?:^|\/)(?:[^/]+\.(?:d\.ts|d\.mts)|pdf\.sandbox\.mjs|pdf\.min\.mjs|pdf\.mjs\.map|pdf_viewer\.mjs\.map|pdf\.worker\.mjs\.map)$/iu,
    /(?:^|\/)image_decoders(?:\/|$)/u,
];

export async function collectWebDeployOutputViolations(rootPath) {
    const violations = [];
    async function walk(directory, relativeDirectory = '') {
        for (const entry of await readdir(directory, {withFileTypes: true})) {
            const relativePath = path.posix.join(relativeDirectory, entry.name);
            const absolutePath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await walk(absolutePath, relativePath);
                continue;
            }
            if (entry.isFile() && WEB_OUTPUT_FORBIDDEN_PATTERNS.some(pattern => pattern.test(relativePath))) {
                violations.push(relativePath);
            }
        }
    }
    await walk(rootPath);
    return violations.sort();
}

function isVercelBuildOutputEnv(env = process.env) {
    return env.VERCEL === '1' || env.NOW_BUILDER === '1';
}

export function getExpectedWebDeployOutputRoots(env = process.env) {
    return isVercelBuildOutputEnv(env)
        ? ['.vercel/output/static']
        : ['nuxt-output/public'];
}

export function parseWebDeployAssetOptions(rawArgs = [], env = process.env) {
    const supportedArgs = new Set(['--vercel-output']);
    const unknownArgs = rawArgs.filter(arg => !supportedArgs.has(arg));

    if (unknownArgs.length > 0) {
        throw new Error(`Unsupported web deploy asset option: ${unknownArgs.join(', ')}`);
    }
    const vercelOutputArgs = rawArgs.filter(arg => arg === '--vercel-output');
    if (vercelOutputArgs.length > 1) {
        throw new Error('Expected at most one --vercel-output option.');
    }
    const vercelOutput = vercelOutputArgs.length === 1 || isVercelBuildOutputEnv(env);

    return {
        outputRoots: vercelOutput
            ? ['.vercel/output/static']
            : ['nuxt-output/public'],
        vercelOutput,
    };
}

export function getNodeServerBootTiming(platform = process.platform) {
    return platform === 'win32'
        ? NODE_SERVER_BOOT_TIMINGS.win32
        : NODE_SERVER_BOOT_TIMINGS.default;
}

async function assertDirectory(dirPath, label) {
    let dirStat;
    try {
        dirStat = await stat(dirPath);
    } catch (error) {
        throw new Error(`Missing ${label}: ${dirPath}`, {cause: error});
    }

    if (!dirStat.isDirectory()) {
        throw new Error(`${label} is not a directory: ${dirPath}`);
    }
}

async function assertFileAsset(rootPath, rootLabel, asset) {
    const assetPath = path.join(rootPath, asset.relativePath);
    let assetStat;
    try {
        assetStat = await stat(assetPath);
    } catch (error) {
        throw new Error(`Missing ${rootLabel} asset: ${asset.relativePath}`, {cause: error});
    }

    if (!assetStat.isFile() || assetStat.size <= 0) {
        throw new Error(`${rootLabel} asset is empty or not a file: ${asset.relativePath}`);
    }

    return {
        byteLength: assetStat.size,
        path: assetPath,
    };
}

async function assertWasmAsset(rootPath, rootLabel, asset) {
    const fileResult = await assertFileAsset(rootPath, rootLabel, asset);
    const wasmBytes = await readFile(fileResult.path);
    const wasmModule = new WebAssembly.Module(wasmBytes);
    const exportNames = new Set(WebAssembly.Module.exports(wasmModule).map(entry => entry.name));
    const missingExports = asset.requiredExports.filter(name => !exportNames.has(name));
    if (missingExports.length > 0) {
        throw new Error(
            `${rootLabel} asset ${asset.relativePath} is missing exports: ${missingExports.join(', ')}`,
        );
    }

    return {
        byteLength: wasmBytes.byteLength,
        path: fileResult.path,
    };
}

function readHtmlAttribute(tag, name) {
    const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'iu').exec(tag);
    return match?.[2] ?? null;
}

function collectModulePreloadPaths(html) {
    const paths = [];
    for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
        const tag = match[0];
        const rel = readHtmlAttribute(tag, 'rel');
        const href = readHtmlAttribute(tag, 'href');
        if (rel?.split(/\s+/u).includes('modulepreload') && href) {
            paths.push(href);
        }
    }
    return paths;
}

function collectStaticImportSpecifiers(source) {
    const specifiers = [];
    const pattern = /\b(?:import(?:[^"'();]*?\bfrom\s*)?|export[^"'();]*?\bfrom\s*)\s*["']([^"']+)["']/gu;
    for (const match of source.matchAll(pattern)) {
        specifiers.push(match[1]);
    }
    return specifiers;
}

function resolveLocalAssetPath(specifier, importerPath = '/') {
    if (
        !specifier.startsWith('/')
        && !specifier.startsWith('./')
        && !specifier.startsWith('../')
    ) {
        return null;
    }

    const baseUrl = new URL(importerPath, 'https://evb.local');
    const resolvedUrl = new URL(specifier, baseUrl);
    return resolvedUrl.origin === baseUrl.origin
        ? decodeURIComponent(resolvedUrl.pathname)
        : null;
}

export async function assertInitialRendererDependencyGraph(rootPath) {
    const htmlPath = path.join(rootPath, 'electron/index.html');
    const html = await readFile(htmlPath, 'utf8');
    const modulePreloads = collectModulePreloadPaths(html)
        .map(href => resolveLocalAssetPath(href))
        .filter(assetPath => assetPath !== null);
    const pending = [...modulePreloads];
    const visited = new Set();

    while (pending.length > 0) {
        const assetPath = pending.pop();
        if (!assetPath || visited.has(assetPath)) {
            continue;
        }
        visited.add(assetPath);

        const source = await readFile(path.join(rootPath, assetPath.slice(1)), 'utf8');
        const forbiddenDependency = FORBIDDEN_INITIAL_RENDERER_DEPENDENCIES.find(dependency => (
            dependency.endsWith('/')
                ? source.includes(dependency)
                : new RegExp(`\\b${dependency}\\b`, 'iu').test(source)
        ));
        if (forbiddenDependency) {
            throw new Error(
                `Initial renderer dependency graph contains ${forbiddenDependency}: ${assetPath}`,
            );
        }

        for (const specifier of collectStaticImportSpecifiers(source)) {
            const importedAssetPath = resolveLocalAssetPath(specifier, assetPath);
            if (importedAssetPath && !visited.has(importedAssetPath)) {
                pending.push(importedAssetPath);
            }
        }
    }

    return {
        modulePreloads,
        staticAssets: [...visited],
    };
}

async function validateAssetRoot(rootPath, rootLabel, {requireOutputContracts = false} = {}) {
    await assertDirectory(rootPath, rootLabel);

    const forbiddenOutput = requireOutputContracts
        ? await collectWebDeployOutputViolations(rootPath)
        : [];
    if (forbiddenOutput.length > 0) {
        throw new Error(`Web build output contains forbidden PDF.js artifacts: ${forbiddenOutput.join(', ')}`);
    }

    const assets = [];
    for (const asset of REQUIRED_WEB_DEPLOY_ASSETS) {
        assets.push('requiredExports' in asset
            ? await assertWasmAsset(rootPath, rootLabel, asset)
            : await assertFileAsset(rootPath, rootLabel, asset));
    }
    if (requireOutputContracts) {
        for (const relativePath of REQUIRED_WEB_OUTPUT_CONTRACTS) {
            assets.push(await assertFileAsset(rootPath, rootLabel, {relativePath}));
        }
        await assertInitialRendererDependencyGraph(rootPath);
    }
    return assets;
}

export async function validateWebDeployAssets({
    env = process.env,
    outputRoots = getExpectedWebDeployOutputRoots(env),
    projectRoot = defaultProjectRoot,
    sourceRoot = 'public',
} = {}) {
    const sourceRootPath = path.join(projectRoot, sourceRoot);
    const sourceAssets = await validateAssetRoot(sourceRootPath, 'source public');

    const outputResults = [];
    for (const outputRoot of outputRoots) {
        const outputRootPath = path.join(projectRoot, outputRoot);
        const assets = await validateAssetRoot(
            outputRootPath,
            `web build output ${outputRoot}`,
            {requireOutputContracts: true},
        );
        const artifactViolations = await scanPublicArtifactDirectory({
            rootPath: outputRootPath,
            target: outputRoot === '.vercel/output/static'
                ? 'web-static'
                : 'desktop-renderer',
        });
        if (artifactViolations.length > 0) {
            throw new Error(
                `Web build output ${outputRoot} contains forbidden public artifacts:\n`
                + artifactViolations.slice(0, 20).join('\n'),
            );
        }
        outputResults.push({
            assets,
            root: outputRoot,
        });
    }

    return {
        outputResults,
        sourceAssets,
    };
}

export async function validateVercelFunctionBoot({projectRoot = defaultProjectRoot} = {}) {
    const entryPath = path.join(
        projectRoot,
        '.vercel/output/functions/__fallback.func/index.mjs',
    );
    await assertFileAsset(
        path.dirname(entryPath),
        'Vercel server function',
        {relativePath: path.basename(entryPath)},
    );

    try {
        await import(`${pathToFileURL(entryPath).href}?boot-check=${Date.now()}`);
    } catch (error) {
        throw new Error('Vercel server function failed to load', {cause: error});
    }
}

async function reserveLoopbackPort() {
    return new Promise((resolve, reject) => {
        const reservation = createServer();
        reservation.once('error', reject);
        reservation.listen(0, '127.0.0.1', () => {
            const address = reservation.address();
            if (!address || typeof address === 'string') {
                reservation.close();
                reject(new Error('Unable to reserve a loopback port for the Nuxt boot check.'));
                return;
            }
            reservation.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(address.port);
            });
        });
    });
}

async function waitForListeningMarker({
    deadline,
    getProcessFailure,
    isListeningObserved,
}) {
    while (Date.now() < deadline) {
        const processFailure = getProcessFailure();
        if (processFailure) {
            throw processFailure;
        }
        if (isListeningObserved()) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Nuxt server did not report its listening address before the deadline.');
}

async function pollHealthEndpoint({
    deadline,
    healthUrl,
}) {
    let lastError;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(healthUrl, {signal: AbortSignal.timeout(1_000)});
            await response.arrayBuffer();
            if (!response.ok) {
                throw new Error(
                    `Nuxt server health request returned HTTP ${String(response.status)}.`,
                );
            }
            return;
        } catch (error) {
            lastError = error;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }
    throw lastError ?? new Error('Nuxt server did not answer its loopback health request.');
}

async function shutdownChild(child, childClosed, timeoutMs) {
    if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
    }
    let shutdownTimer;
    const shutdownTimeout = new Promise(resolve => {
        shutdownTimer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([
        childClosed,
        shutdownTimeout,
    ]);
    clearTimeout(shutdownTimer);
    if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await childClosed;
    }
}

function startNodeServer(entryPath, port, listeningPattern) {
    const state = {
        exit: undefined,
        listeningObserved: false,
        spawnError: undefined,
        stderrOutput: '',
        stderrTruncated: false,
        stdoutOutput: '',
        stdoutTruncated: false,
    };
    const child = spawn(process.execPath, [entryPath], {
        env: {
            ...process.env,
            HOST: '127.0.0.1',
            NITRO_HOST: '127.0.0.1',
            NITRO_PORT: String(port),
            PORT: String(port),
        },
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
        windowsHide: true,
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => {
        const updatedOutput = `${state.stdoutOutput}${chunk}`;
        state.listeningObserved ||= listeningPattern.test(updatedOutput);
        state.stdoutTruncated ||= updatedOutput.length > NODE_SERVER_OUTPUT_LIMIT;
        state.stdoutOutput = updatedOutput.slice(-NODE_SERVER_OUTPUT_LIMIT);
    });
    child.stderr?.on('data', chunk => {
        const updatedOutput = `${state.stderrOutput}${chunk}`;
        state.stderrTruncated ||= updatedOutput.length > NODE_SERVER_OUTPUT_LIMIT;
        state.stderrOutput = updatedOutput.slice(-NODE_SERVER_OUTPUT_LIMIT);
    });
    const childClosed = new Promise(resolve => {
        child.once('error', error => {
            state.spawnError = error;
        });
        child.once('exit', (code, signal) => {
            state.exit = {
                code,
                signal,
            };
        });
        child.once('close', (code, signal) => {
            state.exit ??= {
                code,
                signal,
            };
            resolve(state.exit);
        });
    });
    return {
        child,
        childClosed,
        state,
    };
}

function formatNodeServerFailure(error, state) {
    const childOutput = [
        [
            'stderr',
            state.stderrOutput,
            state.stderrTruncated,
        ],
        [
            'stdout',
            state.stdoutOutput,
            state.stdoutTruncated,
        ],
    ]
        .filter(([
            , output,
        ]) => output.trim().length > 0)
        .map(([
            streamName,
            output,
            truncated,
        ]) => [
            truncated ? `[${streamName} output truncated to the last 64 KiB]` : '',
            output.trim(),
        ].filter(Boolean).join('\n'))
        .join('\n');
    const details = error instanceof Error ? error.message : String(error);
    return new Error(
        `Nuxt node server failed to boot: ${details}${childOutput ? `\n${childOutput}` : ''}`,
        {cause: error},
    );
}

async function runNodeServerBootProbe(entryPath, port) {
    const healthUrl = `http://127.0.0.1:${String(port)}/`;
    const listeningPattern = new RegExp(
        `Listening\\s+on\\s+https?://(?:127\\.0\\.0\\.1|localhost):${String(port)}(?:/|\\s|$)`,
        'iu',
    );
    const timing = getNodeServerBootTiming();
    const {
        child,
        childClosed,
        state,
    } = startNodeServer(entryPath, port, listeningPattern);

    let bootError;
    try {
        await waitForListeningMarker({
            deadline: Date.now() + timing.listeningDeadlineMs,
            getProcessFailure: () => {
                if (state.spawnError) {
                    return state.spawnError;
                }
                return state.exit
                    ? new Error(
                        'Nuxt server exited before reporting its listening address '
                        + `(code ${String(state.exit.code)}, `
                        + `signal ${String(state.exit.signal)}).`,
                    )
                    : undefined;
            },
            isListeningObserved: () => state.listeningObserved,
        });
        await pollHealthEndpoint({
            deadline: Date.now() + timing.healthDeadlineMs,
            healthUrl,
        });
    } catch (error) {
        bootError = error;
    } finally {
        await shutdownChild(child, childClosed, timing.shutdownTimeoutMs);
    }
    if (bootError) {
        throw formatNodeServerFailure(bootError, state);
    }
}

export async function validateNodeServerBoot({
    port: requestedPort,
    projectRoot = defaultProjectRoot,
} = {}) {
    if (
        requestedPort !== undefined
        && (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65_535)
    ) {
        throw new Error('The Nuxt boot check port must be an integer from 1 through 65535.');
    }
    const entryPath = path.join(projectRoot, 'nuxt-output/server/index.mjs');
    await assertFileAsset(
        path.dirname(entryPath),
        'Nuxt node server',
        {relativePath: path.basename(entryPath)},
    );

    const port = requestedPort ?? await reserveLoopbackPort();
    await runNodeServerBootProbe(entryPath, port);
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    try {
        const options = parseWebDeployAssetOptions(process.argv.slice(2));
        const result = await validateWebDeployAssets({outputRoots: options.outputRoots});
        if (options.vercelOutput) {
            await validateVercelFunctionBoot();
        } else {
            await validateNodeServerBoot();
        }
        const outputRoots = result.outputResults.map(entry => entry.root).join(', ');
        console.log(`Web deploy asset check passed for ${outputRoots}.`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
