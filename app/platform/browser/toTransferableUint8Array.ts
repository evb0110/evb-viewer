export function toTransferableUint8Array(data: Uint8Array): Uint8Array<ArrayBuffer> {
    if (
        data.buffer instanceof ArrayBuffer
        && data.byteOffset === 0
        && data.byteLength === data.buffer.byteLength
    ) {
        return data as Uint8Array<ArrayBuffer>;
    }

    if (
        data.byteOffset === 0
        && data.byteLength === data.buffer.byteLength
    ) {
        return new Uint8Array(data);
    }

    return data.slice();
}
