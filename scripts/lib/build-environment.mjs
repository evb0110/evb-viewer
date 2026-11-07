import {
    execFileSync,
    spawnSync,
} from 'node:child_process';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

// The environment values the viewer build reads. nuxt.config.ts and the build
// scripts take their values from readBuildEnvironment, and the release build
// receipt fingerprints this snapshot, Nuxt overrides and the shared Cargo
// configuration collector. A new named build read adds its name here.

// Compiled into a bundle as a value: the receipt records a digest of each.
export const BUILD_SECRET_ENVIRONMENT_KEYS = Object.freeze([
    'SENTRY_BROWSER_DSN',
    'SENTRY_DESKTOP_DSN',
]);

// Tested for presence only: the token's value is not compiled in, so the receipt
// records whether it is set.
export const BUILD_PRESENCE_ENVIRONMENT_KEYS = Object.freeze(['SENTRY_AUTH_TOKEN']);

/** @param {NodeJS.ProcessEnv} [env] */
export function readBuildEnvironment(env = process.env) {
    return {
        // nuxt.config.ts
        EVB_APP_VERSION: env.EVB_APP_VERSION,
        EVB_NUXT_BUILD_DIR: env.EVB_NUXT_BUILD_DIR,
        EVB_NUXT_COMPATIBILITY_VERSION: env.EVB_NUXT_COMPATIBILITY_VERSION,
        EVB_NUXT_OUTPUT_DIR: env.EVB_NUXT_OUTPUT_DIR,
        EVB_NUXT_VITE_CACHE_DIR: env.EVB_NUXT_VITE_CACHE_DIR,
        NODE_ENV: env.NODE_ENV,
        NOW_BUILDER: env.NOW_BUILDER,
        NUXT_PUBLIC_ANALYTICS_ENABLED: env.NUXT_PUBLIC_ANALYTICS_ENABLED,
        NUXT_PUBLIC_LANDING_URL: env.NUXT_PUBLIC_LANDING_URL,
        NUXT_PUBLIC_SITE_URL: env.NUXT_PUBLIC_SITE_URL,
        SENTRY_AUTH_TOKEN: env.SENTRY_AUTH_TOKEN,
        SENTRY_BROWSER_DSN: env.SENTRY_BROWSER_DSN,
        VERCEL: env.VERCEL,
        VERCEL_ENV: env.VERCEL_ENV,
        VERCEL_GIT_COMMIT_SHA: env.VERCEL_GIT_COMMIT_SHA,
        // scripts/build-electron.mjs
        EVB_ELECTRON_SOURCEMAP: env.EVB_ELECTRON_SOURCEMAP,
        EVB_RELEASE_TARGET_ARCH: env.EVB_RELEASE_TARGET_ARCH,
        GITHUB_SHA: env.GITHUB_SHA,
        SENTRY_DESKTOP_DSN: env.SENTRY_DESKTOP_DSN,
        // Native target selection. Compiler inputs belong to this shared collector.
        EVB_NATIVE_TARGET_ARCH: env.EVB_NATIVE_TARGET_ARCH,
        EVB_NATIVE_TARGET_PLATFORM: env.EVB_NATIVE_TARGET_PLATFORM,
        // Read by the release workflow and the package managers rather than by these scripts.
        EVB_RELEASE_TARGET_DIST: env.EVB_RELEASE_TARGET_DIST,
        EVB_RELEASE_TARGET_PLATFORM: env.EVB_RELEASE_TARGET_PLATFORM,
        TARGET_ARCH: env.TARGET_ARCH,
        npm_config_arch: env.npm_config_arch,
    };
}

// Keep in sync with SCAN_CLEANUP_GIT_SHA_HEX_PATTERN in packages/scan-cleanup/core/provenanceStamp.ts.
const GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/**
 * The source revision a build embeds for provenance: HEAD of a clean
 * checkout, the CI or Vercel commit where git is unavailable, otherwise none.
 * @param {ReturnType<typeof readBuildEnvironment>} buildEnv
 */
export function resolveBuildGitSha(buildEnv) {
    const gitOptions = {
        encoding: /** @type {const} */ ('utf8'),
        stdio: /** @type {['ignore', 'pipe', 'ignore']} */ ([
            'ignore',
            'pipe',
            'ignore',
        ]),
    };
    let status;
    try {
        status = execFileSync('git', [
            'status',
            '--porcelain',
        ], gitOptions).trim();
    } catch {
        const ciSha = (buildEnv.GITHUB_SHA || buildEnv.VERCEL_GIT_COMMIT_SHA || '').trim().toLowerCase();
        return GIT_SHA_PATTERN.test(ciSha) ? ciSha : null;
    }
    if (status !== '') {
        return null;
    }
    try {
        const sha = execFileSync('git', [
            'rev-parse',
            '--verify',
            'HEAD',
        ], gitOptions).trim().toLowerCase();
        return GIT_SHA_PATTERN.test(sha) ? sha : null;
    } catch {
        return null;
    }
}

