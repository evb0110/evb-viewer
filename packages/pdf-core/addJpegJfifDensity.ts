/**
 * Records a density in a JPEG's JFIF APP0 header, the only place a JPEG keeps
 * its physical size. Canvas encoders write that header with no units, so the
 * density is stored as dots per inch. Bytes without a JFIF header with room
 * for the density fields are returned unchanged.
 */
export function addJpegJfifDensity(jpegBytes: Uint8Array, dpi: number) {
    if (!Number.isFinite(dpi) || dpi <= 0 || jpegBytes.length < 18) {
        return jpegBytes;
    }

    const view = new DataView(jpegBytes.buffer, jpegBytes.byteOffset, jpegBytes.byteLength);
    // An SOI, then an APP0 segment whose length covers bytes 4 to 17 and whose identifier is "JFIF\0".
    const hasJfifHeader = view.getUint16(0) === 0xffd8
        && view.getUint16(2) === 0xffe0
        && view.getUint16(4) >= 14
        && String.fromCharCode(...jpegBytes.subarray(6, 11)) === 'JFIF\0';
    if (!hasJfifHeader) {
        return jpegBytes;
    }

    const density = Math.min(0xffff, Math.max(1, Math.round(dpi)));
    const output = jpegBytes.slice();
    const outputView = new DataView(output.buffer);
    outputView.setUint8(13, 1);
    outputView.setUint16(14, density);
    outputView.setUint16(16, density);
    return output;
}
