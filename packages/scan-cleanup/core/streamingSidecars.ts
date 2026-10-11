import {createReadStream} from 'fs';
import {
    copyFile,
    open,
} from 'fs/promises';
import {join} from 'path';
import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@contracts/scan-cleanup/inputLimits';
import {getErrorMessage} from '@contracts/getErrorMessage';
import {ScanCleanupStreamingEvidenceError} from '@evb/scan-cleanup/core/errors';
import type {
    IRunScanCleanupPipelineDependencies,
    TScanCleanupLog,
} from '@evb/scan-cleanup/core/types';

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
