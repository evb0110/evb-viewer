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
import {
    openFileBackedScanCleanupResultStore,
    RESULT_STORE_INDEX_BYTES,
} from '@evb/scan-cleanup/core/fileBackedResultStore';
import type {IScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/types';

const DESCRIPTOR_FORMAT = 'evb-scan-cleanup-detection-result-store';
const DESCRIPTOR_SCHEMA_VERSION = 2;
const RESULT_RECORD_MAX_BYTES = 4 * 1024 * 1024;
const HANDOFF_DIRECTORY_PREFIX = 'scan-cleanup-detection-handoff-';

function isSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Plain data safe to pass through workerData. */
export interface IScanCleanupDetectionResultStoreDescriptor {
    format: typeof DESCRIPTOR_FORMAT;
    indexPath: string;
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
        || typeof descriptor.indexPath !== 'string'
        || descriptor.indexPath.length === 0
    ) {
        throw new Error('Invalid scan cleanup detection result-store descriptor');
    }
}

/**
 * Persist the result store as one worker-readable JSONL file plus a fixed-width
 * page-offset index. The store is read one bounded chunk at a time, so this
 * handoff never recreates a result array in the main process.
 */
export async function persistScanCleanupDetectionResultStore(
    store: IScanCleanupDetectionResultStore,
    rootDir: string,
): Promise<IScanCleanupDetectionResultStoreDescriptor> {
    if (!Number.isSafeInteger(store.pageCount) || store.pageCount < 1) {
        throw new RangeError('Scan cleanup detection result store has an invalid page count');
    }
    const directory = await mkdtemp(join(rootDir, HANDOFF_DIRECTORY_PREFIX));
    const recordsPath = join(directory, 'records.jsonl');
    const indexPath = join(directory, 'index.bin');
    const descriptorPath = join(directory, 'descriptor.json');
    let recordsHandle: Awaited<ReturnType<typeof open>> | null = null;
    let indexHandle: Awaited<ReturnType<typeof open>> | null = null;
    let published = false;
    try {
        recordsHandle = await open(recordsPath, 'w');
        indexHandle = await open(indexPath, 'w');
        let expectedPageNumber = 1;
        let resultCount = 0;
        let nextOffset = 0;
        await store.forEachChunk(async results => {
            for (const result of results) {
                if (result.pageNumber !== expectedPageNumber) {
                    throw new Error(
                        `Scan cleanup detection result store returned page ${String(result.pageNumber)} where page ${String(expectedPageNumber)} was expected`,
                    );
                }
                const line = serialize(result);
                const encodedOffset = Buffer.alloc(RESULT_STORE_INDEX_BYTES);
                encodedOffset.writeBigUInt64LE(BigInt(nextOffset) + 1n, 0);
                await indexHandle!.write(
                    encodedOffset,
                    0,
                    encodedOffset.byteLength,
                    (result.pageNumber - 1) * RESULT_STORE_INDEX_BYTES,
                );
                await recordsHandle!.write(line);
                nextOffset += Buffer.byteLength(line, 'utf8');
                if (!Number.isSafeInteger(nextOffset)) {
                    throw new RangeError('Scan cleanup detection result handoff exceeds the offset limit');
                }
                expectedPageNumber += 1;
                resultCount += 1;
            }
        });
        if (expectedPageNumber !== store.pageCount + 1 || resultCount !== store.resultCount) {
            throw new Error('Scan cleanup detection result store is incomplete');
        }
        await recordsHandle.close();
        recordsHandle = null;
        await indexHandle.close();
        indexHandle = null;
        const descriptor: IScanCleanupDetectionResultStoreDescriptor = {
            format: DESCRIPTOR_FORMAT,
            indexPath,
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
        await indexHandle?.close();
        if (!published) {
            await rm(directory, {
                force: true,
                recursive: true,
            });
        }
    }
}

/** Open a worker-safe descriptor directly over its persisted files. */
export async function openScanCleanupDetectionResultStoreDescriptor(
    descriptor: IScanCleanupDetectionResultStoreDescriptor,
): Promise<IScanCleanupDetectionResultStore> {
    assertDescriptor(descriptor);
    if (!isAbsolute(descriptor.recordsPath) || !isAbsolute(descriptor.indexPath)) {
        throw new Error('Scan cleanup result handoff path must be absolute');
    }
    if (dirname(descriptor.recordsPath) !== dirname(descriptor.indexPath)) {
        throw new Error('Scan cleanup result handoff files must share a directory');
    }
    const recordsStats = await stat(descriptor.recordsPath);
    if (!recordsStats.isFile()) {
        throw new Error('Scan cleanup result handoff path is not a file');
    }
    const indexStats = await stat(descriptor.indexPath);
    if (!indexStats.isFile()) {
        throw new Error('Scan cleanup result handoff index is not a file');
    }
    return openFileBackedScanCleanupResultStore<IScanCleanupDetectionResult>({
        recordsPath: descriptor.recordsPath,
        indexPath: descriptor.indexPath,
        pageCount: descriptor.pageCount,
        pageNumberOf: result => result.pageNumber,
        resultCount: descriptor.resultCount,
    });
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
