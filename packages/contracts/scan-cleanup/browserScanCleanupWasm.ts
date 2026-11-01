import {
    SCAN_CLEANUP_WASM_MAX_REQUEST_JSON_BYTES,
    SCAN_CLEANUP_WASM_OP_ANALYZE,
    SCAN_CLEANUP_WASM_OP_RENDER_PREVIEW,
    SCAN_CLEANUP_WASM_OUTPUT_HEADER_BYTES,
    SCAN_CLEANUP_WASM_PLANE_ENCODING_PNG,
    SCAN_CLEANUP_WASM_PLANE_ENCODING_RAW,
    SCAN_CLEANUP_WASM_PLANE_KIND_GRAY8,
    SCAN_CLEANUP_WASM_PLANE_KIND_RGB8,
    SCAN_CLEANUP_WASM_REQUEST_HEADER_BYTES,
    SCAN_CLEANUP_WASM_REQUEST_MAGIC,
    SCAN_CLEANUP_WASM_REQUEST_VERSION,
    SCAN_CLEANUP_WASM_RESULT_HEADER_BYTES,
} from '@contracts/scan-cleanup/browserScanCleanupWasm.generated';
import {
    decodeNativeScanCleanupOutputMetadataJson,
    decodeNativeScanCleanupPageMetadataJson,
    type INativeScanCleanupPageArtifactMetadataV3,
    type TNativeScanCleanupOutputArtifactMetadataV3,
} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import type {
    WasmAnalyzePageRequestV1,
    WasmRenderPreviewRequestV1,
} from '@contracts/scan-cleanup/nativeWire.generated';

/**
 * The browser scan-cleanup engine: `public/wasm/evb-scan-cleanup.wasm`, built
 * from `native/scan-cleanup/src/wasm.rs`. It cleans one page per request with
 * the same Rust code the desktop CLI runs, from raster bytes instead of files.
 */
export const BROWSER_SCAN_CLEANUP_WASM_PATH = '/wasm/evb-scan-cleanup.wasm';

/**
 * A page raster as the engine reads it: PNG, or binary PPM (P6), told apart by
 * signature exactly as the CLI's file readers do.
 */
export type TScanCleanupEncodedRaster = Uint8Array;

export type TScanCleanupWasmPlaneEncoding = 'raw' | 'png';
export type TScanCleanupWasmPlaneKind = 'gray8' | 'rgb8';

/**
 * One output's pixels. Raw planes are row-major with no padding: one byte per
 * pixel for gray8, three for rgb8. PNG planes are the exact bytes the CLI
 * writes to its output file.
 */
export interface IScanCleanupWasmPlane {
    kind: TScanCleanupWasmPlaneKind;
    encoding: TScanCleanupWasmPlaneEncoding;
    width: number;
    height: number;
    data: Uint8Array<ArrayBuffer>;
}

export interface IScanCleanupWasmOutput {
    /** The metadata JSON exactly as the CLI writes it beside its output. */
    metadataJson: string;
    metadata: TNativeScanCleanupOutputArtifactMetadataV3;
    plane: IScanCleanupWasmPlane;
}

export interface IScanCleanupWasmPageResult {
    /** The page result JSON exactly as an analyze or render manifest writes it. */
    pageMetadataJson: string;
    pageMetadata: INativeScanCleanupPageArtifactMetadataV3;
}

export interface IScanCleanupWasmRenderPreviewResult extends IScanCleanupWasmPageResult {outputs: IScanCleanupWasmOutput[];}

/**
 * The fixed analysis plane that owns a render's decisions: the input itself,
 * or a separate raster, at its own resolution.
 */
export type TScanCleanupWasmAnalysisPlane =
    | {
        source: 'input';
        dpi: number;
    }
    | {
        source: 'raster';
        raster: TScanCleanupEncodedRaster;
        dpi: number;
    };

/**
 * Renders one page as the desktop preview and OCR preprocessing do: no
 * matched document canvas and no separable layers.
 */
