import {
    basename,
    isAbsolute,
    relative,
    resolve,
    sep,
} from 'path';

/**
 * Validates that a DjVu temporary PDF path stays inside the OS temp directory
 * and matches the expected generated filename pattern.
 */
export function isAllowedDjvuTempPdfPath(tempPdfPath: string, tempDirPath: string): boolean {
    if (!tempPdfPath || tempPdfPath.trim() === '') {
        return false;
    }

    try {
        const absolutePath = resolve(tempPdfPath.trim());
        const tempDir = resolve(tempDirPath);
        const relativePath = relative(tempDir, absolutePath);

        if (
            relativePath === ''
            || relativePath === '.'
            || relativePath === '..'
            || relativePath.startsWith(`..${sep}`)
            || isAbsolute(relativePath)
        ) {
            return false;
        }

        const fileName = basename(absolutePath).toLowerCase();
        return fileName.startsWith('djvu-') && fileName.endsWith('.pdf');
    } catch {
        return false;
    }
}
