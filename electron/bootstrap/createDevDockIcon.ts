import {nativeImage} from 'electron';

interface IRgbaColor {
    r: number;
    g: number;
    b: number;
    a: number;
}

function blendColorChannel(base: number, overlay: number, alpha: number) {
    return Math.round((base * (255 - alpha) + overlay * alpha) / 255);
}

function fillBitmapRect(
    bitmap: Uint8ClampedArray,
    width: number,
    height: number,
    startX: number,
    startY: number,
    rectWidth: number,
    rectHeight: number,
    color: IRgbaColor,
) {
    const boundedStartX = Math.max(startX, 0);
    const boundedStartY = Math.max(startY, 0);
    const endX = Math.min(boundedStartX + Math.max(rectWidth, 0), width);
    const endY = Math.min(boundedStartY + Math.max(rectHeight, 0), height);
    for (let y = boundedStartY; y < endY; y += 1) {
        for (let x = boundedStartX; x < endX; x += 1) {
            const offset = (y * width + x) * 4;
            const blue = bitmap[offset] ?? 0;
            const green = bitmap[offset + 1] ?? 0;
            const red = bitmap[offset + 2] ?? 0;
            const alpha = bitmap[offset + 3] ?? 0;
            bitmap[offset] = blendColorChannel(blue, color.b, color.a);
            bitmap[offset + 1] = blendColorChannel(green, color.g, color.a);
            bitmap[offset + 2] = blendColorChannel(red, color.r, color.a);
            bitmap[offset + 3] = Math.max(alpha, color.a);
        }
    }
}

export function createDevDockIcon(devDockIconPath: string) {
    const baseIcon = nativeImage.createFromPath(devDockIconPath);
    if (baseIcon.isEmpty()) {
        return null;
    }

    const {width, height} = baseIcon.getSize();
    if (width <= 0 || height <= 0) {
        return null;
    }

    const bitmap = new Uint8ClampedArray(baseIcon.toBitmap());
    const markerSize = Math.max(Math.floor(Math.min(width, height) * 0.28), 56);
    const inset = Math.max(Math.floor(markerSize * 0.12), 8);
    const borderWidth = Math.max(Math.floor(markerSize * 0.08), 4);
    const anchorX = width - markerSize - inset;
    const anchorY = inset;

    fillBitmapRect(bitmap, width, height, anchorX, anchorY, markerSize, markerSize, {
        r: 219,
        g: 39,
        b: 39,
        a: 255,
    });
    fillBitmapRect(
        bitmap,
        width,
        height,
        anchorX + borderWidth,
        anchorY + borderWidth,
        markerSize - borderWidth * 2,
        markerSize - borderWidth * 2,
        {
            r: 255,
            g: 255,
            b: 255,
            a: 255,
        },
    );
    fillBitmapRect(
        bitmap,
        width,
        height,
        anchorX + Math.floor(markerSize * 0.35),
        anchorY + Math.floor(markerSize * 0.18),
        borderWidth,
        Math.floor(markerSize * 0.64),
        {
            r: 219,
            g: 39,
            b: 39,
            a: 255,
        },
    );
    fillBitmapRect(
        bitmap,
        width,
        height,
        anchorX + Math.floor(markerSize * 0.18),
        anchorY + Math.floor(markerSize * 0.47),
        Math.floor(markerSize * 0.64),
        borderWidth,
        {
            r: 219,
            g: 39,
            b: 39,
            a: 255,
        },
    );

    return nativeImage.createFromBitmap(Buffer.from(bitmap), {
        width,
        height,
    });
}
