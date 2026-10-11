import {createReadStream} from 'fs';
import {
    copyFile,
    open,
    writeFile,
} from 'fs/promises';
import {join} from 'path';
import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@contracts/scan-cleanup/inputLimits';
import {getErrorMessage} from '@contracts/getErrorMessage';
import type {IScanCleanupTextLayerInstruction} from '@evb/scan-cleanup/core/compactManifest';
import {ScanCleanupStreamingEvidenceError} from '@evb/scan-cleanup/core/errors';
import {
    inspectScanCleanupSourceTextOmission,
    type IScanCleanupTextLayerPlan,
} from '@evb/scan-cleanup/core/sourceTextLayer';
import type {
    IRunScanCleanupPipelineDependencies,
    TScanCleanupLog,
    TScanCleanupRunCommand,
} from '@evb/scan-cleanup/core/types';
import type {TScanCleanupSummary} from '@contracts/scan-cleanup/electronApiScanCleanup';

type TJsonlFileHandle = Awaited<ReturnType<typeof open>>;

// Native manifests admit a larger transport window, but the production
// coordinator keeps its page plans, raster facts, and qpdf arguments to one
// smaller resident batch. The larger native limit is not a document limit.
const QPDF_MERGE_INPUT_WINDOW = SCAN_CLEANUP_STREAMING_BATCH_PAGES;
const STREAMING_JSONL_MAX_LINE_BYTES = 4 * 1024 * 1024;

export async function appendJsonLine(handle: TJsonlFileHandle, value: unknown) {
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line, 'utf8') > STREAMING_JSONL_MAX_LINE_BYTES) {
        throw new Error(`Scan cleanup JSONL record exceeds ${String(STREAMING_JSONL_MAX_LINE_BYTES)} bytes`);
    }
    await handle.write(line);
}

export async function* readJsonLines<T>(path: string, signal?: AbortSignal): AsyncGenerator<T> {
    const stream = createReadStream(path, {highWaterMark: 512 * 1024});
    let pending = Buffer.alloc(0);
    try {
        for await (const chunk of stream) {
            signal?.throwIfAborted();
            pending = pending.length === 0
                ? Buffer.from(chunk as Uint8Array)
                : Buffer.concat([
                    pending,
                    Buffer.from(chunk as Uint8Array),
                ]);
            if (pending.length > STREAMING_JSONL_MAX_LINE_BYTES) {
                throw new Error(`Scan cleanup JSONL record exceeds ${String(STREAMING_JSONL_MAX_LINE_BYTES)} bytes`);
            }
            let newline = pending.indexOf(0x0a);
            while (newline >= 0) {
                signal?.throwIfAborted();
                const line = pending.subarray(0, newline).toString('utf8').trim();
                pending = pending.subarray(newline + 1);
                if (line.length > 0) {
                    yield JSON.parse(line) as T;
                }
                newline = pending.indexOf(0x0a);
            }
        }
        signal?.throwIfAborted();
        if (pending.length > 0) {
            const line = pending.toString('utf8').trim();
            if (line.length > 0) yield JSON.parse(line) as T;
        }
    } finally {
        stream.destroy();
    }
}

