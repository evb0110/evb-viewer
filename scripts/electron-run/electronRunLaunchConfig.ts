import { execFileSync } from 'node:child_process';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import {
    basename,
    dirname,
    join,
} from 'node:path';
import { projectRoot } from '@scripts/electron-run/projectRoot';
import {
    getCurrentSessionName,
    sessionDir,
} from '@scripts/electron-run/electronRunSessionPaths';
import type { PackageJson } from 'type-fest';

const TRUTHY_ENV_VALUES = new Set([
    '1',
    'true',
    'yes',
    'on',
]);

export const NUXT_BUILD_DIR_ENV = 'EVB_NUXT_BUILD_DIR';
export const NUXT_OUTPUT_DIR_ENV = 'EVB_NUXT_OUTPUT_DIR';
export const NUXT_VITE_CACHE_DIR_ENV = 'EVB_NUXT_VITE_CACHE_DIR';

function normalizeOptionalPath(value: string | undefined) {
    const normalized = value?.trim();
    if (!normalized) {
        return undefined;
    }
    return normalized;
}

export function resolveNuxtDevServerArtifactDirs(
    env: NodeJS.ProcessEnv = process.env,
    sessionName = getCurrentSessionName(),
) {
    const explicitBuildDir = normalizeOptionalPath(env[NUXT_BUILD_DIR_ENV]);
    const explicitOutputDir = normalizeOptionalPath(env[NUXT_OUTPUT_DIR_ENV]);
    const explicitViteCacheDir = normalizeOptionalPath(env[NUXT_VITE_CACHE_DIR_ENV]);
    if (sessionName === 'default' && !explicitBuildDir && !explicitOutputDir && !explicitViteCacheDir) {
        return null;
    }

    const artifactsDir = sessionDir(sessionName);
    return {
        buildDir: explicitBuildDir ?? join(artifactsDir, 'nuxt-build'),
        outputDir: explicitOutputDir ?? join(artifactsDir, 'nuxt-output'),
        viteCacheDir: explicitViteCacheDir ?? join(artifactsDir, 'vite-cache'),
    };
}

export function shouldDisableAutomationSandbox(
    env: NodeJS.ProcessEnv = process.env,
    platform = process.platform,
) {
    const explicitSetting = env.EVB_AUTOMATION_DISABLE_SANDBOX?.trim().toLowerCase();
    if (explicitSetting) {
        return TRUTHY_ENV_VALUES.has(explicitSetting);
    }

    return platform === 'linux' && env.CI === 'true';
}

export function shouldDisableMacOSAutomationGpu(
    env: NodeJS.ProcessEnv = process.env,
    platform = process.platform,
) {
    // Hidden macOS Electron sessions can lose their GPU process before CDP
    // attaches. Keep visible automation and normal desktop launches on the
    // hardware-rendered path.
    return platform === 'darwin' && env.EVB_AUTOMATION_HIDE_WINDOW === '1';
}

export const AUTOMATION_EXTRA_CHROMIUM_SWITCHES_ENV = 'EVB_AUTOMATION_EXTRA_CHROMIUM_SWITCHES';

/**
 * Stress-test host profiles need Chromium switches (`--js-flags`,
 * `--renderer-process-limit`, `--evb-safe-mode`, ...) that no other automation
 * caller sets. The value is whitespace-separated; every token must start with
 * `--` so a stray file path can never become a positional argument.
 */
export function parseExtraChromiumSwitches(rawValue: string | undefined) {
    if (!rawValue) {
        return [];
    }
    const switches = rawValue.split(/\s+/).filter(token => token.length > 0);
    const invalid = switches.filter(token => !token.startsWith('--'));
    if (invalid.length > 0) {
        throw new Error(
            `${AUTOMATION_EXTRA_CHROMIUM_SWITCHES_ENV} accepts only \`--switch\` tokens; rejected: ${invalid.join(' ')}`,
        );
    }
    return switches;
}

