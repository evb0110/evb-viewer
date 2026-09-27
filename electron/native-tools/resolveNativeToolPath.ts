import { existsSync } from 'fs';
import { join } from 'path';
import { resolveNativeToolsBase } from '@electron/native-tools/resolveNativeToolsBase';
import { resolvePlatformArchTag } from '@electron/utils/platformArch';
import { createLogger } from '@electron/utils/createLogger';
import {runtimeConfig} from '@electron/runtimeConfig';

interface IResolveNativeToolPathOptions {
    allowPackagedDiagnosticsPaths?: boolean | undefined;
    binaryName: string;
    binaryRelativePath?: string[] | undefined;
    crateName: string;
    currentDir: string;
    envOverridePath?: string | undefined;
    exists?: ((path: string) => boolean) | undefined;
    includeRustTargetCandidates?: boolean | undefined;
    isPackaged: boolean;
    platform?: NodeJS.Platform | undefined;
    platformArch?: string | undefined;
    projectRoot?: string | undefined;
    resourcesBase?: string | undefined;
}

const RUST_TARGET_BY_PLATFORM_ARCH: Record<string, string> = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'win32-arm64': 'aarch64-pc-windows-msvc',
    'win32-x64': 'x86_64-pc-windows-msvc',
};

const logger = createLogger('native-tool-paths');
function platformFromPlatformArch(platformArch: string | undefined): NodeJS.Platform | undefined {
    if (platformArch?.startsWith('darwin-')) {
        return 'darwin';
    }
    if (platformArch?.startsWith('linux-')) {
        return 'linux';
    }
    if (platformArch?.startsWith('win32-')) {
        return 'win32';
    }

    return undefined;
}

function allowPackagedDiagnosticsPaths(options: IResolveNativeToolPathOptions) {
    return !options.isPackaged
        || options.allowPackagedDiagnosticsPaths === true
        || runtimeConfig.test.nativeToolAllowPackagedDiagnosticPaths;
}

function getDevNativeToolPathCandidates(options: IResolveNativeToolPathOptions) {
    const projectRoot = options.projectRoot ?? process.cwd();
    const platformArch = options.platformArch ?? resolvePlatformArchTag();
    const rustTarget = RUST_TARGET_BY_PLATFORM_ARCH[platformArch];
    const binaryRelativePath = options.binaryRelativePath ?? [
        'bin',
        options.binaryName,
    ];
    const candidates = [join(projectRoot, '.tmp', options.crateName, platformArch, ...binaryRelativePath)];

    if (options.includeRustTargetCandidates === false) {
        return candidates;
    }

    if (rustTarget) {
        candidates.push(join(
            projectRoot,
            'native',
            'target',
            rustTarget,
            'release',
            options.binaryName,
        ));
    }

    candidates.push(join(
        projectRoot,
        'native',
        'target',
        'release',
        options.binaryName,
    ));

    return candidates;
}

export function getNativeToolPathCandidates(options: IResolveNativeToolPathOptions) {
    const platformArch = options.platformArch ?? resolvePlatformArchTag();
    const platform = options.platform ?? platformFromPlatformArch(platformArch);
    const nativeToolsBaseOptions: {
        platform?: NodeJS.Platform;
        resourcesBase?: string;
    } = {};
    if (platform !== undefined) {
        nativeToolsBaseOptions.platform = platform;
    }
    if (options.resourcesBase !== undefined) {
        nativeToolsBaseOptions.resourcesBase = options.resourcesBase;
    }
    const nativeToolsBase = resolveNativeToolsBase(
        options.currentDir,
        options.isPackaged,
        nativeToolsBaseOptions,
    );
    const binaryRelativePath = options.binaryRelativePath ?? [
        'bin',
        options.binaryName,
    ];
    const candidates = [join(nativeToolsBase, options.crateName, platformArch, ...binaryRelativePath)];

    if (allowPackagedDiagnosticsPaths(options)) {
        candidates.push(...getDevNativeToolPathCandidates(options));
    }

    return candidates;
}

export function resolveNativeToolPath(options: IResolveNativeToolPathOptions) {
    const pathExists = options.exists ?? existsSync;
    const overridePath = options.envOverridePath?.trim();
    const allowDiagnosticsPaths = allowPackagedDiagnosticsPaths(options);
    if (overridePath && !allowDiagnosticsPaths) {
        logger.warn(
            `Ignoring packaged native tool override for ${options.crateName}; `
            + 'diagnostic native tool paths are disabled',
        );
    }
    if (overridePath && allowDiagnosticsPaths && pathExists(overridePath)) {
        if (options.isPackaged) {
            logger.warn(`Using diagnostics native tool override for packaged ${options.crateName}: ${overridePath}`);
        }
        return overridePath;
    }

    const resolvedPath = getNativeToolPathCandidates(options).find(candidate => pathExists(candidate)) ?? null;
    if (resolvedPath || !options.isPackaged || allowDiagnosticsPaths) {
        return resolvedPath;
    }

    const unsafeFallbackPath = getDevNativeToolPathCandidates(options).find(candidate => pathExists(candidate));
    if (unsafeFallbackPath) {
        logger.warn(
            `Ignoring packaged native tool fallback for ${options.crateName}: ${unsafeFallbackPath}; `
            + 'diagnostic native tool paths are disabled',
        );
    }
    return null;
}
