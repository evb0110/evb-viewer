import {
    readFile,
    writeFile,
} from 'fs/promises';
import {
    existsSync,
    statSync,
} from 'fs';
import {
    join,
    basename,
} from 'path';
import { app } from 'electron';

const MAX_RECENT_FILES = 10;

// In-memory cache for synchronous access (needed for menu building)
let recentFilesCache: IRecentFile[] = [];

export interface IRecentFile {
    originalPath: string;
    fileName: string;
    timestamp: number;
    fileSize?: number;
}

interface IRecentFilesData {
    version: number;
    files: IRecentFile[];
}

function getStoragePath(): string {
    return join(app.getPath('userData'), 'recent-files.json');
}

async function loadRecentFilesData(): Promise<IRecentFilesData> {
    const storagePath = getStoragePath();
    if (!existsSync(storagePath)) {
        return {
            version: 1,
            files: [], 
        };
    }

    try {
        const content = await readFile(storagePath, 'utf-8');
        return JSON.parse(content);
    } catch (err) {
        console.error('Failed to load recent files:', err);
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
        console.error('Failed to save recent files:', err);
        throw err;
    }
}

export async function addRecentFile(originalPath: string): Promise<void> {
    if (!originalPath || !existsSync(originalPath)) {
        return;
    }

    const data = await loadRecentFilesData();

    // Remove if already exists (to update timestamp)
    data.files = data.files.filter(f => f.originalPath !== originalPath);

    // Get file info
    const fileName = basename(originalPath);
    const fileSize = statSync(originalPath).size;

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
}

export async function getRecentFiles(): Promise<IRecentFile[]> {
    const data = await loadRecentFilesData();
    // Filter out files that no longer exist
    const validFiles = data.files.filter(f => existsSync(f.originalPath));

    // If files were removed, save updated list
    if (validFiles.length !== data.files.length) {
        data.files = validFiles;
        await saveRecentFilesData(data);
    }

    return validFiles;
}

export async function removeRecentFile(originalPath: string): Promise<void> {
    const data = await loadRecentFilesData();
    data.files = data.files.filter(f => f.originalPath !== originalPath);
    await saveRecentFilesData(data);

    // Update cache
    recentFilesCache = data.files;
}

export async function clearRecentFiles(): Promise<void> {
    await saveRecentFilesData({
        version: 1,
        files: [],
    });
    recentFilesCache = [];
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
