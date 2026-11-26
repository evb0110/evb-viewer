import { getErrorMessage } from '@app/utils/error';
import {
    BYTES_HEADER,
    MUTATION_HEADER,
    INSTRUCTED_REQUEST_HEADER,
    REPORTED_HEADER,
    TEXT_BOX_APPEARANCE_HEADER,
    RESPONSE_TEXT_BOX_APPEARANCE,
    OPERATION_CODES,
    REQUEST_HEADER,
    REQUEST_VERSION,
    REQUEST_VERSION_INSTRUCTED,
    RESPONSE_ANNOTATION_PARSE,
    RESPONSE_JSON,
    RESPONSE_MUTATION,
    RESPONSE_REPORTED_INCREMENT,
    RESPONSE_REPORTED_PDF,
    RESPONSE_REPORTED_RASTER,
    U32_BYTES,
} from '@contracts/browserPageOpsWasm.generated';
import {
    type IBrowserPageOpsWorkerRequestMap,
    type IBrowserPageOpsWorkerResultMap,
    type IBrowserPageOpsWasmFailure,
} from '@contracts/browserPageOpsWorker';
import {
    BROWSER_PAGE_OPS_WORKER_RESULT_SCHEMAS,
    isBrowserPageOpsWasmFailure,
} from '@contracts/browserPageOpsWorker';
import {decodeBrowserPdfCatalog} from '@contracts/browserPdfCatalog';
import { toTransferableUint8Array } from '@app/platform/browser/toTransferableUint8Array';
import {
    blobSource,
    callPdfPageOpsWasm,
    createWasmFailure,
    createWasmLoadFailure,
    loadPdfPageOpsWasm,
    releasePdfPageOpsWasmAboveHighWater,
    runFileRequest,
    toWasmU32,
    withOpenFiles,
    writeMagic,
    writeU32,
    type IPageStructureFiles,
    type IPdfPageOpsWasmExports,
} from '@app/platform/browser/pdfPageEngine';
import * as v from 'valibot';
export {
    isBrowserPageOpsWasmFailure, type IBrowserPageOpsWasmFailure,
} from '@contracts/browserPageOpsWorker';

// Page-structure edits read and write files through the engine's host imports, not a request buffer.
type IBrowserPageOpsWasmRequestMap = Omit<IBrowserPageOpsWorkerRequestMap, 'pageStructure'>;

const wasmBytesSchema = v.custom<Uint8Array>(value => value instanceof Uint8Array);
const wasmMutationResultSchema = v.object({
    data: wasmBytesSchema,
    pageCount: v.number(),
});
const wasmCatalogResultSchema = v.pipe(
    v.unknown(),
    // The shared decoder enforces recursive bookmark depth and aggregate item budgets.
    v.transform(value => decodeBrowserPdfCatalog(value)),
    v.check(value => value !== null),
    v.transform(value => value as NonNullable<typeof value>),
);

type IBrowserPageOpsWasmResultMap = {
    [K in keyof IBrowserPageOpsWasmRequestMap]: Exclude<IBrowserPageOpsWorkerResultMap[K], IBrowserPageOpsWasmFailure>;
};

type TBrowserPageOpsWasmRequestType = keyof IBrowserPageOpsWasmRequestMap;

/** Reads that take their document as a Blob, through file framing. */
type TFileReadType =
    | 'getPageGeometry'
    | 'readPageSizes'
    | 'appendAdmission'
    | 'parseAnnotations'
    | 'readCatalog'
    | 'conformance'
    | 'ocrTextVisibility';
/** Requests that carry their document in the request buffer. */
type TByteRequestType = Exclude<TBrowserPageOpsWasmRequestType, TFileReadType>;

type TBrowserPageOpsWasmRequest = {
    [K in TByteRequestType]: {
        type: K;
        payload: IBrowserPageOpsWasmRequestMap[K];
    };
}[TByteRequestType];

interface ICachedDocumentSlot {
    key: string;
    handle: number;
    tool: IPdfPageOpsWasmExports;
}

// One parsed PDF Document kept warm in this thread's page-ops WASM instance,
// keyed by document ref + revision so sequential page rasters avoid copying
// and re-parsing the entire PDF.
let cachedDocument: ICachedDocumentSlot | null = null;
let nextCachedDocumentHandle = 1;

