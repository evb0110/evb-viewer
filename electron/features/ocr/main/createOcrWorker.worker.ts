import { app } from 'electron';
import { existsSync } from 'fs';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import {
    Worker,
    type ResourceLimits,
} from 'worker_threads';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';
import { getOcrToolPaths } from '@electron/features/ocr/main/paths';
import { createLogger } from '@electron/utils/createLogger';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { resolveUnpackedWorkerPath } from '@electron/utils/workerTask';
import { resolveNativePageOpsPath } from '@electron/features/page-ops/public';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import { resolveNativeToolPath } from '@electron/native-tools/resolveNativeToolPath';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const log = createLogger('ocr-ipc');
const OCR_WORKER_RESOURCE_LIMITS: ResourceLimits = {
    maxOldGenerationSizeMb: parseIntegerEnv('EVB_OCR_WORKER_MAX_OLD_MB', 768, 128, 2048),
    maxYoungGenerationSizeMb: parseIntegerEnv('EVB_OCR_WORKER_MAX_YOUNG_MB', 64, 16, 256),
    stackSizeMb: parseIntegerEnv('EVB_OCR_WORKER_STACK_MB', 8, 2, 64),
};

function resolveScanCleanupPath() {
    return resolveNativeToolPath({
        binaryName: process.platform === 'win32' ? 'evb-scan-cleanup.exe' : 'evb-scan-cleanup',
        crateName: 'scan-cleanup',
        currentDir: __dirname,
        envOverridePath: process.env.EVB_SCAN_CLEANUP_PATH,
        isPackaged: __dirname.includes('app.asar'),
    });
}

function getOcrWorkerPath() {
    const defaultPath = join(__dirname, WORKER_BUNDLES_BY_ID.ocr.fileName);
    if (!app.isPackaged && existsSync(defaultPath)) {
        return defaultPath;
    }

    const resolvedPath = resolveUnpackedWorkerPath(__dirname, WORKER_BUNDLES_BY_ID.ocr.fileName);
    if (existsSync(resolvedPath)) {
        return resolvedPath;
    }

    if (existsSync(defaultPath)) {
        return defaultPath;
    }

    const unpackedPath = defaultPath.replace('app.asar', 'app.asar.unpacked');
    throw new Error(`OCR worker script not found. lookedFor="${unpackedPath}", fallback="${defaultPath}"`);
}

export function createOcrWorker(): Worker {
    const paths = getOcrToolPaths();
    const workerPath = getOcrWorkerPath();

    if (!existsSync(workerPath)) {
        throw new Error(`OCR worker unavailable at path: ${workerPath}`);
    }

    log.debug(`Creating OCR worker: ${workerPath}`);
    log.debug(
        `Tool paths: tesseract=${paths.tesseract}, pdftoppm=${paths.pdftoppm}, qpdf=${paths.qpdf}, popplerData=${paths.popplerDataDir?.length ? paths.popplerDataDir : 'none'}, fontConfig=${paths.popplerFontConfigDir?.length ? paths.popplerFontConfigDir : 'none'}`,
    );

    return new Worker(workerPath, {
        workerData: {
            tesseractBinary: paths.tesseract,
            tessdataPath: paths.tessdata,
            pdftoppmBinary: paths.pdftoppm,
            pdftotextBinary: paths.pdftotext,
            pdfimagesBinary: paths.pdfimages,
            popplerDataDir: paths.popplerDataDir,
            popplerFontConfigDir: paths.popplerFontConfigDir,
            qpdfBinary: paths.qpdf,
            pdfPageOpsBinary: resolveNativePageOpsPath() ?? undefined,
            scanCleanupBinary: resolveScanCleanupPath() ?? undefined,
            unpaperBinary: paths.unpaper,
            tempDir: getAppTempDir(),
        },
        resourceLimits: OCR_WORKER_RESOURCE_LIMITS,
    });
}
