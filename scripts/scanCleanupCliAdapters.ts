import {
    spawn,
    type ChildProcess,
} from 'node:child_process';
import {
    constants as fsConstants,
    existsSync,
} from 'node:fs';
import {
    access,
    mkdir,
    readFile,
    stat,
    writeFile,
} from 'node:fs/promises';
import {
    basename,
    dirname,
    join,
} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    constants as osConstants,
    setPriority,
} from 'node:os';
import {decode as decodePng} from 'fast-png';
import {
    isNativeErrorEnvelope,
    type TNativeErrorCode,
} from '@contracts/nativeErrors';
import {NATIVE_SCAN_CLEANUP_ENVELOPE_SCHEMA} from '@contracts/scan-cleanup/nativeProtocolV3';
import type {IScanCleanupDetectionResult} from '@contracts/electronApiScanCleanup';
import {
    getCheckedWasmMemoryView,
    WASM_REQUEST_ALLOCATION_ABI_VERSION,
} from '@contracts/getCheckedWasmMemoryView';
import {createScanCleanupRenderers} from '@evb/scan-cleanup/adapters/createScanCleanupRenderers';
import {parseScanCleanupCompactManifest} from '@evb/scan-cleanup/core/compactManifest';
import {createScanCleanupSidecarProtocolHandler} from '@evb/scan-cleanup/core/createScanCleanupSidecarProtocolHandler';
import type {
    TScanCleanupLog,
    IScanCleanupProcessResult,
    TScanCleanupRunCommand,
    IScanCleanupRunCommandOptions,
    TScanCleanupSidecarProgress,
} from '@evb/scan-cleanup/core/types';

export interface IScanCleanupCompactDetectionVerdict {
    pageNumber: number;
    classification: IScanCleanupDetectionResult['classification'];
    confidence: number;
    cutterXPx: number | null;
    tier1Verdict: IScanCleanupDetectionResult['tier1Verdict'];
    reconciled: boolean;
    clusterAgreement: number;
    documentPrior: IScanCleanupDetectionResult['documentPrior'];
    splitDiagnostics?: IScanCleanupDetectionResult['splitDiagnostics'];
}

export function compactScanCleanupDetectionVerdicts(
    results: readonly IScanCleanupDetectionResult[],
): IScanCleanupCompactDetectionVerdict[] {
    return results.map(result => ({
        pageNumber: result.pageNumber,
        classification: result.classification,
        confidence: result.confidence,
        cutterXPx: result.cutterXPx,
        tier1Verdict: result.tier1Verdict,
        reconciled: result.reconciled,
        clusterAgreement: result.clusterAgreement,
        documentPrior: result.documentPrior,
        ...(result.splitDiagnostics === undefined
            ? {}
            : {splitDiagnostics: result.splitDiagnostics}),
    }));
}

/** Returns only raw PBM planes that the combiner may symbol-code. */
export function compactScanCleanupBilevelMaskPath(pageSpec: string) {
    const fields = pageSpec.split('\t');
    switch (fields[0]) {
        case 'image-bilevel':
        case 'mask':
            return fields.length === 4 ? fields[3] : undefined;
        case 'layered-jpeg':
            return fields.length === 6 ? fields[5] : undefined;
        case 'affine-masked-layered-jpeg':
            return fields.length === 13 || fields.length === 14 ? fields[6] : undefined;
        case undefined:
            return undefined;
        default:
            return undefined;
    }
}

export interface ICliRawMaskEvidence {
    outputOrdinal: number;
    relativePath: string;
}

