import {
    mkdtemp,
    open,
    rm,
} from 'fs/promises';
import type {FileHandle} from 'fs/promises';
import {join} from 'path';
import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@contracts/scan-cleanup/inputLimits';
import type {
    IScanCleanupDetectionResultStore,
    IScanCleanupResultStore,
} from '@evb/scan-cleanup/core/types';
import type {IScanCleanupDetectionResult} from '@contracts/electronApiScanCleanup';

/** A single result record must stay smaller than the native sidecar line cap. */
const RESULT_STORE_MAX_LINE_BYTES = 4 * 1024 * 1024;
const RESULT_STORE_INDEX_BYTES = 8;
const RESULT_STORE_READ_CHUNK_BYTES = 64 * 1024;
const RESULT_STORE_PREFIX = 'scan-cleanup-results-';

export interface IFileBackedScanCleanupResultStoreOptions<TRecord> {
    rootDir: string;
    pageCount: number;
    pageNumberOf: (record: TRecord) => number;
    maxReadPages?: number;
    fileSystem?: {
        mkdtemp: (prefix: string) => Promise<string>;
        open: (
            path: string,
            flags: 'r' | 'w+',
        ) => Promise<FileHandle>;
        rm: (
            path: string,
            options: {
                force: boolean;
                recursive: boolean;
            },
        ) => Promise<void>;
    };
}

type TFileBackedScanCleanupFileSystem = NonNullable<
    IFileBackedScanCleanupResultStoreOptions<unknown>['fileSystem']
>;

function assertPageCount(pageCount: number) {
    if (!Number.isSafeInteger(pageCount) || pageCount < 0) {
        throw new RangeError('Scan cleanup result store page count must be a non-negative safe integer');
    }
}

function assertPageNumber(pageNumber: number, pageCount: number) {
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
        throw new RangeError(`Scan cleanup result store has no page ${String(pageNumber)}`);
    }
}

function assertReadWindow(
    firstPageNumber: number,
    lastPageNumberExclusive: number,
    pageCount: number,
    maxReadPages: number,
) {
    if (
        !Number.isSafeInteger(firstPageNumber)
        || !Number.isSafeInteger(lastPageNumberExclusive)
        || firstPageNumber < 1
        || lastPageNumberExclusive < firstPageNumber
        || lastPageNumberExclusive > pageCount + 1
        || lastPageNumberExclusive - firstPageNumber > maxReadPages
    ) {
        throw new RangeError('Scan cleanup result store read range is invalid or exceeds its bounded window');
    }
}

function checkedIndexPosition(pageNumber: number) {
    const position = (pageNumber - 1) * RESULT_STORE_INDEX_BYTES;
    if (!Number.isSafeInteger(position)) {
        throw new RangeError('Scan cleanup result store index position exceeds the safe integer range');
    }
    return position;
}

function checkedOffset(value: bigint) {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError('Scan cleanup result store record offset exceeds the safe integer range');
    }
    return Number(value);
}

function serializeRecord<TRecord>(record: TRecord) {
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > RESULT_STORE_MAX_LINE_BYTES) {
        throw new RangeError(
            `Scan cleanup result record exceeds ${String(RESULT_STORE_MAX_LINE_BYTES)} bytes`,
        );
    }
    return {
        bytes,
        line,
    };
}

class FileBackedScanCleanupResultStore<TRecord> implements IScanCleanupResultStore<TRecord> {
    private readonly recordsFile: Awaited<ReturnType<typeof open>>;
    private readonly indexFile: Awaited<ReturnType<typeof open>>;
    private readonly directory: string;
    private readonly pageNumberOf: (record: TRecord) => number;
    private readonly maxReadPages: number;
    private readonly fileSystem: TFileBackedScanCleanupFileSystem;
    private _resultCount = 0;
    private nextOffset = 0;
    private nextAppendPageNumber = 1;
    private appendFastPathAvailable = true;
    private closed = false;
    private operation = Promise.resolve();

    public constructor(
        directory: string,
        recordsFile: Awaited<ReturnType<typeof open>>,
        indexFile: Awaited<ReturnType<typeof open>>,
        options: Pick<IFileBackedScanCleanupResultStoreOptions<TRecord>, 'pageCount' | 'pageNumberOf' | 'maxReadPages'>,
        fileSystem: TFileBackedScanCleanupFileSystem,
    ) {
        this.directory = directory;
        this.recordsFile = recordsFile;
        this.indexFile = indexFile;
        this.fileSystem = fileSystem;
        this.pageCount = options.pageCount;
        this.pageNumberOf = options.pageNumberOf;
        this.maxReadPages = options.maxReadPages ?? SCAN_CLEANUP_STREAMING_BATCH_PAGES;
        if (!Number.isSafeInteger(this.maxReadPages) || this.maxReadPages < 1) {
            throw new RangeError('Scan cleanup result store read window must be a positive safe integer');
        }
    }