export function buildElectronAutomationArgs(options: {
    cdpPort: number;
    automationUserDataDir: string;
    mainJs: string;
    initialOpenPaths?: string[];
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
}) {
    const initialOpenPaths = options.initialOpenPaths ?? [];
    const forceNoReducedMotion = options.env?.EVB_E2E_FORCE_NO_REDUCED_MOTION === '1';
    const extraSwitches = parseExtraChromiumSwitches(options.env?.[AUTOMATION_EXTRA_CHROMIUM_SWITCHES_ENV]);
    const args = [
        `--remote-debugging-port=${options.cdpPort}`,
        `--user-data-dir=${options.automationUserDataDir}`,
        '--disable-http-cache',
        options.mainJs,
        ...(initialOpenPaths.length > 0
            ? [
                '--',
                ...initialOpenPaths,
            ]
            : []),
    ];

    if (shouldDisableAutomationSandbox(options.env, options.platform)) {
        args.unshift(
            '--disable-setuid-sandbox',
            '--no-sandbox',
        );
    }
    if (shouldDisableMacOSAutomationGpu(options.env, options.platform)) {
        args.unshift('--disable-gpu');
    }
    if (forceNoReducedMotion) {
        args.unshift('--force-prefers-no-reduced-motion');
    }
    if (extraSwitches.length > 0) {
        args.unshift(...extraSwitches);
    }

    return args;
}

export function sanitizeElectronLaunchEnv(env: NodeJS.ProcessEnv) {
    const launchEnv = { ...env };
    delete launchEnv.ELECTRON_RUN_AS_NODE;
    return launchEnv;
}

export function buildNuxtDevServerEnv(
    env: NodeJS.ProcessEnv,
    port: number,
    sessionName = getCurrentSessionName(),
) {
    const launchEnv: NodeJS.ProcessEnv = {};
    for (const [
        key,
        value,
    ] of Object.entries(env)) {
        if (key === 'VITEST' || key.startsWith('VITEST_')) {
            continue;
        }
        launchEnv[key] = value;
    }

    const artifactDirs = resolveNuxtDevServerArtifactDirs(env, sessionName);
    return {
        ...launchEnv,
        NODE_ENV: 'development',
        PORT: String(port),
        HOST: '127.0.0.1',
        NUXT_IGNORE_LOCK: env.NUXT_IGNORE_LOCK ?? '1',
        ...(artifactDirs
            ? {
                [NUXT_BUILD_DIR_ENV]: artifactDirs.buildDir,
                [NUXT_OUTPUT_DIR_ENV]: artifactDirs.outputDir,
                [NUXT_VITE_CACHE_DIR_ENV]: artifactDirs.viteCacheDir,
            }
            : {}),
    };
}

export function resolveAutomationWindowEnv(
    env: NodeJS.ProcessEnv = process.env,
    options?: { isTTY?: boolean },
) {
    const isTTY = options?.isTTY ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
    const defaultFlag = isTTY ? '0' : '1';
    const noFocus = env.EVB_AUTOMATION_NO_FOCUS ?? defaultFlag;
    const hideWindow = env.EVB_AUTOMATION_HIDE_WINDOW ?? env.EVB_AUTOMATION_NO_FOCUS ?? defaultFlag;

    return {
        EVB_AUTOMATION_NO_FOCUS: noFocus,
        EVB_AUTOMATION_HIDE_WINDOW: hideWindow,
    };
}

export function resolveAutomationRendererReadyEnv(
    env: NodeJS.ProcessEnv,
    automationWindowEnv: ReturnType<typeof resolveAutomationWindowEnv>,
) {
    if (env.EVB_WAIT_RENDERER_READY !== undefined) {
        return env.EVB_WAIT_RENDERER_READY;
    }
    return automationWindowEnv.EVB_AUTOMATION_HIDE_WINDOW === '1'
        || automationWindowEnv.EVB_AUTOMATION_NO_FOCUS === '1'
        ? '1'
        : '0';
}

