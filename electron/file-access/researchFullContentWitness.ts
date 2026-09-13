import { createHash } from 'node:crypto';
import {
    lstat, open, type FileHandle, 
} from 'node:fs/promises';

export const RESEARCH_WITNESS_CHUNK_BYTES = 1024 * 1024;

export class ResearchFullContentWitnessError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ResearchFullContentWitnessError';
    }
}

export interface IResearchFullContentWitness {
    baselineBytes: number;
    baselineSha256: string;
    compareNamedPath: () => Promise<{
        bytes: number;
        sha256: string
    }>;
    close: () => Promise<void>;
}

export interface IResearchFullContentWitnessOptions {
    onBaselineChunk?: (chunkNumber: number) => Promise<void>;
    onComparisonHashed?: () => Promise<void>;
}

async function hashHandle(handle: FileHandle, expectedSize: number, onChunk?: (bytes: number, chunkNumber: number) => Promise<void>) {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(RESEARCH_WITNESS_CHUNK_BYTES);
    let offset = 0;
    let chunkNumber = 0;
    while (offset < expectedSize) {
        const length = Math.min(buffer.byteLength, expectedSize - offset);
        const result = await handle.read(buffer, 0, length, offset);
        if (result.bytesRead !== length) {
            throw new ResearchFullContentWitnessError('full-content witness encountered a short read');
        }
        hash.update(buffer.subarray(0, result.bytesRead));
        offset += result.bytesRead;
        await onChunk?.(result.bytesRead, chunkNumber);
        chunkNumber += 1;
    }
    return hash.digest('hex');
}

async function openRegularFile(path: string) {
    const link = await lstat(path);
    if (!link.isFile()) {
        throw new ResearchFullContentWitnessError('full-content witness requires a regular non-symlink file');
    }
    return open(path, 'r');
}

export async function captureResearchFullContentWitness(path: string, options: IResearchFullContentWitnessOptions = {}): Promise<IResearchFullContentWitness> {
    const handle = await openRegularFile(path);
    try {
        const before = await handle.stat({bigint: true});
        if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new ResearchFullContentWitnessError('full-content witness source size is unsupported');
        }
        const size = Number(before.size);
        const sha256 = await hashHandle(handle, size, async (_bytes, chunkNumber) => options.onBaselineChunk?.(chunkNumber));
        const after = await handle.stat({bigint: true});
        if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
            throw new ResearchFullContentWitnessError('source changed during full-content baseline capture');
        }
        return {
            baselineBytes: size,
            baselineSha256: sha256,
            compareNamedPath: async () => {
                const current = await openRegularFile(path);
                try {
                    const currentBefore = await current.stat({bigint: true});
                    if (!currentBefore.isFile() || currentBefore.size !== before.size) {
                        throw new ResearchFullContentWitnessError('named path changed size before full comparison');
                    }
                    const currentSha256 = await hashHandle(current, size);
                    await options.onComparisonHashed?.();
                    const currentAfter = await current.stat({bigint: true});
                    if (currentAfter.size !== currentBefore.size
                        || currentAfter.mtimeNs !== currentBefore.mtimeNs
                        || currentAfter.ctimeNs !== currentBefore.ctimeNs
                        || currentSha256 !== sha256) {
                        throw new ResearchFullContentWitnessError('named path changed during full-content comparison');
                    }
                    return {
                        bytes: size,
                        sha256: currentSha256,
                    };
                } finally {
                    await current.close();
                }
            },
            close: () => handle.close(),
        };
    } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
    }
}

export async function readResearchWitnessChunk(
    path: string,
    chunkNumber: number,
    onIssued: () => Promise<void>,
) {
    const handle = await openRegularFile(path);
    try {
        const size = Number((await handle.stat({bigint: true})).size);
        const offset = chunkNumber * RESEARCH_WITNESS_CHUNK_BYTES;
        if (offset >= size) {
            throw new ResearchFullContentWitnessError('requested cancellation chunk is outside the file');
        }
        const buffer = Buffer.alloc(Math.min(RESEARCH_WITNESS_CHUNK_BYTES, size - offset));
        const result = await handle.read(buffer, 0, buffer.byteLength, offset);
        if (result.bytesRead !== buffer.byteLength) {
            throw new ResearchFullContentWitnessError('cancellation probe encountered a short read');
        }
        await onIssued();
        return result.bytesRead;
    } finally {
        await handle.close();
    }
}
