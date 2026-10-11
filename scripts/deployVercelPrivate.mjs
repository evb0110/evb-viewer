import { getCliErrorMessage } from './lib/cli-error.mjs';
import {
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
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
import {once} from 'node:events';
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

// One lock per Vercel project for this OS user. It is not under TMPDIR: each
// agent session has its own task temp root, and a temp-dir lock would let two
// sessions deploy the same project at once, which breaks the rollback target.
export function getProductionDeployLockPath(projectId) {
    const projectFingerprint = createHash('sha256').update(projectId).digest('hex').slice(0, 24);
    return path.join(homedir(), '.cache', 'evb-viewer', 'deploy-locks', `evb-vercel-production-${projectFingerprint}.lock`);
}

// The lock is an advisory flock held by a small helper process for as long as
// the deploy runs. The operating system drops it when the helper exits, so a
// killed deploy never leaves a lock behind and no caller reclaims another's.
// The helper takes the lock, refuses a record written by another host (its
// liveness cannot be checked here), writes its own record, and waits for stdin
// to close. Closing stdin, or the death of the deploy process, ends it.
const PRODUCTION_DEPLOY_LOCK_HELPER = `
import fcntl, json, os, sys, time
lock_path, record, host, wait_ms, poll_s = sys.argv[1:6]
deadline = time.monotonic() + int(wait_ms) / 1000
lock = open(lock_path, 'a+')
while True:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        lock.seek(0)
        text = lock.read()
        try:
            owner = json.loads(text) if text.strip() else None
        except ValueError:
            owner = None
        if owner is None or owner.get('hostname') == host:
            break
        fcntl.flock(lock, fcntl.LOCK_UN)
    except BlockingIOError:
        pass
    if time.monotonic() >= deadline:
        sys.exit(3)
    time.sleep(float(poll_s))
os.ftruncate(lock.fileno(), 0)
lock.write(record)
lock.flush()
print('locked', flush=True)
sys.stdin.read()
os.ftruncate(lock.fileno(), 0)
`;

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

    const record = JSON.stringify({
        acquiredAt: Date.now(),
        hostname: hostname(),
        pid: process.pid,
    });
    const helper = spawn('python3', [
        '-I',
        '-c',
        PRODUCTION_DEPLOY_LOCK_HELPER,
        lockPath,
        record,
        hostname(),
        String(waitMs),
        String(PRODUCTION_DEPLOY_LOCK_POLL_MS / 1000),
    ], {stdio: [
        'pipe',
        'pipe',
        'pipe',
    ]});
    let stderr = '';
    helper.stderr.on('data', (chunk) => {
        stderr += chunk;
    });
    await new Promise((resolve, reject) => {
        helper.stdout.once('data', () => resolve());
        helper.once('error', reject);
        helper.once('exit', (code) => {
            if (code === 3) {
                reject(new Error(`Timed out waiting for the production deploy lock for ${waitMs}ms.`));
            } else {
                reject(new Error(`Production deploy lock helper exited with ${code}: ${stderr.trim()}`));
            }
        });
    });
    return async () => {
        helper.stdin.end();
        if (helper.exitCode === null && helper.signalCode === null) {
            await once(helper, 'exit');
        }
    };
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
                env: vercelEnv,
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
            env: vercelEnv,
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
                    env: vercelEnv,
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
