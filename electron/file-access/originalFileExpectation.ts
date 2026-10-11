import type {BigIntStats} from 'node:fs';
import {lstat} from 'node:fs/promises';
import {createOriginalFileContentFingerprintHash} from '@electron/file-access/createOriginalFileContentFingerprintHash';
import {readFileChunk} from '@electron/file-access/readFileChunk';

const ORIGINAL_CONTENT_FINGERPRINT_CHUNK_BYTES = 1024 * 1024;

export interface IWorkingCopyOriginalFileExpectation {
    contentFingerprint?: string;
    ctimeNs?: string;
    deviceId?: string;
    inode?: string;
    mtimeMs: number;
    mtimeNs?: string;
    size: number;
}


export function expectationMatchesStat(expectation: IWorkingCopyOriginalFileExpectation, fileStat: BigIntStats) {
    return fileStat.isFile()
        && (expectation.deviceId === undefined || fileStat.dev.toString() === expectation.deviceId)
        && (expectation.inode === undefined || fileStat.ino.toString() === expectation.inode)
        && fileStat.size === BigInt(expectation.size)
        && (expectation.mtimeNs === undefined
            ? Math.abs(Number(fileStat.mtimeNs) / 1_000_000 - expectation.mtimeMs) < 1
            : fileStat.mtimeNs.toString() === expectation.mtimeNs)
        && (expectation.ctimeNs === undefined || fileStat.ctimeNs.toString() === expectation.ctimeNs);
}


export function getExpectationStatMismatches(
    expected: IWorkingCopyOriginalFileExpectation,
    actual: BigIntStats,
) {
    return [
        expected.ctimeNs !== undefined && actual.ctimeNs.toString() !== expected.ctimeNs ? 'ctimeNs' : null,
        expected.deviceId !== undefined && actual.dev.toString() !== expected.deviceId ? 'deviceId' : null,
        !actual.isFile() ? 'fileType' : null,
        expected.inode !== undefined && actual.ino.toString() !== expected.inode ? 'inode' : null,
        expected.mtimeNs !== undefined && actual.mtimeNs.toString() !== expected.mtimeNs ? 'mtimeNs' : null,
        actual.size !== BigInt(expected.size) ? 'size' : null,
        expected.mtimeNs === undefined
            && Math.abs(Number(actual.mtimeNs) / 1_000_000 - expected.mtimeMs) >= 1
            ? 'mtimeMs'
            : null,
    ].filter((field): field is string => field !== null);
}


export async function createOriginalFileContentFingerprint(
    originalPath: string,
    expectation: IWorkingCopyOriginalFileExpectation,
    signal?: AbortSignal,
) {
    try {
        signal?.throwIfAborted();
        const before = await lstat(originalPath, {bigint: true});
        if (!Number.isSafeInteger(Number(before.size)) || !expectationMatchesStat(expectation, before)) {
            return undefined;
        }
        const hash = createOriginalFileContentFingerprintHash(Number(before.size));
        const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(Number(before.size), ORIGINAL_CONTENT_FINGERPRINT_CHUNK_BYTES)));
        let offset = 0;
        while (offset < Number(before.size)) {
            signal?.throwIfAborted();
            const length = Math.min(buffer.byteLength, Number(before.size) - offset);
            const bytesRead = await readFileChunk(originalPath, buffer.subarray(0, length), offset);
            if (bytesRead <= 0) {
                return undefined;
            }
            hash.update(buffer.subarray(0, bytesRead));
            offset += bytesRead;
        }
        const after = await lstat(originalPath, {bigint: true});
        signal?.throwIfAborted();
        return expectationMatchesStat(expectation, after)
            && expectationMatchesStat(createOriginalFileExpectationFromStat(before), after)
            ? `sha256-full-v1:${hash.digest('hex')}`
            : undefined;
    } catch {
        return undefined;
    }
}

export function createOriginalFileExpectationFromStat(
    originalStat: BigIntStats,
): IWorkingCopyOriginalFileExpectation {
    return {
        ctimeNs: originalStat.ctimeNs.toString(),
        deviceId: originalStat.dev.toString(),
        inode: originalStat.ino.toString(),
        mtimeMs: Number(originalStat.mtimeNs) / 1_000_000,
        mtimeNs: originalStat.mtimeNs.toString(),
        size: Number(originalStat.size),
    };
}