export function buildHeadlessAutomationEnv(env: NodeJS.ProcessEnv = process.env) {
    return {
        ...env,
        EVB_AUTOMATION_NO_FOCUS: '1',
        EVB_AUTOMATION_HIDE_WINDOW: '1',
        EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE: '1',
    } satisfies NodeJS.ProcessEnv;
}

export function buildElectronE2EAutomationEnv(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
) {
    return {
        ...env,
        ...resolveElectronE2EHeadlessRunnerConfig(platform).environment,
    } satisfies NodeJS.ProcessEnv;
}

export function buildVisibleWindowElectronE2EAutomationEnv(
    env: NodeJS.ProcessEnv = process.env,
) {
    return {
        ...env,
        EVB_AUTOMATION_NO_FOCUS: '0',
        EVB_AUTOMATION_HIDE_WINDOW: '0',
        EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE: '0',
    } satisfies NodeJS.ProcessEnv;
}

interface IElectronE2EHeadlessRunnerConfig {
    commandPrefix: string[];
    environment: {
        EVB_AUTOMATION_HIDE_WINDOW: '0' | '1';
        EVB_AUTOMATION_NO_FOCUS: '1';
        EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE: '0' | '1';
    };
    hostDisplayIsolation: 'hidden-window' | 'xvfb';
}

export function resolveElectronE2EHeadlessRunnerConfig(
    platform: NodeJS.Platform = process.platform,
): IElectronE2EHeadlessRunnerConfig {
    if (platform === 'linux') {
        return {
            commandPrefix: [
                'xvfb-run',
                '-a',
            ],
            environment: {
                EVB_AUTOMATION_HIDE_WINDOW: '0',
                EVB_AUTOMATION_NO_FOCUS: '1',
                EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE: '0',
            },
            hostDisplayIsolation: 'xvfb',
        };
    }

    return {
        commandPrefix: [],
        environment: {
            EVB_AUTOMATION_HIDE_WINDOW: '1',
            EVB_AUTOMATION_NO_FOCUS: '1',
            EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE: platform === 'darwin' ? '1' : '0',
        },
        hostDisplayIsolation: 'hidden-window',
    };
}

export function shouldUseMacOSHiddenAppLauncher(
    env: NodeJS.ProcessEnv,
    platform = process.platform,
) {
    // JS-level dock hiding runs after launch, which can still flash a Dock icon.
    // Hidden automation cannot opt out of launch-time Dock suppression.
    return platform === 'darwin'
        && (env.EVB_AUTOMATION_HIDE_WINDOW === '1' || env.EVB_AUTOMATION_NO_FOCUS === '1');
}

export function shouldBootstrapInteractiveDevProfile(options: {
    env?: NodeJS.ProcessEnv;
    sessionName?: string;
    automationWindowEnv?: ReturnType<typeof resolveAutomationWindowEnv>;
    isTTY?: boolean;
}) {
    const env = options.env ?? process.env;
    const sessionName = options.sessionName ?? getCurrentSessionName();
    const automationWindowEnv = options.automationWindowEnv ?? resolveAutomationWindowEnv(env, {...(options.isTTY === undefined ? {} : { isTTY: options.isTTY })});

    return env.CI !== 'true'
        && sessionName === 'default'
        && automationWindowEnv.EVB_AUTOMATION_NO_FOCUS === '0'
        && automationWindowEnv.EVB_AUTOMATION_HIDE_WINDOW === '0';
}

export function buildMacOSHiddenAppBundlePaths(options: {
    sourceAppPath: string;
    destinationRoot: string;
}) {
    const appPath = join(options.destinationRoot, basename(options.sourceAppPath));
    return {
        appPath,
        executablePath: join(
            appPath,
            'Contents',
            'MacOS',
            basename(options.sourceAppPath, '.app'),
        ),
        infoPlistPath: join(appPath, 'Contents', 'Info.plist'),
    };
}

