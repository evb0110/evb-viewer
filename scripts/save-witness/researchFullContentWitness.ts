import { createHash } from 'node:crypto';
import {
    lstat, open, type FileHandle,
} from 'node:fs/promises';

export const RESEARCH_WITNESS_CHUNK_BYTES = 1024 * 1024;
export type TResearchFullContentWitnessPhase = 'baseline' | 'comparison';

export class ResearchFullContentWitnessError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ResearchFullContentWitnessError';
    }
}

export interface IResearchFullContentReadOptions {
    signal?: AbortSignal;
    onRead?: (bytes: number, phase: TResearchFullContentWitnessPhase) => void | Promise<void>;
    onReadIssued?: (phase: TResearchFullContentWitnessPhase) => void;
}

export interface IResearchFullContentWitnessSave {
    bytes: number;
    sha256: string;
    assertPublicationAllowed: (signal?: AbortSignal) => Promise<void>;
    close: () => Promise<void>;
}

export interface IResearchFullContentWitness {
    baselineBytes: number;
    baselineSha256: string;
    beginSave: (options?: IResearchFullContentReadOptions & {onComparisonHashed?: () => void | Promise<void>;}) => Promise<IResearchFullContentWitnessSave>;
}

export interface IResearchFullContentWitnessOptions extends IResearchFullContentReadOptions {
    onBaselineChunk?: (chunkNumber: number) => void | Promise<void>;
    onComparisonHashed?: () => void | Promise<void>;
}

interface IResearchFileStats {
    isFile: () => boolean;
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
}

interface IBoundResearchFile {
    handle: FileHandle;
    pathStats: IResearchFileStats;
    handleStats: IResearchFileStats;
}

function throwIfAborted(signal?: AbortSignal) {
    signal?.throwIfAborted();
}

function sameFile(a: IResearchFileStats, b: IResearchFileStats) {
    return a.dev === b.dev && a.ino === b.ino;
}

function sameContentStats(a: IResearchFileStats, b: IResearchFileStats) {
    return a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function sameBoundStats(a: IResearchFileStats, b: IResearchFileStats) {
    return sameFile(a, b) && sameContentStats(a, b);
}

async function openBoundRegularFile(filePath: string): Promise<IBoundResearchFile> {
    const pathStats = await lstat(filePath, { bigint: true });
    if (!pathStats.isFile()) {
        throw new ResearchFullContentWitnessError('full-content witness requires a regular non-symlink file');
    }
    let handle: FileHandle | undefined;
    try {
        handle = await open(filePath, 'r');
        const handleStats = await handle.stat({ bigint: true });
        if (!handleStats.isFile() || !sameFile(pathStats, handleStats)) {
            throw new ResearchFullContentWitnessError('named path changed while opening full-content witness');
        }
        return {
            handle,
            pathStats,
            handleStats,
        };
    } catch (error) {
        await handle?.close().catch(() => undefined);
        throw error;
    }
}

async function hashHandle(
    handle: FileHandle,
    size: number,
    phase: TResearchFullContentWitnessPhase,
    options: IResearchFullContentReadOptions = {},
    onChunk?: (bytes: number, chunkNumber: number) => void | Promise<void>,
) {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(RESEARCH_WITNESS_CHUNK_BYTES);
    let offset = 0;
    let chunkNumber = 0;
    while (offset < size) {
        throwIfAborted(options.signal);
        const length = Math.min(buffer.byteLength, size - offset);
        const pendingRead = handle.read(buffer, 0, length, offset);
        options.onReadIssued?.(phase);
        const result = await pendingRead;
        await options.onRead?.(result.bytesRead, phase);
        throwIfAborted(options.signal);
        if (result.bytesRead !== length) {
            throw new ResearchFullContentWitnessError('full-content witness encountered a short read');
        }
        hash.update(buffer.subarray(0, result.bytesRead));
        offset += result.bytesRead;
        await onChunk?.(result.bytesRead, chunkNumber++);
    }
    return hash.digest('hex');
}

async function verifyBoundPath(
    filePath: string,
    handle: FileHandle,
    expected: IResearchFileStats,
    message: string,
) {
    const named = await lstat(filePath, { bigint: true });
    const bound = await handle.stat({ bigint: true });
    if (!named.isFile() || !sameBoundStats(named, expected) || !sameBoundStats(bound, expected)) {
        throw new ResearchFullContentWitnessError(message);
    }
}

export async function captureResearchFullContentWitness(
    filePath: string,
    options: IResearchFullContentWitnessOptions = {},
): Promise<IResearchFullContentWitness> {
    throwIfAborted(options.signal);
    const opened = await openBoundRegularFile(filePath);
    const {
        handle, pathStats, handleStats,
    } = opened;
    try {
        if (handleStats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new ResearchFullContentWitnessError('full-content witness source size is unsupported');
        }
        const size = Number(handleStats.size);
        const sha256 = await hashHandle(handle, size, 'baseline', options, async (_bytes, chunkNumber) => {
            await options.onBaselineChunk?.(chunkNumber);
        });
        throwIfAborted(options.signal);
        const after = await handle.stat({ bigint: true });
        if (!sameContentStats(after, handleStats) || !sameFile(after, pathStats)) {
            throw new ResearchFullContentWitnessError('source changed during full-content baseline capture');
        }
        await verifyBoundPath(
            filePath,
            handle,
            handleStats,
            'source changed during full-content baseline capture',
        );
        return {
            baselineBytes: size,
            baselineSha256: sha256,
            beginSave: async (saveOptions = {}) => {
                throwIfAborted(saveOptions.signal);
                const saveOpened = await openBoundRegularFile(filePath);
                const saveHandle = saveOpened.handle;
                let closed = false;
                const close = async () => {
                    if (closed) return;
                    closed = true;
                    await saveHandle.close();
                };
                try {
                    if (saveOpened.handleStats.size !== BigInt(size)) {
                        throw new ResearchFullContentWitnessError('named path changed size before full comparison');
                    }
                    const currentSha256 = await hashHandle(saveHandle, size, 'comparison', saveOptions);
                    await (saveOptions.onComparisonHashed ?? options.onComparisonHashed)?.();
                    throwIfAborted(saveOptions.signal);
                    const afterComparison = await saveHandle.stat({ bigint: true });
                    if (!sameContentStats(afterComparison, saveOpened.handleStats)
                        || currentSha256 !== sha256) {
                        throw new ResearchFullContentWitnessError('named path changed during full-content comparison');
                    }
                    await verifyBoundPath(
                        filePath,
                        saveHandle,
                        afterComparison,
                        'named path changed during full-content comparison',
                    );
                    return {
                        bytes: size,
                        sha256: currentSha256,
                        assertPublicationAllowed: async (signal?: AbortSignal) => {
                            try {
                                throwIfAborted(saveOptions.signal);
                                throwIfAborted(signal);
                                await verifyBoundPath(
                                    filePath,
                                    saveHandle,
                                    afterComparison,
                                    'named path changed before publication',
                                );
                                throwIfAborted(saveOptions.signal);
                                throwIfAborted(signal);
                            } catch (error) {
                                await close().catch(() => undefined);
                                throw error;
                            }
                        },
                        close,
                    };
                } catch (error) {
                    await close().catch(() => undefined);
                    throw error;
                }
            },
        };
    } finally {
        await handle.close().catch(() => undefined);
    }
}
