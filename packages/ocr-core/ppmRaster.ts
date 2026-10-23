/** The same RGB-on-white PPM bytes, whether pixels arrive on the UI or a worker. */
export function createPpmRaster(width: number, height: number) {
    const header = new TextEncoder().encode(`P6\n${width} ${height}\n255\n`);
    const image = new Uint8Array(header.byteLength + width * height * 3);
    image.set(header);
    return {
        image,
        offset: header.byteLength,
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
    for (let row = 0; row < tileHeight; row += 1) {
        let source = row * tileWidth * 4;
        let destination = target.offset + ((top + row) * width + left) * 3;
        for (let column = 0; column < tileWidth; column += 1) {
            target.image[destination++] = pixels[source++]!;
            target.image[destination++] = pixels[source++]!;
            target.image[destination++] = pixels[source++]!;
            source += 1;
        }
    }
}
