import { getCliErrorMessage } from './lib/cli-error.mjs';
import {
    closeSync,
    constants,
    cpSync,
    existsSync,
    ftruncateSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
    writeSync,
} from 'node:fs';
import {
    homedir,
    hostname,
    tmpdir,
} from 'node:os';
import path from 'node:path';
import {
    execFileSync,
    spawn,
    spawnSync,
} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
    fileURLToPath,
    pathToFileURL,
} from 'node:url';
import {
    assertCleanTrackedWebDeploySource,
    getTrackedWebDeploySourcePaths,
    getWebDeployVendorDependencies,
    isExcludedWebDeploySourceDirectoryName,
    isExcludedWebDeploySourceFileName,
    isRootVendorPath,
} from './check-web-deploy-source.mjs';
import { assertWasmArtifactsCurrent } from './ensure-wasm-artifacts.mjs';
import { WASM_ARTIFACTS } from './wasm-artifacts.mjs';
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
export function shouldCopyPrivateDeployPath(sourcePath, projectRoot, deployTarget = 'viewer', vendorDependencies = getWebDeployVendorDependencies(projectRoot)) {
    const relativePath = path.relative(projectRoot, sourcePath).replaceAll(path.sep, '/');

    if (relativePath === '' || vendorDependencies.has(relativePath)) {
        return true;
    }

    const segments = relativePath.split(/[\\/]+/u);

    if (isRootVendorPath(relativePath) || segments.some(segment => (
        isExcludedWebDeploySourceDirectoryName(segment)
        && !(deployTarget === 'landing' && segment === 'landing')
    ))) {
        return false;
    }

    return !isExcludedWebDeploySourceFileName(path.basename(sourcePath));
}