export async function snapshotCliDiagnosticMasks(
    manifestPath: string,
    outputPages: readonly number[],
    evidenceDirectory: string,
) {
    const selected = new Set(outputPages);
    const pageSpecs = parseScanCleanupCompactManifest(await readFile(manifestPath, 'utf8'));
    await mkdir(join(evidenceDirectory, 'raw-masks'), {recursive: true});
    const evidence: ICliRawMaskEvidence[] = [];
    for (const [
        index,
        pageSpec,
    ] of pageSpecs.entries()) {
        const outputOrdinal = index + 1;
        if (!selected.has(outputOrdinal)) continue;
        const maskPath = compactScanCleanupBilevelMaskPath(pageSpec);
        if (maskPath === undefined) continue;
        const payload = await readFile(maskPath);
        if (payload[0] !== 0x50 || payload[1] !== 0x34) continue;
        const relativePath = join(
            'raw-masks',
            `output-${String(outputOrdinal).padStart(4, '0')}.pbm`,
        );
        await writeFile(join(evidenceDirectory, relativePath), payload);
        evidence.push({
            outputOrdinal,
            relativePath,
        });
    }
    const missing = outputPages.filter(page => !evidence.some(item => item.outputOrdinal === page));
    if (missing.length > 0) {
        throw new Error(`Diagnostic mask pages have no raw PBM plane: ${missing.join(', ')}`);
    }
    return evidence;
}

export function buildCliRawMaskEvidenceManifest(
    outputPdf: string,
    evidence: readonly ICliRawMaskEvidence[],
    reportPages: ReadonlyArray<{
        outputOrdinal: number;
        outputPageNumber: number;
        sourcePageNumber: number;
        half: string;
    }>,
) {
    const reportPageByOrdinal = new Map(reportPages.map(page => [
        page.outputOrdinal,
        page,
    ]));
    return {
        schemaVersion: 1,
        outputPdf,
        pages: evidence.map(item => {
            const page = reportPageByOrdinal.get(item.outputOrdinal);
            if (page === undefined) {
                throw new Error(`Diagnostic evidence cannot resolve output ordinal ${String(item.outputOrdinal)}`);
            }
            return {
                outputPage: page.outputPageNumber,
                sourcePage: page.sourcePageNumber,
                half: page.half,
                rawMaskPath: item.relativePath,
            };
        }),
    };
}

interface ICliPdfCombineWasmExports {
    memory: WebAssembly.Memory;
    evb_wasm_request_allocation_abi_version: () => number;
    evb_pdf_image_combine_alloc: (length: number) => number;
    evb_pdf_image_combine_free: (pointer: number, byteLength: number) => void;
    evb_pdf_image_combine_build_pdf: (pointer: number, length: number) => number;
    evb_pdf_image_combine_output_ptr: () => number;
    evb_pdf_image_combine_output_len: () => number;
    evb_pdf_image_combine_error_ptr: () => number;
    evb_pdf_image_combine_error_len: () => number;
}

type TCliPdfCombineWasmPageKind = 'image' | 'mask' | 'layered' | 'layered-color';

interface ICliPdfCombineWasmInput {
    fileName: string;
    data: Uint8Array;
}

const CLI_PDF_COMBINE_WASM_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'public',
    'wasm',
    'evb-pdf-image-combine.wasm',
);
const CLI_PDF_COMBINE_WASM_REQUEST_MAGIC = 'EPIC';
const CLI_PDF_COMBINE_WASM_VERSION_PAGE_SPECS = 4;
const CLI_PDF_COMBINE_WASM_PAGE_KIND_CODES: Record<TCliPdfCombineWasmPageKind, number> = {
    image: 1,
    mask: 2,
    layered: 3,
    'layered-color': 4,
};
const CLI_PDF_COMBINE_WASM_REQUEST_HEADER_BYTES = 4 + (6 * 4);
const CLI_PDF_COMBINE_WASM_PAGE_SPEC_HEADER_BYTES = 4 + (2 * 8) + (2 * 4);
const CLI_WASM_IMAGE_SAMPLE_LIMIT = 200_000;
let cliPdfCombineWasmExportsPromise: Promise<ICliPdfCombineWasmExports | null> | null = null;

type TCliPdfCombineWasmPageInput =
    | {
        kind: 'image';
        imagePath: string;
    }
    | {
        kind: 'mask';
        imagePath: string;
    }
    | {
        kind: 'layered' | 'layered-color';
        backgroundPath: string;
        maskPath: string;
        foregroundColor?: readonly [number, number, number];
    };

export interface ICliPdfCombineWasmPage {
    heightPoints: number;
    input: TCliPdfCombineWasmPageInput;
    jpegQuality?: number;
    widthPoints: number;
}

