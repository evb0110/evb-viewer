import {spawnSync} from 'node:child_process';
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

// CARGO_ENCODED_RUSTFLAGS separates flags with the Unit Separator. RUSTFLAGS splits
// on whitespace, so a home folder with a space in it would become two arguments.
export const CARGO_ENCODED_RUSTFLAGS_SEPARATOR = '\u001f';

/**
 * The Rust flags of every native and WASM build. Rust records the source, registry and
 * toolchain paths it compiled from in panic locations, so the same commit built in
 * another folder or home gave other bytes and another provenance hash. These remaps
 * give those paths fixed names. Optimisation and features are unchanged.
 *
 * @param {{env?: NodeJS.ProcessEnv, extraRustflags?: string[], projectRoot: string}} options
 * @returns {string[]}
 */
export function getCargoRustflags({
    env = process.env,
    extraRustflags = [],
    projectRoot,
}) {
    const inherited = env.CARGO_ENCODED_RUSTFLAGS === undefined
        ? (env.RUSTFLAGS ?? '').split(/\s+/u)
        : env.CARGO_ENCODED_RUSTFLAGS.split(CARGO_ENCODED_RUSTFLAGS_SEPARATOR);
    return [
        ...inherited.filter(Boolean),
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
    projectRoot,
    runCommand = spawnSync,
}) {
    const remappedEnv = {
        ...env,
        CARGO_ENCODED_RUSTFLAGS: getCargoRustflags({
            env,
            // ld64 writes each object's path into the debug map before stripping, and
            // LC_UUID hashes that map. The prefix keeps the build folder out of the UUID.
            extraRustflags: platform === 'darwin'
                ? [
                    '-C',
                    `link-arg=-Wl,-oso_prefix,${projectRoot}`,
                ]
                : [],
            projectRoot,
        }).join(CARGO_ENCODED_RUSTFLAGS_SEPARATOR),
    };
    if (env.RUSTC_WRAPPER) {
        return {
            env: remappedEnv,
            sccache: `configured (${env.RUSTC_WRAPPER})`,
        };
    }
    if (env.EVB_RUST_SCCACHE !== '1') {
        return {
            env: remappedEnv,
            sccache: 'disabled',
        };
    }
    const result = runCommand('sccache', ['--version'], {encoding: 'utf8'});
    if (result.status === 0) {
        return {
            env: {
                ...remappedEnv,
                RUSTC_WRAPPER: 'sccache',
            },
            sccache: String(result.stdout).trim(),
        };
    }
    return {
        env: remappedEnv,
        sccache: 'unavailable',
    };
}
