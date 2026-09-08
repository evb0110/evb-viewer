export interface IBrowserRasterImageMetadata {
    width: number;
    height: number;
    dpi: number;
    orientation: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
    iccProfile?: Uint8Array;
    compressedIccProfile?: Uint8Array;
}

const DEFAULT_DPI = 72;
const METERS_PER_INCH = 0.0254;
const CM_PER_INCH = 2.54;
export const BROWSER_RASTER_MAX_ICC_PROFILE_BYTES = 16 * 1024 * 1024;

function readByte(data: Uint8Array, offset: number) {
    const value = data[offset];
    if (value === undefined) {
        throw new RangeError('ERR_BROWSER_IMAGE_DATA_TRUNCATED');
    }
    return value;
}

function u16be(data: Uint8Array, offset: number) {
    return (readByte(data, offset) << 8) | readByte(data, offset + 1);
}

function u16le(data: Uint8Array, offset: number) {
    return readByte(data, offset) | (readByte(data, offset + 1) << 8);
}

function u24le(data: Uint8Array, offset: number) {
    return readByte(data, offset)
        | (readByte(data, offset + 1) << 8)
        | (readByte(data, offset + 2) << 16);
}

function u32be(data: Uint8Array, offset: number) {
    return ((readByte(data, offset) << 24)
        | (readByte(data, offset + 1) << 16)
        | (readByte(data, offset + 2) << 8)
        | readByte(data, offset + 3)) >>> 0;
}

function u32le(data: Uint8Array, offset: number) {
    return (readByte(data, offset)
        | (readByte(data, offset + 1) << 8)
        | (readByte(data, offset + 2) << 16)
        | (readByte(data, offset + 3) << 24)) >>> 0;
}

function readPng(data: Uint8Array): IBrowserRasterImageMetadata | null {
    if (data.length < 24 || data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4e || data[3] !== 0x47) {
        return null;
    }
    let dpi = DEFAULT_DPI;
    let offset = 8;
    let compressedIccProfile: Uint8Array | undefined;
    while (offset + 12 <= data.length) {
        const length = u32be(data, offset);
        if (offset + 12 + length > data.length) break;
        if (
            length === 9
            && data[offset + 4] === 0x70
            && data[offset + 5] === 0x48
            && data[offset + 6] === 0x59
            && data[offset + 7] === 0x73
            && data[offset + 16] === 1
        ) {
            dpi = Math.max(1, Math.round(Math.max(u32be(data, offset + 8), u32be(data, offset + 12)) * METERS_PER_INCH));
        }
        if (
            data[offset + 4] === 0x69
            && data[offset + 5] === 0x43
            && data[offset + 6] === 0x43
            && data[offset + 7] === 0x50
        ) {
            const chunk = data.subarray(offset + 8, offset + 8 + length);
            const nameEnd = chunk.indexOf(0);
            if (nameEnd > 0 && chunk[nameEnd + 1] === 0) {
                compressedIccProfile = chunk.slice(nameEnd + 2);
            }
        }
        offset += 12 + length;
    }
    return {
        width: u32be(data, 16),
        height: u32be(data, 20),
        dpi,
        orientation: 1,
        ...(compressedIccProfile ? {compressedIccProfile} : {}),
    };
}

