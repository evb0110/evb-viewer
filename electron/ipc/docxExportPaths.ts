import {
    extname,
    resolve,
} from 'path';

const allowedDocxWritePaths = new Set<string>();

function normalizePath(filePath: string): string {
    return resolve(filePath.trim());
}

export function normalizeDocxPath(filePath: string): string {
    const normalizedPath = normalizePath(filePath);
    if (extname(normalizedPath).toLowerCase() !== '.docx') {
        throw new Error('Invalid file type: only DOCX files are allowed');
    }
    return normalizedPath;
}

export function allowDocxWritePath(filePath: string) {
    allowedDocxWritePaths.add(normalizeDocxPath(filePath));
}

export function consumeAllowedDocxWritePath(filePath: string): boolean {
    const normalizedPath = normalizeDocxPath(filePath);
    if (!allowedDocxWritePaths.has(normalizedPath)) {
        return false;
    }
    allowedDocxWritePaths.delete(normalizedPath);
    return true;
}
