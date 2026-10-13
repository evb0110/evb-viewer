import {readBuildEnvironment} from './lib/build-environment.mjs';

/** @type {Record<string, string>} */
const PLATFORM_ALIASES = {
    darwin: 'darwin',
    linux: 'linux',
    mac: 'darwin',
    macos: 'darwin',
    win: 'win32',
    win32: 'win32',
    windows: 'win32',
};

/** @type {Record<string, string>} */
const ARCH_ALIASES = {
    aarch64: 'arm64',
    amd64: 'x64',
    arm64: 'arm64',
    x64: 'x64',
    x86_64: 'x64',
};

/** @type {Record<string, string>} */
const RUST_TARGET_BY_PLATFORM_ARCH = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'win32-arm64': 'aarch64-pc-windows-msvc',
    'win32-x64': 'x86_64-pc-windows-msvc',
};

/** @param {unknown} value @returns {string} */
export function normalizeNativeTargetPlatform(value) {
    const platform = PLATFORM_ALIASES[String(value ?? '').toLowerCase()];
    if (!platform) {
        throw new Error(`Unsupported native Rust target platform: ${value ?? ''}`);
    }

    return platform;
}

/** @param {unknown} value @returns {string} */
export function normalizeNativeTargetArch(value) {
    const arch = ARCH_ALIASES[String(value ?? '').toLowerCase()];
    if (!arch) {
        throw new Error(`Unsupported native Rust target architecture: ${value ?? ''}`);
    }

    return arch;
}

/** @param {{arch?: string, platform?: string}} options @returns {{arch: string, platform: string}} */
export function getHostNativeTarget({
    arch = process.arch,
    platform = process.platform,
} = {}) {
    return {
        arch: normalizeNativeTargetArch(arch),
        platform: normalizeNativeTargetPlatform(platform),
    };
}

/** @param {NodeJS.ProcessEnv} [env] @param {{arch: string, platform: string}} [hostTarget] */
export function getRequestedNativeRustTarget(
    env = process.env,
    hostTarget = getHostNativeTarget(),
) {
    const buildEnv = readBuildEnvironment(env);
    const platform = normalizeNativeTargetPlatform(buildEnv.EVB_NATIVE_TARGET_PLATFORM ?? hostTarget.platform);
    const arch = normalizeNativeTargetArch(buildEnv.EVB_NATIVE_TARGET_ARCH ?? hostTarget.arch);
    const platformArch = `${platform}-${arch}`;
    const rustTarget = RUST_TARGET_BY_PLATFORM_ARCH[platformArch];

    if (!rustTarget) {
        throw new Error(`Unsupported native Rust target: ${platformArch}`);
    }

    const isHostTarget = platform === hostTarget.platform && arch === hostTarget.arch;

    return {
        arch,
        binaryExtension: platform === 'win32' ? '.exe' : '',
        cargoTargetArgs: isHostTarget
            ? []
            : [
                '--target',
                rustTarget,
            ],
        isHostTarget,
        platform,
        platformArch,
        rustTarget,
    };
}
