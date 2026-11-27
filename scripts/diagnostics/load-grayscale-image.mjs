import {createCanvas, loadImage} from '@napi-rs/canvas';

/**
 * Decode an image through the diagnostic canvas path and expose one grayscale
 * byte per pixel. The white fill keeps transparent pixels equivalent to the
 * white page background used by both diagnostic consumers.
 */
export async function loadGrayscaleImage(path) {
    const image = await loadImage(path);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, image.width, image.height);
    context.drawImage(image, 0, 0);
    const rgba = context.getImageData(0, 0, image.width, image.height).data;
    const data = new Uint8Array(image.width * image.height);
    for (let index = 0, pixel = 0; index < rgba.length; index += 4, pixel += 1) {
        data[pixel] = Math.round(rgba[index] * 0.2126 + rgba[index + 1] * 0.7152 + rgba[index + 2] * 0.0722);
    }
    return {
        data,
        height: image.height,
        width: image.width,
    };
}
