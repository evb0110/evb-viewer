import { sumBy } from 'es-toolkit/math';

export interface ITiffEncoderBinaryWriter {
    writeUint(buffer: Uint8Array, offset: number, value: number): void;
    writeUshort(buffer: Uint8Array, offset: number, value: number): void;
}

export interface ITiffEncoderModule {
    _binBE: ITiffEncoderBinaryWriter;
    _writeIFD(
        bin: ITiffEncoderBinaryWriter,
        data: Uint8Array,
        offset: number,
        ifd: Record<string, unknown>,
    ): [number, number];
    ttypes: Record<number, number | undefined>;
}

export interface ITiffImageDescriptor {
    width: number;
    height: number;
    dataLength: number;
    /** Pixels per inch written to XResolution/YResolution. */
    dpiX?: number;
    dpiY?: number;
}

export const TIFF_TYPE_BYTES: Record<number, number> = {
    1: 1,
    2: 1,
    3: 2,
    4: 4,
    5: 8,
    12: 8,
};

export function buildTiffImageIfd(page: ITiffImageDescriptor, dataOffset: number) {
    const dpiX = Number.isFinite(page.dpiX) && page.dpiX! > 0 ? page.dpiX! : 72;
    const dpiY = Number.isFinite(page.dpiY) && page.dpiY! > 0 ? page.dpiY! : dpiX;
    return {
        t256: [page.width],
        t257: [page.height],
        t258: [
            8,
            8,
            8,
            8,
        ],
        t259: [1],
        t262: [2],
        t273: [dataOffset],
        t277: [4],
        t278: [page.height],
        t279: [page.dataLength],
        t282: [dpiX],
        t283: [dpiY],
        t284: [1],
        t286: [0],
        t287: [0],
        t296: [2],
        t305: ['EVB Viewer'],
        t338: [1],
    };
}

export function getTiffValueCount(value: unknown) {
    if (Array.isArray(value)) {
        return value.length;
    }

    if (
        ArrayBuffer.isView(value)
        && 'BYTES_PER_ELEMENT' in value
        && typeof value.BYTES_PER_ELEMENT === 'number'
        && value.BYTES_PER_ELEMENT > 0
    ) {
        return Math.floor(value.byteLength / value.BYTES_PER_ELEMENT);
    }

    return 1;
}

export function measureTiffIfdSize(
    ifd: Record<string, unknown>,
    ttypes: Record<number, number | undefined>,
) {
    const keys = Object.keys(ifd);
    let extraDataLength = 0;

    for (const key of keys) {
        const tag = Number.parseInt(key.slice(1), 10);
        const type = ttypes[tag];
        if (!type) {
            throw new Error(`Unsupported TIFF tag type for tag ${tag}`);
        }

        const rawValue = ifd[key];
        const valueLength = type === 2
            ? `${String(Array.isArray(rawValue) ? rawValue[0] ?? '' : rawValue ?? '')}\0`.length
            : getTiffValueCount(rawValue);
        const dataLength = (TIFF_TYPE_BYTES[type] ?? 0) * valueLength;
        if (dataLength > 4) {
            extraDataLength += dataLength + (dataLength & 1);
        }
    }

    return 2 + (keys.length * 12) + 4 + extraDataLength;
}

export function encodeTiffIfds(
    ifds: Array<Record<string, unknown>>,
    encoder: ITiffEncoderModule,
) {
    const capacity = 8 + sumBy(ifds, ifd => measureTiffIfdSize(ifd, encoder.ttypes));
    const data = new Uint8Array(capacity);
    const bin = encoder._binBE;

    data[0] = 77;
    data[1] = 77;
    data[3] = 42;

    let ifdOffset = 8;
    bin.writeUint(data, 4, ifdOffset);

    for (let index = 0; index < ifds.length; index += 1) {
        const [
            nextIfdPointerOffset,
            nextIfdOffset,
        ] = encoder._writeIFD(bin, data, ifdOffset, ifds[index]!);
        ifdOffset = nextIfdOffset;
        if (index < ifds.length - 1) {
            bin.writeUint(data, nextIfdPointerOffset, ifdOffset);
        }
    }

    return data.slice(0, ifdOffset);
}

export const CLASSIC_TIFF_MAX_BYTE_LENGTH = 0xFFFFFFFF;

function tiffHeaderByteLength(pages: ITiffImageDescriptor[], encoder: ITiffEncoderModule) {
    return 8 + sumBy(pages, page => measureTiffIfdSize(buildTiffImageIfd(page, 0), encoder.ttypes));
}

function alignTiffDataOffset(headerByteLength: number) {
    return Math.ceil(headerByteLength / 8) * 8;
}

export function estimateMultiPageTiffByteLength(pages: ITiffImageDescriptor[], encoder: ITiffEncoderModule) {
    return alignTiffDataOffset(tiffHeaderByteLength(pages, encoder)) + sumBy(pages, page => page.dataLength);
}

export function encodeMultiPageTiffHeader(pages: ITiffImageDescriptor[], encoder: ITiffEncoderModule) {
    const firstDataOffset = alignTiffDataOffset(tiffHeaderByteLength(pages, encoder));
    const totalByteLength = firstDataOffset + sumBy(pages, page => page.dataLength);
    if (totalByteLength > CLASSIC_TIFF_MAX_BYTE_LENGTH) {
        throw new Error('Multi-page TIFF export exceeds the Classic TIFF 4GB limit');
    }
    let offset = firstDataOffset;
    const ifds = pages.map(page => {
        const ifd = buildTiffImageIfd(page, offset);
        offset += page.dataLength;
        return ifd;
    });
    return {
        header: encodeTiffIfds(ifds, encoder),
        firstDataOffset,
        totalByteLength,
    };
}

export function splitTiffPageDescriptorsForClassicLimit<TPage extends ITiffImageDescriptor>(
    pages: TPage[],
    encoder: ITiffEncoderModule,
    maxByteLength = CLASSIC_TIFF_MAX_BYTE_LENGTH,
) {
    const groups: TPage[][] = [];
    let group: TPage[] = [];
    let headerBytes = 8;
    let dataBytes = 0;
    for (const page of pages) {
        const ifdBytes = measureTiffIfdSize(buildTiffImageIfd(page, 0), encoder.ttypes);
        if (alignTiffDataOffset(8 + ifdBytes) + page.dataLength > maxByteLength) {
            throw new Error('A single TIFF page exceeds the Classic TIFF 4GB limit');
        }
        if (group.length && alignTiffDataOffset(headerBytes + ifdBytes) + dataBytes + page.dataLength > maxByteLength) {
            groups.push(group);
            group = [];
            headerBytes = 8;
            dataBytes = 0;
        }
        group.push(page);
        headerBytes += ifdBytes;
        dataBytes += page.dataLength;
    }
    if (group.length) groups.push(group);
    return groups;
}