/** @param {ReturnType<typeof readBuildEnvironment>} buildEnv */
export function isVercelBuildOutput(buildEnv) {
    return buildEnv.VERCEL === '1' || buildEnv.NOW_BUILDER === '1';
}

/** @param {ReturnType<typeof readBuildEnvironment>} buildEnv */
export function nuxtOutputDirectory(buildEnv) {
    return isVercelBuildOutput(buildEnv)
        ? '.vercel/output'
        : buildEnv.EVB_NUXT_OUTPUT_DIR?.trim() || 'nuxt-output';
}

/** @param {NodeJS.ProcessEnv} env */
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
        'EVB_CARGO_',
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


// Both native and release receipts use the same optional Cargo configuration.
/** @param {{env?: NodeJS.ProcessEnv, projectRoot: string}} options */
export function getCargoConfigurationInputs({
    env = process.env, projectRoot,
}) {
    const cargoHome = getCargoHome(env, projectRoot);
    return [
        path.join(projectRoot, '.cargo', 'config'),
        path.join(projectRoot, '.cargo', 'config.toml'),
        path.join(projectRoot, 'rust-toolchain.toml'),
        path.join(cargoHome, 'config'),
        path.join(cargoHome, 'config.toml'),
    ].filter(inputPath => existsSync(inputPath));
}

/** @param {NodeJS.ProcessEnv} env @param {string} projectRoot */
function getCargoHome(env, projectRoot) {
    return env.CARGO_HOME ? path.resolve(projectRoot, env.CARGO_HOME) : path.join(homedir(), '.cargo');
}

/** @param {NodeJS.ProcessEnv} env @param {string} projectRoot */
function getRustupHome(env, projectRoot) {
    return env.RUSTUP_HOME ? path.resolve(projectRoot, env.RUSTUP_HOME) : path.join(homedir(), '.rustup');
}

/**
 * Build-owned arguments, kept separate from Cargo's flag resolution.
 * @param {{env?: NodeJS.ProcessEnv, extraRustflags?: string[], projectRoot: string}} options
 * @returns {string[]}
 */
export function getCargoRustflags({
    env = process.env, extraRustflags = [], projectRoot,
}) {
    return [
        `--remap-path-prefix=${getCargoHome(env, projectRoot)}=/cargo-home`,
        `--remap-path-prefix=${getRustupHome(env, projectRoot)}=/rustup-home`,
        `--remap-path-prefix=${projectRoot}=/evb-viewer`,
        ...extraRustflags,
    ];
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv;
 *   platform?: NodeJS.Platform;
 *   extraRustflags?: string[];
 *   projectRoot: string;
 *   runCommand?: (
 *     command: string,
 *     args: string[],
 *     options: {encoding: BufferEncoding},
 *   ) => {status: number | null; stdout: string};
 * }} options
 */
export function getCargoBuildEnvironment({
    env = process.env,
    platform = process.platform,
    extraRustflags = [],
    projectRoot,
    runCommand = spawnSync,
}) {
    const probe = !env.RUSTC_WRAPPER && env.EVB_RUST_SCCACHE === '1'
        ? runCommand('sccache', ['--version'], {encoding: 'utf8'}) : null;
    const inner = env.RUSTC_WRAPPER || (probe?.status === 0 ? 'sccache' : '');
    return {
        env: {
            ...env,
            RUSTC_WRAPPER: path.join(projectRoot, 'scripts', 'lib', platform === 'win32' ? 'cargo-rustc-wrapper.cmd' : 'cargo-rustc-wrapper.mjs'),
            EVB_CARGO_INNER_WRAPPER: inner,
            EVB_CARGO_RUSTFLAGS: JSON.stringify(getCargoRustflags({
                env,
                projectRoot,
            })),
            EVB_CARGO_APPLE_RUSTFLAGS: JSON.stringify(platform === 'darwin' ? [
                '-C',
                `link-arg=-Wl,-oso_prefix,${projectRoot}`,
            ] : []),
            EVB_CARGO_WASM_RUSTFLAGS: JSON.stringify(extraRustflags),
        },
        sccache: env.RUSTC_WRAPPER ? `configured (${inner})` : inner ? String(probe?.stdout).trim() : (env.EVB_RUST_SCCACHE === '1' ? 'unavailable' : 'disabled'),
    };
}