export async function resolveBrowserRasterIccProfile(metadata: IBrowserRasterImageMetadata) {
    if (metadata.iccProfile) {
        if (metadata.iccProfile.byteLength === 0 || metadata.iccProfile.byteLength > BROWSER_RASTER_MAX_ICC_PROFILE_BYTES) {
            throw new Error('ERR_BROWSER_PDF_COMBINE_ICC_PROFILE_TOO_LARGE');
        }
        return metadata.iccProfile;
    }
    if (!metadata.compressedIccProfile) {
        return undefined;
    }
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('ERR_BROWSER_PDF_COMBINE_ICC_BACKEND_UNAVAILABLE');
    }
    const stream = new Blob([metadata.compressedIccProfile as BlobPart])
        .stream()
        .pipeThrough(new DecompressionStream('deflate'));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let profileBytes = 0;
    for (;;) {
        const {
            done,
            value,
        } = await reader.read();
        if (done) {
            break;
        }
        profileBytes += value.byteLength;
        if (profileBytes > BROWSER_RASTER_MAX_ICC_PROFILE_BYTES) {
            await reader.cancel('ICC profile exceeds browser combine resource limit');
            throw new Error('ERR_BROWSER_PDF_COMBINE_ICC_PROFILE_TOO_LARGE');
        }
        chunks.push(value);
    }
    if (profileBytes === 0) {
        throw new Error('ERR_BROWSER_PDF_COMBINE_ICC_PROFILE_TOO_LARGE');
    }
    const profile = new Uint8Array(profileBytes);
    let profileOffset = 0;
    for (const chunk of chunks) {
        profile.set(chunk, profileOffset);
        profileOffset += chunk.byteLength;
    }
    return profile;
}

function readExifOrientation(data: Uint8Array, start: number, length: number): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 {
    if (length < 14 || String.fromCharCode(...data.subarray(start, start + 6)) !== 'Exif\0\0') {
        return 1;
    }
    const tiff = start + 6;
    const little = data[tiff] === 0x49 && data[tiff + 1] === 0x49;
    if (!little && !(data[tiff] === 0x4d && data[tiff + 1] === 0x4d)) {
        return 1;
    }
    const read16 = little ? u16le : u16be;
    const read32 = little ? u32le : u32be;
    const ifd = tiff + read32(data, tiff + 4);
    if (ifd + 2 > start + length) {
        return 1;
    }
    const count = read16(data, ifd);
    for (let index = 0; index < count; index += 1) {
        const entry = ifd + 2 + (index * 12);
        if (entry + 12 > start + length) break;
        if (read16(data, entry) === 0x0112) {
            const value = read16(data, entry + 8);
            return value === 2 || value === 3 || value === 4 || value === 5 || value === 6 || value === 7 || value === 8 ? value : 1;
        }
    }
    return 1;
}

function readJpeg(data: Uint8Array): IBrowserRasterImageMetadata | null {
    if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
        return null;
    }
    let width = 0;
    let height = 0;
    let dpi = DEFAULT_DPI;
    let orientation: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 = 1;
    let offset = 2;
    const iccChunks: Array<{
        sequence: number;
        total: number;
        data: Uint8Array
    }> = [];
    while (offset + 4 <= data.length) {
        if (data[offset] !== 0xff) break;
        const marker = readByte(data, offset + 1);
        if (marker === 0xda || marker === 0xd9) break;
        const length = u16be(data, offset + 2);
        if (length < 2 || offset + 2 + length > data.length) break;
        const payload = offset + 4;
        if (
            marker === 0xe0
            && length >= 14
            && String.fromCharCode(...data.subarray(payload, payload + 5)) === 'JFIF\0'
        ) {
            const units = readByte(data, payload + 7);
            const density = Math.max(u16be(data, payload + 8), u16be(data, payload + 10));
            if (units === 1 && density > 0) dpi = density;
            if (units === 2 && density > 0) dpi = Math.round(density * CM_PER_INCH);
        } else if (marker === 0xe1) {
            orientation = readExifOrientation(data, payload, length - 2);
        } else if (
            marker === 0xe2
            && length >= 16
            && String.fromCharCode(...data.subarray(payload, payload + 12)) === 'ICC_PROFILE\0'
        ) {
            iccChunks.push({
                sequence: readByte(data, payload + 12),
                total: readByte(data, payload + 13),
                data: data.slice(payload + 14, offset + 2 + length),
            });
        } else if (
            (marker >= 0xc0 && marker <= 0xc3)
            || (marker >= 0xc5 && marker <= 0xc7)
            || (marker >= 0xc9 && marker <= 0xcb)
            || (marker >= 0xcd && marker <= 0xcf)
        ) {
            height = u16be(data, payload + 1);
            width = u16be(data, payload + 3);
        }
        offset += 2 + length;
    }
    const expectedChunks = iccChunks[0]?.total ?? 0;
    const orderedChunks = [...iccChunks].sort((a, b) => a.sequence - b.sequence);
    let iccProfile: Uint8Array | undefined;
    if (
        expectedChunks > 0
        && orderedChunks.length === expectedChunks
        && orderedChunks.every((chunk, index) => chunk.total === expectedChunks && chunk.sequence === index + 1)
    ) {
        const profileBytes = orderedChunks.reduce((total, chunk) => total + chunk.data.byteLength, 0);
        if (profileBytes > BROWSER_RASTER_MAX_ICC_PROFILE_BYTES) {
            throw new Error('ERR_BROWSER_PDF_COMBINE_ICC_PROFILE_TOO_LARGE');
        }
        iccProfile = new Uint8Array(profileBytes);
        let profileOffset = 0;
        for (const chunk of orderedChunks) {
            iccProfile.set(chunk.data, profileOffset);
            profileOffset += chunk.data.byteLength;
        }
    }
    return width > 0 && height > 0 ? {
        width,
        height,
        dpi,
        orientation,
        ...(iccProfile ? {iccProfile} : {}),
    } : null;
}

