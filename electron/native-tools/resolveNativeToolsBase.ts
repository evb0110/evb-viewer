import {dirname, join} from 'path';
import {resolveNativeResourcesBase} from '@electron/native-tools/resolveNativeResourcesBase';
import {resolvePlatformArchTag} from '@electron/utils/platformArch';

interface IResolveNativeToolsBaseOptions {
    platform?: NodeJS.Platform;
    resourcesBase?: string;
}

const RUST_TARGET_BY_PLATFORM_ARCH: Record<string, string> = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'win32-arm64': 'aarch64-pc-windows-msvc',
    'win32-x64': 'x86_64-pc-windows-msvc',
};

export function resolveNativeToolsBase(moduleDir: string, isPackaged: boolean, options: IResolveNativeToolsBaseOptions = {}) {
    const resourcesBase = options.resourcesBase ?? resolveNativeResourcesBase(moduleDir, isPackaged);
    const platform = options.platform ?? process.platform;

    if (isPackaged && platform === 'darwin') {
        return join(resourcesBase, '..', 'MacOS', 'native-tools');
    }

    return resourcesBase;
}

/**
 * Resolves the bundled `evb-windows-job-launcher` process supervisor binary
 * without going through module-level `fs` imports so feature tests that mock
 * `fs` or `resolveNativeToolPath` still locate the real supervisor.
 */
export function resolveNativeProcessSupervisorPath(
    currentDir: string,
    options: {
        exists?: ((path: string) => boolean) | undefined;
        platform?: NodeJS.Platform | undefined;
    } = {},
) {
    const pathExists = options.exists ?? process.getBuiltinModule('node:fs').existsSync;
    const platform = options.platform ?? process.platform;
    const isPackaged = currentDir.includes('app.asar');
    const platformArch = resolvePlatformArchTag({platform});
    const binaryName = platform === 'win32' ? 'evb-windows-job-launcher.exe' : 'evb-windows-job-launcher';
    const resourcesBase = resolveNativeResourcesBase(currentDir, isPackaged, {exists: pathExists});
    const nativeToolsBase = resolveNativeToolsBase(currentDir, isPackaged, {
        platform,
        resourcesBase,
    });
    const candidates = [join(nativeToolsBase, 'windows-job-launcher', platformArch, 'bin', binaryName)];
    if (!isPackaged) {
        const projectRoot = dirname(resourcesBase);
        candidates.push(join(projectRoot, '.tmp', 'windows-job-launcher', platformArch, 'bin', binaryName));
        const rustTarget = RUST_TARGET_BY_PLATFORM_ARCH[platformArch];
        if (rustTarget) {
            candidates.push(join(projectRoot, 'native', 'target', rustTarget, 'release', binaryName));
        }
        candidates.push(join(projectRoot, 'native', 'target', 'release', binaryName));
    }
    return candidates.find((candidate) => pathExists(candidate)) ?? null;
}