function buildStandardFrame(options: {
    operation: number;
    pages?: readonly number[];
    pageNumber?: number;
    data?: Uint8Array;
    insertionData?: Uint8Array;
    password?: Uint8Array;
}) {
    const pages = (options.pages ?? []).map(toWasmU32);
    const pageNumber = toWasmU32(options.pageNumber ?? 0);
    const data = options.data ?? new Uint8Array();
    const insertionData = options.insertionData ?? new Uint8Array();
    const password = options.password ?? new Uint8Array();
    const headerBytes = REQUEST_HEADER.bytes;
    const dataLength = toWasmU32(data.byteLength);
    const insertionDataLength = toWasmU32(insertionData.byteLength);
    const passwordLength = toWasmU32(password.byteLength);
    const output: Uint8Array<ArrayBuffer> = new Uint8Array(
        headerBytes
        + (pages.length * U32_BYTES)
        + dataLength
        + insertionDataLength
        + passwordLength,
    );
    const view = new DataView(output.buffer);
    writeMagic(output, REQUEST_HEADER.magic);
    writeU32(view, REQUEST_HEADER.version, REQUEST_VERSION);
    writeU32(view, REQUEST_HEADER.operation, options.operation);
    writeU32(view, REQUEST_HEADER.pageCount, pages.length);
    writeU32(view, REQUEST_HEADER.pageNumber, pageNumber);
    writeU32(view, REQUEST_HEADER.angle, 0);
    view.setFloat64(REQUEST_HEADER.top, 0, true);
    view.setFloat64(REQUEST_HEADER.bottom, 0, true);
    view.setFloat64(REQUEST_HEADER.left, 0, true);
    view.setFloat64(REQUEST_HEADER.right, 0, true);
    writeU32(view, REQUEST_HEADER.dataLength, dataLength);
    writeU32(view, REQUEST_HEADER.insertionDataLength, insertionDataLength);
    writeU32(view, REQUEST_HEADER.passwordLength, passwordLength);
    let offset: number = headerBytes;
    for (const page of pages) {
        offset = writeU32(view, offset, page);
    }
    output.set(data, offset);
    offset += dataLength;
    output.set(insertionData, offset);
    offset += insertionDataLength;
    output.set(password, offset);
    const passwordOffset = offset;
    password.fill(0);
    return {
        data: output,
        passwordOffset,
        passwordLength,
    };
}

/**
 * Closes any parsed PDF `Document` cached in this thread's WASM instance whose
 * key matches `keyPrefix` (or any cached document when `keyPrefix` is omitted),
 * and releases the WASM instance if its memory grew past the high-water mark.
 */
export function evictCachedBrowserPageOpsDocument(keyPrefix?: string) {
    const slot = cachedDocument;
    if (!slot) return;
    if (keyPrefix !== undefined && !slot.key.startsWith(keyPrefix)) return;
    cachedDocument = null;
    try {
        const frame = buildStandardFrame({
            operation: OPERATION_CODES.closeDocument,
            pageNumber: slot.handle,
        });
        callPdfPageOpsWasm(slot.tool, frame.data);
    } catch {
        // Instance may already have been discarded after a trap.
    } finally {
        releasePdfPageOpsWasmAboveHighWater(slot.tool);
    }
}

function getRequestPages(request: TBrowserPageOpsWasmRequest): number[] {
    switch (request.type) {
        case 'printLayout':
            return request.payload.pageNumbers;
        case 'inspectScanCleanupPdf':
            return request.payload.pages;
        case 'splitPages':
        case 'renderScanCleanupRaster':
        case 'overlayText':
        case 'recompressImages':
        case 'replacePageImages':
        case 'decrypt':
        case 'textBoxAppearance':
            return [];
    }
}

function getRequestData(request: TBrowserPageOpsWasmRequest): Uint8Array {
    switch (request.type) {
        case 'decrypt':
        case 'printLayout':
        case 'inspectScanCleanupPdf':
        case 'splitPages':
        case 'overlayText':
        case 'recompressImages':
        case 'replacePageImages':
            return request.payload.data;
        case 'renderScanCleanupRaster':
            return request.payload.data ?? new Uint8Array();
        case 'textBoxAppearance':
            return new Uint8Array();
    }
}

function getInsertionData(request: TBrowserPageOpsWasmRequest): Uint8Array {
    if (request.type === 'textBoxAppearance') {
        return new TextEncoder().encode(JSON.stringify(request.payload));
    }
    if (request.type === 'printLayout') {
        return new TextEncoder().encode(`${request.payload.viewMode} ${request.payload.orientation}`);
    }
    return new Uint8Array();
}