function readSimple(data: Uint8Array, extension: string): IBrowserRasterImageMetadata | null {
    let width = 0;
    let height = 0;
    if (extension === '.gif' && data.length >= 10 && String.fromCharCode(...data.subarray(0, 3)) === 'GIF') {
        width = u16le(data, 6);
        height = u16le(data, 8);
    } else if (extension === '.bmp' && data.length >= 26 && data[0] === 0x42 && data[1] === 0x4d) {
        width = u32le(data, 18);
        height = Math.abs(u32le(data, 22) | 0);
    } else if (
        extension === '.webp'
        && data.length >= 30
        && String.fromCharCode(...data.subarray(0, 4)) === 'RIFF'
        && String.fromCharCode(...data.subarray(8, 12)) === 'WEBP'
    ) {
        const kind = String.fromCharCode(...data.subarray(12, 16));
        if (kind === 'VP8 ') {
            width = u16le(data, 26) & 0x3fff;
            height = u16le(data, 28) & 0x3fff;
        } else if (kind === 'VP8L') {
            const bits = u32le(data, 21);
            width = 1 + (bits & 0x3fff);
            height = 1 + ((bits >>> 14) & 0x3fff);
        } else if (kind === 'VP8X') {
            width = 1 + u24le(data, 24);
            height = 1 + u24le(data, 27);
        }
    }
    return width > 0 && height > 0 ? {
        width,
        height,
        dpi: DEFAULT_DPI,
        orientation: 1,
    } : null;
}

export function readBrowserRasterImageMetadata(data: Uint8Array, extension: string) {
    if (extension === '.png') {
        return readPng(data);
    }
    if (extension === '.jpg' || extension === '.jpeg') {
        return readJpeg(data);
    }
    return readSimple(data, extension);
}

function readTiffResolutionValue(value: unknown): number {
    if (typeof value === 'number') {
        return value;
    }
    if (Array.isArray(value)) {
        if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number' && value[1] !== 0) {
            return value[0] / value[1];
        }
        return readTiffResolutionValue(value[0]);
    }
    return 0;
}

export function readBrowserTiffFrameDpi(frame: Record<string, unknown>) {
    const resolution = Math.max(
        readTiffResolutionValue(frame.t282),
        readTiffResolutionValue(frame.t283),
    );
    const unit = typeof frame.t296 === 'number' ? frame.t296 : 2;
    return resolution > 0 ? (unit === 3 ? Math.round(resolution * 2.54) : resolution) : 72;
}