// The Vercel CLI reads Git metadata by walking up from the copy. TMPDIR may sit
// inside a checkout (agent sessions use its .devkit), so stop git discovery at
// the scratch root; otherwise the deployment carries the checkout's commit author.
function withScratchGitCeiling(env, scratchRoot) {
    const ceilings = [
        realpathSync(scratchRoot),
        env.GIT_CEILING_DIRECTORIES,
    ]
        .filter(Boolean);
    return {
        ...env,
        GIT_CEILING_DIRECTORIES: ceilings.join(path.delimiter),
    };
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

    for (const dependency of getWebDeployVendorDependencies(sourceRoot)) {
        const segments = dependency.split('/');
        for (let length = 1; length < segments.length; length += 1) {
            filteredLines.push(`!${segments.slice(0, length).join('/')}/`);
        }
        filteredLines.push(`!${dependency}`);
    }
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

function configureDeployManifest(sourceRoot, deployTarget) {
    const packageJsonPath = path.join(sourceRoot, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

    // The root prepare hook stages desktop runtime binaries into resources/,
    // which neither deploy uploads. The viewer build generates its own artifacts.
    delete packageJson.scripts.prepare;
    if (deployTarget === 'landing') {
        packageJson.scripts.build = landingBuildCommand;
        // The landing workspace owns its Nuxt postinstall; the root one prepares the desktop app.
        delete packageJson.scripts.postinstall;
    }
    writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
}

// public/wasm is built locally, not tracked, and the remote build has no Rust
// toolchain, so a viewer upload carries the files `pnpm run build` produced.
// assertWasmArtifactsCurrent has already checked them against the native sources.
function copyBrowserWasm(projectRoot, sourceRoot) {
    for (const artifact of WASM_ARTIFACTS) {
        mkdirSync(path.dirname(path.join(sourceRoot, artifact.publicRelativePath)), {recursive: true});
        cpSync(path.join(projectRoot, artifact.publicRelativePath), path.join(sourceRoot, artifact.publicRelativePath));
    }
}

function copyTrackedDeploySource(projectRoot, sourceRoot, deployTarget) {
    const vendorDependencies = getWebDeployVendorDependencies(projectRoot);
    for (const relativePath of getTrackedWebDeploySourcePaths(projectRoot)) {
        const sourcePath = path.join(projectRoot, relativePath);
        if (!shouldCopyPrivateDeployPath(sourcePath, projectRoot, deployTarget, vendorDependencies)) {
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
    if (deployTarget === 'viewer') {
        assertWasmArtifactsCurrent(projectRoot);
    }

    const scratchRoot = mkdtempSync(path.join(tmpdir(), 'evb-vercel-private-'));
    const sourceRoot = path.join(scratchRoot, 'source');

    mkdirSync(sourceRoot, {recursive: true});
    copyTrackedDeploySource(projectRoot, sourceRoot, deployTarget);
    if (deployTarget === 'viewer' && !prebuilt) {
        copyBrowserWasm(projectRoot, sourceRoot);
    }
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
    configureDeployManifest(sourceRoot, deployTarget);

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

export function buildPrivateDeployArgs(sourceRoot, rawArgs = [], {
    appVersion,
    prebuilt = false,
} = {}) {
    const deployArgs = [...rawArgs];
    const hasArchive = deployArgs.some(arg => arg === '--archive' || arg.startsWith('--archive='));
    const hasYes = deployArgs.includes('--yes') || deployArgs.includes('-y');

    return [
        'deploy',
        sourceRoot,
        ...(hasYes ? [] : ['--yes']),
        ...(prebuilt || hasArchive ? [] : ['--archive=tgz']),
        ...(prebuilt ? ['--prebuilt'] : []),
        ...(appVersion && !prebuilt ? [
            '--build-env',
            `EVB_APP_VERSION=${appVersion}`,
        ] : []),
        ...(deployArgs.includes('--prod') && !deployArgs.includes('--skip-domain') ? ['--skip-domain'] : []),
        ...deployArgs,
    ];
}

// The viewer deploys from main between releases, and only release builds stamp
// package.json, so the deployed commit names its own version: the newest
// release tag, plus the commit when the deploy is past that tag. The About page
// and the Sentry release read it (EVB_APP_VERSION in nuxt.config.ts).
export function resolveViewerAppVersion(projectRoot) {
    let description;
    try {
        description = execFileSync('git', [
            'describe',
            '--tags',
            '--match',
            'v[0-9]*',
            // Releases are vMAJOR.MINOR.PATCH (release.yml); skip any other v* tag.
            '--exclude',
            'v*-*',
            '--long',
            '--abbrev=12',
            'HEAD',
        ], {
            cwd: projectRoot,
            encoding: 'utf8',
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
        }).trim();
    } catch (error) {
        throw new Error('Cannot name the viewer version: no release tag reaches HEAD. Fetch tags and retry.', {cause: error});
    }
    const parts = description.match(/^v(?<version>\d+\.\d+\.\d+)-(?<commitsSinceTag>\d+)-g(?<commit>[0-9a-f]+)$/u)?.groups;
    if (!parts) {
        throw new Error(`Cannot name the viewer version from release tag description ${description}.`);
    }
    return parts.commitsSinceTag === '0' ? parts.version : `${parts.version}+${parts.commit}`;
}

function getViewerBuildEnvironment(env, isProduction, appVersion) {
    return {
        ...env,
        EVB_APP_VERSION: appVersion,
        VERCEL: '1',
        VERCEL_ENV: isProduction ? 'production' : 'preview',
    };
}

function runViewerPrebuiltBuild({
    appVersion,
    env,
    isProduction,
    projectRoot,
    spawnSyncImpl,
}) {
    // Windows command shims require cmd.exe. Pass one fixed command string
    // so shell argument concatenation cannot reinterpret dynamic values.
    const result = spawnSyncImpl(process.platform === 'win32' ? 'cmd.exe' : 'pnpm', process.platform === 'win32' ? [
        '/d',
        '/s',
        '/c',
        'pnpm.cmd run build',
    ] : [
        'run',
        'build',
    ], {
        cwd: projectRoot,
        env: getViewerBuildEnvironment(env, isProduction, appVersion),
        shell: false,
        stdio: 'inherit',
    });
    if (result.error) {
        throw result.error;
    }
    if ((result.status ?? 1) !== 0) {
        throw new Error(`Local prebuilt viewer build exited with ${result.status ?? 1}.`);
    }
}

export function extractVercelDeploymentUrl(output) {
    return output.match(/https:\/\/[a-z0-9][a-z0-9.-]*\.vercel\.app(?:\/[^\s"'<>]*)?/iu)?.[0] ?? null;
}

export function buildVercelRollbackArgs(previousDeployment) {
    if (!previousDeployment) {
        throw new Error('A previous deployment is required before a production rollback can run.');
    }
    return [
        'promote',
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

// The deployment an alias serves, as `vercel inspect` reports it.
function parseVercelDeployment(output, {
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
    if (!id && !url) {
        throw new Error('Vercel inspect did not identify the current production deployment.');
    }
    return {
        id,
        url,
    };
}

function deploymentIdentity({
    id,
    url,
}) {
    if (id) {
        return id;
    }
    return /^https?:\/\//iu.test(url) ? url : `https://${url}`;
}

export function extractVercelDeploymentIdentity(output, options) {
    return deploymentIdentity(parseVercelDeployment(output, options));
}

function inspectDeployment({
    url, expectedAliasUrl, expectedProjectName, runCommand,
}) {
    const result = runCommand([
        'inspect',
        url,
        '--json',
    ]);
    if ((result.status ?? 1) !== 0) {
        throw new Error(`Vercel inspect exited with ${result.status ?? 1}; refusing a production deploy without a rollback target.`);
    }
    const deployment = parseVercelDeployment(result.stdout ?? '', {
        expectedAliasUrl,
        expectedProjectName,
    });
    if (!deployment.id) {
        throw new Error('Vercel inspect did not return an immutable deployment id.');
    }
    return deployment;
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

// One lock per Vercel project for this OS user. It is not under TMPDIR: each
// agent session has its own task temp root, and a temp-dir lock would let two
// sessions deploy the same project at once, which breaks the rollback target.
export function getProductionDeployLockPath(projectId) {
    const projectFingerprint = createHash('sha256').update(projectId).digest('hex').slice(0, 24);
    return path.join(homedir(), '.cache', 'evb-viewer', 'deploy-locks', `evb-vercel-production-${projectFingerprint}.lock`);
}

// A short-lived helper takes flock on the parent's open description. The parent
// and every Vercel child retain descriptors, so SIGKILL cannot admit a follower
// while a surviving CLI still mutates production. Format-2 cutover makes flock
// authoritative; older records at this path no longer decide ownership.
const PRODUCTION_DEPLOY_LOCK_HELPER = `
import fcntl, sys, time
wait_ms, poll_s = sys.argv[1:3]
deadline = time.monotonic() + int(wait_ms) / 1000
while True:
    try:
        fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print('locked', flush=True)
        sys.exit(0)
    except BlockingIOError:
        if time.monotonic() >= deadline:
            sys.exit(3)
        time.sleep(float(poll_s))
`;

// Runs the helper against the lock descriptor this process holds (inherited as fd 3).
// It resolves once the helper has the flock, and the descriptor keeps the lock.
function takeProductionDeployLock(fd, {waitMs}) {
    return new Promise((resolve, reject) => {
        const helper = spawn('python3', [
            '-I',
            '-c',
            PRODUCTION_DEPLOY_LOCK_HELPER,
            String(waitMs),
            String(PRODUCTION_DEPLOY_LOCK_POLL_MS / 1000),
        ], {stdio: [
            'ignore',
            'pipe',
            'pipe',
            fd,
        ]});
        let locked = false;
        let stderr = '';
        helper.stdout.on('data', () => {
            locked = true;
        });
        helper.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        helper.once('error', reject);
        helper.once('close', (code) => {
            if (locked && code === 0) {
                resolve();
            } else if (code === 3) {
                reject(new Error(`Timed out waiting for the production deploy lock for ${waitMs}ms.`));
            } else {
                reject(new Error(`Production deploy lock helper exited with ${code}: ${stderr.trim()}`));
            }
        });
    });
}

export async function acquireProductionDeployLock({
    env,
    projectId,
}) {
    const lockPath = getProductionDeployLockPath(projectId);
    const configuredWaitMs = Number(env.EVB_PRODUCTION_DEPLOY_LOCK_WAIT_MS);
    const waitMs = Number.isSafeInteger(configuredWaitMs) && configuredWaitMs >= 0
        ? configuredWaitMs
        : PRODUCTION_DEPLOY_LOCK_WAIT_MS;
    mkdirSync(path.dirname(lockPath), {recursive: true});

    // The lock file is never removed while in use: a replaced file would be a
    // second lock on a new inode.
    const fd = openSync(lockPath, constants.O_RDWR | constants.O_CREAT, 0o600);
    try {
        await takeProductionDeployLock(fd, {waitMs});
        const record = readFileSync(lockPath, 'utf8').trim();
        let format;
        try { format = JSON.parse(record)?.format; } catch { /* An incomplete record has no authority. */ }
        if (record && format !== 2) {
            console.warn(`Ignoring a pre-format-2 production lock record at ${lockPath}: the flock is free.`);
        }
        ftruncateSync(fd, 0);
        writeSync(fd, JSON.stringify({
            acquiredAt: Date.now(),
            format: 2,
            hostname: hostname(),
            pid: process.pid,
        }), 0);
    } catch (error) {
        closeSync(fd);
        throw error;
    }
    let released = false;
    return Object.assign(async () => {
        if (released) {
            return;
        }
        released = true;
        // Clear the record while the lock is still held, then let the descriptor
        // close: the close is what releases the flock.
        ftruncateSync(fd, 0);
        closeSync(fd);
    }, {fd});
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
        const acceptanceUrl = new URL(url);
        acceptanceUrl.host = new URL(deploymentUrl).host;
        const response = await fetchImpl(acceptanceUrl.href, {
            headers: {accept: 'text/html,application/json'},
            redirect: 'error',
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
            throw new Error(`Deploy acceptance URL ${acceptanceUrl.href} responded with HTTP ${response.status}.`);
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

// Rolls production back to the predecessor only while the alias still serves the
// deployment this run promoted. Another deploy that promoted since would be
// overwritten by the rollback, so the alias is left as it is and the outcome says
// which deployment holds it.
function rollBackPromotedDeployment({
    aliasUrl, expectedProjectName, previous, promoted, runCommand,
}) {
    let production;
    try {
        production = inspectDeployment({
            url: aliasUrl,
            expectedAliasUrl: aliasUrl,
            expectedProjectName,
            runCommand,
        });
    } catch (error) {
        return `Rollback skipped: the production alias could not be read (${getCliErrorMessage(error)}), so no alias was changed.`;
    }
    if (production.id !== promoted.id) {
        return `Rollback skipped: ${aliasUrl} is served by ${production.id}, not by the deployment this run promoted (${promoted.id}), so no alias was changed.`;
    }
    // Vercel has no conditional promote: another host can win between this
    // authority read and the promote being applied remotely.
    try {
        const result = runCommand(buildVercelRollbackArgs(previous.id));
        if ((result.status ?? 1) !== 0) throw new Error(`Vercel promote exited with ${result.status ?? 1}.`);
    } catch (error) {
        return `Rollback also failed: ${getCliErrorMessage(error)}`;
    }
    return 'The failed deployment was rolled back.';
}

export async function runPrivateVercelDeploy({
    command = process.env.VERCEL_CLI || 'vercel',
    projectRoot = defaultProjectRoot,
    rawArgs = process.argv.slice(2),
    env = process.env,
    fetchImpl = globalThis.fetch,
    spawnSyncImpl = spawnSync,
} = {}) {
    const {
        deployArgs,
        deployTarget,
        prebuilt: explicitPrebuilt,
    } = parsePrivateDeployOptions(rawArgs);
    // A viewer deploy that reports to Sentry builds locally so its source maps
    // can be uploaded and removed before the prebuilt output is deployed.
    const reportsToSentry = deployTarget === 'viewer' && Boolean(env.SENTRY_BROWSER_DSN?.trim());
    if (reportsToSentry && !env.SENTRY_AUTH_TOKEN) {
        throw new Error('Refusing a viewer deploy with SENTRY_BROWSER_DSN but no SENTRY_AUTH_TOKEN: its stacks could not be symbolicated.');
    }
    const prebuilt = explicitPrebuilt || reportsToSentry;
    const isProduction = deployArgs.includes('--prod');
    const appVersion = deployTarget === 'viewer' ? resolveViewerAppVersion(projectRoot) : undefined;
    if (reportsToSentry) {
        runViewerPrebuiltBuild({
            appVersion,
            env,
            isProduction,
            projectRoot,
            spawnSyncImpl,
        });
    }
    const prepared = preparePrivateDeploySource({
        deployTarget,
        prebuilt,
        projectRoot,
    });
    const commandArgs = buildPrivateDeployArgs(prepared.sourceRoot, deployArgs, {
        appVersion,
        prebuilt,
    });
    const vercelEnv = withScratchGitCeiling(env, prepared.scratchRoot);
    let lock;

    try {
        const projectLink = isProduction
            ? readVercelProjectLink(prepared.sourceRoot)
            : null;
        if (isProduction) {
            lock = await acquireProductionDeployLock({
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
        const productionAliasUrl = isProduction ? resolveProductionAliasUrl(deployTarget) : null;
        // Every CLI invocation inherits the lock description as fd 3.
        const runCommand = (args) => {
            const useShell = process.platform === 'win32';
            const result = spawnSyncImpl(useShell ? quoteWindowsShellArg(command) : command,
                useShell ? args.map(quoteWindowsShellArg) : args, {
                    cwd: prepared.sourceRoot,
                    env: vercelEnv,
                    encoding: 'utf8',
                    shell: useShell,
                    stdio: [
                        'ignore',
                        'pipe',
                        'pipe',
                        ...(lock ? [lock.fd] : []),
                    ],
                });
            if (result.error) throw result.error;
            return result;
        };
        const inspectProduction = () => inspectDeployment({
            url: productionAliasUrl,
            expectedAliasUrl: productionAliasUrl,
            expectedProjectName: projectLink.projectName,
            runCommand,
        });
        const previousProductionDeployment = isProduction ? inspectProduction() : null;
        console.log(`> ${command} ${commandArgs.join(' ')}`);
        const result = runCommand(commandArgs);

        if (result.stdout) {
            process.stdout.write(result.stdout);
        }
        if (result.stderr) {
            process.stderr.write(result.stderr);
        }
        if ((result.status ?? 1) !== 0) {
            return result.status ?? 1;
        }
        if (!isProduction) return 0;
        // stdout is the CLI's deployment result, not a log line naming an alias.
        const deploymentUrl = extractVercelDeploymentUrl(result.stdout ?? '');
        if (!deploymentUrl) {
            throw new Error('Production Vercel deploy did not report a deployment URL; refusing to promote.');
        }
        const deployment = inspectDeployment({
            url: deploymentUrl,
            expectedProjectName: projectLink.projectName,
            runCommand,
        });
        const production = inspectProduction();
        if (production.id !== previousProductionDeployment.id) {
            throw new Error(`Production promotion stopped: another publisher won; ${productionAliasUrl} is served by ${production.id}.`);
        }
        // The only remaining cross-host race is the authority-read-to-promote
        // window; Vercel does not support a conditional promote.
        try {
            const promotion = runCommand([
                'promote',
                deployment.id,
                '--yes',
            ]);
            if ((promotion.status ?? 1) !== 0) throw new Error(`Vercel promote exited with ${promotion.status ?? 1}.`);
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
            const outcome = rollBackPromotedDeployment({
                aliasUrl: productionAliasUrl,
                expectedProjectName: projectLink.projectName,
                previous: previousProductionDeployment,
                promoted: deployment,
                runCommand,
            });
            throw new Error(`Production deploy acceptance failed: ${getCliErrorMessage(error)}. ${outcome}`, {cause: error});
        }

        return 0;
    } finally {
        await lock?.();
        prepared.cleanup();
    }
}

const isMain = process.argv[1]
    && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
    process.exitCode = await runPrivateVercelDeploy();
}
