import { app } from 'electron';
import { join } from 'path';
import { getDjvuNativeToolsBase } from '@electron/features/djvu/main/nativeToolPaths';
import { resolvePlatformArchTag } from '@electron/utils/platformArch';
interface IBuildDjvuRuntimeEnvOptions {
    baseEnv?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    binDir?: string;
    libDir?: string;
}

function getDjvuLibDir() {
    const platformArch = resolvePlatformArchTag();
    const resourcesBase = getDjvuNativeToolsBase(undefined, app.isPackaged);
    return join(resourcesBase, 'djvulibre', platformArch, 'lib');
}

function prependEnvPath(
    env: NodeJS.ProcessEnv,
    entries: string[],
    key: string,
    envDelimiter: string,
) {
    const current = env[key] ?? '';
    const additions = entries.filter(entry => entry.trim().length > 0);

    if (additions.length === 0) {
        return;
    }

    env[key] = current
        ? `${additions.join(envDelimiter)}${envDelimiter}${current}`
        : additions.join(envDelimiter);
}

function normalizeWindowsPathEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const normalizedEnv: NodeJS.ProcessEnv = {};
    const pathValues: string[] = [];

    for (const [
        key,
        value,
    ] of Object.entries(env)) {
        if (key.toLowerCase() !== 'path') {
            normalizedEnv[key] = value;
            continue;
        }

        if (typeof value === 'string' && value.length > 0) {
            pathValues.push(value);
        }
    }

    normalizedEnv.Path = pathValues.join(';');
    return normalizedEnv;
}

export function buildDjvuRuntimeEnv(options: IBuildDjvuRuntimeEnvOptions = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {...(options.baseEnv ?? process.env)};
    const platform = options.platform ?? process.platform;
    const envDelimiter = platform === 'win32' ? ';' : ':';
    const libDir = options.libDir ?? getDjvuLibDir();

    if (platform === 'win32') {
        const windowsEnv = normalizeWindowsPathEnv(env);
        const binDir = options.binDir ?? join(
            getDjvuNativeToolsBase(undefined, app.isPackaged),
            'djvulibre',
            resolvePlatformArchTag(),
            'bin',
        );
        prependEnvPath(windowsEnv, [
            binDir,
            libDir,
        ], 'Path', envDelimiter);
        return windowsEnv;
    }

    prependEnvPath(env, [libDir], 'DYLD_LIBRARY_PATH', envDelimiter);
    prependEnvPath(env, [libDir], 'LD_LIBRARY_PATH', envDelimiter);
    // DjVuLibre decodes argv through the locale. macOS 14 has no C.UTF-8 locale.
    const locale = platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
    env.LC_ALL = locale;
    env.LC_CTYPE = locale;
    env.LANG = locale;
    return env;
}
