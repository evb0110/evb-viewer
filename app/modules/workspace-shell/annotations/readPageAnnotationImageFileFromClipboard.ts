const PREFERRED_CLIPBOARD_IMAGE_TYPES = [
    'image/apng',
    'image/avif',
    'image/bmp',
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/x-icon',
] as const;

function extensionForMimeType(mimeType: string) {
    switch (mimeType) {
        case 'image/apng':
            return 'apng';
        case 'image/avif':
            return 'avif';
        case 'image/bmp':
            return 'bmp';
        case 'image/gif':
            return 'gif';
        case 'image/jpeg':
            return 'jpg';
        case 'image/png':
            return 'png';
        case 'image/webp':
            return 'webp';
        case 'image/x-icon':
            return 'ico';
        default:
            return 'img';
    }
}

export async function readPageAnnotationImageFileFromClipboard() {
    if (!globalThis.navigator?.clipboard || typeof globalThis.navigator.clipboard.read !== 'function') {
        return null;
    }

    const items = await globalThis.navigator.clipboard.read();
    for (const item of items) {
        const mimeType = PREFERRED_CLIPBOARD_IMAGE_TYPES.find(type => item.types.includes(type));
        if (!mimeType) {
            continue;
        }

        const blob = await item.getType(mimeType);
        const FileConstructor = Reflect.get(globalThis, 'File') as typeof File | undefined;
        if (!FileConstructor) {
            return null;
        }
        return new FileConstructor([blob], `clipboard-image.${extensionForMimeType(mimeType)}`, {
            type: mimeType,
            lastModified: Date.now(),
        });
    }

    return null;
}