function writeCliWasmU32(view: DataView, offset: number, value: number) {
    view.setUint32(offset, value, true);
    return offset + 4;
}

function writeCliWasmF64(view: DataView, offset: number, value: number) {
    view.setFloat64(offset, value, true);
    return offset + 8;
}

function cliWasmInputPaths(page: ICliPdfCombineWasmPage) {
    const input = page.input;
    if (input.kind === 'image' || input.kind === 'mask') {
        return [input.imagePath];
    }
    return [
        input.backgroundPath,
        input.maskPath,
    ];
}

function cliWasmPageKind(page: ICliPdfCombineWasmPage) {
    return page.input.kind;
}

async function loadCliPdfCombineWasm() {
    const pending = cliPdfCombineWasmExportsPromise ?? (async () => {
        try {
            const bytes = await readFile(CLI_PDF_COMBINE_WASM_PATH);
            const instantiated = await WebAssembly.instantiate(bytes);
            const exports = instantiated instanceof WebAssembly.Instance
                ? instantiated.exports
                : instantiated.instance.exports;
            const value = exports as Partial<ICliPdfCombineWasmExports>;
            if (
                !(value.memory instanceof WebAssembly.Memory)
                || typeof value.evb_wasm_request_allocation_abi_version !== 'function'
                || value.evb_wasm_request_allocation_abi_version() !== WASM_REQUEST_ALLOCATION_ABI_VERSION
                || typeof value.evb_pdf_image_combine_alloc !== 'function'
                || typeof value.evb_pdf_image_combine_free !== 'function'
                || typeof value.evb_pdf_image_combine_build_pdf !== 'function'
                || typeof value.evb_pdf_image_combine_output_ptr !== 'function'
                || typeof value.evb_pdf_image_combine_output_len !== 'function'
                || typeof value.evb_pdf_image_combine_error_ptr !== 'function'
                || typeof value.evb_pdf_image_combine_error_len !== 'function'
            ) {
                return null;
            }
            return value as ICliPdfCombineWasmExports;
        } catch {
            return null;
        }
    })();
    cliPdfCombineWasmExportsPromise = pending;
    const exports = await pending;
    if (exports === null && cliPdfCombineWasmExportsPromise === pending) {
        cliPdfCombineWasmExportsPromise = null;
    }
    return exports;
}

function cliWasmEncodedInput(path: string, data: Uint8Array) {
    return {
        fileName: basename(path),
        data,
    } satisfies ICliPdfCombineWasmInput;
}

function cliWasmPageInputs(page: ICliPdfCombineWasmPage, dataByPath: Map<string, Uint8Array>) {
    return cliWasmInputPaths(page).map(path => cliWasmEncodedInput(path, dataByPath.get(path)!));
}

function buildCliWasmPageRequest(page: ICliPdfCombineWasmPage, inputs: ICliPdfCombineWasmInput[]) {
    const kind = cliWasmPageKind(page);
    const requestLength = CLI_PDF_COMBINE_WASM_REQUEST_HEADER_BYTES
        + CLI_PDF_COMBINE_WASM_PAGE_SPEC_HEADER_BYTES
        + inputs.reduce((total, input) => total + 8 + input.fileName.length + input.data.byteLength, 0)
        + (kind === 'layered-color' ? 12 : 0);
    const request = new Uint8Array(requestLength);
    const view = new DataView(request.buffer);
    let offset = 0;
    request.set(Buffer.from(CLI_PDF_COMBINE_WASM_REQUEST_MAGIC, 'ascii'), offset);
    offset += 4;
    offset = writeCliWasmU32(view, offset, CLI_PDF_COMBINE_WASM_VERSION_PAGE_SPECS);
    offset = writeCliWasmU32(view, offset, 0);
    offset = writeCliWasmU32(view, offset, 500);
    offset = writeCliWasmU32(view, offset, 80_000_000);
    offset = writeCliWasmU32(view, offset, 250);
    offset = writeCliWasmU32(view, offset, 1);
    offset = writeCliWasmU32(view, offset, CLI_PDF_COMBINE_WASM_PAGE_KIND_CODES[kind]);
    offset = writeCliWasmF64(view, offset, page.widthPoints);
    offset = writeCliWasmF64(view, offset, page.heightPoints);
    offset = writeCliWasmU32(view, offset, page.jpegQuality ?? 0);
    offset = writeCliWasmU32(view, offset, 0);
    for (const input of inputs) {
        const name = Buffer.from(input.fileName, 'utf8');
        offset = writeCliWasmU32(view, offset, name.byteLength);
        offset = writeCliWasmU32(view, offset, input.data.byteLength);
        request.set(name, offset);
        offset += name.byteLength;
        request.set(input.data, offset);
        offset += input.data.byteLength;
    }
    if (kind === 'layered-color') {
        const color = page.input.kind === 'layered-color'
            ? page.input.foregroundColor ?? [
                0,
                0,
                0,
            ]
            : [
                0,
                0,
                0,
            ];
        for (const channel of color) offset = writeCliWasmU32(view, offset, channel);
    }
    return request;
}

