import { app } from 'electron';
import { existsSync } from 'fs';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { resolvePlatformArchTag } from '@electron/utils/platform-arch';

interface IDjvuToolPaths {
    ddjvu: string;
    djvused: string;
}

interface IBuildDjvuRuntimeEnvOptions {
    baseEnv?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    binDir?: string;
    libDir?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function getResourcesBase(): string {
    if (app.isPackaged) {
        return process.resourcesPath;
    }
    return join(__dirname, '..', '..', 'resources');
}

function getBinaryPath(dir: string, name: string): string {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const binPath = join(dir, 'bin', `${name}${ext}`);

    if (existsSync(binPath)) {
        return binPath;
    }

    // Packaged app must rely on bundled binaries only.
    if (app.isPackaged) {
        return binPath;
    }

    return name;
}

export function getDjvuToolPaths(): IDjvuToolPaths {
    const platformArch = resolvePlatformArchTag();
    const resourcesBase = getResourcesBase();
    const djvuDir = join(resourcesBase, 'djvulibre', platformArch);

    return {
        ddjvu: getBinaryPath(djvuDir, 'ddjvu'),
        djvused: getBinaryPath(djvuDir, 'djvused'),
    };
}

function getDjvuLibDir(): string {
    const platformArch = resolvePlatformArchTag();
    const resourcesBase = getResourcesBase();
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

export function buildDjvuRuntimeEnv(options: IBuildDjvuRuntimeEnvOptions = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {...(options.baseEnv ?? process.env)};
    const platform = options.platform ?? process.platform;
    const envDelimiter = platform === 'win32' ? ';' : ':';
    const libDir = options.libDir ?? getDjvuLibDir();

    if (platform === 'win32') {
        const binDir = options.binDir ?? join(getResourcesBase(), 'djvulibre', resolvePlatformArchTag(), 'bin');
        const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
        prependEnvPath(env, [
            binDir,
            libDir,
        ], pathKey, envDelimiter);
        return env;
    }

    prependEnvPath(env, [libDir], 'DYLD_LIBRARY_PATH', envDelimiter);
    prependEnvPath(env, [libDir], 'LD_LIBRARY_PATH', envDelimiter);
    return env;
}
