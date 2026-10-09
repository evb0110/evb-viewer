export interface ITiffTestFrame {
    /** Omitted: the directory has no ImageWidth tag. */
    width?: number;
    /** Omitted: the directory has no ImageLength tag. */
    height?: number;
}

export interface ICreateTiffBytesOptions {
    bigEndian?: boolean;
    bigTiff?: boolean;
    /** Opaque strip bytes written before each frame's directory. */
    pixelBytesPerFrame?: number;
    /** Points the last directory back at the first one. */
    loopLastDirectoryToFirst?: boolean;
}

const IMAGE_WIDTH = 256;
const IMAGE_LENGTH = 257;
const BITS_PER_SAMPLE = 258;
const STRIP_OFFSETS = 273;

/** Builds a TIFF whose directories store each tag as one LONG. */
export function createTiffBytes(frames: ITiffTestFrame[], options: ICreateTiffBytesOptions = {}) {
    const littleEndian = options.bigEndian !== true;
    const bigTiff = options.bigTiff === true;
    const countBytes = bigTiff ? 8 : 2;
    const entryBytes = bigTiff ? 20 : 12;
    const offsetBytes = bigTiff ? 8 : 4;
    const directories: Array<{
        at: number;
        tags: Map<number, number>;
    }> = [];
    let cursor = bigTiff ? 16 : 8;
    for (const frame of frames) {
        const tags = new Map<number, number>();
        if (frame.width !== undefined) {
            tags.set(IMAGE_WIDTH, frame.width);
        }
        if (frame.height !== undefined) {
            tags.set(IMAGE_LENGTH, frame.height);
        }
        tags.set(BITS_PER_SAMPLE, 8);
        tags.set(STRIP_OFFSETS, cursor);
        cursor += options.pixelBytesPerFrame ?? 0;
        directories.push({
            at: cursor,
            tags,
        });
        cursor += countBytes + (tags.size * entryBytes) + offsetBytes;
    }

    const bytes = new Uint8Array(cursor);
    const view = new DataView(bytes.buffer);
    const writeOffset = (at: number, value: number) => (bigTiff
        ? view.setBigUint64(at, BigInt(value), littleEndian)
        : view.setUint32(at, value, littleEndian));
    bytes.set(new TextEncoder().encode(littleEndian ? 'II' : 'MM'));
    view.setUint16(2, bigTiff ? 43 : 42, littleEndian);
    if (bigTiff) {
        view.setUint16(4, 8, littleEndian);
    }
    writeOffset(bigTiff ? 8 : 4, directories[0]?.at ?? 0);
    directories.forEach((directory, index) => {
        if (bigTiff) {
            view.setBigUint64(directory.at, BigInt(directory.tags.size), littleEndian);
        } else {
            view.setUint16(directory.at, directory.tags.size, littleEndian);
        }
        let entry = directory.at + countBytes;
        for (const [
            tag,
            value,
        ] of directory.tags) {
            view.setUint16(entry, tag, littleEndian);
            view.setUint16(entry + 2, 4, littleEndian);
            writeOffset(entry + 4, 1);
            view.setUint32(entry + 4 + offsetBytes, value, littleEndian);
            entry += entryBytes;
        }
        const nextDirectory = directories[index + 1]?.at
            ?? (options.loopLastDirectoryToFirst ? directories[0]!.at : 0);
        writeOffset(entry, nextDirectory);
    });
    return bytes;
}
