import type {BigIntStats} from 'node:fs';
import {lstat} from 'node:fs/promises';
import {hashContentFingerprintFilePath} from '@electron/file-access/originalPathSnapshot';

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
    return getExpectationStatMismatches(expectation, fileStat).length === 0;
}

/** Identity-only churn needs an already admitted full fingerprint. */
function contentMetadataMatchesStat(expectation: IWorkingCopyOriginalFileExpectation, fileStat: BigIntStats) {
    return expectation.ctimeNs !== undefined && expectation.mtimeNs !== undefined
        && getExpectationStatMismatches(expectation, fileStat)
            .every(field => field === 'deviceId' || field === 'inode');
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
        if (!Number.isSafeInteger(Number(before.size))) {
            return undefined;
        }
        const beforeMatches = expectationMatchesStat(expectation, before);
        if (!beforeMatches && (!expectation.contentFingerprint || !contentMetadataMatchesStat(expectation, before))) {
            return undefined;
        }
        const fingerprint = await hashContentFingerprintFilePath(originalPath, before.size, signal);
        const after = await lstat(originalPath, {bigint: true});
        signal?.throwIfAborted();
        const afterMatches = expectationMatchesStat(expectation, after)
            && expectationMatchesStat(createOriginalFileExpectationFromStat(before), after);
        if (beforeMatches && afterMatches) {
            return fingerprint;
        }
        return contentMetadataMatchesStat(expectation, after)
            && contentMetadataMatchesStat(createOriginalFileExpectationFromStat(before), after)
            && fingerprint === expectation.contentFingerprint
            ? fingerprint : undefined;
    } catch {
        return undefined;
    }
}

export function createOriginalFileExpectationFromStat(
    originalStat: Pick<BigIntStats, 'ctimeNs' | 'dev' | 'ino' | 'mtimeNs' | 'size'>,
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
