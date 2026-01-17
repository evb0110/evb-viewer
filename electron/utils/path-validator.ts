import { app } from 'electron';
import {
    isAbsolute,
    relative,
    resolve,
    sep,
} from 'path';

export function isAllowedWritePath(filePath: string): boolean {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
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
