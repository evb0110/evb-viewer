import {
    SCAN_CLEANUP_WASM_ATTACHMENT_ANALYSIS,
    SCAN_CLEANUP_WASM_ATTACHMENT_DETAIL_BASE_CLEANED,
    SCAN_CLEANUP_WASM_ATTACHMENT_DETAIL_BASE_METADATA,
    SCAN_CLEANUP_WASM_ATTACHMENT_DETAIL_BASE_SOURCE,
    SCAN_CLEANUP_WASM_ATTACHMENT_HEADER_BYTES,
    SCAN_CLEANUP_WASM_ATTACHMENT_INPUT,
    SCAN_CLEANUP_WASM_ATTACHMENT_PAGE_METADATA,
    SCAN_CLEANUP_WASM_ATTACHMENT_TRUSTED_FOREGROUND_SELECTION,
    SCAN_CLEANUP_WASM_ATTACHMENT_TRUSTED_MRC_BACKGROUND,
    SCAN_CLEANUP_WASM_MAX_REQUEST_JSON_BYTES,
    SCAN_CLEANUP_WASM_OP_ANALYZE_PAGE,
    SCAN_CLEANUP_WASM_OP_DERIVE_INK_CONTEXTS,
    SCAN_CLEANUP_WASM_OP_FINISH_PAGE_ANALYSIS,
    SCAN_CLEANUP_WASM_OP_RECONCILE_DOCUMENT,
    SCAN_CLEANUP_WASM_OP_RENDER_PAGE,
    SCAN_CLEANUP_WASM_OP_SAMPLE_PAGE_INK,
    SCAN_CLEANUP_WASM_OUTPUT_HEADER_BYTES,
    SCAN_CLEANUP_WASM_PLANE_ENCODING_PBM,
    SCAN_CLEANUP_WASM_PLANE_ENCODING_PGM,
    SCAN_CLEANUP_WASM_PLANE_ENCODING_PNG,
    SCAN_CLEANUP_WASM_PLANE_ENCODING_PPM,
    SCAN_CLEANUP_WASM_PLANE_ENCODING_RAW,
    SCAN_CLEANUP_WASM_PLANE_HEADER_BYTES,
    SCAN_CLEANUP_WASM_PLANE_KIND_BILEVEL1,
    SCAN_CLEANUP_WASM_PLANE_KIND_GRAY8,
    SCAN_CLEANUP_WASM_PLANE_KIND_RGB8,
    SCAN_CLEANUP_WASM_PLANE_ROLE_BACKGROUND,
    SCAN_CLEANUP_WASM_PLANE_ROLE_BILEVEL,
    SCAN_CLEANUP_WASM_PLANE_ROLE_COMPOSITE,
    SCAN_CLEANUP_WASM_PLANE_ROLE_FOREGROUND_ALPHA,
    SCAN_CLEANUP_WASM_PLANE_ROLE_FOREGROUND_MASK,
    SCAN_CLEANUP_WASM_PLANE_ROLE_PICTURE_MASK,
    SCAN_CLEANUP_WASM_PLANE_ROLE_TONE_PRESERVATION_ALPHA,
    SCAN_CLEANUP_WASM_PLANES_ENCODED,
    SCAN_CLEANUP_WASM_PLANES_RAW,
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
    DetailRenderGeometry,
    DocumentInkSample,
    PageInkConsistencyContext,
    PageReconciliation,
    ReconciliationCandidate,
    WasmAnalyzePageRequestV2,
    WasmDeriveInkContextsRequestV2,
    WasmFinishPageAnalysisRequestV2,
    WasmReconcileDocumentRequestV2,
    WasmRenderPageRequestV2,
    WasmSamplePageInkRequestV2,
} from '@contracts/scan-cleanup/nativeWire.generated';

/**
 * The browser scan-cleanup engine: `public/wasm/evb-scan-cleanup.wasm`, built
 * from `native/scan-cleanup/src/wasm.rs`. Each request is one page of a
 * desktop manifest, or one document-level step a manifest takes between its
 * pages, run by the same Rust code the desktop CLI runs, from bytes instead of
 * files.
 */