    public readonly pageCount: number;

    public get resultCount() {
        return this._resultCount;
    }

    private enqueue<T>(task: () => Promise<T>) {
        const next = this.operation.then(task);
        this.operation = next.then(() => undefined, () => undefined);
        return next;
    }

    private assertOpen() {
        if (this.closed) throw new Error('Scan cleanup result store is closed');
    }

    private async readOffset(pageNumber: number) {
        const bytes = Buffer.alloc(RESULT_STORE_INDEX_BYTES);
        const {bytesRead} = await this.indexFile.read(
            bytes,
            0,
            bytes.byteLength,
            checkedIndexPosition(pageNumber),
        );
        if (bytesRead !== bytes.byteLength) {
            return undefined;
        }
        const encoded = bytes.readBigUInt64LE(0);
        return encoded === 0n ? undefined : checkedOffset(encoded - 1n);
    }

    private async writeOffset(pageNumber: number, offset: number) {
        if (!Number.isSafeInteger(offset) || offset < 0) {
            throw new RangeError('Scan cleanup result store record offset is invalid');
        }
        const encoded = BigInt(offset + 1);
        const bytes = Buffer.alloc(RESULT_STORE_INDEX_BYTES);
        bytes.writeBigUInt64LE(encoded, 0);
        await this.indexFile.write(
            bytes,
            0,
            bytes.byteLength,
            checkedIndexPosition(pageNumber),
        );
    }

    private async readRecordAt(offset: number) {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let position = offset;
        while (totalBytes <= RESULT_STORE_MAX_LINE_BYTES) {
            const chunk = Buffer.alloc(RESULT_STORE_READ_CHUNK_BYTES);
            const {bytesRead} = await this.recordsFile.read(
                chunk,
                0,
                chunk.byteLength,
                position,
            );
            if (bytesRead === 0) break;
            const part = chunk.subarray(0, bytesRead);
            const newline = part.indexOf(0x0a);
            if (newline >= 0) {
                chunks.push(part.subarray(0, newline));
                const payload = Buffer.concat(chunks).toString('utf8');
                try {
                    return JSON.parse(payload) as TRecord;
                } catch (error) {
                    throw new Error(`Scan cleanup result store contains invalid JSON: ${String(error)}`);
                }
            }
            chunks.push(part);
            totalBytes += bytesRead;
            position += bytesRead;
        }
        throw new Error('Scan cleanup result store contains an unterminated or oversized record');
    }

    private async readPageInternal(pageNumber: number) {
        const offset = await this.readOffset(pageNumber);
        return offset === undefined ? undefined : this.readRecordAt(offset);
    }

    private async writeRecord(
        pageNumber: number,
        record: TRecord,
        requireExisting: boolean,
        skipExistingCheck = false,
    ) {
        this.assertOpen();
        assertPageNumber(pageNumber, this.pageCount);
        const recordPageNumber = this.pageNumberOf(record);
        if (recordPageNumber !== pageNumber) {
            throw new Error(
                `Scan cleanup result store received page ${String(recordPageNumber)} for page ${String(pageNumber)}`,
            );
        }
        const existingOffset = skipExistingCheck
            ? undefined
            : await this.readOffset(pageNumber);
        if (requireExisting && existingOffset === undefined) {
            throw new Error(`Scan cleanup result store cannot replace missing page ${String(pageNumber)}`);
        }
        if (!requireExisting && existingOffset !== undefined) {
            throw new Error(`Scan cleanup result store already contains page ${String(pageNumber)}`);
        }
        const serialized = serializeRecord(record);
        const offset = this.nextOffset;
        const nextOffset = BigInt(offset) + BigInt(serialized.bytes);
        if (nextOffset > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new RangeError('Scan cleanup result store record offset exceeds the safe integer range');
        }
        await this.recordsFile.write(serialized.line, offset, 'utf8');
        this.nextOffset = Number(nextOffset);
        await this.writeOffset(pageNumber, offset);
        if (existingOffset === undefined) this._resultCount += 1;
    }

    public append(record: TRecord) {
        return this.enqueue(async () => {
            this.assertOpen();
            const pageNumber = this.pageNumberOf(record);
            assertPageNumber(pageNumber, this.pageCount);
            const sequentialAppend = this.appendFastPathAvailable
                && pageNumber === this.nextAppendPageNumber;
            if (sequentialAppend) {
                await this.writeRecord(pageNumber, record, false, true);
                this.nextAppendPageNumber += 1;
                return;
            }
            this.appendFastPathAvailable = false;
            await this.writeRecord(pageNumber, record, false);
        });
    }

    public replace(pageNumber: number, record: TRecord) {
        return this.enqueue(async () => {
            this.assertOpen();
            await this.writeRecord(pageNumber, record, true);
        });
    }

