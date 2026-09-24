import {
    open,
    stat,
} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {
    buildPdfSaveRestrictions,
    detectPdfaLevelFromPdfText,
    hasPdfEncryptMarkersInPdfText,
    hasPdfSignatureMarkersInPdfText,
} from '@pdf-core';
import type {IPdfConformanceProfile} from '@contracts/pdfConformance';
import {isRecord} from '@contracts/runtimeGuards';
import {resolveNativePageOpsPath} from '@electron/features/page-ops/public/nativePageOpsPath';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {
    abortErrorFromSignal,
    isAbortError,
} from '@electron/utils/abort';
import {getErrorMessage} from '@electron/utils/error';
import {
    PdfConformanceCapabilityError,
    type TPdfConformanceCapabilityErrorCode,
} from '@electron/features/documents/main/pdfConformanceCapabilityError';

const PDF_CONFORMANCE_MARKER_SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
const PDF_CONFORMANCE_MARKER_SCAN_OVERLAP_BYTES = 4 * 1024;
const PDF_CONFORMANCE_STRUCTURAL_DIAGNOSTIC_MAX_BYTES = 1 * 1024 * 1024;
const PDF_CONFORMANCE_STRUCTURAL_TIMEOUT_MS = 10 * 60 * 1000;

const PDF_CONFORMANCE_NATIVE_COMMAND_LABEL = 'evb-pdf-page-ops(pdf-conformance)';
const PDF_CONFORMANCE_FACTS_MAX_BYTES = 64 * 1024;

interface IPdfMarkerEvidence {
    isSigned: boolean;
    isEncrypted: boolean;
    pdfaLevel: ReturnType<typeof detectPdfaLevelFromPdfText>;
}

interface IQpdfStructuralFacts {
    isSigned: boolean;
    isEncrypted: boolean;
    isTagged: boolean;
    hasAcroForm: boolean;
    hasXfa: boolean;
}

