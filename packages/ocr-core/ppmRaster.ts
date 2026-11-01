/**
 * The same on-white Netpbm bytes, whether pixels arrive on the UI or a worker:
 * RGB PPM by default, or one-channel PGM.
 */
export function createPpmRaster(width: number, height: number, channels: 1 | 3 = 3) {
    const header = new TextEncoder().encode(`${channels === 1 ? 'P5' : 'P6'}\n${width} ${height}\n255\n`);
    const image = new Uint8Array(header.byteLength + width * height * channels);
    image.set(header);
    return {
        image,
        offset: header.byteLength,
        channels,
    };
}

export function writePpmTile(
    target: ReturnType<typeof createPpmRaster>,
    width: number,
    pixels: Uint8ClampedArray,
    left: number,
    top: number,
    tileWidth: number,
    tileHeight: number,
) {
    const {channels} = target;
    for (let row = 0; row < tileHeight; row += 1) {
        let source = row * tileWidth * 4;
        let destination = target.offset + ((top + row) * width + left) * channels;
        for (let column = 0; column < tileWidth; column += 1) {
            const red = pixels[source++]!;
            const green = pixels[source++]!;
            const blue = pixels[source++]!;
            source += 1;
            if (channels === 1) {
                // Integer BT.601 luma, rounded. Poppler's own gray is not proven equal.
                target.image[destination++] = (77 * red + 150 * green + 29 * blue + 128) >> 8;
            } else {
                target.image[destination++] = red;
                target.image[destination++] = green;
                target.image[destination++] = blue;
            }
        }
    }
}
