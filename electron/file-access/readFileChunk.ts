import {open} from 'node:fs/promises';

/**
 * Read at most 1 MiB, closing before the caller hashes or checks metadata.
 * Node opens with read/write/delete sharing on Windows. A replacing rename
 * can still fail while its destination is open, so no witness retains it.
 */
export async function readFileChunk(path: string, buffer: Buffer, position: number) {
    const handle = await open(path, 'r');
    try {
        return (await handle.read(buffer, 0, Math.min(buffer.byteLength, 1024 * 1024), position)).bytesRead;
    } finally {
        await handle.close();
    }
}