    public getPage(pageNumber: number) {
        return this.enqueue(async () => {
            this.assertOpen();
            assertPageNumber(pageNumber, this.pageCount);
            return this.readPageInternal(pageNumber);
        });
    }

    private async readRangeInternal(firstPageNumber: number, lastPageNumberExclusive: number) {
        assertReadWindow(
            firstPageNumber,
            lastPageNumberExclusive,
            this.pageCount,
            this.maxReadPages,
        );
        const results: TRecord[] = [];
        for (
            let pageNumber = firstPageNumber;
            pageNumber < lastPageNumberExclusive;
            pageNumber += 1
        ) {
            const result = await this.readPageInternal(pageNumber);
            if (result !== undefined) results.push(result);
        }
        return results;
    }

    public readRange(firstPageNumber: number, lastPageNumberExclusive: number) {
        return this.enqueue(async () => {
            this.assertOpen();
            return this.readRangeInternal(firstPageNumber, lastPageNumberExclusive);
        });
    }

    public forEachChunk(onChunk: (results: readonly TRecord[], firstPageNumber: number) => Promise<void> | void) {
        return this.enqueue(async () => {
            this.assertOpen();
            for (
                let firstPageNumber = 1;
                firstPageNumber <= this.pageCount;
                firstPageNumber += this.maxReadPages
            ) {
                const lastPageNumberExclusive = Math.min(
                    this.pageCount + 1,
                    firstPageNumber + this.maxReadPages,
                );
                await onChunk(
                    await this.readRangeInternal(firstPageNumber, lastPageNumberExclusive),
                    firstPageNumber,
                );
            }
        });
    }

    public close() {
        return this.enqueue(async () => {
            if (this.closed) {
                return;
            }
            this.closed = true;
            await Promise.allSettled([
                this.recordsFile.close(),
                this.indexFile.close(),
            ]);
            await this.fileSystem.rm(this.directory, {
                force: true,
                recursive: true,
            });
        });
    }
}

/**
 * Create a result store whose records stay on disk and whose fixed-width index
 * makes page reads independent of the number of earlier pages. The index is a
 * file, not a JavaScript array, so million-page runs retain only the current
 * read window.
 */
export async function createFileBackedScanCleanupResultStore<TRecord>(
    options: IFileBackedScanCleanupResultStoreOptions<TRecord>,
): Promise<IScanCleanupResultStore<TRecord>> {
    assertPageCount(options.pageCount);
    if (typeof options.pageNumberOf !== 'function') {
        throw new TypeError('Scan cleanup result store requires a page-number reader');
    }
    const fileSystem = options.fileSystem ?? {
        mkdtemp,
        open,
        rm,
    };
    const directory = await fileSystem.mkdtemp(join(options.rootDir, RESULT_STORE_PREFIX));
    let recordsFile: Awaited<ReturnType<typeof open>> | null = null;
    let indexFile: Awaited<ReturnType<typeof open>> | null = null;
    try {
        recordsFile = await fileSystem.open(join(directory, 'records.jsonl'), 'w+');
        indexFile = await fileSystem.open(join(directory, 'index.bin'), 'w+');
        return new FileBackedScanCleanupResultStore(
            directory,
            recordsFile,
            indexFile,
            options,
            fileSystem,
        );
    } catch (error) {
        await Promise.allSettled([
            recordsFile?.close(),
            indexFile?.close(),
        ]);
        await fileSystem.rm(directory, {
            force: true,
            recursive: true,
        }).catch(() => undefined);
        throw error;
    }
}

/** A detection-specialized factory keeps the public call site self-documenting. */
export function createFileBackedScanCleanupDetectionResultStore(
    options: Omit<IFileBackedScanCleanupResultStoreOptions<IScanCleanupDetectionResult>, 'pageNumberOf'>,
): Promise<IScanCleanupDetectionResultStore> {
    return createFileBackedScanCleanupResultStore<IScanCleanupDetectionResult>({
        ...options,
        pageNumberOf: result => result.pageNumber,
    }).then(store => {
        const persistedResult = (result: IScanCleanupDetectionResult): IScanCleanupDetectionResult => {
            if (result.outputModeDiagnostics === undefined) {
                return result;
            }
            const persisted = {...result};
            delete persisted.outputModeDiagnostics;
            return persisted;
        };
        return {
            close: () => store.close(),
            forEachChunk: onChunk => store.forEachChunk(onChunk),
            get pageCount() {
                return store.pageCount;
            },
            get resultCount() {
                return store.resultCount;
            },
            getPage: pageNumber => store.getPage(pageNumber),
            readRange: (firstPageNumber, lastPageNumberExclusive) => (
                store.readRange(firstPageNumber, lastPageNumberExclusive)
            ),
            append: result => store.append(persistedResult(result)),
            replace: (pageNumber, result) => store.replace(pageNumber, persistedResult(result)),
        };
    });
}
