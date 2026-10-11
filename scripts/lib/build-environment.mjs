// The environment values the viewer build reads. nuxt.config.ts and the build
// scripts take their values from readBuildEnvironment, and the release build
// receipt fingerprints the same snapshot, so a value that a build reads cannot
// change the build without changing the receipt. A new read adds its name here.

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
        // scripts/native-rust-targets.mjs and scripts/build-native-tool.mjs, and the Cargo they run
        CARGO_HOME: env.CARGO_HOME,
        EVB_NATIVE_TARGET_ARCH: env.EVB_NATIVE_TARGET_ARCH,
        EVB_NATIVE_TARGET_PLATFORM: env.EVB_NATIVE_TARGET_PLATFORM,
        RUSTFLAGS: env.RUSTFLAGS,
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
