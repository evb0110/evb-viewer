import { app } from 'electron';
import {
    existsSync,
    readdirSync,
} from 'fs';
import { execSync } from 'child_process';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { resolvePlatformArchTag } from '@electron/utils/platform-arch';

interface IOcrPaths {
    binary: string;
    tessdata: string;
}

interface IOcrToolPaths {
    tesseract: string;
    tessdata: string;
    pdftoppm: string;
    pdftotext: string;
    pdfimages?: string;
    qpdf: string;
    unpaper?: string;
}

interface IToolValidationResult {
    valid: boolean;
    tools: {
        tesseract: {
            found: boolean;
            path: string;
            version?: string 
        };
        tessdata: {
            found: boolean;
            path: string;
            languages?: string[] 
        };
        pdftoppm: {
            found: boolean;
            path: string 
        };
        pdftotext: {
            found: boolean;
            path: string 
        };
        qpdf: {
            found: boolean;
            path: string 
        };
    };
    errors: string[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function getResourcesBase(): string {
    if (app.isPackaged) {
        return process.resourcesPath;
    }
    return join(__dirname, '..', 'resources');
}

function findOnSystemPath(name: string): string {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const fullName = `${name}${ext}`;

    if (process.platform === 'darwin') {
        // macOS apps launched from Finder don't inherit shell PATH,
        // so Homebrew binaries aren't found via bare name lookup.
        // Check common Homebrew locations explicitly.
        const brewPaths = [
            join('/opt/homebrew/bin', fullName),  // Apple Silicon
            join('/usr/local/bin', fullName),      // Intel
        ];
        for (const p of brewPaths) {
            if (existsSync(p)) {
                return p;
            }
        }
    }

    return fullName;
}

function getBinaryPath(dir: string, name: string, optional = false): string {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const binPath = join(dir, 'bin', `${name}${ext}`);

    if (existsSync(binPath)) {
        return binPath;
    }

    if (optional) {
        return '';
    }

    // Packaged app must rely on bundled binaries only.
    if (app.isPackaged) {
        return binPath;
    }

    return findOnSystemPath(name);
}

function getToolVersion(path: string, versionFlag = '--version'): string | undefined {
    if (!path || !existsSync(path)) {
        return undefined;
    }
    try {
        const output = execSync(`"${path}" ${versionFlag}`, {
            encoding: 'utf-8',
            timeout: 5000,
            stdio: [
                'pipe',
                'pipe',
                'pipe',
            ],
        });
        // Extract version number from first line
        const match = output.match(/(\d+\.\d+(?:\.\d+)?)/);
        return match?.[1];
    } catch {
        return undefined;
    }
}

export function getOcrPaths(): IOcrPaths {
    const platformArch = resolvePlatformArchTag();
    const resourcesBase = getResourcesBase();

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

export function getOcrToolPaths(): IOcrToolPaths {
    const platformArch = resolvePlatformArchTag();
    const resourcesBase = getResourcesBase();

    // Tesseract paths
    const tesseractDir = join(resourcesBase, 'tesseract');
    const tesseractPlatformDir = join(tesseractDir, platformArch);
    const tesseract = getBinaryPath(tesseractPlatformDir, 'tesseract');
    const tessdata = join(tesseractDir, 'tessdata');

    // Poppler paths (pdftoppm, pdftotext)
    const popplerDir = join(resourcesBase, 'poppler', platformArch);
    const pdftoppm = getBinaryPath(popplerDir, 'pdftoppm');
    const pdftotext = getBinaryPath(popplerDir, 'pdftotext');
    const pdfimages = getBinaryPath(popplerDir, 'pdfimages', true) || undefined;

    // qpdf path
    const qpdfDir = join(resourcesBase, 'qpdf', platformArch);
    const qpdf = getBinaryPath(qpdfDir, 'qpdf');

    // unpaper (optional, currently in tesseract dir alongside tesseract)
    const unpaper = getBinaryPath(tesseractPlatformDir, 'unpaper', true) || undefined;

    return {
        tesseract,
        tessdata,
        pdftoppm,
        pdftotext,
        pdfimages,
        qpdf,
        unpaper,
    };
}

function checkToolExists(path: string): boolean {
    // If path contains a directory separator, check if file exists
    if (path.includes('/') || path.includes('\\')) {
        return existsSync(path);
    }
    // Otherwise it's a system PATH reference - try to find it
    try {
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        execSync(`${cmd} "${path}"`, {
            encoding: 'utf-8',
            timeout: 5000,
            stdio: [
                'pipe',
                'pipe',
                'pipe',
            ],
        });
        return true;
    } catch {
        return false;
    }
}

function getAvailableLanguages(tessdataPath: string): string[] {
    if (!existsSync(tessdataPath)) {
        return [];
    }
    try {
        const files = readdirSync(tessdataPath);
        return files
            .filter((f: string) => f.endsWith('.traineddata'))
            .map((f: string) => f.replace('.traineddata', ''));
    } catch {
        return [];
    }
}

export async function validateOcrTools(): Promise<IToolValidationResult> {
    const paths = getOcrToolPaths();
    const errors: string[] = [];

    // Check tesseract
    const tesseractFound = checkToolExists(paths.tesseract);
    const tesseractVersion = tesseractFound ? getToolVersion(paths.tesseract) : undefined;
    if (!tesseractFound) {
        errors.push(`Tesseract binary not found: ${paths.tesseract}`);
    }

    // Check tessdata
    const tessdataFound = existsSync(paths.tessdata);
    const languages = tessdataFound ? getAvailableLanguages(paths.tessdata) : undefined;
    if (!tessdataFound) {
        errors.push(`Tessdata directory not found: ${paths.tessdata}`);
    } else if (languages && languages.length === 0) {
        errors.push(`No language models found in tessdata: ${paths.tessdata}`);
    }

    // Check pdftoppm
    const pdftoppmFound = checkToolExists(paths.pdftoppm);
    if (!pdftoppmFound) {
        errors.push(`pdftoppm not found: ${paths.pdftoppm} (install Poppler or bundle it)`);
    }

    // Check pdftotext
    const pdftotextFound = checkToolExists(paths.pdftotext);
    if (!pdftotextFound) {
        errors.push(`pdftotext not found: ${paths.pdftotext} (install Poppler or bundle it)`);
    }

    // Check qpdf
    const qpdfFound = checkToolExists(paths.qpdf);
    if (!qpdfFound) {
        errors.push(`qpdf not found: ${paths.qpdf} (install qpdf or bundle it)`);
    }

    const valid = tesseractFound && tessdataFound && pdftoppmFound && qpdfFound;

    return {
        valid,
        tools: {
            tesseract: {
                found: tesseractFound,
                path: paths.tesseract,
                version: tesseractVersion,
            },
            tessdata: {
                found: tessdataFound,
                path: paths.tessdata,
                languages,
            },
            pdftoppm: {
                found: pdftoppmFound,
                path: paths.pdftoppm,
            },
            pdftotext: {
                found: pdftotextFound,
                path: paths.pdftotext,
            },
            qpdf: {
                found: qpdfFound,
                path: paths.qpdf,
            },
        },
        errors,
    };
}