export function buildElectronExecutablePath(options?: {
    platform?: NodeJS.Platform;
    rootDir?: string;
}) {
    const platform = options?.platform ?? process.platform;
    const rootDir = options?.rootDir ?? projectRoot;
    const distDir = join(rootDir, 'node_modules', 'electron', 'dist');

    // Automation must launch the real Electron binary here.
    // The npm shim can fail in CI/package environments before Electron starts.
    if (platform === 'darwin') {
        return join(distDir, 'Electron.app', 'Contents', 'MacOS', 'Electron');
    }

    if (platform === 'win32') {
        return join(distDir, 'electron.exe');
    }

    return join(distDir, 'electron');
}

function setMacOSAutomationAgentMode(infoPlistPath: string) {
    if (!lstatSync(infoPlistPath).isFile()) {
        throw new Error(`Automation Info.plist must be a regular copied file: ${infoPlistPath}`);
    }
    const replaceArgs = [
        '-replace',
        'LSUIElement',
        '-bool',
        'YES',
        infoPlistPath,
    ];
    const insertArgs = [
        '-insert',
        'LSUIElement',
        '-bool',
        'YES',
        infoPlistPath,
    ];

    try {
        execFileSync('/usr/bin/plutil', replaceArgs, { stdio: 'ignore' });
    } catch {
        execFileSync('/usr/bin/plutil', insertArgs, { stdio: 'ignore' });
    }
}

const HIDDEN_APP_BUNDLES_ROOT_SEGMENTS = [
    '.devkit',
    'tmp',
    'electron-e2e-hidden-app',
] as const;
const HIDDEN_APP_BUNDLE_STAGING_PREFIX = '.staging-';
const HIDDEN_APP_BUNDLE_STAGING_MAX_AGE_MS = 60 * 60 * 1000;

export interface IHiddenAppBundleDirCandidate {
    name: string;
    mtimeMs: number;
}

export function readElectronDistVersion(rootDir = projectRoot) {
    const packageJson = JSON.parse(
        readFileSync(join(rootDir, 'node_modules', 'electron', 'package.json'), 'utf8'),
    ) as PackageJson;
    const version = typeof packageJson.version === 'string' ? packageJson.version.trim() : '';
    if (!version) {
        throw new Error('node_modules/electron/package.json must define the installed Electron version.');
    }
    return version;
}

export function resolveMacOSHiddenAppBundlesRoot(rootDir = projectRoot) {
    return join(rootDir, ...HIDDEN_APP_BUNDLES_ROOT_SEGMENTS);
}

export function buildMacOSHiddenAppBundleDirName(electronVersion: string) {
    return `electron-${electronVersion.trim().replace(/[^a-zA-Z0-9._-]+/gu, '-')}`;
}

export function resolveMacOSHiddenAppBundleDestinationRoot(options: {
    electronVersion: string;
    rootDir?: string;
}) {
    return join(
        resolveMacOSHiddenAppBundlesRoot(options.rootDir),
        buildMacOSHiddenAppBundleDirName(options.electronVersion),
    );
}

export function selectStaleMacOSHiddenAppBundleDirs(
    candidates: IHiddenAppBundleDirCandidate[],
    options: {
        keepDirName: string;
        nowMs?: number;
    },
) {
    const nowMs = options.nowMs ?? Date.now();
    return candidates
        .filter((candidate) => {
            if (candidate.name === options.keepDirName) {
                return false;
            }
            if (candidate.name.startsWith(HIDDEN_APP_BUNDLE_STAGING_PREFIX)) {
                return nowMs - candidate.mtimeMs > HIDDEN_APP_BUNDLE_STAGING_MAX_AGE_MS;
            }
            return true;
        })
        .map(candidate => candidate.name);
}

