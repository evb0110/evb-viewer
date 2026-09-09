import {
    createHash,
    randomBytes,
} from 'node:crypto';
import {
    closeSync,
    constants as fsConstants,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from 'fs';
import {
    mkdir,
    open,
    readFile,
    rename,
    writeFile,
} from 'fs/promises';
import {
    basename,
    dirname,
    join,
} from 'path';
import {fsyncParentDirectory} from '@electron/utils/atomicReplace';

type TSnapshotRecord<TSession, TVersion extends number> =
    | {
        schemaVersion: TVersion;
        type: 'session-snapshot';
        key: string;
        writtenAt: string;
        session: TSession;
    }
    | {
        schemaVersion: TVersion;
        type: 'session-reset';
        key: string;
        writtenAt: string;
    }
    | {
        schemaVersion: TVersion;
        type: 'session-snapshot-ref';
        keyDigest: string;
        writtenAt: string;
        blobFile: string;
        sha256: string;
        sizeBytes: number;
    };
type TSnapshotPayloadRecord<TSession, TVersion extends number> = Extract<
    TSnapshotRecord<TSession, TVersion>,
    {type: 'session-snapshot'}
>;
type TSnapshotReference<TSession, TVersion extends number> = Extract<
    TSnapshotRecord<TSession, TVersion>,
    {type: 'session-snapshot-ref'}
>;

interface IAssistantChatSnapshotStorageOptions<TSession, TVersion extends number> {
    blobsDir: string;
    maxSessionBytes: number;
    createTooLargeError: (key: string, message: string) => Error;
    parseRecord: (line: string) => TSnapshotRecord<TSession, TVersion> | null;
}

function randomSuffix() {
    return randomBytes(8).toString('hex');
}

function fsyncSyncBestEffort(fd: number) {
    try {
        fsyncSync(fd);
    } catch {
        // Best effort. The atomic rename still prevents a partial destination.
    }
}

function fsyncParentDirectorySync(filePath: string) {
    if (process.platform === 'win32') {
        return;
    }

    let fd: number | null = null;
    try {
        fd = openSync(dirname(filePath), fsConstants.O_RDONLY);
        fsyncSyncBestEffort(fd);
    } catch {
        return;
    } finally {
        if (fd !== null) {
            try {
                closeSync(fd);
            } catch {
                // Best effort.
            }
        }
    }
}

async function atomicWriteJsonLineFile(filePath: string, payload: unknown) {
    await mkdir(dirname(filePath), {recursive: true});
    const tempPath = join(dirname(filePath), `.${basename(filePath)}.${randomSuffix()}.tmp`);
    await writeFile(tempPath, typeof payload === 'string' ? payload : `${JSON.stringify(payload)}\n`, 'utf8');
    const handle = await open(tempPath, 'r');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
    await rename(tempPath, filePath);
    await fsyncParentDirectory(filePath);
}

function atomicWriteJsonLineFileSync(filePath: string, payload: unknown) {
    mkdirSync(dirname(filePath), {recursive: true});
    const tempPath = join(dirname(filePath), `.${basename(filePath)}.${randomSuffix()}.tmp`);
    writeFileSync(tempPath, typeof payload === 'string' ? payload : `${JSON.stringify(payload)}\n`, 'utf8');
    let fd: number | null = null;
    try {
        fd = openSync(tempPath, 'r');
        fsyncSyncBestEffort(fd);
    } finally {
        if (fd !== null) {
            try {
                closeSync(fd);
            } catch {
                // Best effort.
            }
        }
    }
    renameSync(tempPath, filePath);
    fsyncParentDirectorySync(filePath);
}

function serializedBytes(value: unknown) {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') + 1;
}

function snapshotBlobPayload<TSession, TVersion extends number>(record: TSnapshotPayloadRecord<TSession, TVersion>) {
    return `${JSON.stringify(record)}\n`;
}

function snapshotContentDigest<TSession, TVersion extends number>(record: TSnapshotPayloadRecord<TSession, TVersion>) {
    const {
        writtenAt: _writtenAt,
        ...content
    } = record;
    return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

export class AssistantChatSnapshotStorage<TSession, TVersion extends number> {
    readonly blobsDir: string;
    private readonly maxSessionBytes: number;
    private readonly createTooLargeError: (key: string, message: string) => Error;
    private readonly parseRecord: (line: string) => TSnapshotRecord<TSession, TVersion> | null;

    constructor(options: IAssistantChatSnapshotStorageOptions<TSession, TVersion>) {
        this.blobsDir = options.blobsDir;
        this.maxSessionBytes = options.maxSessionBytes;
        this.createTooLargeError = options.createTooLargeError;
        this.parseRecord = options.parseRecord;
        mkdirSync(this.blobsDir, {recursive: true});
    }

    private getSnapshotBlobPath(blobFile: string) {
        return join(this.blobsDir, blobFile);
    }

    private createSnapshotReference(
        record: TSnapshotPayloadRecord<TSession, TVersion>,
        payload: string,
        blobFile: string,
    ) {
        const digest = createHash('sha256').update(payload).digest('hex');
        const reference: TSnapshotReference<TSession, TVersion> = {
            schemaVersion: record.schemaVersion,
            type: 'session-snapshot-ref',
            keyDigest: createHash('sha256').update(record.key).digest('hex'),
            writtenAt: record.writtenAt,
            blobFile,
            sha256: digest,
            sizeBytes: Buffer.byteLength(payload, 'utf8'),
        };
        if (serializedBytes(reference) > this.maxSessionBytes) {
            throw this.createTooLargeError(
                record.key,
                `Assistant chat snapshot for "${record.key}" cannot fit within ${this.maxSessionBytes} bytes.`,
            );
        }
        return {
            payload,
            reference,
        };
    }

    private async findReusableBlob(
        record: TSnapshotPayloadRecord<TSession, TVersion>,
        blobFile: string,
    ) {
        const filePath = this.getSnapshotBlobPath(blobFile);
        let payload: string;
        try {
            payload = await readFile(filePath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return {
                    exists: false,
                    reference: null,
                };
            }
            throw error;
        }
        const parsed = this.parseRecord(payload.trim());
        if (
            !parsed
            || parsed.type !== 'session-snapshot'
            || snapshotContentDigest(parsed) !== snapshotContentDigest(record)
        ) {
            return {
                exists: true,
                reference: null,
            };
        }
        const reference = this.createSnapshotReference(record, payload, blobFile).reference;
        return {
            exists: true,
            reference,
        };
    }

    private findReusableBlobSync(
        record: TSnapshotPayloadRecord<TSession, TVersion>,
        blobFile: string,
    ) {
        const filePath = this.getSnapshotBlobPath(blobFile);
        let payload: string;
        try {
            payload = readFileSync(filePath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return {
                    exists: false,
                    reference: null,
                };
            }
            throw error;
        }
        const parsed = this.parseRecord(payload.trim());
        if (
            !parsed
            || parsed.type !== 'session-snapshot'
            || snapshotContentDigest(parsed) !== snapshotContentDigest(record)
        ) {
            return {
                exists: true,
                reference: null,
            };
        }
        const reference = this.createSnapshotReference(record, payload, blobFile).reference;
        return {
            exists: true,
            reference,
        };
    }

    async prepareRecordForStorage(record: TSnapshotRecord<TSession, TVersion>, key: string) {
        if (record.type !== 'session-snapshot' || serializedBytes(record) <= this.maxSessionBytes) {
            return record;
        }

        const payload = snapshotBlobPayload(record);
        const contentDigest = snapshotContentDigest(record);
        const reusable = await this.findReusableBlob(record, `${contentDigest}.json`);
        if (reusable.reference) {
            return reusable.reference;
        }
        const {reference} = this.createSnapshotReference(
            record,
            payload,
            reusable.exists ? `${createHash('sha256').update(payload).digest('hex')}.json` : `${contentDigest}.json`,
        );
        await mkdir(this.blobsDir, {recursive: true});
        await atomicWriteJsonLineFile(this.getSnapshotBlobPath(reference.blobFile), payload);
        if (Buffer.byteLength(payload, 'utf8') !== reference.sizeBytes) {
            throw this.createTooLargeError(
                key,
                `Assistant chat snapshot for "${key}" changed while writing its bounded payload.`,
            );
        }
        return reference;
    }

    prepareRecordForStorageSync(
        record: TSnapshotPayloadRecord<TSession, TVersion>,
        key: string,
    ): TSnapshotRecord<TSession, TVersion> {
        if (serializedBytes(record) <= this.maxSessionBytes) {
            return record;
        }

        const payload = snapshotBlobPayload(record);
        const contentDigest = snapshotContentDigest(record);
        const reusable = this.findReusableBlobSync(record, `${contentDigest}.json`);
        if (reusable.reference) {
            return reusable.reference;
        }
        const {reference} = this.createSnapshotReference(
            record,
            payload,
            reusable.exists ? `${createHash('sha256').update(payload).digest('hex')}.json` : `${contentDigest}.json`,
        );
        mkdirSync(this.blobsDir, {recursive: true});
        atomicWriteJsonLineFileSync(this.getSnapshotBlobPath(reference.blobFile), payload);
        if (Buffer.byteLength(payload, 'utf8') !== reference.sizeBytes) {
            throw this.createTooLargeError(
                key,
                `Assistant chat snapshot for "${key}" changed while writing its bounded payload.`,
            );
        }
        return reference;
    }

    async writeBoundedSnapshot(filePath: string, record: TSnapshotPayloadRecord<TSession, TVersion>, key: string) {
        const storageRecord = await this.prepareRecordForStorage(record, key);
        await atomicWriteJsonLineFile(filePath, storageRecord);
    }

    writeBoundedSnapshotSync(filePath: string, record: TSnapshotPayloadRecord<TSession, TVersion>, key: string) {
        const storageRecord = this.prepareRecordForStorageSync(record, key);
        atomicWriteJsonLineFileSync(filePath, storageRecord);
    }

    async writeReference(filePath: string, reference: TSnapshotReference<TSession, TVersion>) {
        await atomicWriteJsonLineFile(filePath, reference);
    }

    readSnapshotBlobSync(reference: TSnapshotReference<TSession, TVersion>): {
        key: string;
        session: TSession;
    } {
        const payload = readFileSync(this.getSnapshotBlobPath(reference.blobFile), 'utf8');
        if (Buffer.byteLength(payload, 'utf8') !== reference.sizeBytes) {
            throw new Error('Assistant chat snapshot blob size does not match its reference.');
        }
        const digest = createHash('sha256').update(payload).digest('hex');
        if (digest !== reference.sha256) {
            throw new Error('Assistant chat snapshot blob checksum does not match its reference.');
        }
        const record = this.parseRecord(payload.trim());
        if (!record || record.type !== 'session-snapshot') {
            throw new Error('Assistant chat snapshot blob is malformed.');
        }
        const keyDigest = createHash('sha256').update(record.key).digest('hex');
        if (keyDigest !== reference.keyDigest) {
            throw new Error('Assistant chat snapshot blob key does not match its reference.');
        }
        return {
            key: record.key,
            session: record.session,
        };
    }
}
