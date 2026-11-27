import {createOriginalFileContentFingerprintHash} from '@electron/file-access/createOriginalFileContentFingerprintHash';
import {
    abortErrorFromSignal,
    raceWithAbortSignal,
} from '@electron/utils/abort';
import {createHash} from 'node:crypto';
import {
    open,
    stat,
    type FileHandle,
} from 'node:fs/promises';

const FINGERPRINT_CHUNK_BYTES = 1024 * 1024;

export async function fingerprintFileBounded(path: string, expectedBytes: number, signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
        throw new Error('Document file size changed during inspection');
    }
    const expectedSize = BigInt(expectedBytes);
    const before = await raceWithAbortSignal(stat(path, {bigint: true}), signal);
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
    if (!before.isFile() || before.size !== expectedSize) {
        throw new Error('Document file size changed during inspection');
    }
    const hash = createHash('sha256');
    const contentHash = createOriginalFileContentFingerprintHash(expectedBytes);
    const openPromise = open(path, 'r');
    let handle: FileHandle;
    try {
        handle = await raceWithAbortSignal(openPromise, signal);
    } catch (error) {
        void openPromise.then(opened => opened.close().catch(() => undefined), () => undefined);
        throw error;
    }

    let handleClosed = false;
    let inFlightOp: Promise<unknown> | null = null;
    try {
        const statPromise = handle.stat({bigint: true});
        inFlightOp = statPromise;
        let opened;
        try {
            opened = await raceWithAbortSignal(statPromise, signal);
            inFlightOp = null;
        } catch (error) {
            if (!signal?.aborted) {
                inFlightOp = null;
            }
            throw error;
        }
        if (
            !opened.isFile()
            || opened.size !== before.size
            || opened.dev !== before.dev
            || opened.ino !== before.ino
        ) {
            throw new Error('Document file changed during inspection');
        }

        const chunkBuffer = Buffer.allocUnsafe(Math.min(FINGERPRINT_CHUNK_BYTES, Math.max(expectedBytes, 1)));
        let offset = 0;
        for (;;) {
            if (signal?.aborted) {
                throw abortErrorFromSignal(signal);
            }
            const readPromise = handle.read(chunkBuffer, 0, chunkBuffer.byteLength, offset);
            inFlightOp = readPromise;
            let bytesRead: number;
            try {
                ({bytesRead} = await raceWithAbortSignal(readPromise, signal));
                inFlightOp = null;
            } catch (error) {
                if (!signal?.aborted) {
                    inFlightOp = null;
                }
                throw error;
            }
            if (bytesRead === 0) {
                break;
            }
            offset += bytesRead;
            if (offset > expectedBytes) {
                throw new Error('Document file size changed during inspection');
            }
            const chunk = bytesRead === chunkBuffer.byteLength
                ? chunkBuffer
                : chunkBuffer.subarray(0, bytesRead);
            hash.update(chunk);
            contentHash.update(chunk);
        }
        if (signal?.aborted) {
            throw abortErrorFromSignal(signal);
        }
        if (offset !== expectedBytes) {
            throw new Error('Document file size changed during inspection');
        }
        const closePromise = handle.close();
        handleClosed = true;
        try {
            await raceWithAbortSignal(closePromise, signal);
        } catch (error) {
            void closePromise.catch(() => undefined);
            throw error;
        }
    } finally {
        if (!handleClosed) {
            handleClosed = true;
            if (inFlightOp !== null) {
                const pendingOp = inFlightOp;
                void pendingOp
                    .then(() => handle.close(), () => handle.close())
                    .catch(() => undefined);
            } else if (signal?.aborted) {
                void handle.close().catch(() => undefined);
            } else {
                const closePromise = handle.close().catch(() => undefined);
                await raceWithAbortSignal(closePromise, signal).catch(() => undefined);
            }
        }
    }

    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
    const after = await raceWithAbortSignal(stat(path, {bigint: true}), signal);
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
    if (!after.isFile()
        || after.size !== before.size
        || after.dev !== before.dev
        || after.ino !== before.ino
        || after.mtimeNs !== before.mtimeNs
        || after.ctimeNs !== before.ctimeNs) {
        throw new Error('Document file changed during inspection');
    }
    return {
        bytes: expectedBytes,
        sha256: hash.digest('hex'),
        contentFingerprint: `sha256-full-v1:${contentHash.digest('hex')}`,
    };
}
