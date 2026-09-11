import {
    extname,
    isAbsolute,
} from 'path';

const ALLOWED_SAVE_EXTENSIONS = new Set([
    '.pdf',
    '.djvu',
    '.djv',
]);

export function isAllowedOriginalSavePath(path: string) {
    if (!isAbsolute(path)) {
        return false;
    }
    return ALLOWED_SAVE_EXTENSIONS.has(extname(path.trimEnd()).toLowerCase());
}