function readCliWasmBytes(exports: ICliPdfCombineWasmExports, pointer: number, length: number) {
    return getCheckedWasmMemoryView(exports.memory, pointer, length, 'CLI PDF image combine WASM').slice();
}

async function normalizeCliWasmMask(
    inputPath: string,
    temporaryDirectory: string,
    magickBinary: string,
    pageIndex: number,
    options: IScanCleanupRunCommandOptions,
) {
    if (inputPath.toLowerCase().endsWith('.pbm')) {
        return inputPath;
    }
    const normalizedPath = join(temporaryDirectory, `wasm-mask-${String(pageIndex)}.pbm`);
    await runCliNativeToolCommand(magickBinary, [
        inputPath,
        '-colorspace',
        'Gray',
        '-threshold',
        '50%',
        '-type',
        'Bilevel',
        normalizedPath,
    ], options);
    return normalizedPath;
}

interface ICliWasmImageTone { grayscale: boolean; }

async function inspectCliWasmPngTone(inputPath: string): Promise<ICliWasmImageTone | null> {
    if (!inputPath.toLowerCase().endsWith('.png')) {
        return null;
    }
    const decoded = decodePng(await readFile(inputPath));
    const pixelCount = decoded.width * decoded.height;
    const stride = Math.max(1, Math.ceil(pixelCount / CLI_WASM_IMAGE_SAMPLE_LIMIT));
    let coloredPixels = 0;
    for (let pixel = 0; pixel < pixelCount; pixel += stride) {
        const offset = pixel * decoded.channels;
        if (
            decoded.channels >= 3
            && (
                decoded.data[offset] !== decoded.data[offset + 1]
                || decoded.data[offset] !== decoded.data[offset + 2]
            )
        ) {
            coloredPixels += 1;
        }
    }
    const grayscale = coloredPixels === 0;
    return {grayscale};
}

async function normalizeCliWasmImage(
    inputPath: string,
    temporaryDirectory: string,
    magickBinary: string,
    pageIndex: number,
    options: IScanCleanupRunCommandOptions,
): Promise<{
    imagePath: string;
    kind: 'image' | 'mask'
}> {
    const tone = await inspectCliWasmPngTone(inputPath);
    if (tone?.grayscale === true) {
        const normalizedPath = join(temporaryDirectory, `wasm-image-${String(pageIndex)}.pgm`);
        await runCliNativeToolCommand(magickBinary, [
            inputPath,
            '-colorspace',
            'Gray',
            '-depth',
            '8',
            normalizedPath,
        ], options);
        return {
            imagePath: normalizedPath,
            kind: 'image',
        };
    }
    if (tone !== null) {
        const normalizedPath = join(temporaryDirectory, `wasm-image-${String(pageIndex)}.ppm`);
        await runCliNativeToolCommand(magickBinary, [
            inputPath,
            '-depth',
            '8',
            normalizedPath,
        ], options);
        return {
            imagePath: normalizedPath,
            kind: 'image',
        };
    }
    return {
        imagePath: inputPath,
        kind: 'image',
    };
}