export interface IScanCleanupWasmRenderPreviewRequest {
    input: TScanCleanupEncodedRaster;
    page: Omit<WasmRenderPreviewRequestV1, 'analysisDpi' | 'analysisIsInput'>;
    analysisPlane?: TScanCleanupWasmAnalysisPlane;
    planeEncoding: TScanCleanupWasmPlaneEncoding;
}

/** Analyzes one page as an analyze manifest does, before reconciliation. */
export interface IScanCleanupWasmAnalyzeRequest {
    input: TScanCleanupEncodedRaster;
    page: WasmAnalyzePageRequestV1;
}

const PLANE_ENCODING_CODES: Record<TScanCleanupWasmPlaneEncoding, number> = {
    raw: SCAN_CLEANUP_WASM_PLANE_ENCODING_RAW,
    png: SCAN_CLEANUP_WASM_PLANE_ENCODING_PNG,
};
const PLANE_KINDS = new Map<number, {
    kind: TScanCleanupWasmPlaneKind;
    channels: number
}>([
    [
        SCAN_CLEANUP_WASM_PLANE_KIND_GRAY8,
        {
            kind: 'gray8',
            channels: 1,
        },
    ],
    [
        SCAN_CLEANUP_WASM_PLANE_KIND_RGB8,
        {
            kind: 'rgb8',
            channels: 3,
        },
    ],
]);
const PLANE_ENCODINGS = new Map<number, TScanCleanupWasmPlaneEncoding>([
    [
        SCAN_CLEANUP_WASM_PLANE_ENCODING_RAW,
        'raw',
    ],
    [
        SCAN_CLEANUP_WASM_PLANE_ENCODING_PNG,
        'png',
    ],
]);
const U32_MAX = 0xffff_ffff;

export class InvalidScanCleanupWasmResultError extends Error {
    constructor(message: string) {
        super(`The browser cleanup engine returned malformed output: ${message}`);
        this.name = 'InvalidScanCleanupWasmResultError';
    }
}

function encodeFrame(
    operation: number,
    planeEncoding: number,
    page: object,
    input: Uint8Array,
    analysis: Uint8Array,
): Uint8Array<ArrayBuffer> {
    const json = new TextEncoder().encode(JSON.stringify(page));
    if (json.byteLength > SCAN_CLEANUP_WASM_MAX_REQUEST_JSON_BYTES) {
        throw new RangeError('Scan-cleanup request JSON exceeds its admission ceiling');
    }
    if (input.byteLength > U32_MAX || analysis.byteLength > U32_MAX) {
        throw new RangeError('Scan-cleanup raster exceeds the 32-bit frame field');
    }
    const frame = new Uint8Array(SCAN_CLEANUP_WASM_REQUEST_HEADER_BYTES + json.byteLength + input.byteLength + analysis.byteLength);
    frame.set(new TextEncoder().encode(SCAN_CLEANUP_WASM_REQUEST_MAGIC), 0);
    const view = new DataView(frame.buffer);
    const fields = [
        SCAN_CLEANUP_WASM_REQUEST_VERSION,
        operation,
        planeEncoding,
        json.byteLength,
        input.byteLength,
        analysis.byteLength,
    ];
    fields.forEach((value, index) => view.setUint32(SCAN_CLEANUP_WASM_REQUEST_MAGIC.length + index * 4, value, true));
    let offset = SCAN_CLEANUP_WASM_REQUEST_HEADER_BYTES;
    for (const bytes of [
        json,
        input,
        analysis,
    ]) {
        frame.set(bytes, offset);
        offset += bytes.byteLength;
    }
    return frame;
}

export function encodeScanCleanupWasmRenderPreviewRequest(request: IScanCleanupWasmRenderPreviewRequest) {
    const plane = request.analysisPlane;
    const page: WasmRenderPreviewRequestV1 = {
        ...request.page,
        ...(plane === undefined ? {} : {analysisDpi: plane.dpi}),
        ...(plane?.source === 'input' ? {analysisIsInput: true} : {}),
    };
    return encodeFrame(
        SCAN_CLEANUP_WASM_OP_RENDER_PREVIEW,
        PLANE_ENCODING_CODES[request.planeEncoding],
        page,
        request.input,
        plane?.source === 'raster' ? plane.raster : new Uint8Array(),
    );
}

