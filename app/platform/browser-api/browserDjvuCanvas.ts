import { decodeBrowserImageBlob } from '@app/platform/browser-api/decodeBrowserImageBlob';

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

export async function fetchDjvuObjectUrlBytes(url: string) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to read DjVu page image: ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
}

export async function loadDjvuBitmap(bytes: Uint8Array) {
    const blob = new Blob([toOwnedArrayBuffer(bytes)], { type: 'image/png' });
    return decodeBrowserImageBlob(blob, { fallbackErrorMessage: 'Failed to decode DjVu page image' });
}

export function releaseDjvuCanvas(canvas: TDjvuCanvas) {
    canvas.width = 0;
    canvas.height = 0;
}
