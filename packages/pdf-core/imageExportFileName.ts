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
