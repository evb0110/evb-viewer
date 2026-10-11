import {createCanvas} from '@napi-rs/canvas';

export function createLargeAssistantImage(width = 1200, height = 1000) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    const pixels = context.createImageData(width, height);
    let seed = 42;
    for (let index = 0; index < pixels.data.length; index += 1) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        pixels.data[index] = index % 4 === 3 ? 255 : seed & 255;
    }
    context.putImageData(pixels, 0, 0);
    return canvas.toBuffer('image/png');
}
