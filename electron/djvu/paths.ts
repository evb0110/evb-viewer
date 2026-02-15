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

export function getDjvuLibDir(): string {
    const platformArch = resolvePlatformArchTag();
    const resourcesBase = getResourcesBase();
    return join(resourcesBase, 'djvulibre', platformArch, 'lib');
}
