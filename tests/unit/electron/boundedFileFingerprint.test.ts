import {createHash} from 'node:crypto';
import {
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {hashContentFingerprintFilePath} from '@electron/file-access/originalPathSnapshot';
import {fingerprintFileBounded} from '@electron/features/documents/main/fingerprintFileBounded';

describe('bounded file fingerprint', () => {
    const directories: string[] = [];

    afterEach(() => {
        for (const directory of directories.splice(0)) {
            rmSync(directory, {
                force: true,
                recursive: true,
            });
        }
    });

    it('fingerprints generic binary content through a bounded stream', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-bounded-fingerprint-'));
        directories.push(directory);
        const path = join(directory, 'placed-image.jpg');
        const bytes = Buffer.concat([
            Buffer.from([
                0xff,
                0xd8,
                0xff,
                0xe0,
            ]),
            Buffer.alloc(3 * 1024 * 1024 + 19, 0xa5),
        ]);
        writeFileSync(path, bytes);

        await expect(fingerprintFileBounded(path, bytes.byteLength)).resolves.toEqual({
            bytes: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            contentFingerprint: await hashContentFingerprintFilePath(path, BigInt(bytes.byteLength)),
        });
    });

    it('rejects a file whose size differs from the caller expectation', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-bounded-fingerprint-'));
        directories.push(directory);
        const path = join(directory, 'document.pdf');
        writeFileSync(path, Buffer.from('%PDF-1.7\n%%EOF'));

        await expect(fingerprintFileBounded(path, 1)).rejects.toThrow('size changed');
    });
});
