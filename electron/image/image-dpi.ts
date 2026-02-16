const DEFAULT_IMAGE_DPI = 72;
const METERS_PER_INCH = 0.0254;
const CM_PER_INCH = 2.54;

function readUint32BE(buf: Uint8Array, offset: number) {
    return ((buf[offset]! << 24) | (buf[offset + 1]! << 16) | (buf[offset + 2]! << 8) | buf[offset + 3]!) >>> 0;
}

function readUint16BE(buf: Uint8Array, offset: number) {
    return (buf[offset]! << 8) | buf[offset + 1]!;
}

function readPngDpi(data: Uint8Array): number | null {
    if (data.length < 8) {
        return null;
    }

    let offset = 8;

    while (offset + 12 <= data.length) {
        const chunkLength = readUint32BE(data, offset);

        if (
            data[offset + 4] === 0x70
            && data[offset + 5] === 0x48
            && data[offset + 6] === 0x59
            && data[offset + 7] === 0x73
            && chunkLength === 9
            && offset + 8 + 9 <= data.length
        ) {
            const xPixelsPerUnit = readUint32BE(data, offset + 8);
            const yPixelsPerUnit = readUint32BE(data, offset + 12);
            const unit = data[offset + 16]!;

            if (unit === 1 && (xPixelsPerUnit > 0 || yPixelsPerUnit > 0)) {
                const pixelsPerMeter = Math.max(xPixelsPerUnit, yPixelsPerUnit);
                const dpi = Math.round(pixelsPerMeter * METERS_PER_INCH);
                return dpi > 0 ? dpi : null;
            }
        }

        offset += 12 + chunkLength;
    }

    return null;
}

function readJpegDpi(data: Uint8Array): number | null {
    if (data.length < 20 || data[0] !== 0xFF || data[1] !== 0xD8) {
        return null;
    }

    let offset = 2;

    while (offset + 4 < data.length) {
        if (data[offset] !== 0xFF) break;
        const marker = data[offset + 1]!;

        if (marker === 0xE0) {
            const segLength = readUint16BE(data, offset + 2);
            if (segLength >= 14 && offset + 2 + segLength <= data.length) {
                if (
                    data[offset + 4] === 0x4A
                    && data[offset + 5] === 0x46
                    && data[offset + 6] === 0x49
                    && data[offset + 7] === 0x46
                    && data[offset + 8] === 0x00
                ) {
                    const units = data[offset + 11]!;
                    const xDensity = readUint16BE(data, offset + 12);
                    const yDensity = readUint16BE(data, offset + 14);
                    const density = Math.max(xDensity, yDensity);

                    if (units === 1 && density > 0) {
                        return density;
                    }
                    if (units === 2 && density > 0) {
                        return Math.round(density * CM_PER_INCH);
                    }
                }
            }
        }

        if (marker === 0xDA) break;

        const segLength = readUint16BE(data, offset + 2);
        offset += 2 + segLength;
    }

    return null;
}

interface ITiffResolutionTags {
    t282?: unknown;
    t283?: unknown;
    t296?: unknown;
}

function extractTiffRational(value: unknown): number | null {
    if (typeof value === 'number' && value > 0) {
        return value;
    }
    if (Array.isArray(value) && value.length >= 1 && typeof value[0] === 'number' && value[0] > 0) {
        if (value.length >= 2 && typeof value[1] === 'number' && value[1] > 0) {
            return value[0] / value[1];
        }
        return value[0];
    }
    return null;
}

function extractTiffUnit(value: unknown): number {
    if (typeof value === 'number') {
        return value;
    }
    if (Array.isArray(value) && value.length >= 1 && typeof value[0] === 'number') {
        return value[0];
    }
    return 2;
}

export function readTiffFrameDpi(ifd: ITiffResolutionTags): number | null {
    const xRes = extractTiffRational(ifd.t282);
    const yRes = extractTiffRational(ifd.t283);
    const unit = extractTiffUnit(ifd.t296);

    const resolution = Math.max(xRes ?? 0, yRes ?? 0);
    if (resolution <= 0) {
        return null;
    }

    if (unit === 2) {
        return Math.round(resolution);
    }
    if (unit === 3) {
        return Math.round(resolution * CM_PER_INCH);
    }

    return null;
}

export function readImageDpi(data: Uint8Array, extension: string) {
    const ext = extension.toLowerCase();
    let dpi: number | null = null;

    if (ext === '.png') {
        dpi = readPngDpi(data);
    } else if (ext === '.jpg' || ext === '.jpeg') {
        dpi = readJpegDpi(data);
    }

    return dpi && dpi > 0 ? dpi : DEFAULT_IMAGE_DPI;
}

export function pixelsToPdfPoints(pixels: number, dpi: number) {
    return (pixels / dpi) * 72;
}
