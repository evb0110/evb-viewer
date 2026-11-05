export const IMAGE_EXPORT_FORMATS = {
    jpeg: {
        extension: '.jpg',
        mimeType: 'image/jpeg',
        extensions: [
            '.jpg',
            '.jpeg',
        ],
    },
    png: {
        extension: '.png',
        mimeType: 'image/png',
        extensions: ['.png'],
    },
    tiff: {
        extension: '.tif',
        mimeType: 'image/tiff',
        extensions: [
            '.tif',
            '.tiff',
        ],
    },
} as const;

export type TImageExportFormat = keyof typeof IMAGE_EXPORT_FORMATS;

export function resolveImageExportFormat(fileName: string, fallback: TImageExportFormat = 'png'): TImageExportFormat {
    const extension = fileName.trim().match(/\.[^.]+$/u)?.[0].toLowerCase();
    for (const format of Object.keys(IMAGE_EXPORT_FORMATS) as TImageExportFormat[]) {
        if (IMAGE_EXPORT_FORMATS[format].extensions.some(candidate => candidate === extension)) return format;
    }
    return fallback;
}

/** Apply to a suggestion or a path we own, never to an already-selected handle. */
export function normalizeImageExportFileName(fileName: string, format: TImageExportFormat) {
    const name = fileName.trim();
    if (IMAGE_EXPORT_FORMATS[format].extensions.some(extension => name.toLowerCase().endsWith(extension))) return name;
    return `${name.replace(/\.(?:jpe?g|png|tiff?)$/iu, '').replace(/\.+$/u, '')}${IMAGE_EXPORT_FORMATS[format].extension}`;
}

export const MAX_PATH_COMPONENT_BYTES = 255;

export function truncateUtf8PathComponent(value: string, maxBytes = MAX_PATH_COMPONENT_BYTES) {
    if (maxBytes < 0) throw new Error('Path component byte budget must not be negative');
    const encoder = new TextEncoder();
    let byteLength = 0;
    let result = '';
    for (const character of value) {
        const characterBytes = encoder.encode(character).byteLength;
        if (byteLength + characterBytes > maxBytes) break;
        byteLength += characterBytes;
        result += character;
    }
    return result;
}

export function buildOutputFileNameWithSuffix(fileName: string, suffix: string) {
    const dot = fileName.lastIndexOf('.');
    const extension = dot > 0 && fileName !== '..' ? fileName.slice(dot) : '';
    const stem = extension ? fileName.slice(0, -extension.length) : fileName;
    const tail = `${suffix}${extension}`;
    const tailBytes = new TextEncoder().encode(tail).byteLength;
    if (tailBytes > MAX_PATH_COMPONENT_BYTES) {
        throw new Error('Output filename suffix exceeds the filesystem component limit');
    }
    return `${truncateUtf8PathComponent(stem, MAX_PATH_COMPONENT_BYTES - tailBytes)}${tail}`;
}

export function buildMultiPageTiffOutputSuffixes(partCount: number) {
    return partCount <= 1 ? [''] : Array.from({length: partCount}, (_, index) =>
        `-part-${String(index + 1).padStart(3, '0')}`,
    );
}
