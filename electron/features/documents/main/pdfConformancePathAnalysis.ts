import {join} from 'node:path';
import {createPdfConformanceProfile} from '@pdf-core/pdfConformanceHelpers';
import type {IPdfConformanceProfile} from '@contracts/pdfConformance';
import type {IPdfConformanceFactsWire} from '@contracts/pdfPageOpsWire.generated';
import {hasNativeErrorCode} from '@contracts/nativeErrors';
import {resolveNativePageOpsPath} from '@electron/features/page-ops/public/nativePageOpsPath';
import {runDesktopQpdfWasm} from '@electron/native-tools/qpdfWasmWorkerClient';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {getAppTempDir} from '@electron/utils/appTempDir';
import {usingManagedScratchScope} from '@electron/utils/managedScratchTemp';
import {QPDF_SUCCESS_EXIT_CODES} from '@pdf-core/qpdfCommands';
import {abortErrorFromSignal, isAbortError} from '@electron/utils/abort';
import {getErrorMessage} from '@electron/utils/error';
import {getUnprovenNativeTerminationDetail} from '@electron/utils/nativeTerminationProof';
import type {IJobBrokerRunContext, TTerminationProofSink} from '@electron/resources/jobBroker';
import {
    PdfConformanceCapabilityError,
    type TPdfConformanceCapabilityErrorCode,
} from '@electron/features/documents/main/pdfConformanceCapabilityError';
import * as v from 'valibot';

const PDF_CONFORMANCE_STRUCTURAL_DIAGNOSTIC_MAX_BYTES = 1 * 1024 * 1024;
const PDF_CONFORMANCE_STRUCTURAL_TIMEOUT_MS = 10 * 60 * 1000;

const PDF_CONFORMANCE_NATIVE_COMMAND_LABEL = 'evb-pdf-page-ops(pdf-conformance)';
const PDF_CONFORMANCE_FACTS_MAX_BYTES = 64 * 1024;

const qpdfStructuralFactsSchema = v.object({
    isSigned: v.boolean(),
    isEncrypted: v.boolean(),
    isTagged: v.boolean(),
    hasAcroForm: v.boolean(),
    hasXfa: v.boolean(),
});

const qpdfFullFactsSchema = v.object({
    ...qpdfStructuralFactsSchema.entries,
    pdfaLevel: v.nullable(v.string()),
});

const pdfMarkerEvidenceSchema = v.object({
    isEncrypted: v.boolean(),
    pdfaLevel: v.nullable(v.string()),
});

type IQpdfStructuralFacts = IPdfConformanceFactsWire;
type IQpdfFullFacts = IQpdfStructuralFacts & {pdfaLevel: string | null};
type IPdfMarkerEvidence = v.InferOutput<typeof pdfMarkerEvidenceSchema>;