function getPassword(request: TBrowserPageOpsWasmRequest) {
    return request.type === 'decrypt'
        ? new TextEncoder().encode(request.payload.password)
        : new Uint8Array();
}

interface IInstructedWasmRequest {
    data: Uint8Array;
    instructions: unknown;
    attachments: Uint8Array[];
}

/** The writers whose desktop commands read a JSON instructions file. */
function getInstructedRequest(request: TBrowserPageOpsWasmRequest): IInstructedWasmRequest | null {
    switch (request.type) {
        case 'splitPages':
        case 'recompressImages':
            return {
                data: request.payload.data,
                instructions: request.payload.instructions,
                attachments: [],
            };
        case 'renderScanCleanupRaster':
            return {
                data: request.payload.data ?? new Uint8Array(),
                instructions: request.payload.request,
                attachments: [],
            };
        case 'overlayText':
            return {
                data: request.payload.data,
                instructions: request.payload.instructions,
                attachments: [request.payload.sourceData],
            };
        case 'replacePageImages':
            return {
                data: request.payload.data,
                instructions: request.payload.instructions,
                attachments: request.payload.replacementPdfs,
            };
        case 'textBoxAppearance':
        case 'decrypt':
        case 'printLayout':
        case 'inspectScanCleanupPdf':
            return null;
    }
}

/** The document, its JSON instructions, then each attached PDF with its length. */
function buildInstructedWasmRequest(operation: number, payload: IInstructedWasmRequest) {
    const instructions = new TextEncoder().encode(JSON.stringify(payload.instructions));
    const attachmentLengths = payload.attachments.map(attachment => toWasmU32(attachment.byteLength));
    const output: Uint8Array<ArrayBuffer> = new Uint8Array(attachmentLengths.reduce(
        (total, length) => total + U32_BYTES + length,
        INSTRUCTED_REQUEST_HEADER.bytes + payload.data.byteLength + instructions.byteLength,
    ));
    const view = new DataView(output.buffer);
    writeMagic(output, INSTRUCTED_REQUEST_HEADER.magic);
    writeU32(view, INSTRUCTED_REQUEST_HEADER.version, REQUEST_VERSION_INSTRUCTED);
    writeU32(view, INSTRUCTED_REQUEST_HEADER.operation, operation);
    writeU32(view, INSTRUCTED_REQUEST_HEADER.dataLength, toWasmU32(payload.data.byteLength));
    writeU32(view, INSTRUCTED_REQUEST_HEADER.instructionsLength, toWasmU32(instructions.byteLength));
    writeU32(view, INSTRUCTED_REQUEST_HEADER.attachmentCount, toWasmU32(payload.attachments.length));
    let offset: number = INSTRUCTED_REQUEST_HEADER.bytes;
    output.set(payload.data, offset);
    offset += payload.data.byteLength;
    output.set(instructions, offset);
    offset += instructions.byteLength;
    for (const [
        index,
        attachment,
    ] of payload.attachments.entries()) {
        offset = writeU32(view, offset, attachmentLengths[index]!);
        output.set(attachment, offset);
        offset += attachment.byteLength;
    }
    return {
        data: output,
        passwordOffset: 0,
        passwordLength: 0,
    };
}

function buildWasmRequest(request: TBrowserPageOpsWasmRequest) {
    const instructed = getInstructedRequest(request);
    if (instructed !== null) {
        return buildInstructedWasmRequest(OPERATION_CODES[request.type], instructed);
    }
    return buildStandardFrame({
        operation: OPERATION_CODES[request.type],
        pages: getRequestPages(request),
        data: getRequestData(request),
        insertionData: getInsertionData(request),
        password: getPassword(request),
    });
}

function readMutationResult(output: Uint8Array) {
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    const pageCount = view.getUint32(MUTATION_HEADER.pageCount, true);
    const dataLength = view.getUint32(MUTATION_HEADER.dataLength, true);
    const offset = MUTATION_HEADER.bytes;
    if (offset + dataLength !== output.byteLength) {
        return null;
    }

    return {
        data: toTransferableUint8Array(output.slice(offset, offset + dataLength)),
        pageCount,
    };
}

function readJsonResult(output: Uint8Array) {
    if (output.byteLength < BYTES_HEADER.bytes) {
        return null;
    }
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    const dataLength = view.getUint32(BYTES_HEADER.dataLength, true);
    if (dataLength !== output.byteLength - BYTES_HEADER.bytes) {
        return null;
    }
    try {
        return JSON.parse(new TextDecoder().decode(output.slice(BYTES_HEADER.bytes))) as unknown;
    } catch {
        return null;
    }
}

