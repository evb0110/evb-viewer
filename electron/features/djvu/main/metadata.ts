import { open } from 'node:fs/promises';
import {
    basename,
    dirname,
    resolve,
} from 'node:path';
import { DEFAULT_DJVU_SOURCE_DPI } from '@contracts/djvuConversionPolicy';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import {
    buildDjvuPageComponentMap,
    normalizeDjvuOutlineTree,
} from '@djvu-core/djvuOutline';
import { runDjvuEngine } from '@electron/features/djvu/main/djvuEnginePool';
import { getCachedDjvuHasText } from '@electron/features/djvu/main/getCachedDjvuHasText';
import { createLogger } from '@electron/utils/createLogger';
import { isAbortError } from '@electron/utils/abort';
import { getUnprovenNativeTerminationDetail } from '@electron/utils/nativeTerminationProof';

const logger = createLogger('djvu-metadata');
const DJVU_METADATA_TIMEOUT_MS = 20_000;

interface IDjvuMetadataOptions {
    signal?: AbortSignal;
    onTerminationProof?: (proof: Promise<boolean>) => void;
    maxStdoutBytes?: number;
}

export async function getDjvuPageCount(filePath: string, options: IDjvuMetadataOptions = {}) {
    const info = await runDjvuEngine<'getDocInfo'>({
        type: 'getDocInfo',
        djvuPath: filePath,
    }, {
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: DJVU_METADATA_TIMEOUT_MS,
    });
    if (!Number.isSafeInteger(info.pageCount) || info.pageCount <= 0) {
        throw new Error(`Invalid DjVu page count: ${info.pageCount}`);
    }
    return info.pageCount;
}

export async function getDjvuOutlineBookmarks(
    filePath: string,
    options: IDjvuMetadataOptions = {},
): Promise<IPdfBookmarkEntry[]> {
    const outline = await runDjvuEngine<'getOutline'>({
        type: 'getOutline',
        djvuPath: filePath,
    }, {
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: DJVU_METADATA_TIMEOUT_MS,
    });
    if (outline.raw.length === 0) {
        return [];
    }
    const pageComponents = new Map<string, number>(Object.entries(outline.pageComponents));
    return normalizeDjvuOutlineTree(outline.raw, pageComponents, outline.pageCount);
}

export async function getDjvuPageComponentMap(filePath: string, options: IDjvuMetadataOptions = {}) {
    const info = await runDjvuEngine<'getDocInfo'>({
        type: 'getDocInfo',
        djvuPath: filePath,
    }, {
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: DJVU_METADATA_TIMEOUT_MS,
    });
    return buildDjvuPageComponentMap(info.files);
}

export async function getDjvuMetadata(
    filePath: string,
    options: IDjvuMetadataOptions = {},
): Promise<Record<string, string>> {
    try {
        return await runDjvuEngine<'getMetadata'>({
            type: 'getMetadata',
            djvuPath: filePath,
        }, {
            ...(options.signal ? { signal: options.signal } : {}),
            timeoutMs: DJVU_METADATA_TIMEOUT_MS,
        });
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        logger.debug(`Failed to read DjVu metadata for ${filePath}: ${String(error)}`);
        return {};
    }
}

/**
 * The files an indirect document's pages and shared dictionaries live in, or
 * none for a bundled or single-page document, whose one file holds them all.
 */
export async function getDjvuIndirectComponentPaths(filePath: string, options: IDjvuMetadataOptions = {}) {
    const header = Buffer.alloc(25);
    const file = await open(filePath, 'r');
    try {
        await file.read(header, 0, header.length, 0);
    } finally {
        await file.close();
    }
    const isIndirect = header.toString('latin1', 0, 4) === 'AT&T'
        && header.toString('latin1', 12, 20) === 'DJVMDIRM'
        && (header[24]! & 0x80) === 0;
    if (!isIndirect) {
        return [];
    }
    const info = await runDjvuEngine<'getDocInfo'>({
        type: 'getDocInfo',
        djvuPath: filePath,
    }, {
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: DJVU_METADATA_TIMEOUT_MS,
    });
    const names = info.files.map(entry => entry.id || entry.name).filter(Boolean);
    if (names.some(name => name !== basename(name) || name === '.' || name === '..')) {
        throw new Error('Indirect DjVu names a component outside its folder');
    }
    return [...new Set(names.map(name => resolve(dirname(filePath), name)))];
}

export async function getDjvuResolution(filePath: string, options: IDjvuMetadataOptions = {}) {
    try {
        const info = await runDjvuEngine<'getDocInfo'>({
            type: 'getDocInfo',
            djvuPath: filePath,
        }, {
            ...(options.signal ? { signal: options.signal } : {}),
            timeoutMs: DJVU_METADATA_TIMEOUT_MS,
        });
        return Number.isSafeInteger(info.sourceDpi) && info.sourceDpi > 0 ? info.sourceDpi : DEFAULT_DJVU_SOURCE_DPI;
    } catch (error) {
        if (isAbortError(error) || getUnprovenNativeTerminationDetail(error) !== undefined) {
            throw error;
        }
        logger.debug(`Failed to read DjVu resolution for ${filePath}: ${String(error)}`);
        return DEFAULT_DJVU_SOURCE_DPI;
    }
}

export async function getDjvuHasText(filePath: string, options: IDjvuMetadataOptions = {}) {
    try {
        return await getCachedDjvuHasText(filePath, options.signal);
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        logger.debug(`Failed to detect DjVu text layer for ${filePath}: ${String(error)}`);
        return false;
    }
}
