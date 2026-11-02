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

interface IClipboardLike {read: Clipboard['read'];}

/**
 * The image a user's paste event carries. Unlike `navigator.clipboard.read`,
 * it needs no clipboard permission, so it works where a browser blocks that read.
 * Read it while the event is dispatched; the data is unreadable afterwards.
 */
export function readPageAnnotationImageFileFromPasteData(data: {readonly files: ArrayLike<File>} | null) {
    const imageTypes: readonly string[] = PREFERRED_CLIPBOARD_IMAGE_TYPES;
    return Array.from(data?.files ?? []).find(file => imageTypes.includes(file.type)) ?? null;
}

function isClipboardLike(value: unknown): value is IClipboardLike {
    return typeof value === 'object'
        && value !== null
        && typeof Reflect.get(value, 'read') === 'function';
}

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
    const navigatorValue: unknown = Reflect.get(globalThis, 'navigator');
    const clipboard: unknown = navigatorValue && typeof navigatorValue === 'object'
        ? Reflect.get(navigatorValue, 'clipboard')
        : null;
    if (!isClipboardLike(clipboard)) {
        return null;
    }

    const items = await clipboard.read();
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