export function encodeScanCleanupWasmAnalyzeRequest(request: IScanCleanupWasmAnalyzeRequest) {
    return encodeFrame(
        SCAN_CLEANUP_WASM_OP_ANALYZE,
        SCAN_CLEANUP_WASM_PLANE_ENCODING_RAW,
        request.page,
        request.input,
        new Uint8Array(),
    );
}

class FrameReader {
    private offset = 0;

    private readonly view: DataView;

    constructor(private readonly bytes: Uint8Array) {
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    u32() {
        if (this.offset + 4 > this.bytes.byteLength) throw new InvalidScanCleanupWasmResultError('truncated header');
        const value = this.view.getUint32(this.offset, true);
        this.offset += 4;
        return value;
    }

    take(length: number) {
        if (this.offset + length > this.bytes.byteLength) throw new InvalidScanCleanupWasmResultError('truncated data');
        const slice = this.bytes.slice(this.offset, this.offset + length);
        this.offset += length;
        return slice;
    }

    text(length: number) {
        return new TextDecoder('utf-8', {fatal: true}).decode(this.take(length));
    }

    end() {
        if (this.offset !== this.bytes.byteLength) throw new InvalidScanCleanupWasmResultError('trailing bytes');
    }
}

function decodeFrame(output: Uint8Array) {
    if (output.byteLength < SCAN_CLEANUP_WASM_RESULT_HEADER_BYTES) {
        throw new InvalidScanCleanupWasmResultError('truncated header');
    }
    const reader = new FrameReader(output);
    const pageLength = reader.u32();
    const outputCount = reader.u32();
    const pageMetadataJson = reader.text(pageLength);
    if (outputCount > (output.byteLength - SCAN_CLEANUP_WASM_RESULT_HEADER_BYTES) / SCAN_CLEANUP_WASM_OUTPUT_HEADER_BYTES) {
        throw new InvalidScanCleanupWasmResultError('output count exceeds the frame');
    }
    const outputs: IScanCleanupWasmOutput[] = [];
    for (let index = 0; index < outputCount; index += 1) {
        const metadataLength = reader.u32();
        const kindCode = reader.u32();
        const encodingCode = reader.u32();
        const width = reader.u32();
        const height = reader.u32();
        const dataLength = reader.u32();
        const kind = PLANE_KINDS.get(kindCode);
        const encoding = PLANE_ENCODINGS.get(encodingCode);
        if (!kind || !encoding || width === 0 || height === 0) {
            throw new InvalidScanCleanupWasmResultError('unknown output plane');
        }
        if (encoding === 'raw' && dataLength !== width * height * kind.channels) {
            throw new InvalidScanCleanupWasmResultError('raw plane length does not match its dimensions');
        }
        const metadataJson = reader.text(metadataLength);
        outputs.push({
            metadataJson,
            metadata: decodeNativeScanCleanupOutputMetadataJson(metadataJson),
            plane: {
                kind: kind.kind,
                encoding,
                width,
                height,
                data: reader.take(dataLength),
            },
        });
    }
    reader.end();
    return {
        pageMetadataJson,
        pageMetadata: decodeNativeScanCleanupPageMetadataJson(pageMetadataJson),
        outputs,
    };
}

export function decodeScanCleanupWasmRenderPreviewResult(output: Uint8Array): IScanCleanupWasmRenderPreviewResult {
    return decodeFrame(output);
}

export function decodeScanCleanupWasmAnalyzeResult(output: Uint8Array): IScanCleanupWasmPageResult {
    const {
        outputs, ...page
    } = decodeFrame(output);
    if (outputs.length !== 0) throw new InvalidScanCleanupWasmResultError('an analysis carries no outputs');
    return page;
}
