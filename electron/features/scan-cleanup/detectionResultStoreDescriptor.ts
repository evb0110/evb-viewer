import {createReadStream} from 'node:fs';
import {
    mkdtemp,
    open,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {
    dirname,
    isAbsolute,
    join,
} from 'node:path';
import type {IScanCleanupDetectionResult} from '@contracts/electronApiScanCleanup';
import {isRecord} from '@contracts/runtimeGuards';
import {createFileBackedScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/fileBackedResultStore';
import type {IScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/types';

const DESCRIPTOR_FORMAT = 'evb-scan-cleanup-detection-result-store';
const DESCRIPTOR_SCHEMA_VERSION = 1;
const RESULT_RECORD_MAX_BYTES = 4 * 1024 * 1024;
const HANDOFF_DIRECTORY_PREFIX = 'scan-cleanup-detection-handoff-';

function isSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Plain data safe to pass through workerData. */
export interface IScanCleanupDetectionResultStoreDescriptor {
    format: typeof DESCRIPTOR_FORMAT;
    pageCount: number;
    recordsPath: string;
    resultCount: number;
    schemaVersion: typeof DESCRIPTOR_SCHEMA_VERSION;
}

function serialize(result: IScanCleanupDetectionResult) {
    const line = `${JSON.stringify(result)}\n`;
    if (Buffer.byteLength(line, 'utf8') > RESULT_RECORD_MAX_BYTES) {
        throw new RangeError('Scan cleanup detection result exceeds the handoff record limit');
    }
    return line;
}

function assertDescriptor(descriptor: unknown): asserts descriptor is IScanCleanupDetectionResultStoreDescriptor {
    if (
        !isRecord(descriptor)
        || descriptor.format !== DESCRIPTOR_FORMAT
        || descriptor.schemaVersion !== DESCRIPTOR_SCHEMA_VERSION
        || !isSafeInteger(descriptor.pageCount)
        || descriptor.pageCount < 1
        || !isSafeInteger(descriptor.resultCount)
        || descriptor.resultCount !== descriptor.pageCount
        || typeof descriptor.recordsPath !== 'string'
        || descriptor.recordsPath.length === 0
    ) {
        throw new Error('Invalid scan cleanup detection result-store descriptor');
    }
}

/**
 * Copy the result store into a worker-readable JSONL sidecar. The store is
 * read one bounded chunk at a time, so this handoff never recreates a result
 * array in the main process.
 */
export async function persistScanCleanupDetectionResultStore(
    store: IScanCleanupDetectionResultStore,
    rootDir: string,
): Promise<IScanCleanupDetectionResultStoreDescriptor> {
    if (!Number.isSafeInteger(store.pageCount) || store.pageCount < 1) {
        throw new RangeError('Scan cleanup detection result store has an invalid page count');
    }
    const directory = await mkdtemp(join(rootDir, HANDOFF_DIRECTORY_PREFIX));
    const recordsPath = join(directory, 'results.jsonl');
    const descriptorPath = join(directory, 'descriptor.json');
    let recordsHandle: Awaited<ReturnType<typeof open>> | null = null;
    let published = false;
    try {
        recordsHandle = await open(recordsPath, 'w');
        let expectedPageNumber = 1;
        let resultCount = 0;
        await store.forEachChunk(async results => {
            for (const result of results) {
                if (result.pageNumber !== expectedPageNumber) {
                    throw new Error(
                        `Scan cleanup detection result store returned page ${String(result.pageNumber)} where page ${String(expectedPageNumber)} was expected`,
                    );
                }
                await recordsHandle!.write(serialize(result));
                expectedPageNumber += 1;
                resultCount += 1;
            }
        });
        if (expectedPageNumber !== store.pageCount + 1 || resultCount !== store.resultCount) {
            throw new Error('Scan cleanup detection result store is incomplete');
        }
        await recordsHandle.close();
        recordsHandle = null;
        const descriptor: IScanCleanupDetectionResultStoreDescriptor = {
            format: DESCRIPTOR_FORMAT,
            pageCount: store.pageCount,
            recordsPath,
            resultCount: store.resultCount,
            schemaVersion: DESCRIPTOR_SCHEMA_VERSION,
        };
        // Keep a tiny human/debug-readable descriptor beside the sidecar. The
        // worker receives the same plain object, not a path with live methods.
        await writeFile(descriptorPath, `${JSON.stringify(descriptor)}\n`, 'utf8');
        published = true;
        return descriptor;
    } finally {
        await recordsHandle?.close();
        if (!published) {
            await rm(directory, {
                force: true,
                recursive: true,
            });
        }
    }
}

async function* readResults(recordsPath: string): AsyncGenerator<IScanCleanupDetectionResult> {
    const stream = createReadStream(recordsPath, {encoding: 'utf8'});
    let pending = '';
    try {
        for await (const chunk of stream) {
            if (typeof chunk !== 'string') {
                throw new Error('Scan cleanup result handoff produced a non-text chunk');
            }
            pending += chunk;
            if (Buffer.byteLength(pending, 'utf8') > RESULT_RECORD_MAX_BYTES) {
                throw new Error('Scan cleanup result handoff contains an oversized record');
            }
            let newline = pending.indexOf('\n');
            while (newline >= 0) {
                const line = pending.slice(0, newline).trim();
                pending = pending.slice(newline + 1);
                if (line.length > 0) {
                    yield JSON.parse(line) as IScanCleanupDetectionResult;
                }
                newline = pending.indexOf('\n');
            }
        }
        const line = pending.trim();
        if (line.length > 0) {
            yield JSON.parse(line) as IScanCleanupDetectionResult;
        }
    } finally {
        stream.destroy();
    }
}

/** Open a worker-safe descriptor while retaining only one record at a time. */
export async function openScanCleanupDetectionResultStoreDescriptor(
    descriptor: IScanCleanupDetectionResultStoreDescriptor,
): Promise<IScanCleanupDetectionResultStore> {
    assertDescriptor(descriptor);
    if (!isAbsolute(descriptor.recordsPath)) {
        throw new Error('Scan cleanup result handoff path must be absolute');
    }
    const recordsStats = await stat(descriptor.recordsPath);
    if (!recordsStats.isFile()) {
        throw new Error('Scan cleanup result handoff path is not a file');
    }
    const rootDir = dirname(descriptor.recordsPath);
    const store = await createFileBackedScanCleanupDetectionResultStore({
        pageCount: descriptor.pageCount,
        rootDir,
    });
    let expectedPageNumber = 1;
    try {
        for await (const result of readResults(descriptor.recordsPath)) {
            if (result.pageNumber !== expectedPageNumber) {
                throw new Error('Scan cleanup result handoff pages are out of order');
            }
            await store.append(result);
            expectedPageNumber += 1;
        }
        if (expectedPageNumber !== descriptor.pageCount + 1 || store.resultCount !== descriptor.resultCount) {
            throw new Error('Scan cleanup result handoff is incomplete');
        }
        return store;
    } catch (error) {
        await store.close();
        throw error;
    }
}

export async function removeScanCleanupDetectionResultStoreDescriptor(
    descriptor: IScanCleanupDetectionResultStoreDescriptor,
) {
    assertDescriptor(descriptor);
    await rm(dirname(descriptor.recordsPath), {
        force: true,
        recursive: true,
    });
}
