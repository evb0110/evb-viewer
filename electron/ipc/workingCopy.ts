import { app } from 'electron';
import {
    existsSync,
    mkdirSync,
    rmSync,
} from 'fs';
import { copyFile } from 'fs/promises';
import {
    join,
    basename,
    dirname,
    resolve,
    relative,
    sep,
    isAbsolute,
} from 'path';

export const workingCopyMap = new Map<string, string>();

export async function createWorkingCopy(originalPath: string): Promise<string> {
    const tempDir = app.getPath('temp');
    const sessionId = `pdf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workDir = join(tempDir, `pdf-work-${sessionId}`);

    mkdirSync(workDir, { recursive: true });

    const fileName = basename(originalPath);
    const workingPath = join(workDir, fileName);
    await copyFile(originalPath, workingPath);

    workingCopyMap.set(workingPath, originalPath);

    return workingPath;
}

export async function handleFileSave(
    _event: Electron.IpcMainInvokeEvent,
    workingPath: string,
): Promise<boolean> {
    if (!workingPath || workingPath.trim() === '') {
        throw new Error('Invalid file path');
    }

    const normalizedWorkingPath = workingPath.trim();
    const originalPath = workingCopyMap.get(normalizedWorkingPath);

    if (!originalPath) {
        throw new Error('No original path found for this working copy');
    }

    try {
        await copyFile(normalizedWorkingPath, originalPath);
        return true;
    } catch (err) {
        throw new Error(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
    }
}

function cleanupWorkingCopyDirectory(workingPath: string) {
    const normalizedPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedPath) {
        return;
    }

    try {
        const tempDir = resolve(app.getPath('temp'));
        const workDir = resolve(dirname(normalizedPath));
        const relativePath = relative(tempDir, workDir);
        const workDirName = basename(workDir);

        const isWithinTemp = (
            relativePath !== '..'
            && !relativePath.startsWith(`..${sep}`)
            && !isAbsolute(relativePath)
        );
        const isWorkingCopyDir = workDirName.startsWith('pdf-work-');

        if (isWithinTemp && isWorkingCopyDir) {
            if (existsSync(workDir)) {
                rmSync(workDir, {
                    recursive: true,
                    force: true,
                });
            }

            const ocrDir = `${workDir}.ocr`;
            if (existsSync(ocrDir)) {
                rmSync(ocrDir, {
                    recursive: true,
                    force: true,
                });
            }
        }
    } catch (err) {
        console.warn('[cleanup] Failed to delete working directory:', err);
    }
}

export function cleanupWorkingCopy(workingPath: string) {
    const normalizedPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedPath) {
        return;
    }

    workingCopyMap.delete(normalizedPath);
    cleanupWorkingCopyDirectory(normalizedPath);
}

export function clearAllWorkingCopies() {
    for (const workingPath of workingCopyMap.keys()) {
        cleanupWorkingCopyDirectory(workingPath);
    }
    workingCopyMap.clear();
}
