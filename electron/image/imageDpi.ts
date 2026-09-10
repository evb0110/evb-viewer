const DEFAULT_IMAGE_DPI = 72;
const DEFAULT_RENDER_DPI = 300;
const MIN_RENDER_DPI = 72;
const MAX_RENDER_DPI = 1200;
const METERS_PER_INCH = 0.0254;
const CM_PER_INCH = 2.54;
const PNG_SIGNATURE_LENGTH = 8;
const PNG_CHUNK_HEADER_LENGTH = 8;
const PNG_CHUNK_CRC_LENGTH = 4;
const PNG_PHYS_CHUNK_LENGTH = 9;
const JPEG_APP0_MARKER = 0xE0;
const JPEG_START_OF_SCAN_MARKER = 0xDA;
const JPEG_APP1_MARKER = 0xE1;

function readUint32BE(buf: Uint8Array, offset: number) {
    return ((buf[offset]! << 24) | (buf[offset + 1]! << 16) | (buf[offset + 2]! << 8) | buf[offset + 3]!) >>> 0;
}

function readUint16BE(buf: Uint8Array, offset: number) {
    return (buf[offset]! << 8) | buf[offset + 1]!;
}

interface IPngChunk {
    offset: number;
    length: number;
}

function isPngPhysChunk(data: Uint8Array, offset: number) {
    return (
        data[offset + 4] === 0x70
        && data[offset + 5] === 0x48
        && data[offset + 6] === 0x59
        && data[offset + 7] === 0x73
    );
}

function parsePngPhysDpi(data: Uint8Array, offset: number) {
    const xPixelsPerUnit = readUint32BE(data, offset + PNG_CHUNK_HEADER_LENGTH);
    const yPixelsPerUnit = readUint32BE(data, offset + PNG_CHUNK_HEADER_LENGTH + 4);
    const unit = data[offset + PNG_CHUNK_HEADER_LENGTH + 8]!;

    if (unit !== 1 || (xPixelsPerUnit <= 0 && yPixelsPerUnit <= 0)) {
        return null;
    }

    const pixelsPerMeter = Math.max(xPixelsPerUnit, yPixelsPerUnit);
    const dpi = Math.round(pixelsPerMeter * METERS_PER_INCH);
    return dpi > 0 ? dpi : null;
}

function getNextPngChunk(data: Uint8Array, offset: number): IPngChunk | null {
    if (offset + PNG_CHUNK_HEADER_LENGTH + PNG_CHUNK_CRC_LENGTH > data.length) {
        return null;
    }

    const length = readUint32BE(data, offset);
    const chunkEnd = offset + PNG_CHUNK_HEADER_LENGTH + length + PNG_CHUNK_CRC_LENGTH;
    if (chunkEnd > data.length) {
        return null;
    }

    return {
        offset,
        length,
    };
}

function readPngDpi(data: Uint8Array) {
    if (data.length < PNG_SIGNATURE_LENGTH) {
        return null;
    }

    let offset = PNG_SIGNATURE_LENGTH;

    while (offset < data.length) {
        const chunk = getNextPngChunk(data, offset);
        if (!chunk) {
            return null;
        }

        if (isPngPhysChunk(data, chunk.offset) && chunk.length === PNG_PHYS_CHUNK_LENGTH) {
            return parsePngPhysDpi(data, chunk.offset);
        }

        offset += PNG_CHUNK_HEADER_LENGTH + chunk.length + PNG_CHUNK_CRC_LENGTH;
    }

    return null;
}

function isJfifSegment(data: Uint8Array, offset: number) {
    return (
        data[offset + 4] === 0x4A
        && data[offset + 5] === 0x46
        && data[offset + 6] === 0x49
        && data[offset + 7] === 0x46
        && data[offset + 8] === 0x00
    );
}

function parseJfifDensityDpi(units: number, xDensity: number, yDensity: number) {
    const density = Math.max(xDensity, yDensity);
    if (density <= 0) {
        return null;
    }

    if (units === 1) {
        return density;
    }
    if (units === 2) {
        return Math.round(density * CM_PER_INCH);
    }

    return null;
}

function readJfifDensityDpi(data: Uint8Array, offset: number) {
    return parseJfifDensityDpi(
        data[offset + 11]!,
        readUint16BE(data, offset + 12),
        readUint16BE(data, offset + 14),
    );
}

