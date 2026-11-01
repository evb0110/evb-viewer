export type TDjvuCanvas = OffscreenCanvas | HTMLCanvasElement;

export function createDjvuCanvas(width: number, height: number) {
    if (typeof OffscreenCanvas !== 'undefined') {
        return new OffscreenCanvas(width, height);
    }
    if (typeof document === 'undefined') {
        throw new Error('Canvas is unavailable in the current runtime');
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

export function getDjvuCanvas2dContext(
    canvas: TDjvuCanvas,
): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null {
    if (typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement) {
        return canvas.getContext('2d');
    }
    // An HTMLCanvasElement cannot exist in a runtime whose constructor is undefined,
    // so the remaining case is always OffscreenCanvas.
    return (canvas as OffscreenCanvas).getContext('2d');
}

export function toOwnedArrayBuffer(bytes: Uint8Array) {
    if (
        bytes.buffer instanceof ArrayBuffer
        && bytes.byteOffset === 0
        && bytes.byteLength === bytes.buffer.byteLength
    ) {
        return bytes.buffer;
    }
    return bytes.slice().buffer;
}

export async function encodeDjvuCanvas(
    canvas: TDjvuCanvas,
    type: 'image/jpeg' | 'image/png',
    quality?: number,
) {
    if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
        const encodeOptions: ImageEncodeOptions = {type};
        if (quality !== undefined) {
            encodeOptions.quality = quality;
        }
        const blob = await canvas.convertToBlob(encodeOptions);
        return new Uint8Array(await blob.arrayBuffer());
    }
    const blob = await new Promise<Blob>((resolve, reject) => {
        (canvas as HTMLCanvasElement).toBlob((nextBlob: Blob | null) => {
            if (!nextBlob) {
                reject(new Error(`Failed to encode canvas as ${type}`));
                return;
            }
            resolve(nextBlob);
        }, type, quality);
    });
    return new Uint8Array(await blob.arrayBuffer());
}

export function releaseDjvuCanvas(canvas: TDjvuCanvas) {
    canvas.width = 0;
    canvas.height = 0;
}

// Every browser allocates a canvas of this size; larger ones are measured.
const UNIVERSAL_CANVAS_EDGE = 4096;
// Tiles of a raster too large for one canvas; each is drawn scaled.
const DJVU_TILE_EDGE = 4096;
// Each tile is drawn with this much of its neighbours, so smoothing at a tile
// edge samples real pixels instead of the transparent canvas border.
const DJVU_TILE_OVERLAP = 2;
const canvasAllocationResults = new Map<string, boolean>();

function probeCanvasAllocation(width: number, height: number) {
    let canvas: TDjvuCanvas | null = null;
    try {
        canvas = createDjvuCanvas(width, height);
        const context = getDjvuCanvas2dContext(canvas);
        if (!context) {
            return false;
        }
        // A canvas past the browser's limit still constructs, but stays blank.
        context.fillStyle = '#000000';
        context.fillRect(width - 1, height - 1, 1, 1);
        return context.getImageData(width - 1, height - 1, 1, 1).data[3] === 255;
    } catch {
        return false;
    } finally {
        if (canvas) {
            releaseDjvuCanvas(canvas);
        }
    }
}

/**
 * Whether this browser can allocate and draw a canvas of this size. The
 * answer comes from allocating one, because the limits differ by browser and
 * device; the result is kept per size.
 */
export function canAllocateDjvuCanvas(width: number, height: number) {
    if (width <= UNIVERSAL_CANVAS_EDGE && height <= UNIVERSAL_CANVAS_EDGE) {
        return true;
    }
    if (typeof OffscreenCanvas === 'undefined' && typeof document === 'undefined') {
        // No canvas exists here, so nothing this guard protects can run.
        return true;
    }
    const key = `${width}x${height}`;
    let allowed = canvasAllocationResults.get(key);
    if (allowed === undefined) {
        allowed = probeCanvasAllocation(width, height);
        canvasAllocationResults.set(key, allowed);
    }
    return allowed;
}

/**
 * Draws a decoded page scaled onto `context`. A page that fits one canvas is
 * drawn through it; a larger one is drawn tile by tile, so the browser's
 * canvas limit binds only the output size, never the source.
 */
export function drawDjvuImageDataScaled(
    context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
    imageData: ImageData,
    targetWidth: number,
    targetHeight: number,
) {
    const scaleX = targetWidth / imageData.width;
    const scaleY = targetHeight / imageData.height;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    if (canAllocateDjvuCanvas(imageData.width, imageData.height)) {
        const source = createDjvuCanvas(imageData.width, imageData.height);
        try {
            const sourceContext = getDjvuCanvas2dContext(source);
            if (!sourceContext) {
                throw new Error('Canvas 2D context is unavailable');
            }
            sourceContext.putImageData(imageData, 0, 0);
            context.drawImage(source, 0, 0, targetWidth, targetHeight);
        } finally {
            releaseDjvuCanvas(source);
        }
        return;
    }

    const tile = createDjvuCanvas(1, 1);
    try {
        const tileContext = getDjvuCanvas2dContext(tile);
        if (!tileContext) {
            throw new Error('Canvas 2D context is unavailable');
        }
        for (let y = 0; y < imageData.height; y += DJVU_TILE_EDGE) {
            for (let x = 0; x < imageData.width; x += DJVU_TILE_EDGE) {
                // Each tile paints only its interior, on whole target pixels, so
                // neighbouring tiles neither leave a seam nor stack. Its source
                // covers that clip plus the overlap, and the tile holds exactly
                // those pixels, so resampling never reads an empty margin.
                const left = Math.round(x * scaleX);
                const top = Math.round(y * scaleY);
                const right = Math.round(Math.min(imageData.width, x + DJVU_TILE_EDGE) * scaleX);
                const bottom = Math.round(Math.min(imageData.height, y + DJVU_TILE_EDGE) * scaleY);
                const sourceX = Math.max(0, Math.floor(left / scaleX) - DJVU_TILE_OVERLAP);
                const sourceY = Math.max(0, Math.floor(top / scaleY) - DJVU_TILE_OVERLAP);
                const sourceWidth = Math.min(imageData.width, Math.ceil(right / scaleX) + DJVU_TILE_OVERLAP) - sourceX;
                const sourceHeight = Math.min(imageData.height, Math.ceil(bottom / scaleY) + DJVU_TILE_OVERLAP) - sourceY;
                tile.width = sourceWidth;
                tile.height = sourceHeight;
                tileContext.putImageData(imageData, -sourceX, -sourceY, sourceX, sourceY, sourceWidth, sourceHeight);
                context.save();
                context.beginPath();
                context.rect(left, top, right - left, bottom - top);
                context.clip();
                context.drawImage(tile, sourceX * scaleX, sourceY * scaleY, sourceWidth * scaleX, sourceHeight * scaleY);
                context.restore();
            }
        }
    } finally {
        releaseDjvuCanvas(tile);
    }
}
