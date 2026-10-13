const PNG_METERS_PER_INCH = 0.0254;

function writeUint32Be(target: Uint8Array, offset: number, value: number) {
    target[offset] = (value >>> 24) & 0xff;
    target[offset + 1] = (value >>> 16) & 0xff;
    target[offset + 2] = (value >>> 8) & 0xff;
    target[offset + 3] = value & 0xff;
}

/** Offset of the first chunk of `type`, or -1. Walks chunk lengths from the signature. */
function findChunkOffset(pngBytes: Uint8Array, type: string) {
    const view = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
    for (let offset = 8; offset + 12 <= pngBytes.length;) {
        if (String.fromCharCode(...pngBytes.subarray(offset + 4, offset + 8)) === type) {
            return offset;
        }
        offset += 12 + view.getUint32(offset, false);
    }
    return -1;
}

function crc32(bytes: Uint8Array) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

export function addPngPhysicalResolution(pngBytes: Uint8Array, dpi: number) {
    if (!Number.isFinite(dpi) || dpi <= 0 || pngBytes.length < 20) {
        return pngBytes;
    }

    const pixelsPerMeter = Math.max(1, Math.round(dpi / PNG_METERS_PER_INCH));
    const chunk = new Uint8Array(4 + 4 + 9 + 4);
    writeUint32Be(chunk, 0, 9);
    chunk.set([
        0x70,
        0x48,
        0x59,
        0x73,
    ], 4);
    writeUint32Be(chunk, 8, pixelsPerMeter);
    writeUint32Be(chunk, 12, pixelsPerMeter);
    chunk[16] = 1;
    writeUint32Be(chunk, 17, crc32(chunk.subarray(4, 17)));

    const iendOffset = pngBytes.length - 12;
    if (
        pngBytes[iendOffset + 4] !== 0x49
        || pngBytes[iendOffset + 5] !== 0x45
        || pngBytes[iendOffset + 6] !== 0x4e
        || pngBytes[iendOffset + 7] !== 0x44
    ) {
        return pngBytes;
    }

    // PNG requires pHYs before the first IDAT; readers that stop at image data miss it.
    const idatOffset = findChunkOffset(pngBytes, 'IDAT');
    if (idatOffset < 0) {
        return pngBytes;
    }

    const result = new Uint8Array(pngBytes.length + chunk.length);
    result.set(pngBytes.subarray(0, idatOffset), 0);
    result.set(chunk, idatOffset);
    result.set(pngBytes.subarray(idatOffset), idatOffset + chunk.length);
    return result;
}