function readJpegSegmentDpi(data: Uint8Array, offset: number, marker: number) {
    if (marker !== JPEG_APP0_MARKER) {
        return null;
    }

    const segLength = readUint16BE(data, offset + 2);
    if (segLength < 14 || offset + 2 + segLength > data.length || !isJfifSegment(data, offset)) {
        return null;
    }

    return readJfifDensityDpi(data, offset);
}

function readJpegDpi(data: Uint8Array) {
    if (data.length < 20 || data[0] !== 0xFF || data[1] !== 0xD8) {
        return null;
    }

    let offset = 2;

    while (offset + 4 < data.length) {
        if (data[offset] !== 0xFF) break;
        const marker = data[offset + 1]!;

        const dpi = readJpegSegmentDpi(data, offset, marker);
        if (dpi) {
            return dpi;
        }

        if (marker === JPEG_START_OF_SCAN_MARKER) break;

        const segLength = readUint16BE(data, offset + 2);
        offset += 2 + segLength;
    }

    return null;
}

function readUint16(data: Uint8Array, offset: number, littleEndian: boolean) {
    return littleEndian
        ? data[offset]! | (data[offset + 1]! << 8)
        : readUint16BE(data, offset);
}

function readUint32(data: Uint8Array, offset: number, littleEndian: boolean) {
    if (!littleEndian) {
        return readUint32BE(data, offset);
    }
    return (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)) >>> 0;
}

function readExifOrientationSegment(data: Uint8Array, payloadOffset: number, payloadLength: number) {
    if (
        payloadLength < 14
        || String.fromCharCode(...data.subarray(payloadOffset, payloadOffset + 6)) !== 'Exif\0\0'
    ) {
        return 1;
    }
    const tiffOffset = payloadOffset + 6;
    const littleEndian = data[tiffOffset] === 0x49 && data[tiffOffset + 1] === 0x49;
    if (!littleEndian && !(data[tiffOffset] === 0x4d && data[tiffOffset + 1] === 0x4d)) {
        return 1;
    }
    const ifdOffset = tiffOffset + readUint32(data, tiffOffset + 4, littleEndian);
    if (ifdOffset + 2 > payloadOffset + payloadLength) {
        return 1;
    }
    const entryCount = readUint16(data, ifdOffset, littleEndian);
    for (let index = 0; index < entryCount; index += 1) {
        const entryOffset = ifdOffset + 2 + (index * 12);
        if (entryOffset + 12 > payloadOffset + payloadLength) break;
        if (readUint16(data, entryOffset, littleEndian) === 0x0112) {
            const orientation = readUint16(data, entryOffset + 8, littleEndian);
            return orientation >= 2 && orientation <= 8 ? orientation as 2 | 3 | 4 | 5 | 6 | 7 | 8 : 1;
        }
    }
    return 1;
}

export function readJpegExifOrientation(data: Uint8Array): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 {
    if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
        return 1;
    }
    let offset = 2;
    while (offset + 4 < data.length && data[offset] === 0xff) {
        const marker = data[offset + 1]!;
        if (marker === JPEG_START_OF_SCAN_MARKER) break;
        const segmentLength = readUint16BE(data, offset + 2);
        if (segmentLength < 2 || offset + 2 + segmentLength > data.length) break;
        if (marker === JPEG_APP1_MARKER) {
            return readExifOrientationSegment(data, offset + 4, segmentLength - 2);
        }
        offset += 2 + segmentLength;
    }
    return 1;
}

interface ITiffResolutionTags {
    t282?: unknown;
    t283?: unknown;
    t296?: unknown;
}

function extractNumber(value: unknown) {
    return typeof value === 'number' && value > 0 ? value : null;
}

function extractTiffRational(value: unknown) {
    const numericValue = extractNumber(value);
    if (numericValue !== null) {
        return numericValue;
    }

    if (!Array.isArray(value)) {
        return null;
    }

    const numerator = extractNumber(value[0]);
    if (numerator === null) {
        return null;
    }

    const denominator = extractNumber(value[1]);
    if (denominator !== null) {
        return numerator / denominator;
    }

    return numerator;
}

function extractTiffUnit(value: unknown) {
    if (typeof value === 'number') {
        return value;
    }
    if (Array.isArray(value) && value.length >= 1 && typeof value[0] === 'number') {
        return value[0];
    }
    return 2;
}

export function readTiffFrameDpi(ifd: ITiffResolutionTags) {
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

export function clampDpi(value: number) {
    if (!Number.isFinite(value)) {
        return DEFAULT_RENDER_DPI;
    }
    return Math.min(Math.max(Math.round(value), MIN_RENDER_DPI), MAX_RENDER_DPI);
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