export interface IPdfConformancePathAnalysisOptions {
    signal?: AbortSignal;
    cancelGroup?: string;
    timeoutMs?: number;
    markerEvidence?: 'full' | 'structural-only';
    strict?: boolean;
    brokerRun?: IJobBrokerRunContext;
    onTerminationProof?: TTerminationProofSink;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

function capabilityError(code: TPdfConformanceCapabilityErrorCode, message: string, cause?: unknown): PdfConformanceCapabilityError {
    if (getUnprovenNativeTerminationDetail(cause) !== undefined) {
        throw cause;
    }
    return new PdfConformanceCapabilityError(code, message, {
        ...(cause === undefined ? {} : {cause}),
        operation: 'pdf-conformance-path-analysis',
    });
}

async function readPdfConformanceFactsFromPath(
    filePath: string,
    options: IPdfConformancePathAnalysisOptions,
    withMarkers: true,
): Promise<IQpdfFullFacts>;
async function readPdfConformanceFactsFromPath(
    filePath: string,
    options: IPdfConformancePathAnalysisOptions,
    withMarkers: false,
): Promise<IQpdfStructuralFacts>;
async function readPdfConformanceFactsFromPath(
    filePath: string,
    options: IPdfConformancePathAnalysisOptions = {},
    withMarkers = false,
): Promise<IQpdfStructuralFacts | IQpdfFullFacts> {
    // Runs both structural indexing and (when requested) bounded streaming marker
    // scanning inside evb-pdf-page-ops so only the compact facts record crosses
    // into JavaScript with zero main-thread latin1 decoding or full-file buffering.
    throwIfAborted(options.signal);
    const nativePath = resolveNativePageOpsPath();
    if (!nativePath) {
        throw capabilityError('native-unavailable', 'The native PDF conformance structural reader is unavailable');
    }
    const runConformanceCommand = (targetPath: string, mode: 'structural' | 'with-markers' | 'markers-only') =>
        runNativeToolCommand(
            nativePath,
            [
                'pdf-conformance',
                '--input',
                targetPath,
                ...(mode !== 'markers-only' && options.strict ? ['--strict'] : []),
                ...(mode === 'with-markers' ? ['--with-markers'] : []),
                ...(mode === 'markers-only' ? ['--markers-only'] : []),
            ],
            {
                timeoutMs: options.timeoutMs ?? PDF_CONFORMANCE_STRUCTURAL_TIMEOUT_MS,
                maxStdoutBytes: PDF_CONFORMANCE_FACTS_MAX_BYTES,
                maxStderrBytes: PDF_CONFORMANCE_STRUCTURAL_DIAGNOSTIC_MAX_BYTES,
                rejectOnStdoutTruncation: true,
                allowedExitCodes: [0],
                commandLabel: PDF_CONFORMANCE_NATIVE_COMMAND_LABEL,
                ...(options.signal ? {signal: options.signal} : {}),
                ...(options.cancelGroup ? {cancelGroup: options.cancelGroup} : {}),
                ...(options.brokerRun ? {brokerRun: options.brokerRun} : {}),
                ...(options.onTerminationProof ? {onTerminationProof: options.onTerminationProof} : {}),
            },
        );

    const parseJsonOutput = (raw: string): unknown => {
        try {
            return JSON.parse(raw);
        } catch (error) {
            throw capabilityError('native-failure', `Native PDF conformance facts are not valid JSON: ${getErrorMessage(error)}`, error);
        }
    };

    let stdout: string;
    let markersStdout: string | null = null;
    try {
        try {
            ({stdout} = await runConformanceCommand(filePath, withMarkers ? 'with-markers' : 'structural'));
        } catch (error) {
            if (options.strict || isAbortError(error) || !(hasNativeErrorCode(error) && error.code === 'corrupt-xref')) {
                throw error;
            }
            // Damaged cross-reference tables that the WASM structural indexer refuses can still be
            // recovered by qpdf without decrypting or decompressing streams. When marker evidence
            // is requested, scan the original file's raw bytes with `--markers-only` because qpdf
            // repair can strip comments or unreferenced byte markers.
            ({stdout} = await usingManagedScratchScope('pdf-page-ops-', getAppTempDir(), async (scratchDir) => {
                const repairedPath = join(scratchDir, 'repaired.pdf');
                await runDesktopQpdfWasm(
                    ['--warning-exit-0', '--preserve-unreferenced', '--stream-data=preserve', filePath, repairedPath],
                    {
                        timeoutMs: options.timeoutMs ?? PDF_CONFORMANCE_STRUCTURAL_TIMEOUT_MS,
                        maxStdoutBytes: PDF_CONFORMANCE_FACTS_MAX_BYTES,
                        maxStderrBytes: PDF_CONFORMANCE_STRUCTURAL_DIAGNOSTIC_MAX_BYTES,
                        allowedExitCodes: QPDF_SUCCESS_EXIT_CODES,
                        commandLabel: 'qpdf(conformance-repair)',
                        ...(options.signal ? {signal: options.signal} : {}),
                        ...(options.cancelGroup ? {cancelGroup: options.cancelGroup} : {}),
                        ...(options.brokerRun ? {brokerRun: options.brokerRun} : {}),
                        ...(options.onTerminationProof ? {onTerminationProof: options.onTerminationProof} : {}),
                    },
                );
                return runConformanceCommand(repairedPath, 'structural');
            }));
            if (withMarkers) {
                ({stdout: markersStdout} = await runConformanceCommand(filePath, 'markers-only'));
            }
        }
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        const message = getErrorMessage(error);
        const code =
            (hasNativeErrorCode(error) && error.code === 'too-large') ||
            /stdout exceeded|truncated|timed out|too.large|resource.limit/iu.test(message)
                ? 'structural-output-too-large'
                : 'native-failure';
        throw capabilityError(code, `Native PDF conformance structure was unavailable for "${filePath}": ${message}`, error);
    }
    throwIfAborted(options.signal);
    const parsed = parseJsonOutput(stdout);
    if (withMarkers && markersStdout !== null) {
        const structural = v.safeParse(qpdfStructuralFactsSchema, parsed, {abortEarly: true});
        const markers = v.safeParse(pdfMarkerEvidenceSchema, parseJsonOutput(markersStdout), {abortEarly: true});
        if (!structural.success || !markers.success) {
            throw capabilityError('native-failure', 'Native PDF conformance output has an invalid structural facts payload');
        }
        const markerEvidence: IPdfMarkerEvidence = markers.output;
        return {
            ...structural.output,
            isEncrypted: structural.output.isEncrypted || markerEvidence.isEncrypted,
            pdfaLevel: markerEvidence.pdfaLevel,
        };
    }
    const facts = withMarkers
        ? v.safeParse(qpdfFullFactsSchema, parsed, {abortEarly: true})
        : v.safeParse(qpdfStructuralFactsSchema, parsed, {abortEarly: true});
    if (!facts.success) {
        throw capabilityError('native-failure', 'Native PDF conformance output has an invalid structural facts payload');
    }
    return facts.output;
}

export async function analyzePdfConformancePath(
    filePath: string,
    options: IPdfConformancePathAnalysisOptions = {},
): Promise<IPdfConformanceProfile> {
    if (options.markerEvidence === 'structural-only') {
        const structuralFacts = await readPdfConformanceFactsFromPath(filePath, options, false);
        return createPdfConformanceProfile(structuralFacts);
    }
    const fullFacts = await readPdfConformanceFactsFromPath(filePath, options, true);
    return createPdfConformanceProfile(fullFacts, {
        isEncrypted: fullFacts.isEncrypted,
        pdfaLevel: fullFacts.pdfaLevel,
    });
}

export async function validatePdfStructureFromPath(filePath: string, options: IPdfConformancePathAnalysisOptions = {}) {
    await readPdfConformanceFactsFromPath(filePath, options, false);
}
