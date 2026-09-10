import { getCliErrorMessage } from './lib/cli-error.mjs';
import {
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {
    link as linkAsync,
    open as openFile,
    readFile as readFileAsync,
    unlink as unlinkAsync,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {
    fileURLToPath,
    pathToFileURL,
} from 'node:url';
import {
    assertCleanTrackedWebDeploySource,
    getTrackedWebDeploySourcePaths,
    isExcludedWebDeploySourceDirectoryName,
    isExcludedWebDeploySourceFileName,
} from './check-web-deploy-source.mjs';
import {
    isSentryDiagnosticsBuild,
    resolveSentryBuildIdentity,
} from '../packages/contracts/diagnostics/releaseIdentity.js';
import {assertSentryPrivateManifestParity} from './release/build-receipt.mjs';
import {
    getPrivateSourcemapManifestPath,
    stagePrivateSourcemaps,
} from './release/stage-private-sourcemaps.mjs';
import {
    assertSentryUploadReceipt,
    uploadSentrySourcemaps,
} from './release/upload-sentry-sourcemaps.mjs';
export {promoteLandingVercelOutput} from './promoteLandingVercelOutput.mjs';

const defaultProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supportedDeployTargets = new Set([
    'landing',
    'viewer',
]);
const landingBuildCommand = [
    'pnpm --dir landing run build',
    'node scripts/promoteLandingVercelOutput.mjs',
].join(' && ');
const PRODUCTION_DEPLOY_LOCK_WAIT_MS = 15 * 60_000;
const PRODUCTION_DEPLOY_LOCK_POLL_MS = 250;

// The copy filter and the `check-web-deploy-source.mjs` walker share one entry
// predicate, so what this deploy uploads is what that check measured: local-only
// artifacts (in any ASCII case, at any depth), env files that are not templates,
// and the deploy-specific build files are all excluded from both.
export function shouldCopyPrivateDeployPath(sourcePath, projectRoot, deployTarget = 'viewer') {
    const relativePath = path.relative(projectRoot, sourcePath);

    if (relativePath === '') {
        return true;
    }

    const segments = relativePath.split(/[\\/]+/u);

    if (segments.some(segment => (
        isExcludedWebDeploySourceDirectoryName(segment)
        && !(deployTarget === 'landing' && segment === 'landing')
    ))) {
        return false;
    }

    return !isExcludedWebDeploySourceFileName(path.basename(sourcePath));
}

function shouldKeepVercelIgnoreLine(line, sourceRoot) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith('#') || trimmedLine.startsWith('!')) {
        return true;
    }

    const normalizedLine = trimmedLine.replace(/^\/+/, '');
    const [firstSegment] = normalizedLine.split(/[\\/]+/u);

    return !firstSegment || existsSync(path.join(sourceRoot, firstSegment));
}

function sanitizeVercelIgnore(sourceRoot, deployTarget) {
    const vercelIgnorePath = path.join(sourceRoot, '.vercelignore');

    if (!existsSync(vercelIgnorePath)) {
        return;
    }

    const content = readFileSync(vercelIgnorePath, 'utf8');
    const lines = content.split(/\r?\n/u);
    const filteredLines = lines.filter((line) => {
        const normalizedLine = line.trim().replace(/^\/+|\/+$/gu, '');

        if (deployTarget === 'landing' && normalizedLine === 'landing') {
            return false;
        }

        return shouldKeepVercelIgnoreLine(line, sourceRoot);
    });

    writeFileSync(vercelIgnorePath, filteredLines.join('\n'), 'utf8');
}

