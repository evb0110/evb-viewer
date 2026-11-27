export async function writePngBlobToClipboard(blob: Blob) {
    if (typeof ClipboardItem !== 'function') {
        throw new Error('ClipboardItem API is unavailable');
    }
    const clipboardValue = (globalThis.navigator as Omit<Navigator, 'clipboard'> & {clipboard?: unknown}).clipboard;
    if (
        typeof clipboardValue !== 'object' ||
        clipboardValue === null ||
        !('write' in clipboardValue) ||
        typeof clipboardValue.write !== 'function'
    ) {
        throw new Error('Clipboard write API is unavailable');
    }

    const clipboardItem = new ClipboardItem({'image/png': blob});
    const clipboard = clipboardValue as Pick<Clipboard, 'write'>;
    await clipboard.write([clipboardItem]);
}
