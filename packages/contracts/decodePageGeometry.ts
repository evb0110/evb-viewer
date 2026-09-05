import type {
    IPageGeometry,
    IPdfBox,
} from '@contracts/geometry';
import {
    isFiniteNumber,
    isRecord,
} from '@contracts/runtimeGuards';

function decodePdfBox(value: unknown): IPdfBox | null {
    if (!isRecord(value)) {
        return null;
    }
    if (
        !isFiniteNumber(value.x)
        || !isFiniteNumber(value.y)
        || !isFiniteNumber(value.width)
        || !isFiniteNumber(value.height)
    ) {
        return null;
    }
    return {
        x: value.x,
        y: value.y,
        width: value.width,
        height: value.height,
    };
}

export function decodePageGeometry(value: unknown): IPageGeometry | null {
    if (!isRecord(value) || !isFiniteNumber(value.rotation)) {
        return null;
    }

    const mediaBox = decodePdfBox(value.mediaBox);
    if (!mediaBox) {
        return null;
    }

    const cropBox = value.cropBox === null
        ? null
        : decodePdfBox(value.cropBox);
    if (cropBox === null && value.cropBox !== null) {
        return null;
    }

    return {
        mediaBox,
        cropBox,
        rotation: value.rotation,
    };
}
