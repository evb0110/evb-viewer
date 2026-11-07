import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';

/** SHA-256 of a whole source file, streamed. */
export async function sha256ScanCleanupFile(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) {
        if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) {
            throw new Error(`Scan cleanup source stream produced an unsupported chunk: ${path}`);
        }
        hash.update(chunk);
    }
    return hash.digest('hex');
}
