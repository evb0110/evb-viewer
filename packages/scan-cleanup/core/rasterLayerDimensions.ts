import type {Stats} from 'fs';
import {open} from 'fs/promises';

export interface IScanCleanupOpenFileHandle {
    read: (
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
    ) => Promise<{bytesRead: number}>;
    stat: () => Promise<Stats>;
    close: () => Promise<void>;
}
export type TScanCleanupOpenFile = (path: string, flags: 'r') => Promise<IScanCleanupOpenFileHandle>;
const defaultOpenFile: TScanCleanupOpenFile = (path, flags) => open(path, flags);

const NETPBM_HEADER_MAX_BYTES = 4_096;
const PPM_READ_CHUNK_BYTES = 1024 * 1024;

interface INetpbmInspection {
    width: number;
    height: number;
    maxValue: number;
    payloadOffset: number;
    payloadByteLength: number;
    fileSize: number;
    fileIdentity: string;
}

export interface IReadPpmRasterOptions {
    maxPixels: number;
    maxDimensionPx: number;
    signal?: AbortSignal;
    open?: TScanCleanupOpenFile;
}

function fileIdentity(stats: Stats) {
    return [
        stats.dev,
        stats.ino,
        stats.size,
        stats.mtimeMs,
        stats.ctimeMs,
    ].join(':');
}

async function readExactly(
    handle: IScanCleanupOpenFileHandle,
    buffer: Buffer,
    position: number,
    signal?: AbortSignal,
) {
    let offset = 0;
    while (offset < buffer.byteLength) {
        signal?.throwIfAborted();
        const length = Math.min(PPM_READ_CHUNK_BYTES, buffer.byteLength - offset);
        const {bytesRead} = await handle.read(buffer, offset, length, position + offset);
        if (bytesRead === 0) {
            break;
        }
        offset += bytesRead;
    }
    return offset;
}

async function inspectPngHeader(
    path: string,
    invalidHeaderMessage: string,
    openFile: TScanCleanupOpenFile = defaultOpenFile,
) {
    const handle = await openFile(path, 'r');
    try {
        const header = Buffer.alloc(26);
        const {bytesRead} = await handle.read(header, 0, header.byteLength, 0);
        if (
            bytesRead !== header.byteLength
            || header.subarray(0, 8).compare(Buffer.from([
                0x89,
                0x50,
                0x4e,
                0x47,
                0x0d,
                0x0a,
                0x1a,
                0x0a,
            ])) !== 0
        ) {
            throw new Error(invalidHeaderMessage);
        }
        const width = header.readUInt32BE(16);
        const height = header.readUInt32BE(20);
        const colorType = header[25]!;
        return {
            width,
            height,
            isColor: colorType === 2 || colorType === 3 || colorType === 6,
            colorType,
        };
    } finally {
        await handle.close();
    }
}

export function readPngHeader(path: string, openFile: TScanCleanupOpenFile = defaultOpenFile) {
    return inspectPngHeader(path, `Invalid PNG header: ${path}`, openFile).then((header) => {
        return {
            height: header.height,
            isColor: header.isColor,
            width: header.width,
        };
    });
}

export async function readPngDimensions(
    path: string,
    openFile: TScanCleanupOpenFile = defaultOpenFile,
) {
    const {
        colorType,
        width,
        height,
    } = await inspectPngHeader(
        path,
        `Unable to inspect raster dimensions for ${path}`,
        openFile,
    );
    if (
        width === 0
        || height === 0
        || ![
            0,
            2,
            3,
            4,
            6,
        ].includes(colorType)
    ) {
        throw new Error(`Invalid PNG header for ${path}`);
    }
    return {
        width,
        height,
    };
}

