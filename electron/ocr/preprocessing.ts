import { spawn } from 'child_process';
import { existsSync } from 'fs';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { app } from 'electron';
import { createLogger } from '@electron/utils/logger';

const log = createLogger('preprocessing');

interface IPreprocessingOptions {
    binary: string;
    args: string[];
    timeout?: number;
}

interface IPreprocessingResult {
    success: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
}

/**
 * Get paths to preprocessing binaries
 * Falls back gracefully if binaries don't exist
 */
interface IPreprocessingBinaries {
    leptonica: string | null;
    unpaper: string | null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function getPreprocessingBinaries(): IPreprocessingBinaries {
    let resourcesBase: string;

    if (app.isPackaged) {
        resourcesBase = process.resourcesPath;
    } else {
        // Development: in bundled code, __dirname is dist-electron, so go up one level
        // In source code from dist-electron/ocr, we'd go ../.. but esbuild bundles to dist-electron/main.js
        // So __dirname will be dist-electron, and we need to go up once: ../resources
        resourcesBase = join(__dirname, '..', 'resources');
    }

    const tesseractDir = join(resourcesBase, 'tesseract');
    const arch = process.platform === 'win32'
        ? 'win32-x64'
        : process.platform === 'darwin'
            ? process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
            : 'linux-x64';

    const binDir = join(tesseractDir, arch, 'bin');
    const ext = process.platform === 'win32' ? '.exe' : '';

    const leptonica = join(binDir, `leptonica${ext}`);
    const unpaper = join(binDir, `unpaper${ext}`);

    // Debug logging
    log.debug(`getPreprocessingBinaries: __dirname=${__dirname}, resourcesBase=${resourcesBase}, arch=${arch}, binDir=${binDir}`);
    log.debug(`  leptonica path: ${leptonica}, exists: ${existsSync(leptonica)}`);
    log.debug(`  unpaper path: ${unpaper}, exists: ${existsSync(unpaper)}`);

    return {
        leptonica: existsSync(leptonica) ? leptonica : null,
        unpaper: existsSync(unpaper) ? unpaper : null,
    };
}

/**
 * Generic preprocessing tool runner
 * Executes preprocessing binaries with given arguments
 */
async function runPreprocessing(
    options: IPreprocessingOptions,
): Promise<IPreprocessingResult> {
    log.debug(`Running: ${options.binary} ${options.args.join(' ')}`);

    if (!existsSync(options.binary)) {
        const error = `Binary not found: ${options.binary}`;
        log.debug(`Error: ${error}`);
        return {
            success: false,
            error, 
        };
    }

    return new Promise((resolve) => {
        const proc = spawn(options.binary, options.args);

        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timeout = options.timeout || 60000; // 60 seconds default
        const timeoutHandle = setTimeout(() => {
            timedOut = true;
            log.debug('Process timeout');
            proc.kill();
        }, timeout);

        proc.stdout.on('data', (data: Buffer) => {
            stdout += data.toString();
        });

        proc.stderr.on('data', (data: Buffer) => {
            const msg = data.toString();
            stderr += msg;
            log.debug(`stderr: ${msg.trim()}`);
        });

        proc.on('close', (code) => {
            clearTimeout(timeoutHandle);

            if (timedOut) {
                log.debug(`Process timed out after ${timeout}ms`);
                resolve({
                    success: false,
                    error: `Process timed out after ${timeout}ms`,
                    stderr,
                });
            } else if (code === 0) {
                log.debug('Process completed successfully');
                resolve({
                    success: true,
                    stdout,
                    stderr,
                });
            } else {
                log.debug(`Process exited with code ${code}`);
                resolve({
                    success: false,
                    error: stderr || `Process exited with code ${code}`,
                    stderr,
                });
            }
        });

        proc.on('error', (err) => {
            clearTimeout(timeoutHandle);
            log.debug(`Process error: ${err.message}`);
            resolve({
                success: false,
                error: err.message,
                stderr,
            });
        });
    });
}

/**
 * Clean a scanned document with Unpaper
 * Removes noise, marks, and artifacts from scanned pages
 *
 * @param inputPath Path to input image
 * @param outputPath Path to write output image
 * @param aggressive If true, applies stronger cleaning filters
 */
async function cleanScannedPageWithUnpaper(
    inputPath: string,
    outputPath: string,
    aggressive = false,
): Promise<IPreprocessingResult> {
    const bins = getPreprocessingBinaries();

    if (!bins.unpaper) {
        return {
            success: false,
            error: 'Unpaper binary not found. Build with: ./scripts/bundle-leptonica-unpaper-macos.sh',
        };
    }

    const args = [
        '--layout',
        'single',         // Single-page layout
        '--deskew',                   // Deskew
        '--cleanup',                  // Remove artifacts
        '--no-mask-center',          // Don't mask center (preserve document)
        '--despeckle',               // Remove small speckles
    ];

    if (aggressive) {
        args.push(
            '--noise-filter',        // Aggressive noise reduction
            '--blur-filter',          // Slightly blur before OCR (helps with binarization)
        );
    }

    args.push(inputPath, outputPath);

    return runPreprocessing({
        binary: bins.unpaper,
        args,
        timeout: 30000,
    });
}

/**
 * Apply full preprocessing pipeline
 * Combines deskew + cleanup for best OCR results
 *
 * @param inputPath Path to input image
 * @param outputPath Path to write output image
 */
export async function preprocessPageForOcr(
    inputPath: string,
    outputPath: string,
): Promise<IPreprocessingResult> {
    log.debug(`Preprocessing page for OCR: ${inputPath}`);

    return cleanScannedPageWithUnpaper(inputPath, outputPath, false);
}

/**
 * Validate preprocessing setup
 * Check if required binaries are available
 */
export function validatePreprocessingSetup(): {
    valid: boolean;
    available: string[];
    missing: string[];
} {
    const bins = getPreprocessingBinaries();
    const available: string[] = [];
    const missing: string[] = [];

    if (bins.unpaper) {
        available.push('unpaper');
    } else {
        missing.push('unpaper');
    }

    if (bins.leptonica) {
        available.push('leptonica');
    } else {
        missing.push('leptonica');
    }

    return {
        // unpaper is required for preprocessing - leptonica is optional/diagnostic
        valid: !!bins.unpaper,
        available,
        missing,
    };
}