/** A REPORTED_HEADER frame: its bytes and the JSON report after them. */
function readReportedResult(output: Uint8Array, expectedKind: number) {
    if (output.byteLength < REPORTED_HEADER.bytes) {
        return null;
    }
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    const dataLength = view.getUint32(REPORTED_HEADER.dataLength, true);
    const reportLength = view.getUint32(REPORTED_HEADER.reportLength, true);
    const reportOffset = REPORTED_HEADER.bytes + dataLength;
    if (
        view.getUint32(REPORTED_HEADER.kind, true) !== expectedKind
        || reportOffset + reportLength !== output.byteLength
    ) {
        return null;
    }
    try {
        return {
            data: toTransferableUint8Array(output.slice(REPORTED_HEADER.bytes, reportOffset)),
            pageCount: view.getUint32(REPORTED_HEADER.pageCount, true),
            report: JSON.parse(new TextDecoder().decode(output.subarray(reportOffset))) as unknown,
        };
    } catch {
        return null;
    }
}

const REPORTED_RESPONSE_KINDS = {
    splitPages: RESPONSE_REPORTED_PDF,
    overlayText: RESPONSE_REPORTED_PDF,
    recompressImages: RESPONSE_REPORTED_INCREMENT,
    replacePageImages: RESPONSE_REPORTED_INCREMENT,
    renderScanCleanupRaster: RESPONSE_REPORTED_RASTER,
} as const;
type TReportedWriterType = keyof typeof REPORTED_RESPONSE_KINDS;

function isReportedWriterType(type: TBrowserPageOpsWasmRequestType): type is TReportedWriterType {
    return Object.hasOwn(REPORTED_RESPONSE_KINDS, type);
}

function parseReportedOutput(type: TReportedWriterType, output: Uint8Array) {
    const parsed = v.safeParse(
        BROWSER_PAGE_OPS_WORKER_RESULT_SCHEMAS[type],
        readReportedResult(output, REPORTED_RESPONSE_KINDS[type]),
        {abortEarly: true},
    );
    return parsed.success && !isBrowserPageOpsWasmFailure(parsed.output) ? parsed.output : null;
}

function parseWasmOutput<K extends TBrowserPageOpsWasmRequestType>(
    type: K,
    output: Uint8Array,
): IBrowserPageOpsWasmResultMap[K] | null {
    if (output.byteLength < U32_BYTES) {
        return null;
    }

    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    const kind = view.getUint32(MUTATION_HEADER.kind, true);
    if (type === 'textBoxAppearance') {
        if (kind !== RESPONSE_TEXT_BOX_APPEARANCE || output.byteLength < TEXT_BOX_APPEARANCE_HEADER.bytes) return null;
        const dataLength = view.getUint32(TEXT_BOX_APPEARANCE_HEADER.dataLength, true);
        const metadataLength = view.getUint32(TEXT_BOX_APPEARANCE_HEADER.metadataLength, true);
        const offset = TEXT_BOX_APPEARANCE_HEADER.bytes;
        if (offset + dataLength + metadataLength !== output.byteLength) return null;
        try {
            const parsed = v.safeParse(BROWSER_PAGE_OPS_WORKER_RESULT_SCHEMAS.textBoxAppearance, {
                ...JSON.parse(new TextDecoder().decode(output.subarray(offset + dataLength))),
                data: toTransferableUint8Array(output.slice(offset, offset + dataLength)),
            }, {abortEarly: true});
            return parsed.success ? parsed.output as IBrowserPageOpsWasmResultMap[K] : null;
        } catch { return null; }
    }
    if (type === 'parseAnnotations') {
        if (kind !== RESPONSE_ANNOTATION_PARSE || output.byteLength < BYTES_HEADER.bytes) {
            return null;
        }
        const dataLength = view.getUint32(BYTES_HEADER.dataLength, true);
        if (dataLength !== output.byteLength - BYTES_HEADER.bytes) {
            return null;
        }
        const parsed = v.safeParse(
            BROWSER_PAGE_OPS_WORKER_RESULT_SCHEMAS.parseAnnotations,
            {data: toTransferableUint8Array(output.slice(BYTES_HEADER.bytes))},
            {abortEarly: true},
        );
        return parsed.success ? parsed.output as IBrowserPageOpsWasmResultMap[K] : null;
    }

    if (
        type === 'getPageGeometry'
        || type === 'readPageSizes'
        || type === 'appendAdmission'
        || type === 'ocrTextVisibility'
        || type === 'inspectScanCleanupPdf'
    ) {
        const parsed = kind === RESPONSE_JSON
            ? v.safeParse(BROWSER_PAGE_OPS_WORKER_RESULT_SCHEMAS[type], readJsonResult(output), {abortEarly: true})
            : null;
        return parsed?.success && !isBrowserPageOpsWasmFailure(parsed.output)
            ? parsed.output as IBrowserPageOpsWasmResultMap[K]
            : null;
    }

    if (isReportedWriterType(type)) {
        return parseReportedOutput(type, output) as IBrowserPageOpsWasmResultMap[K] | null;
    }

    if (type === 'readCatalog' || type === 'conformance') {
        if (kind !== RESPONSE_JSON) {
            return null;
        }
        const value: unknown = readJsonResult(output);
        if (type === 'readCatalog') {
            const parsed = v.safeParse(wasmCatalogResultSchema, value, {abortEarly: true});
            return parsed.success ? parsed.output as IBrowserPageOpsWasmResultMap[K] : null;
        }
        const parsed = v.safeParse(BROWSER_PAGE_OPS_WORKER_RESULT_SCHEMAS.conformance, value, {abortEarly: true});
        return parsed.success ? parsed.output as IBrowserPageOpsWasmResultMap[K] : null;
    }

    const parsed = kind === RESPONSE_MUTATION
        ? v.safeParse(wasmMutationResultSchema, readMutationResult(output), {abortEarly: true})
        : null;
    return parsed?.success ? parsed.output as IBrowserPageOpsWasmResultMap[K] : null;
}