function sanitizePnpmWorkspace(sourceRoot) {
    const workspacePath = path.join(sourceRoot, 'pnpm-workspace.yaml');

    if (!existsSync(workspacePath)) {
        return;
    }

    const content = readFileSync(workspacePath, 'utf8');
    const lines = content.split(/\r?\n/u);
    let isPackagesSection = false;
    const filteredLines = lines.filter((line) => {
        if (/^packages:\s*(?:#.*)?$/u.test(line)) {
            isPackagesSection = true;
            return true;
        }
        if (/^[^\s#][^:]*:/u.test(line)) {
            isPackagesSection = false;
        }
        if (!isPackagesSection) {
            return true;
        }

        const packageEntry = line.match(/^\s*-\s*['"]([^'"]+)['"]\s*$/u)?.[1];

        if (!packageEntry || /[*?[{]/u.test(packageEntry)) {
            return true;
        }

        return existsSync(path.join(sourceRoot, packageEntry));
    });

    writeFileSync(workspacePath, filteredLines.join('\n'), 'utf8');
}

function configureLandingBuild(sourceRoot) {
    const packageJsonPath = path.join(sourceRoot, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

    packageJson.scripts = {
        ...packageJson.scripts,
        build: landingBuildCommand,
    };
    writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
}

function copyTrackedDeploySource(projectRoot, sourceRoot, deployTarget) {
    for (const relativePath of getTrackedWebDeploySourcePaths(projectRoot)) {
        const sourcePath = path.join(projectRoot, relativePath);
        if (!shouldCopyPrivateDeployPath(sourcePath, projectRoot, deployTarget)) {
            continue;
        }

        const destinationPath = path.join(sourceRoot, relativePath);
        const sourceStat = lstatSync(sourcePath);
        if (sourceStat.isSymbolicLink()) {
            throw new Error(`Tracked web deploy source contains a symbolic link: ${relativePath}`);
        }
        if (!sourceStat.isFile()) {
            throw new Error(`Tracked web deploy source is not a regular file: ${relativePath}`);
        }
        mkdirSync(path.dirname(destinationPath), {recursive: true});
        cpSync(sourcePath, destinationPath, {force: true});
    }
}

export function preparePrivateDeploySource({
    deployTarget = 'viewer',
    prebuilt = false,
    projectRoot = defaultProjectRoot,
} = {}) {
    if (!supportedDeployTargets.has(deployTarget)) {
        throw new Error(`Unsupported deploy target: ${deployTarget}`);
    }
    if (prebuilt && deployTarget !== 'viewer') {
        throw new Error('Prebuilt deployment is supported only for the viewer target.');
    }

    const projectLinkRoot = deployTarget === 'landing'
        ? path.join(projectRoot, 'landing')
        : projectRoot;
    const projectJson = path.join(projectLinkRoot, '.vercel', 'project.json');

    if (!existsSync(projectJson)) {
        throw new Error(`Missing ${projectJson}. Run \`vercel link\` in this project first.`);
    }

    assertCleanTrackedWebDeploySource(projectRoot);

    const scratchRoot = mkdtempSync(path.join(tmpdir(), 'evb-vercel-private-'));
    const sourceRoot = path.join(scratchRoot, 'source');

    mkdirSync(sourceRoot, {recursive: true});
    copyTrackedDeploySource(projectRoot, sourceRoot, deployTarget);
    mkdirSync(path.join(sourceRoot, '.vercel'), {recursive: true});
    cpSync(projectJson, path.join(sourceRoot, '.vercel', 'project.json'));
    if (prebuilt) {
        const outputRoot = path.join(projectRoot, '.vercel', 'output');
        if (!existsSync(path.join(outputRoot, 'config.json'))) {
            throw new Error('Viewer prebuilt deployment requires .vercel/output/config.json.');
        }
        cpSync(outputRoot, path.join(sourceRoot, '.vercel', 'output'), {
            force: true,
            recursive: true,
            verbatimSymlinks: true,
        });
    }
    sanitizePnpmWorkspace(sourceRoot);
    sanitizeVercelIgnore(sourceRoot, deployTarget);
    if (deployTarget === 'landing') {
        configureLandingBuild(sourceRoot);
    }

    return {
        cleanup: () => rmSync(scratchRoot, {
            force: true,
            recursive: true,
        }),
        scratchRoot,
        sourceRoot,
    };
}

export function parsePrivateDeployOptions(rawArgs = []) {
    const targetArgs = rawArgs.filter(arg => arg.startsWith('--target='));

    if (targetArgs.length > 1) {
        throw new Error(`Expected at most one deploy target, received: ${targetArgs.join(', ')}`);
    }

    const deployTarget = targetArgs[0]?.slice('--target='.length) || 'viewer';
    const prebuiltArgs = rawArgs.filter(arg => arg === '--prebuilt');

    if (!supportedDeployTargets.has(deployTarget)) {
        throw new Error(`Unsupported deploy target: ${deployTarget}`);
    }
    if (prebuiltArgs.length > 1) {
        throw new Error('Expected at most one --prebuilt deploy option.');
    }
    if (prebuiltArgs.length === 1 && deployTarget !== 'viewer') {
        throw new Error('Prebuilt deployment is supported only for the viewer target.');
    }

    return {
        deployArgs: rawArgs.filter(arg => !arg.startsWith('--target=') && arg !== '--prebuilt'),
        deployTarget,
        prebuilt: prebuiltArgs.length === 1,
    };
}

export function buildPrivateDeployArgs(sourceRoot, rawArgs = [], {prebuilt = false} = {}) {
    const deployArgs = [...rawArgs];
    const hasArchive = deployArgs.some(arg => arg === '--archive' || arg.startsWith('--archive='));
    const hasYes = deployArgs.includes('--yes') || deployArgs.includes('-y');

    return [
        'deploy',
        sourceRoot,
        ...(hasYes ? [] : ['--yes']),
        ...(prebuilt || hasArchive ? [] : ['--archive=tgz']),
        ...(prebuilt ? ['--prebuilt'] : []),
        ...deployArgs,
    ];
}

function getViewerBuildEnvironment(env, isProduction) {
    return {
        ...env,
        EVB_SENTRY_DIAGNOSTICS_BUILD: '1',
        EVB_SENTRY_ENVIRONMENT: isProduction ? 'production' : 'preview',
        EVB_SENTRY_TARGET: 'web',
        VERCEL: '1',
        VERCEL_ENV: isProduction ? 'production' : 'preview',
    };
}

async function runViewerPrebuiltBuild({
    env,
    isProduction,
    projectRoot,
    stageSourcemaps,
    spawnSyncImpl,
}) {
    const buildEnvironment = getViewerBuildEnvironment(env, isProduction);
    const packageManagerCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    for (const step of [
        {
            args: [
                'run',
                'generate:build-artifacts',
            ],
            command: packageManagerCommand,
            label: 'artifact generation',
        },
        {
            args: [
                'exec',
                'nuxi',
                'build',
            ],
            command: packageManagerCommand,
            label: 'Nuxt build',
        },
    ]) {
        const result = spawnSyncImpl(step.command, step.args, {
            cwd: projectRoot,
            env: buildEnvironment,
            shell: false,
            stdio: 'inherit',
        });
        if (result.error) {
            throw result.error;
        }
        if ((result.status ?? 1) !== 0) {
            throw new Error(`Local prebuilt viewer ${step.label} exited with ${result.status ?? 1}.`);
        }
    }
    const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    const identity = resolveSentryBuildIdentity({
        target: 'web',
        version: packageJson.version,
        environment: buildEnvironment,
        platform: process.platform,
        architecture: process.arch,
    });
    await stageSourcemaps({
        identity,
        outputRoots: ['.vercel/output'],
        projectRoot,
        reset: true,
    });
    for (const script of [
        'scripts/prune-build-artifacts.mjs',
        'scripts/check-web-deploy-assets.mjs',
    ]) {
        const result = spawnSyncImpl(process.execPath, [script], {
            cwd: projectRoot,
            env: buildEnvironment,
            shell: false,
            stdio: 'inherit',
        });
        if (result.error) {
            throw result.error;
        }
        if ((result.status ?? 1) !== 0) {
            throw new Error(`Local prebuilt viewer finalizer ${script} exited with ${result.status ?? 1}.`);
        }
    }
    assertSentryPrivateManifestParity({
        identity,
        projectRoot,
    });
    return identity;
}

function getServedBundlePath(bundlePath) {
    const staticPrefix = '.vercel/output/static/';
    return bundlePath.startsWith(staticPrefix)
        ? `/${bundlePath.slice(staticPrefix.length)}`
        : null;
}

function isCrossOriginResponse(responseUrl, deploymentUrl) {
    if (typeof responseUrl !== 'string' || responseUrl.length === 0) {
        return false;
    }
    return new URL(responseUrl).origin !== new URL(deploymentUrl).origin;
}

function assertServedBundleBytes(bundle, bytes) {
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== bundle.bundleSha256) {
        throw new Error(`Served bundle does not match private manifest: ${bundle.servedPath}`);
    }
}

function readProtectedVercelBundles({
    bundles,
    deploymentUrl,
    projectRoot,
    spawnSyncImpl = spawnSync,
}) {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'evb-vercel-parity-'));
    try {
        const outputPaths = bundles.map((_, index) => path.join(temporaryRoot, `${index}.bundle`));
        const args = [
            'curl',
            bundles[0].servedPath,
            '--deployment',
            deploymentUrl,
            '--',
            '--silent',
            '--show-error',
            '--fail-with-body',
            '--output',
            outputPaths[0],
        ];
        for (let index = 1; index < bundles.length; index += 1) {
            args.push(
                '--url',
                new URL(bundles[index].servedPath, deploymentUrl).href,
                '--output',
                outputPaths[index],
            );
        }
        const result = spawnSyncImpl(
            process.platform === 'win32' ? 'vercel.cmd' : 'vercel',
            args,
            {
                cwd: projectRoot,
                encoding: 'utf8',
                maxBuffer: 16 * 1024 * 1024,
                shell: false,
                stdio: [
                    'ignore',
                    'ignore',
                    'pipe',
                ],
            },
        );
        if (result.error) {
            throw result.error;
        }
        if ((result.status ?? 1) !== 0) {
            throw new Error('Authenticated Vercel bundle fetch failed.');
        }
        return new Map(bundles.map((bundle, index) => [
            bundle.servedPath,
            readFileSync(outputPaths[index]),
        ]));
    } finally {
        rmSync(temporaryRoot, {
            force: true,
            recursive: true,
        });
    }
}

export async function assertServedSentryBundleParity({
    deploymentUrl,
    fetchImpl = globalThis.fetch,
    identity,
    projectRoot = defaultProjectRoot,
    protectedBundleReader = readProtectedVercelBundles,
} = {}) {
    if (typeof fetchImpl !== 'function') {
        throw new Error('Served bundle parity requires a fetch implementation.');
    }
    const manifestPath = getPrivateSourcemapManifestPath({
        identity,
        projectRoot,
    });
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const servedBundles = [
        ...manifest.bundles,
        ...(manifest.unmappedGeneratedBundles ?? []),
    ]
        .map(bundle => ({
            ...bundle,
            servedPath: getServedBundlePath(bundle.bundle),
        }))
        .filter(bundle => bundle.servedPath !== null);
    if (servedBundles.length === 0) {
        throw new Error('Private manifest has no served viewer bundles.');
    }
    for (const bundle of servedBundles) {
        const url = new URL(bundle.servedPath, deploymentUrl);
        const response = await fetchImpl(url, {
            redirect: 'follow',
            signal: AbortSignal.timeout(30_000),
        });
        if (isCrossOriginResponse(response.url, deploymentUrl)) {
            const protectedBundles = await protectedBundleReader({
                bundles: servedBundles,
                deploymentUrl,
                projectRoot,
            });
            for (const protectedBundle of servedBundles) {
                const bytes = protectedBundles.get(protectedBundle.servedPath);
                if (!bytes) {
                    throw new Error(`Authenticated Vercel fetch omitted ${protectedBundle.servedPath}.`);
                }
                assertServedBundleBytes(protectedBundle, bytes);
            }
            return true;
        }
        if (!response.ok) {
            throw new Error(`Served bundle ${bundle.servedPath} responded with HTTP ${response.status}.`);
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        assertServedBundleBytes(bundle, bytes);
    }
    return true;
}

export function extractVercelDeploymentUrl(output) {
    return output.match(/https:\/\/[a-z0-9][a-z0-9.-]*\.vercel\.app(?:\/[^\s"'<>]*)?/iu)?.[0] ?? null;
}

export function buildVercelRollbackArgs(previousDeployment) {
    if (!previousDeployment) {
        throw new Error('A previous deployment is required before a production rollback can run.');
    }
    return [
        'rollback',
        previousDeployment,
        '--yes',
    ];
}

const DEFAULT_PRODUCTION_ACCEPTANCE_URLS = Object.freeze({
    landing: 'https://evb-viewer.com/',
    viewer: 'https://web.evb-viewer.com/',
});

function parseHttpsAcceptanceUrls(rawValue) {
    return rawValue
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
        .map(value => {
            const url = new URL(value);
            if (url.protocol !== 'https:') {
                throw new Error(`Deploy acceptance URL must use HTTPS: ${value}`);
            }
            return url.href;
        });
}

export function resolveProductionAcceptanceUrls({
    deployTarget,
    env,
}) {
    const configuredUrl = env.EVB_DEPLOY_ACCEPTANCE_URL?.trim();
    if (configuredUrl) {
        const configuredUrls = parseHttpsAcceptanceUrls(configuredUrl);
        if (configuredUrls.length === 0) {
            throw new Error('EVB_DEPLOY_ACCEPTANCE_URL must contain at least one HTTPS URL.');
        }
        return configuredUrls;
    }
    const defaultUrl = DEFAULT_PRODUCTION_ACCEPTANCE_URLS[deployTarget];
    if (!defaultUrl) {
        throw new Error(`No production acceptance URL is configured for deploy target ${deployTarget}.`);
    }
    return [defaultUrl];
}

function resolveProductionAliasUrl(deployTarget) {
    const aliasUrl = DEFAULT_PRODUCTION_ACCEPTANCE_URLS[deployTarget];
    if (!aliasUrl) {
        throw new Error(`No production alias is configured for deploy target ${deployTarget}.`);
    }
    return aliasUrl;
}

export function extractVercelDeploymentIdentity(output, {
    expectedAliasUrl,
    expectedProjectName,
} = {}) {
    let parsed;
    try {
        parsed = JSON.parse(output);
    } catch (error) {
        throw new Error('Vercel inspect did not return valid JSON.', {cause: error});
    }
    const id = typeof parsed?.id === 'string' ? parsed.id.trim() : '';
    const url = typeof parsed?.url === 'string' ? parsed.url.trim() : '';
    if (expectedProjectName && parsed?.name !== expectedProjectName) {
        throw new Error('Vercel inspect returned a deployment from a different project.');
    }
    if (expectedAliasUrl) {
        const expectedAlias = new URL(expectedAliasUrl).hostname;
        const aliases = Array.isArray(parsed?.aliases) ? parsed.aliases : [];
        if (!aliases.includes(expectedAlias)) {
            throw new Error('Vercel inspect returned a deployment that does not own the production alias.');
        }
    }
    if (id) {
        return id;
    }
    if (url) {
        return /^https?:\/\//iu.test(url) ? url : `https://${url}`;
    }
    throw new Error('Vercel inspect did not identify the current production deployment.');
}

function inspectCurrentProductionDeployment({
    aliasUrl,
    command,
    env,
    expectedProjectName,
    sourceRoot,
    spawnSyncImpl,
}) {
    const useShell = process.platform === 'win32';
    const inspectArgs = [
        'inspect',
        aliasUrl,
        '--json',
    ];
    const inspectCommand = useShell ? quoteWindowsShellArg(command) : command;
    const inspectSpawnArgs = useShell ? inspectArgs.map(quoteWindowsShellArg) : inspectArgs;
    const result = spawnSyncImpl(inspectCommand, inspectSpawnArgs, {
        cwd: sourceRoot,
        encoding: 'utf8',
        env,
        shell: useShell,
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });
    if (result.error) {
        throw result.error;
    }
    if ((result.status ?? 1) !== 0) {
        throw new Error(`Vercel inspect exited with ${result.status ?? 1}; refusing a production deploy without a rollback target.`);
    }
    return extractVercelDeploymentIdentity(result.stdout ?? '', {
        expectedAliasUrl: aliasUrl,
        expectedProjectName,
    });
}

function readVercelProjectLink(sourceRoot) {
    const projectLinkPath = path.join(sourceRoot, '.vercel', 'project.json');
    let projectLink;
    try {
        projectLink = JSON.parse(readFileSync(projectLinkPath, 'utf8'));
    } catch (error) {
        throw new Error('Production deploy locking requires valid Vercel project linkage.', {cause: error});
    }
    const projectId = typeof projectLink?.projectId === 'string'
        ? projectLink.projectId.trim()
        : '';
    if (!projectId) {
        throw new Error('Production deploy locking requires a Vercel project ID.');
    }
    const projectName = typeof projectLink?.projectName === 'string'
        ? projectLink.projectName.trim()
        : '';
    if (!projectName) {
        throw new Error('Production deploy locking requires a Vercel project name.');
    }
    return {
        projectId,
        projectName,
    };
}

function getProductionDeployLockPath(projectId) {
    const projectFingerprint = createHash('sha256').update(projectId).digest('hex').slice(0, 24);
    return path.join(tmpdir(), `evb-vercel-production-${projectFingerprint}.lock`);
}

async function readProductionDeployLock(lockPath) {
    try {
        return JSON.parse(await readFileAsync(lockPath, 'utf8'));
    } catch {
        return null;
    }
}

async function acquireProductionDeployLock({
    env,
    projectId,
}) {
    const lockPath = getProductionDeployLockPath(projectId);
    const lockToken = randomUUID();
    const configuredWaitMs = Number(env.EVB_PRODUCTION_DEPLOY_LOCK_WAIT_MS);
    const waitMs = Number.isSafeInteger(configuredWaitMs) && configuredWaitMs >= 0
        ? configuredWaitMs
        : PRODUCTION_DEPLOY_LOCK_WAIT_MS;
    const deadline = Date.now() + waitMs;

    while (true) {
        const temporaryPath = `${lockPath}.${process.pid}.${lockToken}.tmp`;
        try {
            const handle = await openFile(temporaryPath, 'wx', 0o600);
            try {
                await handle.writeFile(JSON.stringify({
                    acquiredAt: Date.now(),
                    pid: process.pid,
                    token: lockToken,
                }));
            } finally {
                await handle.close();
            }
            await linkAsync(temporaryPath, lockPath);
            await unlinkAsync(temporaryPath).catch(() => undefined);
            return async () => {
                const currentOwner = await readProductionDeployLock(lockPath);
                if (currentOwner?.token === lockToken) {
                    await unlinkAsync(lockPath).catch(() => undefined);
                }
            };
        } catch (error) {
            await unlinkAsync(temporaryPath).catch(() => undefined);
            if (error?.code !== 'EEXIST') {
                throw error;
            }
        }

        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for the production deploy lock for ${waitMs}ms.`);
        }
        await new Promise(resolve => setTimeout(resolve, PRODUCTION_DEPLOY_LOCK_POLL_MS));
    }
}

async function runDeployAcceptanceChecks({
    acceptanceUrls,
    deploymentUrl,
    deployTarget,
    env,
    fetchImpl,
    sourceRoot,
    spawnSyncImpl,
}) {
    if (acceptanceUrls.length === 0) {
        throw new Error('Production deploy acceptance requires at least one public URL.');
    }
    if (typeof fetchImpl !== 'function') {
        throw new Error('Production deploy acceptance requires a fetch implementation.');
    }

    for (const url of acceptanceUrls) {
        const response = await fetchImpl(url, {
            headers: {accept: 'text/html,application/json'},
            redirect: 'follow',
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
            throw new Error(`Deploy acceptance URL ${url} responded with HTTP ${response.status}.`);
        }
    }

    const acceptanceCommand = env.EVB_DEPLOY_ACCEPTANCE_COMMAND?.trim();
    if (acceptanceCommand) {
        const result = spawnSyncImpl(acceptanceCommand, [], {
            cwd: sourceRoot,
            env: {
                ...env,
                EVB_DEPLOYMENT_URL: deploymentUrl,
                EVB_DEPLOY_TARGET: deployTarget,
            },
            shell: true,
            stdio: 'inherit',
        });
        if (result.error) {
            throw result.error;
        }
        if ((result.status ?? 1) !== 0) {
            throw new Error(`Deploy acceptance command exited with ${result.status ?? 1}.`);
        }
    }
}

export function quoteWindowsShellArg(arg) {
    // spawnSync with shell:true on Windows concatenates args into a cmd.exe
    // command line. Whitespace splits an unquoted arg, but so do cmd's own
    // metacharacters (& | < > ( ) ^): a scratch path under an account name like
    // "A&B" (C:\Users\A&B\AppData\Local\Temp\...) has no spaces yet the bare &
    // makes cmd run the tail as a separate command. Wrapping every argument in
    // double quotes makes all of those literal, and the target program's own
    // argv parser strips the outer quotes. The one residual cmd cannot escape is
    // % (env expansion runs even inside quotes); it is not reachable from the
    // paths and deploy flags built here.
    return `"${arg.replace(/"/g, '\\"')}"`;
}

export async function runPrivateVercelDeploy({
    command = process.env.VERCEL_CLI || 'vercel',
    projectRoot = defaultProjectRoot,
    rawArgs = process.argv.slice(2),
    env = process.env,
    fetchImpl = globalThis.fetch,
    spawnSyncImpl = spawnSync,
    stageSourcemaps = stagePrivateSourcemaps,
    uploadSourcemaps = uploadSentrySourcemaps,
} = {}) {
    const {
        deployArgs,
        deployTarget,
        prebuilt: explicitPrebuilt,
    } = parsePrivateDeployOptions(rawArgs);
    const diagnosticsEnabled = deployTarget === 'viewer' && isSentryDiagnosticsBuild(env);
    const prebuilt = explicitPrebuilt || diagnosticsEnabled;
    const isProduction = deployArgs.includes('--prod');
    const identity = diagnosticsEnabled
        ? await runViewerPrebuiltBuild({
            env,
            isProduction,
            projectRoot,
            stageSourcemaps,
            spawnSyncImpl,
        })
        : null;
    if (identity) {
        const uploadReceipt = await uploadSourcemaps({
            identity,
            projectRoot,
            environment: env,
        });
        assertSentryUploadReceipt(uploadReceipt, identity);
    }
    const prepared = preparePrivateDeploySource({
        deployTarget,
        prebuilt,
        projectRoot,
    });
    const commandArgs = buildPrivateDeployArgs(prepared.sourceRoot, deployArgs, {prebuilt});
    let releaseProductionDeployLock = async () => undefined;

    try {
        const projectLink = isProduction
            ? readVercelProjectLink(prepared.sourceRoot)
            : null;
        if (isProduction) {
            releaseProductionDeployLock = await acquireProductionDeployLock({
                env,
                projectId: projectLink.projectId,
            });
        }
        const acceptanceUrls = isProduction
            ? resolveProductionAcceptanceUrls({
                deployTarget,
                env,
            })
            : [];
        const previousProductionDeployment = isProduction
            ? inspectCurrentProductionDeployment({
                aliasUrl: resolveProductionAliasUrl(deployTarget),
                command,
                env,
                expectedProjectName: projectLink.projectName,
                sourceRoot: prepared.sourceRoot,
                spawnSyncImpl,
            })
            : null;
        const useShell = process.platform === 'win32';
        const spawnCommand = useShell ? quoteWindowsShellArg(command) : command;
        const spawnArgs = useShell ? commandArgs.map(quoteWindowsShellArg) : commandArgs;
        console.log(`> ${command} ${commandArgs.join(' ')}`);
        const result = spawnSyncImpl(spawnCommand, spawnArgs, {
            cwd: prepared.sourceRoot,
            env,
            encoding: 'utf8',
            shell: useShell,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
        });

        if (result.error) {
            throw result.error;
        }

        const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
        if (result.stdout) {
            process.stdout.write(result.stdout);
        }
        if (result.stderr) {
            process.stderr.write(result.stderr);
        }
        if ((result.status ?? 1) !== 0) {
            return result.status ?? 1;
        }
        const deploymentUrl = extractVercelDeploymentUrl(output);
        try {
            if (identity) {
                if (!deploymentUrl) {
                    throw new Error('Diagnostics-enabled Vercel deploy did not report a deployment URL.');
                }
                await assertServedSentryBundleParity({
                    deploymentUrl,
                    fetchImpl,
                    identity,
                    projectRoot,
                });
            }
            if (!isProduction) {
                return 0;
            }

            if (!deploymentUrl) {
                throw new Error('Production Vercel deploy did not report a deployment URL; refusing an unverified alias.');
            }

            await runDeployAcceptanceChecks({
                acceptanceUrls,
                deploymentUrl,
                deployTarget,
                env,
                fetchImpl,
                sourceRoot: prepared.sourceRoot,
                spawnSyncImpl,
            });
        } catch (error) {
            if (!isProduction) {
                throw error;
            }
            let rollbackError;
            try {
                const rollbackArgs = buildVercelRollbackArgs(previousProductionDeployment);
                const rollbackUseShell = process.platform === 'win32';
                const rollbackCommand = rollbackUseShell ? quoteWindowsShellArg(command) : command;
                const rollbackSpawnArgs = rollbackUseShell
                    ? rollbackArgs.map(quoteWindowsShellArg)
                    : rollbackArgs;
                const rollbackResult = spawnSyncImpl(rollbackCommand, rollbackSpawnArgs, {
                    cwd: prepared.sourceRoot,
                    env,
                    shell: rollbackUseShell,
                    stdio: 'inherit',
                });
                if (rollbackResult.error) {
                    throw rollbackResult.error;
                }
                if ((rollbackResult.status ?? 1) !== 0) {
                    throw new Error(`Vercel rollback exited with ${rollbackResult.status ?? 1}.`);
                }
            } catch (rollbackFailure) {
                rollbackError = rollbackFailure;
            }
            const acceptanceMessage = getCliErrorMessage(error);
            const rollbackMessage = rollbackError
                ? ` Rollback also failed: ${getCliErrorMessage(rollbackError)}`
                : ' The failed deployment was rolled back.';
            throw new Error(`Production deploy acceptance failed: ${acceptanceMessage}.${rollbackMessage}`, {cause: error});
        }

        return 0;
    } finally {
        await releaseProductionDeployLock();
        prepared.cleanup();
    }
}

const isMain = process.argv[1]
    && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
    process.exitCode = await runPrivateVercelDeploy();
}