async function mergeScanCleanupPdfPathSidecarUnchecked({
    inputPath,
    inputCount,
    scratch,
    stagedPdfPath,
    qpdfBinary,
    signal,
    log,
    runCommand,
}: {
    inputPath: string;
    inputCount: number;
    scratch: string;
    stagedPdfPath: string;
    qpdfBinary: string;
    signal: AbortSignal;
    log: TScanCleanupLog;
    runCommand: IRunScanCleanupPipelineDependencies['runCommand'];
}) {
    let currentPath = inputPath;
    let currentCount = inputCount;
    let level = 0;
    while (currentCount > 1) {
        signal.throwIfAborted();
        const nextPath = join(scratch, `scan-cleanup-merge-${String(level)}.jsonl`);
        const nextHandle = await open(nextPath, 'w');
        let nextCount = 0;
        let groupIndex = 0;
        let group: string[] = [];
        let seenCount = 0;
        const flushGroup = async () => {
            if (group.length === 0) {
                return;
            }
            signal.throwIfAborted();
            const mergedPath = join(
                scratch,
                `scan-cleanup-merge-${String(level)}-${String(groupIndex)}.pdf`,
            );
            const qpdfArgs = [
                '--empty',
                '--pages',
                ...group,
                '--',
                mergedPath,
            ];
            await runCommand(qpdfBinary, qpdfArgs, {
                signal,
                commandLabel: 'qpdf(scan-cleanup:merge-bounded-batches)',
                timeoutMs: 10 * 60 * 1000,
                log,
            });
            await appendJsonLine(nextHandle, {path: mergedPath});
            nextCount += 1;
            groupIndex += 1;
            group = [];
        };
        try {
            for await (const record of readJsonLines<{path?: unknown}>(currentPath, signal)) {
                if (typeof record.path !== 'string' || record.path.length === 0) {
                    throw new Error('Scan cleanup batch output sidecar contains an invalid path');
                }
                seenCount += 1;
                group.push(record.path);
                if (group.length >= QPDF_MERGE_INPUT_WINDOW) {
                    await flushGroup();
                }
            }
            await flushGroup();
        } finally {
            await nextHandle.close();
        }
        if (seenCount !== currentCount) {
            throw new Error(
                `Scan cleanup batch output sidecar declared ${String(currentCount)} paths but contained ${String(seenCount)}`,
            );
        }
        if (nextCount === 0) {
            throw new Error('Scan cleanup batch output sidecar contained no PDF paths');
        }
        currentPath = nextPath;
        currentCount = nextCount;
        level += 1;
    }
    let finalPath: string | null = null;
    for await (const record of readJsonLines<{path?: unknown}>(currentPath, signal)) {
        if (typeof record.path !== 'string' || record.path.length === 0) {
            throw new Error('Scan cleanup merged output sidecar contains an invalid path');
        }
        if (finalPath !== null) {
            throw new Error('Scan cleanup merged output sidecar contains too many paths');
        }
        finalPath = record.path;
    }
    if (finalPath === null) {
        throw new Error('Scan cleanup merged output sidecar contained no PDF paths');
    }
    await copyFile(finalPath, stagedPdfPath);
}

export async function mergeScanCleanupPdfPathSidecar(
    args: Parameters<typeof mergeScanCleanupPdfPathSidecarUnchecked>[0],
) {
    try {
        return await mergeScanCleanupPdfPathSidecarUnchecked(args);
    } catch (error) {
        args.signal.throwIfAborted();
        if (error instanceof ScanCleanupStreamingEvidenceError) {
            throw error;
        }
        throw new ScanCleanupStreamingEvidenceError(
            args.inputPath,
            getErrorMessage(error),
        );
    }
}

/**
 * Source text one conversion run gathers from its batches. A batch numbers its
 * output pages from zero, so `outputPageOffset` shifts them past the batches
 * before it; one overlay over the merged document then resolves every link.
 */
export interface IScanCleanupSourceTextSink {
    outputPageOffset: number;
    pages: IScanCleanupTextLayerInstruction[];
    skippedNonAffine: number[];
}

export function collectSourceText(sink: IScanCleanupSourceTextSink, plan: IScanCleanupTextLayerPlan) {
    sink.pages.push(...plan.pages.map(page => ({
        ...page,
        outputPageIndex: page.outputPageIndex + sink.outputPageOffset,
    })));
    sink.skippedNonAffine.push(...plan.skippedNonAffine);
}

/**
 * Inspects the source pages no overlay could place. The pages file is the
 * native inspection's input, so nothing is written when every page was placed.
 */
export async function inspectSkippedScanCleanupSourceText(input: {
    skippedNonAffine: readonly number[];
    pdfPath: string;
    scratch: string;
    pdfPageOpsBinary: string | undefined;
    qpdfBinary: string;
    signal: AbortSignal;
    runCommand: TScanCleanupRunCommand;
    log: TScanCleanupLog;
}): Promise<TScanCleanupSummary['sourceTextOmission']> {
    if (input.skippedNonAffine.length === 0 || input.pdfPageOpsBinary === undefined) return undefined;
    const pagesPath = join(input.scratch, 'source-text-omission-pages.txt');
    await writeFile(pagesPath, `${input.skippedNonAffine.join('\n')}\n`);
    return inspectScanCleanupSourceTextOmission({
        pdfPath: input.pdfPath,
        pagesPath,
        pdfPageOpsBinary: input.pdfPageOpsBinary,
        qpdfBinary: input.qpdfBinary,
        signal: input.signal,
        runCommand: input.runCommand,
        log: input.log,
    });
}