export function pruneStaleMacOSHiddenAppBundles(options: {
    bundlesRootDir: string;
    keepDirName: string;
    nowMs?: number;
}) {
    let entryNames: string[];
    try {
        entryNames = readdirSync(options.bundlesRootDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name);
    } catch {
        return [];
    }
    const candidates: IHiddenAppBundleDirCandidate[] = [];
    for (const name of entryNames) {
        try {
            candidates.push({
                name,
                mtimeMs: statSync(join(options.bundlesRootDir, name)).mtimeMs,
            });
        } catch {
            // Another launch pruned this entry between readdir and stat; nothing left to consider.
        }
    }

    const removed: string[] = [];
    for (const name of selectStaleMacOSHiddenAppBundleDirs(candidates, options)) {
        try {
            rmSync(join(options.bundlesRootDir, name), {
                recursive: true,
                force: true,
            });
            removed.push(name);
        } catch {
            // A stale bundle that cannot be removed now is retried by the next launch.
        }
    }
    return removed;
}

function isMacOSHiddenAppBundleComplete(bundlePaths: ReturnType<typeof buildMacOSHiddenAppBundlePaths>) {
    return existsSync(bundlePaths.executablePath) && existsSync(bundlePaths.infoPlistPath);
}

function resealMacOSAutomationAppBundle(appPath: string) {
    // The LSUIElement edit invalidates a Developer ID seal, and the kernel kills a
    // hardened-runtime app whose Info.plist no longer matches its signature about
    // two seconds after launch. An ad-hoc seal without the hardened runtime keeps
    // the copy launchable and still loads the team-signed Electron frameworks.
    execFileSync('/usr/bin/codesign', [
        '--force',
        '--sign',
        '-',
        appPath,
    ], { stdio: 'ignore' });
    execFileSync('/usr/bin/codesign', [
        '--verify',
        '--strict',
        appPath,
    ], { stdio: 'ignore' });
}

function assertMacOSAutomationAgentMode(infoPlistPath: string) {
    let agentMode: string | undefined;
    try {
        agentMode = execFileSync('/usr/bin/plutil', [
            '-extract',
            'LSUIElement',
            'raw',
            '-expect',
            'bool',
            '-o',
            '-',
            infoPlistPath,
        ], {
            encoding: 'utf8',
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
        }).trim();
    } catch {
        // Missing or malformed launch metadata must never fall back to a regular app.
    }
    if (agentMode !== 'true') {
        throw new Error(`Refusing macOS automation launch without LSUIElement=true: ${infoPlistPath}`);
    }
}

function cloneMacOSAppBundle(sourceAppPath: string, destinationAppPath: string) {
    // cp -c clones through APFS clonefile(2): the bundle shares its blocks with
    // node_modules until a file changes, so a 280 MiB app costs kilobytes.
    try {
        execFileSync('/bin/cp', [
            '-Rc',
            sourceAppPath,
            destinationAppPath,
        ], { stdio: 'ignore' });
    } catch {
        rmSync(destinationAppPath, {
            recursive: true,
            force: true,
        });
        execFileSync('/usr/bin/ditto', [
            sourceAppPath,
            destinationAppPath,
        ], { stdio: 'ignore' });
    }
}

function publishStagedMacOSHiddenAppBundle(
    stagingRoot: string,
    destinationRoot: string,
    bundlePaths: ReturnType<typeof buildMacOSHiddenAppBundlePaths>,
) {
    try {
        renameSync(stagingRoot, destinationRoot);
        return;
    } catch (error) {
        if (isMacOSHiddenAppBundleComplete(bundlePaths)) {
            rmSync(stagingRoot, {
                recursive: true,
                force: true,
            });
            return;
        }
        if (!existsSync(destinationRoot)) {
            throw error;
        }
    }
    rmSync(destinationRoot, {
        recursive: true,
        force: true,
    });
    renameSync(stagingRoot, destinationRoot);
}

