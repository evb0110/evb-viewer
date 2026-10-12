import {createOriginalFileContentFingerprintHash} from '@electron/file-access/createOriginalFileContentFingerprintHash';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {Writable} from 'node:stream';

const FINGERPRINT_CHUNK_BYTES = 1024 * 1024;

export async function fingerprintFileBounded(path: string, expectedBytes: number) {
    const before = await stat(path);
    if (!before.isFile() || before.size !== expectedBytes) {
        throw new Error('Document file size changed during inspection');
    }
    const hash = createHash('sha256');
    const contentHash = createOriginalFileContentFingerprintHash(expectedBytes);
    await pipeline(
        createReadStream(path, {highWaterMark: FINGERPRINT_CHUNK_BYTES}),
        new Writable({write(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            contentHash.update(chunk);
            callback();
        }}),
    );
    const after = await stat(path);
    if (!after.isFile()
        || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs) {
        throw new Error('Document file changed during inspection');
    }
    return {
        bytes: after.size,
        sha256: hash.digest('hex'),
        contentFingerprint: `sha256-full-v1:${contentHash.digest('hex')}`,
    };
}
