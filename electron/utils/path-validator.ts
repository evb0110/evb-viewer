import { app } from 'electron';
import {
    isAbsolute,
    relative,
    resolve,
    sep,
} from 'path';

export function isAllowedWritePath(filePath: string): boolean {
    if (!filePath || filePath.trim() === '') {
        return false;
    }

    try {
        const absolutePath = resolve(filePath.trim());
        const tempDir = resolve(app.getPath('temp'));
        const relativePath = relative(tempDir, absolutePath);

        // Ensure the path is within temp directory (no '..' escape, no cross-drive absolute result)
        if (relativePath === '' || relativePath === '.') {
            // Writing directly to the temp directory path is not a valid file path.
            return false;
        }

        return (
            relativePath !== '..'
            && !relativePath.startsWith(`..${sep}`)
            && !isAbsolute(relativePath)
        );
    } catch {
        return false;
    }
}

export function isAllowedReadPath(filePath: string): boolean {
    if (!filePath || filePath.trim() === '') {
        return false;
    }

    try {
        const absolutePath = resolve(filePath.trim());
        const tempDir = resolve(app.getPath('temp'));
        const relativePath = relative(tempDir, absolutePath);

        // Ensure the path is within temp directory (no '..' escape, no cross-drive absolute result)
        if (relativePath === '' || relativePath === '.') {
            // Reading directly from the temp directory path is not a valid file path.
            return false;
        }

        return (
            relativePath !== '..'
            && !relativePath.startsWith(`..${sep}`)
            && !isAbsolute(relativePath)
        );
    } catch {
        return false;
    }
}
