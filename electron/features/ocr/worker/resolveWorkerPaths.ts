import type { IWorkerPaths } from '@electron/ocr/worker/types';
import { isRecord } from '@contracts/runtimeGuards';

function readRequiredPath(
    data: Record<string, unknown>,
    key: keyof IWorkerPaths,
) {
    const value = data[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`Invalid OCR workerData.${String(key)} path`);
    }
    return value;
}

function readOptionalPath(
    data: Record<string, unknown>,
    key: keyof IWorkerPaths,
): string | undefined {
    const value = data[key];
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
        return undefined;
    }
    return value;
}

export function resolveWorkerPaths(rawWorkerData: unknown): IWorkerPaths {
    if (!isRecord(rawWorkerData)) {
        throw new Error('Invalid OCR workerData payload');
    }
    const paths: IWorkerPaths = {
        tesseractBinary: readRequiredPath(rawWorkerData, 'tesseractBinary'),
        tessdataPath: readRequiredPath(rawWorkerData, 'tessdataPath'),
        pdftoppmBinary: readRequiredPath(rawWorkerData, 'pdftoppmBinary'),
        qpdfBinary: readRequiredPath(rawWorkerData, 'qpdfBinary'),
        tempDir: readRequiredPath(rawWorkerData, 'tempDir'),
    };

    const pdftotextBinary = readOptionalPath(rawWorkerData, 'pdftotextBinary');
    if (pdftotextBinary !== undefined) {
        paths.pdftotextBinary = pdftotextBinary;
    }
    const pdfimagesBinary = readOptionalPath(rawWorkerData, 'pdfimagesBinary');
    if (pdfimagesBinary !== undefined) {
        paths.pdfimagesBinary = pdfimagesBinary;
    }
    const pdfPageOpsBinary = readOptionalPath(rawWorkerData, 'pdfPageOpsBinary');
    if (pdfPageOpsBinary !== undefined) {
        paths.pdfPageOpsBinary = pdfPageOpsBinary;
    }
    const scanCleanupBinary = readOptionalPath(rawWorkerData, 'scanCleanupBinary');
    if (scanCleanupBinary !== undefined) {
        paths.scanCleanupBinary = scanCleanupBinary;
    }
    const popplerDataDir = readOptionalPath(rawWorkerData, 'popplerDataDir');
    if (popplerDataDir !== undefined) {
        paths.popplerDataDir = popplerDataDir;
    }
    const popplerFontConfigDir = readOptionalPath(rawWorkerData, 'popplerFontConfigDir');
    if (popplerFontConfigDir !== undefined) {
        paths.popplerFontConfigDir = popplerFontConfigDir;
    }
    const unpaperBinary = readOptionalPath(rawWorkerData, 'unpaperBinary');
    if (unpaperBinary !== undefined) {
        paths.unpaperBinary = unpaperBinary;
    }

    return paths;
}