export function prepareMacOSHiddenAppBundle(options: {
    sourceAppPath: string;
    destinationRoot: string;
}) {
    const bundlePaths = buildMacOSHiddenAppBundlePaths(options);
    if (isMacOSHiddenAppBundleComplete(bundlePaths)) {
        assertMacOSAutomationAgentMode(bundlePaths.infoPlistPath);
        return bundlePaths;
    }

    const bundlesRootDir = dirname(options.destinationRoot);
    mkdirSync(bundlesRootDir, { recursive: true });
    const stagingRoot = mkdtempSync(join(bundlesRootDir, HIDDEN_APP_BUNDLE_STAGING_PREFIX));
    const stagingPaths = buildMacOSHiddenAppBundlePaths({
        sourceAppPath: options.sourceAppPath,
        destinationRoot: stagingRoot,
    });
    try {
        // Clone the real directory, never a symlink that would redirect plist edits to the source.
        cloneMacOSAppBundle(realpathSync(options.sourceAppPath), stagingPaths.appPath);
        setMacOSAutomationAgentMode(stagingPaths.infoPlistPath);
        resealMacOSAutomationAppBundle(stagingPaths.appPath);
        assertMacOSAutomationAgentMode(stagingPaths.infoPlistPath);
        publishStagedMacOSHiddenAppBundle(stagingRoot, options.destinationRoot, bundlePaths);
    } catch (error) {
        rmSync(stagingRoot, {
            recursive: true,
            force: true,
        });
        throw error;
    }
    assertMacOSAutomationAgentMode(bundlePaths.infoPlistPath);
    return bundlePaths;
}

export function prepareSharedMacOSHiddenAppBundle(options: {
    sourceAppPath: string;
    rootDir?: string;
}) {
    const rootDir = options.rootDir ?? projectRoot;
    const destinationRoot = resolveMacOSHiddenAppBundleDestinationRoot({
        electronVersion: readElectronDistVersion(rootDir),
        rootDir,
    });
    const bundlePaths = prepareMacOSHiddenAppBundle({
        sourceAppPath: options.sourceAppPath,
        destinationRoot,
    });
    const removed = pruneStaleMacOSHiddenAppBundles({
        bundlesRootDir: dirname(destinationRoot),
        keepDirName: basename(destinationRoot),
    });
    return {
        ...bundlePaths,
        removedStaleBundleDirs: removed,
    };
}

export function buildAutomationAppEntryPaths(destinationRoot: string) {
    const appPath = join(destinationRoot, 'automation-app');
    return {
        appPath,
        packageJsonPath: join(appPath, 'package.json'),
        mainJsPath: join(appPath, 'main.js'),
    };
}

export function buildAutomationAppEntryPackage(appVersion: string) {
    const version = appVersion.trim();
    if (!version) {
        throw new Error('The development app entry requires the canonical application version.');
    }

    return {
        name: 'evb-automation-app',
        version,
        main: 'main.js',
    } satisfies PackageJson;
}

function readCanonicalApplicationVersion() {
    const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as PackageJson;
    if (typeof packageJson.version !== 'string') {
        throw new Error('The root package.json must define the canonical application version.');
    }
    return packageJson.version;
}

export function prepareAutomationAppEntry(options: {
    destinationRoot: string;
    mainJs: string;
    appVersion?: string;
}) {
    const entryPaths = buildAutomationAppEntryPaths(options.destinationRoot);
    rmSync(entryPaths.appPath, {
        recursive: true,
        force: true,
    });
    mkdirSync(entryPaths.appPath, { recursive: true });
    const packageJson = buildAutomationAppEntryPackage(
        options.appVersion ?? readCanonicalApplicationVersion(),
    );
    writeFileSync(entryPaths.packageJsonPath, JSON.stringify(packageJson, null, 2));
    writeFileSync(entryPaths.mainJsPath, [
        '(async () => {',
        `  await import(${JSON.stringify(options.mainJs)});`,
        '})();',
        '',
    ].join('\n'));
    return entryPaths;
}
