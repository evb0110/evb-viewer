const BROWSER_COMBINE_IMAGE_EXTENSIONS = new Set([
    '.bmp',
    '.gif',
    '.jpeg',
    '.jpg',
    '.png',
    '.tif',
    '.tiff',
    '.webp',
]);

function getBrowserFileExtension(fileName: string) {
    const lowerName = fileName.toLowerCase();
    const lastDot = lowerName.lastIndexOf('.');
    return lastDot >= 0 ? lowerName.slice(lastDot) : '';
}

function toBrowserOwnedArrayBuffer(
    bytes: Uint8Array,
    options: { copy?: boolean } = {},
) {
    if (options.copy) {
        const copied = new Uint8Array(bytes.byteLength);
        copied.set(bytes);
        return copied.buffer;
    }

    if (
        bytes.buffer instanceof ArrayBuffer
        && bytes.byteOffset === 0
        && bytes.byteLength === bytes.buffer.byteLength
    ) {
        return bytes.buffer;
    }

    const copied = new Uint8Array(bytes.byteLength);
    copied.set(bytes);
    return copied.buffer;
}

function buildBrowserByteLimitError(
    label: string,
    maxBytes: number,
    noun: string,
    hint?: string,
) {
    return new Error(
        `${label} is unavailable in the browser for ${noun} larger than ${Math.floor(maxBytes / (1024 * 1024))}MB`
        + (hint ? (hint.startsWith('.') ? hint : ` ${hint}`) : ''),
    );
}

export {
    BROWSER_COMBINE_IMAGE_EXTENSIONS,
    buildBrowserByteLimitError,
    getBrowserFileExtension,
    toBrowserOwnedArrayBuffer,
};