async function inspectNetpbm(
    handle: IScanCleanupOpenFileHandle,
    path: string,
    magic: 'P4' | 'P6',
    signal?: AbortSignal,
): Promise<INetpbmInspection> {
    const format = magic === 'P4' ? 'PBM' : 'PPM';
    signal?.throwIfAborted();
    const fileStats = await handle.stat();
    const header = Buffer.alloc(Math.min(fileStats.size, NETPBM_HEADER_MAX_BYTES));
    const bytesRead = await readExactly(handle, header, 0, signal);
    const data = header.subarray(0, bytesRead);
    if (data.subarray(0, 2).toString('ascii') !== magic) {
        throw new Error(`Unsupported ${format} header for ${path}`);
    }
    const state = {offset: 2};
    function readNumber(label: string) {
        while (state.offset < data.length) {
            const byte = data[state.offset]!;
            if (byte === 0x23) {
                while (state.offset < data.length && data[state.offset] !== 0x0a) {
                    state.offset += 1;
                }
            } else if (byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20) {
                state.offset += 1;
            } else {
                break;
            }
        }
        const start = state.offset;
        while (
            state.offset < data.length
            && data[state.offset]! >= 0x30
            && data[state.offset]! <= 0x39
        ) {
            state.offset += 1;
        }
        if (start === state.offset) {
            throw new Error(`Invalid ${format} ${label} for ${path}`);
        }
        const value = Number.parseInt(data.subarray(start, state.offset).toString('ascii'), 10);
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new Error(`Invalid ${format} ${label} for ${path}`);
        }
        return value;
    }
    const width = readNumber('width');
    const height = readNumber('height');
    const maxValue = magic === 'P6' ? readNumber('max value') : 1;
    if (maxValue > 65_535) {
        throw new Error(`Invalid ${format} max value for ${path}`);
    }
    const terminator = data[state.offset];
    if (terminator !== 0x09 && terminator !== 0x0a && terminator !== 0x0d && terminator !== 0x20) {
        throw new Error(`Invalid ${format} header terminator for ${path}`);
    }
    state.offset += terminator === 0x0d && data[state.offset + 1] === 0x0a ? 2 : 1;
    const rowBytes = magic === 'P4' ? Math.ceil(width / 8) : width * 3 * (maxValue > 255 ? 2 : 1);
    const payloadByteLength = rowBytes * height;
    const expectedBytes = state.offset + payloadByteLength;
    if (!Number.isSafeInteger(payloadByteLength) || !Number.isSafeInteger(expectedBytes)) {
        throw new Error(`Invalid ${format} payload size for ${path}`);
    }
    if (fileStats.size < expectedBytes) {
        throw new Error(`Truncated ${format} payload for ${path}`);
    }
    if (fileStats.size > expectedBytes) {
        throw new Error(`Surplus ${format} payload for ${path}`);
    }
    return {
        width,
        height,
        maxValue,
        payloadOffset: state.offset,
        payloadByteLength,
        fileSize: fileStats.size,
        fileIdentity: fileIdentity(fileStats),
    };
}

async function readNetpbmDimensions(path: string, magic: 'P4' | 'P6', openFile: TScanCleanupOpenFile) {
    const handle = await openFile(path, 'r');
    try {
        const inspected = await inspectNetpbm(handle, path, magic);
        return {
            width: inspected.width,
            height: inspected.height,
        };
    } finally {
        await handle.close();
    }
}

export function readPbmDimensions(path: string, openFile: TScanCleanupOpenFile = defaultOpenFile) {
    return readNetpbmDimensions(path, 'P4', openFile);
}

export function readPpmDimensions(path: string, openFile: TScanCleanupOpenFile = defaultOpenFile) {
    return readNetpbmDimensions(path, 'P6', openFile).then(dimensions => ({
        ...dimensions,
        isColor: true,
    }));
}

export async function readPpmRaster(path: string, options: IReadPpmRasterOptions) {
    const limits = {
        maxPixels: options.maxPixels,
        maxDimensionPx: options.maxDimensionPx,
    };
    for (const [
        label,
        value,
    ] of Object.entries(limits)) {
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new TypeError(`PPM raster ${label} must be a positive safe integer`);
        }
    }

    const handle = await (options.open ?? defaultOpenFile)(path, 'r');
    try {
        const inspected = await inspectNetpbm(handle, path, 'P6', options.signal);
        if (inspected.maxValue !== 255) {
            throw new Error(`Unsupported PPM max value for ${path}`);
        }
        if (
            inspected.width > options.maxDimensionPx
            || inspected.height > options.maxDimensionPx
            || inspected.width * inspected.height > options.maxPixels
        ) {
            throw new RangeError(
                `PPM raster ${String(inspected.width)}x${String(inspected.height)} exceeds limits for ${path}`,
            );
        }

        const pixels = Buffer.allocUnsafe(inspected.payloadByteLength);
        const bytesRead = await readExactly(
            handle,
            pixels,
            inspected.payloadOffset,
            options.signal,
        );
        if (bytesRead !== pixels.byteLength) {
            throw new Error(`Truncated PPM payload for ${path}`);
        }
        options.signal?.throwIfAborted();
        const finalStats = await handle.stat();
        if (
            finalStats.size !== inspected.fileSize
            || fileIdentity(finalStats) !== inspected.fileIdentity
        ) {
            throw new Error(`PPM raster changed while it was being read: ${path}`);
        }
        return {
            width: inspected.width,
            height: inspected.height,
            isColor: true as const,
            pixels,
        };
    } finally {
        await handle.close();
    }
}