function runWasmRequest<K extends TByteRequestType>(
    tool: IPdfPageOpsWasmExports,
    type: K,
    payload: IBrowserPageOpsWasmRequestMap[K],
): IBrowserPageOpsWasmResultMap[K] | IBrowserPageOpsWasmFailure {
    let builtRequest: ReturnType<typeof buildWasmRequest>;
    try {
        builtRequest = buildWasmRequest({
            type,
            payload,
        } as TBrowserPageOpsWasmRequest);
    } catch (error) {
        return createWasmFailure(
            'invalid-request',
            error instanceof Error ? getErrorMessage(error) : 'Page operation WASM request failed',
        );
    }

    const called = callPdfPageOpsWasm(tool, builtRequest.data, {
        ...(builtRequest.passwordLength > 0
            ? {
                scrubRange: {
                    offset: builtRequest.passwordOffset,
                    length: builtRequest.passwordLength,
                },
            }
            : {}),
        // Preserve an active cached Document instance while unrelated requests run.
        ...(cachedDocument?.tool === tool ? {skipHighWaterRelease: true} : {}),
    });
    if (called.status === 'failed') {
        if (cachedDocument?.tool === tool && called.error.code === 'too-large') {
            cachedDocument = null;
        }
        return called;
    }

    return parseWasmOutput(type, called.output)
        ?? createWasmFailure('invalid-request', 'Page operation WASM returned malformed output');
}

async function runCachedScanCleanupRaster(
    tool: IPdfPageOpsWasmExports,
    payload: IBrowserPageOpsWasmRequestMap['renderScanCleanupRaster'],
): Promise<IBrowserPageOpsWasmResultMap['renderScanCleanupRaster'] | IBrowserPageOpsWasmFailure> {
    const cacheKey = payload.cacheKey;
    if (cacheKey === undefined) {
        const data = payload.data ?? new Uint8Array(await payload.source!.arrayBuffer());
        return runWasmRequest(tool, 'renderScanCleanupRaster', {
            ...payload,
            data,
        });
    }

    const requestJson = new TextEncoder().encode(JSON.stringify(payload.request));
    const renderWithHandle = (handle: number) => {
        const frame = buildStandardFrame({
            operation: OPERATION_CODES.renderScanCleanupRasterCached,
            pageNumber: handle,
            insertionData: requestJson,
        });
        return callPdfPageOpsWasm(tool, frame.data, {skipHighWaterRelease: true});
    };

    if (cachedDocument !== null && cachedDocument.key === cacheKey && cachedDocument.tool === tool) {
        const hit = renderWithHandle(cachedDocument.handle);
        if (hit.status === 'succeeded') {
            return parseWasmOutput('renderScanCleanupRaster', hit.output)
                ?? createWasmFailure('invalid-request', 'Page operation WASM returned malformed output');
        }
        if (hit.error.code !== 'invalid-request' || !hit.error.message.includes('Cached PDF document handle is not open')) {
            if (hit.error.code === 'too-large') cachedDocument = null;
            return hit;
        }
        cachedDocument = null;
    }

    // Evict any prior document before opening the new revision.
    if (cachedDocument !== null) {
        evictCachedBrowserPageOpsDocument();
    }

    const bytes = payload.data ?? new Uint8Array(await payload.source!.arrayBuffer());
    const handle = nextCachedDocumentHandle;
    nextCachedDocumentHandle = nextCachedDocumentHandle >= 0xffff_ffff ? 1 : nextCachedDocumentHandle + 1;
    const openFrame = buildStandardFrame({
        operation: OPERATION_CODES.openDocument,
        pageNumber: handle,
        data: bytes,
    });
    const opened = callPdfPageOpsWasm(tool, openFrame.data, {skipHighWaterRelease: true});
    if (opened.status === 'failed') {
        return opened;
    }
    cachedDocument = {
        key: cacheKey,
        handle,
        tool,
    };

    const rendered = renderWithHandle(handle);
    if (rendered.status === 'failed') {
        if (rendered.error.code === 'too-large') cachedDocument = null;
        return rendered;
    }
    return parseWasmOutput('renderScanCleanupRaster', rendered.output)
        ?? createWasmFailure('invalid-request', 'Page operation WASM returned malformed output');
}