export async function writeCliWasmPdfPage(
    page: ICliPdfCombineWasmPage,
    outputPath: string,
    temporaryDirectory: string,
    magickBinary: string,
    pageIndex: number,
    options: IScanCleanupRunCommandOptions,
) {
    const exports = await loadCliPdfCombineWasm();
    if (exports === null) {
        return false;
    }
    const pageInput = page.input;
    const input = pageInput.kind === 'image'
        ? page.jpegQuality === undefined
            ? pageInput
            : await normalizeCliWasmImage(pageInput.imagePath, temporaryDirectory, magickBinary, pageIndex, options)
        : pageInput.kind === 'mask'
            ? {
                ...pageInput,
                imagePath: await normalizeCliWasmMask(pageInput.imagePath, temporaryDirectory, magickBinary, pageIndex, options),
            }
            : {
                ...pageInput,
                maskPath: await normalizeCliWasmMask(pageInput.maskPath, temporaryDirectory, magickBinary, pageIndex, options),
            };
    const normalizedPage: ICliPdfCombineWasmPage = {
        ...page,
        input,
    };
    const paths = cliWasmInputPaths(normalizedPage);
    const dataByPath = new Map<string, Uint8Array>();
    for (const path of paths) dataByPath.set(path, await readFile(path));
    const request = buildCliWasmPageRequest(normalizedPage, cliWasmPageInputs(normalizedPage, dataByPath));
    const pointer = exports.evb_pdf_image_combine_alloc(request.byteLength);
    if (pointer === 0) throw new Error('CLI PDF image combine WASM allocation failed');
    try {
        const requestMemory = getCheckedWasmMemoryView(
            exports.memory,
            pointer,
            request.byteLength,
            'CLI PDF image combine WASM allocation',
        );
        requestMemory.set(request);
        const resultCode = exports.evb_pdf_image_combine_build_pdf(pointer, request.byteLength);
        if (resultCode !== 0) {
            const errorPointer = exports.evb_pdf_image_combine_error_ptr();
            const errorLength = exports.evb_pdf_image_combine_error_len();
            const error = errorLength === 0
                ? `code ${String(resultCode)}`
                : new TextDecoder().decode(readCliWasmBytes(exports, errorPointer, errorLength));
            throw new Error(`CLI PDF image combine WASM failed: ${error}`);
        }
        const outputLength = exports.evb_pdf_image_combine_output_len();
        if (outputLength === 0) throw new Error('CLI PDF image combine WASM returned an empty PDF');
        await writeFile(outputPath, readCliWasmBytes(
            exports,
            exports.evb_pdf_image_combine_output_ptr(),
            outputLength,
        ));
        return true;
    } finally {
        exports.evb_pdf_image_combine_free(pointer, request.byteLength);
    }
}

function terminateCliChild(child: ChildProcess) {
    const pid = child.pid;
    if (typeof pid !== 'number' || pid < 1) {
        child.kill('SIGTERM');
        return;
    }
    try {
        if (process.platform === 'win32') child.kill('SIGTERM');
        else process.kill(-pid, 'SIGTERM');
    } catch {
        child.kill('SIGTERM');
    }
    setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
            try {
                if (process.platform === 'win32') child.kill('SIGKILL');
                else process.kill(-pid, 'SIGKILL');
            } catch {
                child.kill('SIGKILL');
            }
        }
    }, 1_500).unref();
}