export const BROWSER_SCAN_CLEANUP_WASM_PATH = '/wasm/evb-scan-cleanup.wasm';

/**
 * A page raster as the engine reads it: PNG, or binary PPM (P6), told apart by
 * signature exactly as the CLI's file readers do.
 */
export type TScanCleanupEncodedRaster = Uint8Array;

/** What a plane is: the files a desktop manifest output can publish. */
export type TScanCleanupWasmPlaneRole =
    | 'composite'
    | 'bilevel'
    | 'background'
    | 'foreground-mask'
    | 'foreground-alpha'
    | 'picture-mask'
    | 'tone-preservation-alpha';
export type TScanCleanupWasmPlaneKind = 'gray8' | 'rgb8' | 'bilevel1';
export type TScanCleanupWasmPlaneEncoding = 'raw' | 'png' | 'pbm' | 'ppm' | 'pgm';
/** How a preview's composite comes back: pixels, or the CLI's PNG bytes. */
export type TScanCleanupWasmPreviewEncoding = Extract<TScanCleanupWasmPlaneEncoding, 'raw' | 'png'>;
/** How a render's planes come back: pixels, or each plane's CLI file bytes. */
export type TScanCleanupWasmRequestedPlanes = 'raw' | 'encoded';

/**
 * One plane's pixels. Raw planes are row-major with no padding: one byte per
 * pixel for gray8, three for rgb8, and for bilevel1 packed rows of
 * `ceil(width / 8)` bytes, most significant bit first, one for black, as in a
 * PBM P4 payload. Encoded planes are the exact bytes the CLI writes to that
 * plane's destination file.
 */
export interface IScanCleanupWasmPlane {
    role: TScanCleanupWasmPlaneRole;
    kind: TScanCleanupWasmPlaneKind;
    encoding: TScanCleanupWasmPlaneEncoding;
    width: number;
    height: number;
    data: Uint8Array<ArrayBuffer>;
}

/** One output of a preview: its composite. */
export interface IScanCleanupWasmOutput {
    /** The metadata JSON exactly as the CLI writes it beside its output. */
    metadataJson: string;
    metadata: TNativeScanCleanupOutputArtifactMetadataV3;
    plane: IScanCleanupWasmPlane;
}

/** One output of a render: every plane its destination took. */
export interface IScanCleanupWasmRenderedOutput {
    /** The metadata JSON exactly as the CLI's manifest run leaves it. */
    metadataJson: string;
    metadata: TNativeScanCleanupOutputArtifactMetadataV3;
    planes: IScanCleanupWasmPlane[];
}

export interface IScanCleanupWasmPageResult {
    /** The page result JSON exactly as an analyze or render manifest writes it. */
    pageMetadataJson: string;
    pageMetadata: INativeScanCleanupPageArtifactMetadataV3;
}

export interface IScanCleanupWasmRenderPreviewResult extends IScanCleanupWasmPageResult {outputs: IScanCleanupWasmOutput[];}

export interface IScanCleanupWasmRenderPageResult extends IScanCleanupWasmPageResult {outputs: IScanCleanupWasmRenderedOutput[];}

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
 * A compact MRC page's extracted layers. The selection is a raster, or the PDF
 * JBIG2 generic region the CLI reads from a `.jb2e` file.
 */
export interface IScanCleanupWasmTrustedMrcLayers {
    selection: Uint8Array;
    selectionEncoding: 'raster' | 'jbig2';
    background: TScanCleanupEncodedRaster;
}

/** The base preview a detail render refines. */
export interface IScanCleanupWasmDetailBase {
    geometry: DetailRenderGeometry;
    /** The base output's metadata JSON, as its render returned it. */
    baseMetadataJson: string;
    baseSource: TScanCleanupEncodedRaster;
    baseCleaned?: TScanCleanupEncodedRaster;
}

