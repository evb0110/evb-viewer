import { app } from 'electron';
import { existsSync } from 'fs';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';

interface IOcrPaths {
    binary: string;
    tessdata: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function getPlatformArch(): string {
    const platform = process.platform;
    const arch = process.arch;

    // Map Node.js arch names to our directory names
    const archMap: Record<string, string> = {
        arm64: 'arm64',
        x64: 'x64',
    };

    const mappedArch = archMap[arch];
    if (!mappedArch) {
        throw new Error(`Unsupported architecture: ${arch}`);
    }

    // Map Node.js platform names to our directory names
    const platformMap: Record<string, string> = {
        darwin: 'darwin',
        win32: 'win32',
        linux: 'linux',
    };

    const mappedPlatform = platformMap[platform];
    if (!mappedPlatform) {
        throw new Error(`Unsupported platform: ${platform}`);
    }

    return `${mappedPlatform}-${mappedArch}`;
}

export function getOcrPaths(): IOcrPaths {
    const platformArch = getPlatformArch();

    let resourcesBase: string;

    if (app.isPackaged) {
        // Production: binaries are in extraResources
        resourcesBase = process.resourcesPath;
    } else {
        // Development: __dirname is dist-electron, go up to project root
        resourcesBase = join(__dirname, '..', 'resources');
    }

    const tesseractDir = join(resourcesBase, 'tesseract');
    const platformDir = join(tesseractDir, platformArch);

    const binary = process.platform === 'win32'
        ? join(platformDir, 'bin', 'tesseract.exe')
        : join(platformDir, 'bin', 'tesseract');

    const tessdata = join(tesseractDir, 'tessdata');

    return {
        binary,
        tessdata, 
    };
}

export function validateOcrPaths(): {
    valid: boolean;
    error?: string 
} {
    try {
        const paths = getOcrPaths();

        if (!existsSync(paths.binary)) {
            return {
                valid: false,
                error: `Tesseract binary not found: ${paths.binary}`,
            };
        }

        if (!existsSync(paths.tessdata)) {
            return {
                valid: false,
                error: `Tessdata directory not found: ${paths.tessdata}`,
            };
        }

        return { valid: true };
    } catch (error) {
        return {
            valid: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}