export interface IPdfConformancePathAnalysisOptions {
    signal?: AbortSignal;
    cancelGroup?: string;
    timeoutMs?: number;
    markerEvidence?: 'full' | 'structural-only';
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

function capabilityError(
    code: TPdfConformanceCapabilityErrorCode,
    message: string,
    cause?: unknown,
): PdfConformanceCapabilityError {
    return new PdfConformanceCapabilityError(code, message, {
        ...(cause === undefined ? {} : {cause}),
        operation: 'pdf-conformance-path-analysis',
    });
}

function getSafeFileSize(value: number | bigint) {
    const size = typeof value === 'bigint'
        ? value
        : Number.isSafeInteger(value) && value >= 0
            ? BigInt(value)
            : null;
    if (size === null || size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw capabilityError(
            'native-failure',
            'PDF conformance source size is outside the safe range for bounded range reads',
        );
    }
    return size;
}

function scanPdfMarkerEvidence(data: Uint8Array): IPdfMarkerEvidence {
    let isSigned = false;
    let isEncrypted = false;
    let pdfaLevel: IPdfMarkerEvidence['pdfaLevel'] = null;

    for (let offset = 0; offset < data.byteLength;) {
        const end = Math.min(
            data.byteLength,
            offset + PDF_CONFORMANCE_MARKER_SCAN_CHUNK_BYTES,
        );
        const text = Buffer.from(data.buffer, data.byteOffset + offset, end - offset)
            .toString('latin1');
        isSigned ||= hasPdfSignatureMarkersInPdfText(text);
        isEncrypted ||= hasPdfEncryptMarkersInPdfText(text);
        pdfaLevel ??= detectPdfaLevelFromPdfText(text);
        if (end === data.byteLength) {
            break;
        }
        offset = Math.max(
            offset + 1,
            end - PDF_CONFORMANCE_MARKER_SCAN_OVERLAP_BYTES,
        );
    }

    return {
        isSigned,
        isEncrypted,
        pdfaLevel,
    };
}

async function readPdfMarkerEvidenceFromPath(
    filePath: string,
    signal?: AbortSignal,
): Promise<IPdfMarkerEvidence> {
    throwIfAborted(signal);
    let fileStat;
    try {
        fileStat = await stat(filePath);
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        throw capabilityError(
            'native-unavailable',
            `Unable to stat PDF conformance source "${filePath}": ${getErrorMessage(error)}`,
            error,
        );
    }
    if (!fileStat.isFile()) {
        throw capabilityError(
            'native-failure',
            `PDF conformance source is not a regular file: ${filePath}`,
        );
    }

    const size = getSafeFileSize(fileStat.size);
    let handle: FileHandle | undefined;
    try {
        try {
            handle = await open(filePath, 'r');
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            throw capabilityError(
                'native-unavailable',
                `Unable to open PDF conformance source "${filePath}": ${getErrorMessage(error)}`,
                error,
            );
        }

        let offset = 0n;
        let overlap = Buffer.alloc(0);
        let evidence: IPdfMarkerEvidence = {
            isSigned: false,
            isEncrypted: false,
            pdfaLevel: null,
        };
        while (offset < size) {
            throwIfAborted(signal);
            const remaining = size - offset;
            const chunkBytes = Number(
                remaining < BigInt(PDF_CONFORMANCE_MARKER_SCAN_CHUNK_BYTES)
                    ? remaining
                    : BigInt(PDF_CONFORMANCE_MARKER_SCAN_CHUNK_BYTES),
            );
            const chunk = Buffer.allocUnsafe(chunkBytes);
            let bytesRead: number;
            try {
                ({bytesRead} = await handle.read(chunk, 0, chunkBytes, offset));
            } catch (error) {
                if (isAbortError(error)) {
                    throw error;
                }
                throw capabilityError(
                    'native-failure',
                    `Unable to read PDF conformance source "${filePath}": ${getErrorMessage(error)}`,
                    error,
                );
            }
            if (bytesRead <= 0) {
                throw capabilityError(
                    'native-failure',
                    `PDF conformance source changed while it was being read: ${filePath}`,
                );
            }

            const bytes = chunk.subarray(0, bytesRead);
            const window = overlap.length === 0
                ? bytes
                : Buffer.concat([
                    overlap,
                    bytes,
                ]);
            const windowEvidence = scanPdfMarkerEvidence(window);
            evidence = {
                isSigned: evidence.isSigned || windowEvidence.isSigned,
                isEncrypted: evidence.isEncrypted || windowEvidence.isEncrypted,
                pdfaLevel: evidence.pdfaLevel ?? windowEvidence.pdfaLevel,
            };
            overlap = bytes.subarray(
                Math.max(0, bytes.length - PDF_CONFORMANCE_MARKER_SCAN_OVERLAP_BYTES),
            );
            offset += BigInt(bytesRead);
        }

        throwIfAborted(signal);
        return evidence;
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

function parseStructuralFacts(value: unknown): IQpdfStructuralFacts {
    if (!isRecord(value)
        || typeof value.isSigned !== 'boolean'
        || typeof value.isEncrypted !== 'boolean'
        || typeof value.isTagged !== 'boolean'
        || typeof value.hasAcroForm !== 'boolean'
        || typeof value.hasXfa !== 'boolean') {
        throw capabilityError(
            'native-failure',
            'Native PDF conformance output has an invalid structural facts payload',
        );
    }
    return {
        isSigned: value.isSigned,
        isEncrypted: value.isEncrypted,
        isTagged: value.isTagged,
        hasAcroForm: value.hasAcroForm,
        hasXfa: value.hasXfa,
    };
}

async function readPdfStructuralFactsFromPath(
    filePath: string,
    options: IPdfConformancePathAnalysisOptions = {},
): Promise<IQpdfStructuralFacts> {
    // The native operation sends qpdf JSON to its private sidecar and parses it
    // with the bounded structural loader. Only the compact facts record crosses
    // into JavaScript, so structural output is not subject to the worker's
    // 8 MiB payload budget.
    throwIfAborted(options.signal);
    const nativePath = resolveNativePageOpsPath();
    if (!nativePath) {
        throw capabilityError(
            'native-unavailable',
            'The native PDF conformance structural reader is unavailable',
        );
    }
    const qpdfPath = getPdfNativeToolPaths().qpdf;
    if (!qpdfPath) {
        throw capabilityError(
            'native-unavailable',
            'The bundled qpdf structural reader is unavailable',
        );
    }
    let stdout: string;
    try {
        ({stdout} = await runNativeToolCommand(nativePath, [
            'pdf-conformance',
            '--input',
            filePath,
            '--qpdf',
            qpdfPath,
        ], {
            timeoutMs: options.timeoutMs ?? PDF_CONFORMANCE_STRUCTURAL_TIMEOUT_MS,
            maxStdoutBytes: PDF_CONFORMANCE_FACTS_MAX_BYTES,
            maxStderrBytes: PDF_CONFORMANCE_STRUCTURAL_DIAGNOSTIC_MAX_BYTES,
            rejectOnStdoutTruncation: true,
            allowedExitCodes: [0],
            commandLabel: PDF_CONFORMANCE_NATIVE_COMMAND_LABEL,
            ...(options.signal ? {signal: options.signal} : {}),
            ...(options.cancelGroup ? {cancelGroup: options.cancelGroup} : {}),
        }));
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        const message = getErrorMessage(error);
        const code = /stdout exceeded|truncated|timed out|too.large|resource.limit/iu.test(message)
            ? 'structural-output-too-large'
            : 'native-failure';
        throw capabilityError(
            code,
            `Native PDF conformance structure was unavailable for "${filePath}": ${message}`,
            error,
        );
    }
    throwIfAborted(options.signal);
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch (error) {
        throw capabilityError(
            'native-failure',
            `Native PDF conformance facts are not valid JSON: ${getErrorMessage(error)}`,
            error,
        );
    }
    return parseStructuralFacts(parsed);
}

export async function analyzePdfConformancePath(
    filePath: string,
    options: IPdfConformancePathAnalysisOptions = {},
): Promise<IPdfConformanceProfile> {
    const structuralFacts = await readPdfStructuralFactsFromPath(filePath, options);
    const markerEvidence = options.markerEvidence === 'structural-only'
        ? {
            isSigned: false,
            isEncrypted: false,
            pdfaLevel: null,
        }
        : await readPdfMarkerEvidenceFromPath(filePath, options.signal);
    const profileBase = {
        isSigned: structuralFacts.isSigned || markerEvidence.isSigned,
        isEncrypted: structuralFacts.isEncrypted || markerEvidence.isEncrypted,
        isTagged: structuralFacts.isTagged,
        pdfaLevel: markerEvidence.pdfaLevel,
        hasAcroForm: structuralFacts.hasAcroForm,
        hasXfa: structuralFacts.hasXfa,
        canIncrementalSave: !(
            structuralFacts.isEncrypted
            || markerEvidence.isEncrypted
            || structuralFacts.hasXfa
        ),
    };

    return {
        ...profileBase,
        saveRestrictions: buildPdfSaveRestrictions(profileBase),
    };
}

export async function validatePdfStructureFromPath(
    filePath: string,
    options: IPdfConformancePathAnalysisOptions = {},
) {
    await readPdfStructuralFactsFromPath(filePath, options);
}