type TRenderPage = Omit<WasmRenderPageRequestV2, 'analysisDpi' | 'analysisIsInput' | 'trustedForegroundJbig2' | 'detailRenderPlan'>;

/**
 * Renders one page as a one-page desktop render manifest does: a preview, or
 * a final render with a matched canvas, separable layers, bilevel, picture and
 * tone planes for the destinations `page.outputs` lists.
 */
export interface IScanCleanupWasmRenderPageRequest {
    input: TScanCleanupEncodedRaster;
    page: TRenderPage;
    analysisPlane?: TScanCleanupWasmAnalysisPlane;
    trustedMrc?: IScanCleanupWasmTrustedMrcLayers;
    detail?: IScanCleanupWasmDetailBase;
    planes: TScanCleanupWasmRequestedPlanes;
}

/**
 * Renders one page as the desktop preview and OCR preprocessing do: every
 * output's composite and no separable layers.
 */
export interface IScanCleanupWasmRenderPreviewRequest {
    input: TScanCleanupEncodedRaster;
    page: Omit<TRenderPage, 'renderMode' | 'outputs'>;
    analysisPlane?: TScanCleanupWasmAnalysisPlane;
    trustedMrc?: IScanCleanupWasmTrustedMrcLayers;
    detail?: IScanCleanupWasmDetailBase;
    planeEncoding: TScanCleanupWasmPreviewEncoding;
}

/** Analyzes one page as an analyze manifest's first pass, or its rerun, does. */
export interface IScanCleanupWasmAnalyzeRequest {
    input: TScanCleanupEncodedRaster;
    page: WasmAnalyzePageRequestV2;
}

/** An analysis, and what document reconciliation reads from its page. */
export interface IScanCleanupWasmAnalyzeResult extends IScanCleanupWasmPageResult {reconciliation: ReconciliationCandidate;}

/** Reconciles one manifest batch's analyzed pages, in page order. */
export type TScanCleanupWasmReconcileDocumentRequest = WasmReconcileDocumentRequestV2;

/** Each page's reconciliation, or null where its analysis stands. */
export interface IScanCleanupWasmReconcileDocumentResult {pages: Array<PageReconciliation | null>;}

/**
 * Finishes one analysis: applies its reconciliation and PDF placement. The
 * analysis is the page's own, or the rerun's when the reconciliation is one.
 */
export interface IScanCleanupWasmFinishPageAnalysisRequest extends WasmFinishPageAnalysisRequestV2 {pageMetadataJson: string;}

export interface IScanCleanupWasmSamplePageInkRequest {
    trustedMrc: IScanCleanupWasmTrustedMrcLayers;
    page: Omit<WasmSamplePageInkRequestV2, 'trustedForegroundJbig2'>;
}

export interface IScanCleanupWasmSamplePageInkResult {sample: DocumentInkSample | null;}

/** Derives each page's ink context from one render manifest batch's samples. */
export type TScanCleanupWasmDeriveInkContextsRequest = WasmDeriveInkContextsRequestV2;

export interface IScanCleanupWasmDeriveInkContextsResult {contexts: Array<PageInkConsistencyContext | null>;}

