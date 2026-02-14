import { app } from 'electron';
import { existsSync } from 'fs';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';

interface IDjvuToolPaths {
    ddjvu: string;
    djvused: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function getPlatformArch(): string {
    const archMap: Record<string, string> = {
        arm64: 'arm64',
        x64: 'x64',
    };
    const platformMap: Record<string, string> = {
        darwin: 'darwin',
        win32: 'win32',
        linux: 'linux',
    };

    const mappedArch = archMap[process.arch];
    if (!mappedArch) {
        throw new Error(`Unsupported architecture: ${process.arch}`);
    }

    const mappedPlatform = platformMap[process.platform];
    if (!mappedPlatform) {
        throw new Error(`Unsupported platform: ${process.platform}`);
    }

    return `${mappedPlatform}-${mappedArch}`;
}

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
    const platformArch = getPlatformArch();
    const resourcesBase = getResourcesBase();
    const djvuDir = join(resourcesBase, 'djvulibre', platformArch);

    return {
        ddjvu: getBinaryPath(djvuDir, 'ddjvu'),
        djvused: getBinaryPath(djvuDir, 'djvused'),
    };
}

export function getDjvuLibDir(): string {
    const platformArch = getPlatformArch();
    const resourcesBase = getResourcesBase();
    return join(resourcesBase, 'djvulibre', platformArch, 'lib');
}
