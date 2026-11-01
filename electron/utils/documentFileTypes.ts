import {extname} from 'path';
import {
    isSupportedOpenExtension,
    PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS,
} from '@pdf-core/documentOpenFileTypes';

export {PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS};

const SUPPORTED_IMAGE_EXTENSION_SET = new Set<string>(
    PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS,
);
// Classify suffix punctuation only; callers retain the exact native path for I/O.
export function getInputFileExtension(filePath: string) {
    return extname(filePath.replace(/[\s"']+$/u, '')).toLowerCase();
}

export function isPdfPath(filePath: string) {
    return getInputFileExtension(filePath) === '.pdf';
}

export function isDjvuPath(filePath: string) {
    const extension = getInputFileExtension(filePath);
    return extension === '.djvu' || extension === '.djv';
}

export function isImagePath(filePath: string) {
    return SUPPORTED_IMAGE_EXTENSION_SET.has(getInputFileExtension(filePath));
}

export function isPdfOrImagePath(filePath: string) {
    return isPdfPath(filePath) || isImagePath(filePath);
}

export function isSupportedOpenPath(filePath: string) {
    return isSupportedOpenExtension(getInputFileExtension(filePath));
}