const PLANE_ROLES = new Map<number, TScanCleanupWasmPlaneRole>([
    [
        SCAN_CLEANUP_WASM_PLANE_ROLE_COMPOSITE,
        'composite',
    ],
    [
        SCAN_CLEANUP_WASM_PLANE_ROLE_BILEVEL,
        'bilevel',
    ],
    [
        SCAN_CLEANUP_WASM_PLANE_ROLE_BACKGROUND,
        'background',
    ],
    [
        SCAN_CLEANUP_WASM_PLANE_ROLE_FOREGROUND_MASK,
        'foreground-mask',
    ],
    [
        SCAN_CLEANUP_WASM_PLANE_ROLE_FOREGROUND_ALPHA,
        'foreground-alpha',
    ],
    [
        SCAN_CLEANUP_WASM_PLANE_ROLE_PICTURE_MASK,
        'picture-mask',
    ],
    [
        SCAN_CLEANUP_WASM_PLANE_ROLE_TONE_PRESERVATION_ALPHA,
        'tone-preservation-alpha',
    ],
]);
const PLANE_KINDS = new Map<number, TScanCleanupWasmPlaneKind>([
    [
        SCAN_CLEANUP_WASM_PLANE_KIND_GRAY8,
        'gray8',
    ],
    [
        SCAN_CLEANUP_WASM_PLANE_KIND_RGB8,
        'rgb8',
    ],
    [
        SCAN_CLEANUP_WASM_PLANE_KIND_BILEVEL1,
        'bilevel1',
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
    [
        SCAN_CLEANUP_WASM_PLANE_ENCODING_PBM,
        'pbm',
    ],
    [
        SCAN_CLEANUP_WASM_PLANE_ENCODING_PPM,
        'ppm',
    ],
    [
        SCAN_CLEANUP_WASM_PLANE_ENCODING_PGM,
        'pgm',
    ],
]);
const REQUESTED_PLANES: Record<TScanCleanupWasmRequestedPlanes, number> = {
    raw: SCAN_CLEANUP_WASM_PLANES_RAW,
    encoded: SCAN_CLEANUP_WASM_PLANES_ENCODED,
};
const U32_MAX = 0xffff_ffff;

export class InvalidScanCleanupWasmResultError extends Error {
    constructor(message: string) {
        super(`The browser cleanup engine returned malformed output: ${message}`);
        this.name = 'InvalidScanCleanupWasmResultError';
    }
}

type TAttachment = readonly [role: number, bytes: Uint8Array | undefined];

function encodeFrame(
    operation: number,
    planes: number,
    request: object,
    attachments: readonly TAttachment[] = [],
): Uint8Array<ArrayBuffer> {
    const json = new TextEncoder().encode(JSON.stringify(request));
    if (json.byteLength > SCAN_CLEANUP_WASM_MAX_REQUEST_JSON_BYTES) {
        throw new RangeError('Scan-cleanup request JSON exceeds its admission ceiling');
    }
    const present = attachments.filter((entry): entry is readonly [number, Uint8Array] => entry[1] !== undefined);
    if (present.some(([
        , bytes,
    ]) => bytes.byteLength > U32_MAX)) {
        throw new RangeError('Scan-cleanup attachment exceeds the 32-bit frame field');
    }
    const headerBytes = SCAN_CLEANUP_WASM_REQUEST_HEADER_BYTES + present.length * SCAN_CLEANUP_WASM_ATTACHMENT_HEADER_BYTES;
    const frame = new Uint8Array(headerBytes + json.byteLength + present.reduce((total, [
        , bytes,
    ]) => total + bytes.byteLength, 0));
    frame.set(new TextEncoder().encode(SCAN_CLEANUP_WASM_REQUEST_MAGIC), 0);
    const view = new DataView(frame.buffer);
    let offset = SCAN_CLEANUP_WASM_REQUEST_MAGIC.length;
    const write = (value: number) => {
        view.setUint32(offset, value, true);
        offset += 4;
    };
    for (const value of [
        SCAN_CLEANUP_WASM_REQUEST_VERSION,
        operation,
        planes,
        json.byteLength,
        present.length,
    ]) write(value);
    for (const [
        role,
        bytes,
    ] of present) {
        write(role);
        write(bytes.byteLength);
    }
    for (const bytes of [
        json,
        ...present.map(([
            , bytes,
        ]) => bytes),
    ]) {
        frame.set(bytes, offset);
        offset += bytes.byteLength;
    }
    return frame;
}

function renderAttachments(request: {
    input: Uint8Array;
    analysisPlane?: TScanCleanupWasmAnalysisPlane;
    trustedMrc?: IScanCleanupWasmTrustedMrcLayers;
    detail?: IScanCleanupWasmDetailBase;
}): TAttachment[] {
    const plane = request.analysisPlane;
    return [
        [
            SCAN_CLEANUP_WASM_ATTACHMENT_INPUT,
            request.input,
        ],
        [
            SCAN_CLEANUP_WASM_ATTACHMENT_ANALYSIS,
            plane?.source === 'raster' ? plane.raster : undefined,
        ],
        [
            SCAN_CLEANUP_WASM_ATTACHMENT_TRUSTED_FOREGROUND_SELECTION,
            request.trustedMrc?.selection,
        ],
        [
            SCAN_CLEANUP_WASM_ATTACHMENT_TRUSTED_MRC_BACKGROUND,
            request.trustedMrc?.background,
        ],
        [
            SCAN_CLEANUP_WASM_ATTACHMENT_DETAIL_BASE_METADATA,
            request.detail === undefined ? undefined : new TextEncoder().encode(request.detail.baseMetadataJson),
        ],
        [
            SCAN_CLEANUP_WASM_ATTACHMENT_DETAIL_BASE_SOURCE,
            request.detail?.baseSource,
        ],
        [
            SCAN_CLEANUP_WASM_ATTACHMENT_DETAIL_BASE_CLEANED,
            request.detail?.baseCleaned,
        ],
    ];
}

function renderPage(request: Omit<IScanCleanupWasmRenderPageRequest, 'planes'>): WasmRenderPageRequestV2 {
    const plane = request.analysisPlane;
    return {
        ...request.page,
        ...(plane === undefined ? {} : {analysisDpi: plane.dpi}),
        ...(plane?.source === 'input' ? {analysisIsInput: true} : {}),
        ...(request.trustedMrc?.selectionEncoding === 'jbig2' ? {trustedForegroundJbig2: true} : {}),
        ...(request.detail === undefined ? {} : {detailRenderPlan: request.detail.geometry}),
    };
}

export function encodeScanCleanupWasmRenderPageRequest(request: IScanCleanupWasmRenderPageRequest) {
    return encodeFrame(
        SCAN_CLEANUP_WASM_OP_RENDER_PAGE,
        REQUESTED_PLANES[request.planes],
        renderPage(request),
        renderAttachments(request),
    );
}

export function encodeScanCleanupWasmRenderPreviewRequest(request: IScanCleanupWasmRenderPreviewRequest) {
    return encodeFrame(
        SCAN_CLEANUP_WASM_OP_RENDER_PAGE,
        REQUESTED_PLANES[request.planeEncoding === 'png' ? 'encoded' : 'raw'],
        renderPage({
            ...request,
            page: {
                ...request.page,
                renderMode: 'preview',
            },
        }),
        renderAttachments(request),
    );
}

export function encodeScanCleanupWasmAnalyzeRequest(request: IScanCleanupWasmAnalyzeRequest) {
    return encodeFrame(SCAN_CLEANUP_WASM_OP_ANALYZE_PAGE, SCAN_CLEANUP_WASM_PLANES_RAW, request.page, [[
        SCAN_CLEANUP_WASM_ATTACHMENT_INPUT,
        request.input,
    ]]);
}

export function encodeScanCleanupWasmReconcileDocumentRequest(request: TScanCleanupWasmReconcileDocumentRequest) {
    return encodeFrame(SCAN_CLEANUP_WASM_OP_RECONCILE_DOCUMENT, SCAN_CLEANUP_WASM_PLANES_RAW, request);
}

export function encodeScanCleanupWasmFinishPageAnalysisRequest({
    pageMetadataJson,
    ...request
}: IScanCleanupWasmFinishPageAnalysisRequest) {
    return encodeFrame(SCAN_CLEANUP_WASM_OP_FINISH_PAGE_ANALYSIS, SCAN_CLEANUP_WASM_PLANES_RAW, request, [[
        SCAN_CLEANUP_WASM_ATTACHMENT_PAGE_METADATA,
        new TextEncoder().encode(pageMetadataJson),
    ]]);
}

export function encodeScanCleanupWasmSamplePageInkRequest(request: IScanCleanupWasmSamplePageInkRequest) {
    return encodeFrame(
        SCAN_CLEANUP_WASM_OP_SAMPLE_PAGE_INK,
        SCAN_CLEANUP_WASM_PLANES_RAW,
        {
            ...request.page,
            ...(request.trustedMrc.selectionEncoding === 'jbig2' ? {trustedForegroundJbig2: true} : {}),
        } satisfies WasmSamplePageInkRequestV2,
        [
            [
                SCAN_CLEANUP_WASM_ATTACHMENT_TRUSTED_FOREGROUND_SELECTION,
                request.trustedMrc.selection,
            ],
            [
                SCAN_CLEANUP_WASM_ATTACHMENT_TRUSTED_MRC_BACKGROUND,
                request.trustedMrc.background,
            ],
        ],
    );
}

export function encodeScanCleanupWasmDeriveInkContextsRequest(request: TScanCleanupWasmDeriveInkContextsRequest) {
    return encodeFrame(SCAN_CLEANUP_WASM_OP_DERIVE_INK_CONTEXTS, SCAN_CLEANUP_WASM_PLANES_RAW, request);
}

class FrameReader {
    private offset = 0;

    private readonly view: DataView;

    constructor(private readonly bytes: Uint8Array) {
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    remaining() {
        return this.bytes.byteLength - this.offset;
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

const CHANNELS: Record<Exclude<TScanCleanupWasmPlaneKind, 'bilevel1'>, number> = {
    gray8: 1,
    rgb8: 3,
};

function readPlane(reader: FrameReader): IScanCleanupWasmPlane {
    const role = PLANE_ROLES.get(reader.u32());
    const kind = PLANE_KINDS.get(reader.u32());
    const encoding = PLANE_ENCODINGS.get(reader.u32());
    const width = reader.u32();
    const height = reader.u32();
    const dataLength = reader.u32();
    if (!role || !kind || !encoding || width === 0 || height === 0) {
        throw new InvalidScanCleanupWasmResultError('unknown output plane');
    }
    const rawLength = kind === 'bilevel1' ? Math.ceil(width / 8) * height : width * height * CHANNELS[kind];
    if (encoding === 'raw' && dataLength !== rawLength) {
        throw new InvalidScanCleanupWasmResultError('raw plane length does not match its dimensions');
    }
    return {
        role,
        kind,
        encoding,
        width,
        height,
        data: reader.take(dataLength),
    };
}

function decodeFrame(output: Uint8Array) {
    if (output.byteLength < SCAN_CLEANUP_WASM_RESULT_HEADER_BYTES) {
        throw new InvalidScanCleanupWasmResultError('truncated header');
    }
    const reader = new FrameReader(output);
    const pageLength = reader.u32();
    const detailsLength = reader.u32();
    const outputCount = reader.u32();
    const pageMetadataJson = reader.text(pageLength);
    const detailsJson = reader.text(detailsLength);
    if (outputCount > reader.remaining() / SCAN_CLEANUP_WASM_OUTPUT_HEADER_BYTES) {
        throw new InvalidScanCleanupWasmResultError('output count exceeds the frame');
    }
    const outputs: IScanCleanupWasmRenderedOutput[] = [];
    for (let index = 0; index < outputCount; index += 1) {
        const metadataLength = reader.u32();
        const planeCount = reader.u32();
        const metadataJson = reader.text(metadataLength);
        if (planeCount > reader.remaining() / SCAN_CLEANUP_WASM_PLANE_HEADER_BYTES) {
            throw new InvalidScanCleanupWasmResultError('plane count exceeds the frame');
        }
        outputs.push({
            metadataJson,
            metadata: decodeNativeScanCleanupOutputMetadataJson(metadataJson),
            planes: Array.from({length: planeCount}, () => readPlane(reader)),
        });
    }
    reader.end();
    return {
        pageMetadataJson,
        detailsJson,
        outputs,
    };
}

function decodePage(pageMetadataJson: string): IScanCleanupWasmPageResult {
    return {
        pageMetadataJson,
        pageMetadata: decodeNativeScanCleanupPageMetadataJson(pageMetadataJson),
    };
}

function decodeDetails(detailsJson: string, field: string, accepts: (value: unknown) => boolean): unknown {
    let details: unknown;
    try {
        details = JSON.parse(detailsJson);
    } catch {
        throw new InvalidScanCleanupWasmResultError('details are not JSON');
    }
    const value = typeof details === 'object' && details !== null ? (details as Record<string, unknown>)[field] : undefined;
    if (!accepts(value)) throw new InvalidScanCleanupWasmResultError(`details carry no valid ${field}`);
    return value;
}

const isObject = (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isObjectOrNullArray = (value: unknown) => Array.isArray(value) && value.every(entry => entry === null || isObject(entry));

function decodeDocumentStep(output: Uint8Array) {
    const {
        pageMetadataJson,
        detailsJson,
        outputs,
    } = decodeFrame(output);
    if (pageMetadataJson !== '' || outputs.length !== 0) {
        throw new InvalidScanCleanupWasmResultError('a document step carries no page');
    }
    return detailsJson;
}

export function decodeScanCleanupWasmRenderPageResult(output: Uint8Array): IScanCleanupWasmRenderPageResult {
    const {
        pageMetadataJson,
        outputs,
    } = decodeFrame(output);
    return {
        ...decodePage(pageMetadataJson),
        outputs,
    };
}

export function decodeScanCleanupWasmRenderPreviewResult(output: Uint8Array): IScanCleanupWasmRenderPreviewResult {
    const {
        outputs, ...page
    } = decodeScanCleanupWasmRenderPageResult(output);
    return {
        ...page,
        outputs: outputs.map(({
            planes, ...rendered
        }) => {
            const [plane] = planes;
            if (planes.length !== 1 || plane?.role !== 'composite') {
                throw new InvalidScanCleanupWasmResultError('a preview output carries its composite only');
            }
            return {
                ...rendered,
                plane,
            };
        }),
    };
}

export function decodeScanCleanupWasmAnalyzeResult(output: Uint8Array): IScanCleanupWasmAnalyzeResult {
    const {
        pageMetadataJson,
        detailsJson,
        outputs,
    } = decodeFrame(output);
    if (outputs.length !== 0) throw new InvalidScanCleanupWasmResultError('an analysis carries no outputs');
    return {
        ...decodePage(pageMetadataJson),
        reconciliation: decodeDetails(detailsJson, 'reconciliation', isObject) as ReconciliationCandidate,
    };
}

export function decodeScanCleanupWasmReconcileDocumentResult(output: Uint8Array): IScanCleanupWasmReconcileDocumentResult {
    return {pages: decodeDetails(decodeDocumentStep(output), 'pages', isObjectOrNullArray) as Array<PageReconciliation | null>};
}

export function decodeScanCleanupWasmFinishPageAnalysisResult(output: Uint8Array): IScanCleanupWasmPageResult {
    const {
        pageMetadataJson,
        detailsJson,
        outputs,
    } = decodeFrame(output);
    if (detailsJson !== '' || outputs.length !== 0) {
        throw new InvalidScanCleanupWasmResultError('a finished analysis carries its page only');
    }
    return decodePage(pageMetadataJson);
}

export function decodeScanCleanupWasmSamplePageInkResult(output: Uint8Array): IScanCleanupWasmSamplePageInkResult {
    return {sample: decodeDetails(decodeDocumentStep(output), 'sample', value => value === null || isObject(value)) as DocumentInkSample | null};
}

export function decodeScanCleanupWasmDeriveInkContextsResult(output: Uint8Array): IScanCleanupWasmDeriveInkContextsResult {
    return {contexts: decodeDetails(decodeDocumentStep(output), 'contexts', isObjectOrNullArray) as Array<PageInkConsistencyContext | null>};
}
