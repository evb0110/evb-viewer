import {existsSync} from 'fs';
import {join} from 'path';

interface INativeToolBinaryPathOptions {
    dir: string;
    isPackaged: boolean;
    name: string;
    optional?: boolean;
    platform?: NodeJS.Platform;
    exists?: (path: string) => boolean;
}

interface IFindNativeToolOnSystemPathOptions {
    exists?: (path: string) => boolean;
    platform?: NodeJS.Platform;
}

class MissingNativeToolBinaryError extends Error {
    constructor(name: string, path: string) {
        super(`Missing required native tool binary "${name}" at ${path}`);
        this.name = 'MissingNativeToolBinaryError';
    }
}

function getNativeToolExecutableName(name: string, platform: NodeJS.Platform = process.platform) {
    const ext = platform === 'win32' ? '.exe' : '';
    return `${name}${ext}`;
}

function findNativeToolOnSystemPath(name: string, options: IFindNativeToolOnSystemPathOptions = {}) {
    const platform = options.platform ?? process.platform;
    const pathExists = options.exists ?? existsSync;
    const fullName = getNativeToolExecutableName(name, platform);

    if (platform === 'darwin') {
        const brewPaths = [join('/opt/homebrew/bin', fullName), join('/usr/local/bin', fullName)];
        for (const candidate of brewPaths) {
            if (pathExists(candidate)) {
                return candidate;
            }
        }
    }

    return fullName;
}

export function getNativeToolBinaryPath(options: INativeToolBinaryPathOptions) {
    const platform = options.platform ?? process.platform;
    const pathExists = options.exists ?? existsSync;
    const binPath = join(options.dir, 'bin', getNativeToolExecutableName(options.name, platform));

    if (pathExists(binPath)) {
        return binPath;
    }

    if (options.optional) {
        return '';
    }

    if (options.isPackaged) {
        throw new MissingNativeToolBinaryError(options.name, binPath);
    }

    return findNativeToolOnSystemPath(options.name, {
        exists: pathExists,
        platform,
    });
}