export async function runCliNativeToolCommand(
    command: string,
    args: string[],
    options: IScanCleanupRunCommandOptions = {},
): Promise<IScanCleanupProcessResult> {
    if (options.signal?.aborted) throw options.signal.reason;
    return new Promise<IScanCleanupProcessResult>((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            detached: process.platform !== 'win32',
            env: options.env ?? process.env,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;
        const stdoutLimit = options.maxStdoutBytes ?? Number.POSITIVE_INFINITY;
        const stderrLimit = options.maxStderrBytes ?? 64 * 1024;
        const append = (current: string, chunk: string, limit: number) => {
            const next = `${current}${chunk}`;
            return next.length > limit ? next.slice(-limit) : next;
        };
        const cleanup = () => {
            if (timer !== undefined) clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
        };
        const finish = (error: Error | null, result?: IScanCleanupProcessResult) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            if (error === null && result !== undefined) resolve(result);
            else reject(error ?? new Error('Native command failed without a result'));
        };
        const onAbort = () => {
            terminateCliChild(child);
        };
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            stdout = append(stdout, chunk, stdoutLimit);
            options.onStdout?.(chunk);
        });
        child.stderr.on('data', (chunk: string) => {
            stderr = append(stderr, chunk, stderrLimit);
        });
        child.once('error', error => finish(error));
        child.once('close', (code, signal) => {
            if (options.signal?.aborted) {
                finish(options.signal.reason instanceof Error
                    ? options.signal.reason
                    : new Error('Native command aborted'));
                return;
            }
            if (timedOut) {
                finish(new Error(`${options.commandLabel ?? command} timed out`));
                return;
            }
            const exitCode = code ?? -1;
            const allowedExitCodes = options.allowedExitCodes ?? [0];
            if (!allowedExitCodes.includes(exitCode)) {
                finish(new Error(
                    `${options.commandLabel ?? command} exited with code ${String(exitCode)}${
                        signal === null ? '' : ` (${signal})`
                    }: ${stderr.trim()}`,
                ));
                return;
            }
            if (options.rejectOnStdoutTruncation && stdout.length >= stdoutLimit) {
                finish(new Error(`${options.commandLabel ?? command} stdout exceeded its limit`));
                return;
            }
            finish(null, {
                exitCode,
                stdout,
                stderr,
            });
        });
        const timer = options.timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                timedOut = true;
                terminateCliChild(child);
            }, options.timeoutMs);
        options.signal?.addEventListener('abort', onAbort, {once: true});
    });
}

function decodeNativeEnvelope(line: string) {
    return NATIVE_SCAN_CLEANUP_ENVELOPE_SCHEMA.decode(JSON.parse(line));
}

function throwCliProtocolError(error: Error | null) {
    if (error !== null) {
        throw error;
    }
}

function parseNativeError(stderr: string): {
    code: TNativeErrorCode;
    message: string
} | null {
    for (const line of stderr.trim().split(/\r?\n/u).reverse()) {
        try {
            const value: unknown = JSON.parse(line);
            if (isNativeErrorEnvelope(value)) {
                return value;
            }
        } catch {
            continue;
        }
    }
    return null;
}

export async function runCliScanCleanupSidecar(
    binaryPath: string,
    manifestPath: string,
    signal: AbortSignal,
    log: TScanCleanupLog,
    onProgress: TScanCleanupSidecarProgress,
    options: {
        priority?: 'background';
        allowedPathRoot?: string;
    } = {},
) {
    if (signal.aborted) throw signal.reason;
    const child = spawn(binaryPath, [
        '--manifest',
        manifestPath,
        ...(options.allowedPathRoot === undefined
            ? []
            : [
                '--allowed-path-root',
                options.allowedPathRoot,
            ]),
    ], {
        detached: process.platform !== 'win32',
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });
    if (options.priority === 'background' && child.pid !== undefined) {
        try {
            setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
        } catch (error) {
            log('debug', `Could not lower scan cleanup detection priority: ${String(error)}`);
        }
    }
    let terminalStatus = null as 'success' | 'failure' | null;
    const nativeFailure: {value: {
        code: TNativeErrorCode;
        message: string
    } | null} = {value: null};
    let protocolError: Error | null = null;
    const protocol = createScanCleanupSidecarProtocolHandler({
        stdout: child.stdout,
        stderr: child.stderr,
        onProtocolError: error => {
            protocolError = error;
            terminateCliChild(child);
        },
        log,
    });
    protocol.lines.on('line', line => {
        if (protocolError !== null || terminalStatus !== null) {
            return;
        }
        try {
            const envelope = decodeNativeEnvelope(line);
            if (envelope.type === 'progress') {
                onProgress(envelope.progress);
                return;
            }
            terminalStatus = envelope.result.status;
            if (envelope.result.status === 'failure') nativeFailure.value = envelope.result;
        } catch (error) {
            protocol.failProtocol(error, line);
        }
    });
    let aborting = false as boolean;
    const onAbort = () => {
        aborting = true;
        terminateCliChild(child);
    };
    signal.addEventListener('abort', onAbort, {once: true});
    try {
        let result: {
            code: number | null;
            signal: NodeJS.Signals | null
        };
        try {
            result = await new Promise((resolve, reject) => {
                child.once('error', reject);
                child.once('exit', (code, exitSignal) => resolve({
                    code,
                    signal: exitSignal,
                }));
            });
        } catch (error) {
            throwCliProtocolError(protocolError);
            throw error;
        }
        throwCliProtocolError(protocolError);
        if (aborting) throw signal.reason;
        const failure = nativeFailure.value;
        if (failure !== null) {
            throw new Error(`${failure.code}: ${failure.message}`);
        }
        if (result.code !== 0) {
            const error = parseNativeError(protocol.stderr);
            throw new Error(error === null
                ? `evb-scan-cleanup exited unsuccessfully (code=${String(result.code)}, signal=${String(result.signal)})`
                : `${error.code}: ${error.message}`);
        }
        if (terminalStatus !== 'success') {
            throw new Error('evb-scan-cleanup returned no terminal result envelope');
        }
    } finally {
        signal.removeEventListener('abort', onAbort);
        protocol.lines.close();
        log('debug', `evb-scan-cleanup completed ${basename(manifestPath)}`);
    }
}

