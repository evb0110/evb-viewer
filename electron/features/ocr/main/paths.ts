import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { getRuntimeTessdataDir } from '@electron/features/ocr/languageModels';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { resolveNativeToolPath } from '@electron/native-tools/resolveNativeToolPath';
import { resolveNativePageOpsPath } from '@electron/features/page-ops/public';
import { getAppTempDir } from '@electron/utils/appTempDir';
import {runtimeConfig} from '@electron/runtimeConfig';
import type { IOcrPipelinePaths } from '@electron/features/ocr/pipeline/types';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Native tools, installed models and scratch directory for one OCR job. */
export function resolveOcrPipelinePaths(): IOcrPipelinePaths {
    const pdfPaths = getPdfNativeToolPaths();
    const pdfPageOpsBinary = resolveNativePageOpsPath() ?? undefined;
    const scanCleanupBinary = resolveNativeToolPath({
        binaryName: process.platform === 'win32' ? 'evb-scan-cleanup.exe' : 'evb-scan-cleanup',
        crateName: 'scan-cleanup',
        currentDir: __dirname,
        envOverridePath: runtimeConfig.scanCleanupPath,
        isPackaged: __dirname.includes('app.asar'),
    }) ?? undefined;
    return {
        tessdataPath: getRuntimeTessdataDir(),
        pdftoppmBinary: pdfPaths.pdftoppm,
        pdftotextBinary: pdfPaths.pdftotext,
        qpdfBinary: pdfPaths.qpdf,
        tempDir: getAppTempDir(),
        ...(pdfPaths.pdfimages === undefined ? {} : {pdfimagesBinary: pdfPaths.pdfimages}),
        ...(pdfPaths.popplerDataDir === undefined ? {} : {popplerDataDir: pdfPaths.popplerDataDir}),
        ...(pdfPaths.popplerFontConfigDir === undefined ? {} : {popplerFontConfigDir: pdfPaths.popplerFontConfigDir}),
        ...(pdfPageOpsBinary === undefined ? {} : {pdfPageOpsBinary}),
        ...(scanCleanupBinary === undefined ? {} : {scanCleanupBinary}),
    };
}
