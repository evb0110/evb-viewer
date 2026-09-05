import path from 'node:path';

const PACKAGE_NAMES = new Set([
    'pdfjs-dist',
    '@evb0110/pdfjs-dist',
    '@pdfjs-dist/pdfjs-dist',
]);
const PACKAGE_CONTENT = new Set([
    'build',
    'legacy',
    'web',
    'types',
    'cmaps',
    'standard_fonts',
    'wasm',
    'iccs',
    'image_decoders',
    'LICENSE',
    'NOTICE',
    'README.md',
    'package.json',
]);
const LINKED_PACKAGE_FILES = new Set([
    'pdf.mjs',
    'pdf.worker.mjs',
    'pdf.min.mjs',
    'pdf.sandbox.mjs',
    'pdf_viewer.mjs',
    'package.json',
]);

function slashSegments(filePath) {
    return path.posix.normalize(filePath.replaceAll('\\', '/')).split('/').filter(Boolean);
}

export function isPdfjsPackagePath(filePath) {
    const segments = slashSegments(filePath);
    for (let index = 0; index < segments.length; index += 1) {
        const name = segments[index] === 'pdfjs-dist'
            ? (segments[index - 1] === '@evb0110' || segments[index - 1] === '@pdfjs-dist'
                ? `${segments[index - 1]}/${segments[index]}` : segments[index])
            : null;
        if (!name || !PACKAGE_NAMES.has(name)) continue;
        const parent = segments[index - (name.includes('/') ? 2 : 1)];
        const child = segments[index + 1];
        if (parent === 'node_modules' || (PACKAGE_CONTENT.has(child) && LINKED_PACKAGE_FILES.has(segments[index + 2]))) {
            return true;
        }
    }
    return false;
}

export function isPdfjsPackageId(filePath) {
    return isPdfjsPackagePath(filePath.replaceAll('\\', '/'));
}