export async function requireCliPublishedRaster(path: string | undefined, pageNumber: number, role: string) {
    if (path === undefined) throw new Error(`Page ${pageNumber} declared a ${role} without an output destination`);
    const stats = await stat(path).catch((error: NodeJS.ErrnoException) => {
        throw new Error(`Page ${pageNumber} ${role} is unavailable: ${error.message}`);
    });
    if (!stats.isFile()) throw new Error(`Page ${pageNumber} ${role} is not a file: ${path}`);
    await access(path, fsConstants.R_OK).catch((error: NodeJS.ErrnoException) => {
        throw new Error(`Page ${pageNumber} ${role} is unreadable: ${error.message}`);
    });
    return path;
}

function platformArchTag() {
    const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
    return `${process.platform}-${architecture}`;
}

function rustTargetTag() {
    const targets: Partial<Record<NodeJS.Platform, Partial<Record<'arm64' | 'x64', string>>>> = {
        darwin: {
            arm64: 'aarch64-apple-darwin',
            x64: 'x86_64-apple-darwin',
        },
        linux: {
            arm64: 'aarch64-unknown-linux-gnu',
            x64: 'x86_64-unknown-linux-gnu',
        },
        win32: {
            arm64: 'aarch64-pc-windows-msvc',
            x64: 'x86_64-pc-windows-msvc',
        },
    };
    const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
    return targets[process.platform]?.[architecture];
}

export function resolveCliNativeToolPath(
    binaryName: string,
    crateName: string,
    currentDir: string,
    envOverride?: string,
) {
    const candidates = [
        envOverride,
        join(currentDir, '.tmp', crateName, platformArchTag(), 'bin', binaryName),
        join(currentDir, 'resources', crateName, platformArchTag(), 'bin', binaryName),
        join(currentDir, 'resources', 'poppler', platformArchTag(), 'bin', binaryName),
        join(currentDir, 'resources', 'qpdf', platformArchTag(), 'bin', binaryName),
        ...(rustTargetTag() === undefined
            ? []
            : [join(currentDir, 'native', 'target', rustTargetTag()!, 'release', binaryName)]),
        join(currentDir, 'native', 'target', 'release', binaryName),
        `/opt/homebrew/bin/${binaryName}`,
        `/usr/local/bin/${binaryName}`,
        `/usr/bin/${binaryName}`,
    ];
    return candidates.find(candidate => candidate !== undefined && existsSync(candidate)) ?? null;
}

export function createCliRenderers(runCommand: TScanCleanupRunCommand, pdfinfoBinary?: string) {
    return createScanCleanupRenderers(runCommand, undefined, {...(pdfinfoBinary === undefined ? {} : {pdfinfoBinary})});
}
