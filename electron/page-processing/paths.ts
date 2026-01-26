import { app } from 'electron';
import { stat } from 'fs/promises';
import { exec } from 'child_process';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface IPageProcessingPaths {
    processor: string;
    pdftoppm: string;
    qpdf: string;
}

export interface IToolValidation {
    valid: boolean;
    tools: {
        processor: {
            found: boolean;
            path: string;
            version?: string;
        };
        pdftoppm: {
            found: boolean;
            path: string;
        };
        qpdf: {
            found: boolean;
            path: string;
        };
    };
    errors: string[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// Cache for tool paths (computed once at startup)
let cachedPaths: IPageProcessingPaths | null = null;

// Cache for validation results (computed once per session)
let cachedValidation: IToolValidation | null = null;

function getPlatformArch(): string {
    const platform = process.platform;
    const arch = process.arch;

    const archMap: Record<string, string> = {
        arm64: 'arm64',
        x64: 'x64',
    };

    const mappedArch = archMap[arch];
    if (!mappedArch) {
        throw new Error(`Unsupported architecture: ${arch}`);
    }

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

function getResourcesBase(): string {
    if (app.isPackaged) {
        return process.resourcesPath;
    }
    return join(__dirname, '..', 'resources');
}

async function fileExists(path: string): Promise<boolean> {
    try {
        const s = await stat(path);
        // We only consider regular files as valid tool binaries.
        return s.isFile();
    } catch {
        return false;
    }
}

async function getBinaryPath(dir: string, name: string, optional = false): Promise<string> {
    const ext = process.platform === 'win32' ? '.exe' : '';
    // Support both PyInstaller layouts:
    // - onefile: <dir>/bin/<name>
    // - onedir:  <dir>/bin/<name>/<name>
    const binPath = join(dir, 'bin', `${name}${ext}`);
    const onedirPath = join(dir, 'bin', name, `${name}${ext}`);

    if (await fileExists(binPath)) {
        return binPath;
    }
    if (await fileExists(onedirPath)) {
        return onedirPath;
    }

    if (optional) {
        return '';
    }

    // Fall back to system PATH - return just the name
    return name;
}

async function getToolVersion(path: string, versionFlag = '--version'): Promise<string | undefined> {
    if (!path || !(await fileExists(path))) {
        return undefined;
    }
    try {
        const { stdout } = await execAsync(`"${path}" ${versionFlag}`, {
            encoding: 'utf-8',
            timeout: 5000,
        });
        // Extract version number from first line
        const match = stdout.match(/(\d+\.\d+(?:\.\d+)?)/);
        return match?.[1];
    } catch {
        return undefined;
    }
}

async function checkToolExists(path: string): Promise<boolean> {
    // If path contains a directory separator, check if file exists
    if (path.includes('/') || path.includes('\\')) {
        return fileExists(path);
    }
    // Otherwise it's a system PATH reference - try to find it
    try {
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        await execAsync(`${cmd} "${path}"`, {
            encoding: 'utf-8',
            timeout: 5000,
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Get page processing tool paths.
 * Returns cached paths if available (synchronous), otherwise computes and caches them.
 * For first call, use initPageProcessingPaths() during app startup.
 */
export function getPageProcessingPaths(): IPageProcessingPaths {
    if (cachedPaths) {
        return cachedPaths;
    }

    // Synchronous fallback for first call if not initialized
    // This only happens if initPageProcessingPaths wasn't called at startup
    const platformArch = getPlatformArch();
    const resourcesBase = getResourcesBase();

    const processorDir = join(resourcesBase, 'page-processing', platformArch);
    const popplerDir = join(resourcesBase, 'poppler', platformArch);
    const qpdfDir = join(resourcesBase, 'qpdf', platformArch);
    const ext = process.platform === 'win32' ? '.exe' : '';

    // Return paths without checking existence (worker will handle errors)
    cachedPaths = {
        // Default to the onedir layout; validation/init will correct this if needed.
        processor: join(processorDir, 'bin', 'page-processor', `page-processor${ext}`),
        pdftoppm: join(popplerDir, 'bin', `pdftoppm${ext}`),
        qpdf: join(qpdfDir, 'bin', `qpdf${ext}`),
    };

    return cachedPaths;
}

/**
 * Initialize page processing paths asynchronously.
 * Call this during app startup to cache paths before they're needed.
 */
export async function initPageProcessingPaths(): Promise<IPageProcessingPaths> {
    const platformArch = getPlatformArch();
    const resourcesBase = getResourcesBase();

    // Page processor binary (PyInstaller bundle)
    const processorDir = join(resourcesBase, 'page-processing', platformArch);
    const processor = await getBinaryPath(processorDir, 'page-processor');

    // Poppler paths (reuse from OCR tooling)
    const popplerDir = join(resourcesBase, 'poppler', platformArch);
    const pdftoppm = await getBinaryPath(popplerDir, 'pdftoppm');

    // qpdf path (reuse from OCR tooling)
    const qpdfDir = join(resourcesBase, 'qpdf', platformArch);
    const qpdf = await getBinaryPath(qpdfDir, 'qpdf');

    cachedPaths = {
        processor,
        pdftoppm,
        qpdf,
    };

    return cachedPaths;
}

/**
 * Validate page processing tools asynchronously.
 * Results are cached for the session.
 */
export async function validatePageProcessingTools(): Promise<IToolValidation> {
    // Return cached result if available
    if (cachedValidation) {
        return cachedValidation;
    }

    const paths = await initPageProcessingPaths();
    const errors: string[] = [];

    // Run all checks in parallel for faster validation
    const [
        processorFound,
        pdftoppmFound,
        qpdfFound,
        processorVersion,
    ] = await Promise.all([
        checkToolExists(paths.processor),
        checkToolExists(paths.pdftoppm),
        checkToolExists(paths.qpdf),
        getToolVersion(paths.processor),
    ]);

    if (!processorFound) {
        errors.push(`Page processor binary not found: ${paths.processor}`);
    }
    if (!pdftoppmFound) {
        errors.push(`pdftoppm not found: ${paths.pdftoppm} (install Poppler or bundle it)`);
    }
    if (!qpdfFound) {
        errors.push(`qpdf not found: ${paths.qpdf} (install qpdf or bundle it)`);
    }

    const valid = processorFound && pdftoppmFound && qpdfFound;

    cachedValidation = {
        valid,
        tools: {
            processor: {
                found: processorFound,
                path: paths.processor,
                version: processorVersion,
            },
            pdftoppm: {
                found: pdftoppmFound,
                path: paths.pdftoppm,
            },
            qpdf: {
                found: qpdfFound,
                path: paths.qpdf,
            },
        },
        errors,
    };

    return cachedValidation;
}

/**
 * Clear cached validation (useful for re-checking after tool installation).
 */
export function clearValidationCache(): void {
    cachedValidation = null;
}
