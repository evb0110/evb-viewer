import {
    readFile,
    stat,
    writeFile,
} from 'fs/promises';
import {
    join,
    basename,
} from 'path';
import { app } from 'electron';
import type { IRecentFile } from '@app/types/shared';
import {
    CACHE_TTL_MS,
    MAX_RECENT_FILES,
} from '@electron/config/constants';
import { createLogger } from '@electron/utils/logger';

const logger = createLogger('recent-files');

// In-memory cache for synchronous access (needed for menu building)
let recentFilesCache: IRecentFile[] = [];
let cacheTimestamp = 0;

interface IRecentFilesData {
    version: number;
    files: IRecentFile[];
}

function getStoragePath(): string {
    return join(app.getPath('userData'), 'recent-files.json');
}

async function pathExists(filePath: string) {
    try {
        await stat(filePath);
        return true;
    } catch {
        return false;
    }
}

async function filterExistingFiles(files: IRecentFile[]) {
    const checks = await Promise.all(files.map(async (file) => {
        const exists = await pathExists(file.originalPath);
        return exists ? file : null;
    }));

    return checks.filter((file): file is IRecentFile => file !== null);
}

async function loadRecentFilesData(): Promise<IRecentFilesData> {
    const storagePath = getStoragePath();
    try {
        const content = await readFile(storagePath, 'utf-8');
        return JSON.parse(content);
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
            return {
                version: 1,
                files: [],
            };
        }
        logger.error(`Failed to load recent files: ${err instanceof Error ? err.message : String(err)}`);
        return {
            version: 1,
            files: [],
        };
    }
}

async function saveRecentFilesData(data: IRecentFilesData): Promise<void> {
    const storagePath = getStoragePath();
    try {
        await writeFile(storagePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
        logger.error(`Failed to save recent files: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
    }
}

export async function addRecentFile(originalPath: string): Promise<void> {
    // Invalidate cache before mutation
    cacheTimestamp = 0;

    if (!originalPath) {
        return;
    }

    // Get file info with race-safe stat
    let fileSize: number;
    try {
        const st = await stat(originalPath);
        fileSize = st.size;
    } catch {
        // File doesn't exist or became unreadable
        return;
    }

    const data = await loadRecentFilesData();

    // Remove if already exists (to update timestamp)
    data.files = data.files.filter(f => f.originalPath !== originalPath);

    // Get file info
    const fileName = basename(originalPath);

    // Add to front
    data.files.unshift({
        originalPath,
        fileName,
        timestamp: Date.now(),
        fileSize,
    });

    // Enforce limit
    if (data.files.length > MAX_RECENT_FILES) {
        data.files = data.files.slice(0, MAX_RECENT_FILES);
    }

    await saveRecentFilesData(data);

    // Update cache
    recentFilesCache = data.files;
    cacheTimestamp = Date.now();
}

export async function getRecentFiles(): Promise<IRecentFile[]> {
    // Use cache if fresh
    if (Date.now() - cacheTimestamp < CACHE_TTL_MS) {
        // Still validate existence
        return filterExistingFiles(recentFilesCache);
    }

    // Refresh cache from disk
    const data = await loadRecentFilesData();
    const validFiles = await filterExistingFiles(data.files);

    // Update cache
    recentFilesCache = validFiles;
    cacheTimestamp = Date.now();

    // If files were removed, save updated list
    if (validFiles.length !== data.files.length) {
        data.files = validFiles;
        await saveRecentFilesData(data);
    }

    return validFiles;
}

export async function removeRecentFile(originalPath: string): Promise<void> {
    // Invalidate cache before mutation
    cacheTimestamp = 0;

    const data = await loadRecentFilesData();
    data.files = data.files.filter(f => f.originalPath !== originalPath);
    await saveRecentFilesData(data);

    // Update cache
    recentFilesCache = data.files;
    cacheTimestamp = Date.now();
}

export async function clearRecentFiles(): Promise<void> {
    // Invalidate cache before mutation
    cacheTimestamp = 0;
    recentFilesCache = [];

    await saveRecentFilesData({
        version: 1,
        files: [],
    });
    cacheTimestamp = Date.now();
}

/**
 * Get recent files synchronously from cache (for menu building)
 * Returns array of file paths
 */
export function getRecentFilesSync(): string[] {
    return recentFilesCache.map(f => f.originalPath);
}

/**
 * Initialize the recent files cache
 * Call this during app startup before menu is built
 */
export async function initRecentFilesCache(): Promise<void> {
    const files = await getRecentFiles();
    recentFilesCache = files;
}