const NO_SINK = {
    write: () => {
        throw new Error('A read writes nothing');
    },
    read: () => {
        throw new Error('A read writes nothing');
    },
};

/** A read of one document the engine takes by range from `payload.source`, answered as the byte request was. */
async function runFileRead<K extends TFileReadType>(
    tool: IPdfPageOpsWasmExports,
    type: K,
    payload: IBrowserPageOpsWasmRequestMap[K],
) {
    const files: IPageStructureFiles = {
        sources: [await blobSource(payload.source)],
        sink: NO_SINK,
        copy: () => Promise.reject(new Error('A read copies nothing')),
    };
    const output = await withOpenFiles(files, async () => runFileRequest(tool, {
        operation: OPERATION_CODES[type],
        sourceCount: 1,
        ...('pages' in payload ? {pages: payload.pages} : {}),
        ...('pageNumber' in payload ? {pages: [payload.pageNumber]} : {}),
        ...('withEvbOcrText' in payload && payload.withEvbOcrText ? {payload: new TextEncoder().encode('with-evb-ocr-text')} : {}),
    }));
    if (isBrowserPageOpsWasmFailure(output)) return output;
    return parseWasmOutput(type, output) ?? createWasmFailure('invalid-request', 'Page operation WASM returned malformed output');
}

/**
 * Runs a page operation in this thread's engine. `beforeRun` is awaited once
 * the module has loaded and before any input enters the engine; a caller
 * whose request has ended throws there, and the engine is not entered.
 */
export async function tryRunBrowserPageOpsWithWasm<K extends TBrowserPageOpsWasmRequestType>(
    type: K,
    payload: IBrowserPageOpsWasmRequestMap[K],
    beforeRun?: () => Promise<void>,
): Promise<IBrowserPageOpsWasmResultMap[K] | IBrowserPageOpsWasmFailure> {
    let tool: IPdfPageOpsWasmExports;
    try {
        tool = await loadPdfPageOpsWasm();
    } catch (error) {
        return createWasmLoadFailure(error);
    }
    await beforeRun?.();

    if (
        type === 'getPageGeometry'
        || type === 'readPageSizes'
        || type === 'appendAdmission'
        || type === 'parseAnnotations'
        || type === 'readCatalog'
        || type === 'conformance'
        || type === 'ocrTextVisibility'
    ) {
        return runFileRead(tool, type as TFileReadType, payload as IBrowserPageOpsWasmRequestMap[TFileReadType]) as Promise<IBrowserPageOpsWasmResultMap[K] | IBrowserPageOpsWasmFailure>;
    }
    if (type === 'renderScanCleanupRaster') {
        return runCachedScanCleanupRaster(
            tool,
            payload as IBrowserPageOpsWasmRequestMap['renderScanCleanupRaster'],
        ) as Promise<IBrowserPageOpsWasmResultMap[K] | IBrowserPageOpsWasmFailure>;
    }
    return runWasmRequest(tool, type as TByteRequestType, payload as IBrowserPageOpsWasmRequestMap[TByteRequestType]) as IBrowserPageOpsWasmResultMap[K] | IBrowserPageOpsWasmFailure;
}
